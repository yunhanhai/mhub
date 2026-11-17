//! Bounded waiting for original-file preparation. Only dispatched jobs hold a
//! preparation permit; waiting never opens a cached file or reserves disk space.
use super::*;
use std::collections::VecDeque;
use tokio::sync::OwnedSemaphorePermit;

const QUEUE_LIMIT: usize = 16;
const USER_QUEUE_LIMIT: usize = 4;
const MAX_WAIT: Duration = Duration::from_secs(5);
type Principal = Option<String>;

/// A stable user ID spans all of that user's sessions. Anonymous requests share
/// one lane. Joined consumers retain the first request's lane and deadline.
#[derive(Default)]
pub(super) struct Queue {
    lanes: VecDeque<(Principal, VecDeque<String>)>,
}
impl Queue {
    pub(super) fn len(&self) -> usize {
        self.lanes.iter().map(|(_, keys)| keys.len()).sum()
    }
    fn user_len(&self, principal: &Principal) -> usize {
        self.lanes
            .iter()
            .find(|(owner, _)| owner == principal)
            .map_or(0, |(_, keys)| keys.len())
    }
    fn push(&mut self, principal: Principal, key: String) {
        if let Some((_, keys)) = self.lanes.iter_mut().find(|(owner, _)| owner == &principal) {
            keys.push_back(key);
        } else {
            self.lanes.push_back((principal, VecDeque::from([key])));
        }
    }
    fn pop(&mut self) -> Option<String> {
        let (principal, mut keys) = self.lanes.pop_front()?;
        let key = keys.pop_front();
        if !keys.is_empty() {
            self.lanes.push_back((principal, keys));
        }
        key
    }
    pub(super) fn remove(&mut self, key: &str) {
        for (_, keys) in &mut self.lanes {
            keys.retain(|candidate| candidate != key);
        }
        self.lanes.retain(|(_, keys)| !keys.is_empty());
    }
}

impl Library {
    pub(super) fn begin_task(
        self: &Arc<Self>,
        entry: Entry,
        session: Option<Session>,
    ) -> Result<Value> {
        let key = representation_key(
            &self.config.source.instance_id,
            &entry.song_id,
            &entry.sha256,
        );
        let mut control = self.control.lock().unwrap();
        self.expire_waiters(&mut control);
        if control.tasks.len() >= 256 {
            let terminal = control
                .tasks
                .values()
                .filter(|task| {
                    matches!(
                        task.progress.lock().unwrap().state,
                        State::Failed | State::Cancelled
                    )
                })
                .min_by_key(|task| task.expires_at)
                .map(|task| task.id.clone());
            if let Some(id) = terminal {
                control.tasks.remove(&id);
            } else {
                return Err(error(429, "task_limit", "播放任务已满，请稍后重试"));
            }
        }
        let session = session.and_then(|value| {
            control
                .sessions
                .get(&value.key)
                .filter(|current| current.expires_at > now())
                .cloned()
        });
        if entry.access == Access::Restricted && session.is_none() {
            return Err(error(401, "login_required", "请先登录"));
        }
        let principal = session.as_ref().map(|session| session.user.id.clone());
        let expires_at = (now() + self.config.task_ttl_seconds * 1000).min(
            session
                .as_ref()
                .filter(|_| entry.access == Access::Restricted)
                .map_or(u64::MAX, |session| session.expires_at),
        );
        let media_stop = session
            .as_ref()
            .filter(|_| entry.access == Access::Restricted)
            .map_or_else(CancellationToken::new, |session| {
                session.revoked.child_token()
            });
        let task = Arc::new(Task {
            id: opaque::<24>(),
            key: key.clone(),
            selection: entry.selection(&self.config.source.instance_id),
            owner: session
                .as_ref()
                .filter(|_| entry.access == Access::Restricted)
                .map(|s| s.key.clone()),
            expires_at,
            progress: Mutex::new(Progress {
                state: State::Preparing,
                file: None,
                error: None,
            }),
            media_stop,
        });
        if let Some(job) = control.jobs.get_mut(&key) {
            if job.cancel.is_cancelled() {
                return Err(error(
                    409,
                    "download_cancelling",
                    "之前的准备正在取消，请重试",
                ));
            }
            job.consumers.insert(task.id.clone());
        } else {
            if control.pending.len() >= QUEUE_LIMIT {
                self.count(|c| c.preparation_queue_rejections += 1);
                return Err(error(
                    429,
                    "preparation_queue_full",
                    "等待播放的曲目已满，请稍后重试",
                ));
            }
            if control.pending.user_len(&principal) >= USER_QUEUE_LIMIT {
                self.count(|c| c.preparation_user_rejections += 1);
                return Err(error(
                    429,
                    "preparation_user_limit",
                    "您的等待曲目已满，请稍后重试",
                ));
            }
            let enqueued_at = Instant::now();
            control.pending.push(principal, key.clone());
            control.jobs.insert(
                key,
                Job {
                    id: opaque::<12>(),
                    cancel: CancellationToken::new(),
                    consumers: HashSet::from([task.id.clone()]),
                    waiting: true,
                    enqueued_at,
                    deadline: enqueued_at + MAX_WAIT,
                },
            );
        }
        let view = task.public(&entry);
        control.tasks.insert(task.id.clone(), task);
        let start_scheduler = !control.scheduler_running;
        control.scheduler_running = true;
        drop(control);
        if start_scheduler {
            let library = self.clone();
            tokio::spawn(async move {
                library.drive_preparations().await;
            });
        }
        self.preparation_changed.notify_one();
        Ok(view)
    }

    fn expire_waiters(&self, control: &mut Control) {
        let expired: Vec<_> = control
            .jobs
            .iter()
            .filter(|(_, job)| job.waiting && job.deadline <= Instant::now())
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            control.pending.remove(&key);
            if let Some(job) = control.jobs.remove(&key) {
                job.cancel.cancel();
                for id in job.consumers {
                    if let Some(task) = control.tasks.get(&id) {
                        let mut progress = task.progress.lock().unwrap();
                        if progress.state == State::Preparing {
                            progress.state = State::Failed;
                            progress.error = Some("preparation_timeout");
                            task.media_stop.cancel();
                        }
                    }
                }
                self.count(|c| c.preparation_timeouts += 1);
            }
        }
    }

    async fn drive_preparations(self: Arc<Self>) {
        loop {
            // notify_one retains a permit even if a completion races the wait.
            let changed = self.preparation_changed.notified();
            self.cleanup();
            let mut starts = Vec::new();
            let deadline;
            {
                let mut control = self.control.lock().unwrap();
                self.expire_waiters(&mut control);
                while control.pending.len() > 0 {
                    let Ok(permit) = self.downloads.clone().try_acquire_owned() else {
                        break;
                    };
                    let key = control.pending.pop().unwrap();
                    let Some(job) = control.jobs.get_mut(&key) else {
                        continue;
                    };
                    job.waiting = false;
                    self.count(|c| {
                        c.preparation_starts += 1;
                        c.preparation_wait_ms += job.enqueued_at.elapsed().as_millis() as u64;
                    });
                    starts.push((key, job.id.clone(), job.cancel.clone(), permit));
                }
                if control.jobs.is_empty() {
                    control.scheduler_running = false;
                    return;
                }
                deadline = control
                    .jobs
                    .values()
                    .filter(|job| job.waiting)
                    .map(|job| job.deadline)
                    .min();
            }
            for (key, id, cancel, permit) in starts {
                let library = self.clone();
                tokio::spawn(async move {
                    library.run_preparation(key, id, cancel, permit).await;
                });
            }
            self.flush_metrics();
            if let Some(deadline) = deadline {
                tokio::select! { _ = changed => {}, _ = tokio::time::sleep_until(deadline) => {} }
            } else {
                changed.await;
            }
        }
    }

    async fn run_preparation(
        self: Arc<Self>,
        key: String,
        id: String,
        cancel: CancellationToken,
        permit: OwnedSemaphorePermit,
    ) {
        let outcome = self.prepare_for_consumer(&key, &id, &cancel).await;
        {
            let mut control = self.control.lock().unwrap();
            // A generation check protects any later work with the same key.
            if control.jobs.get(&key).is_some_and(|job| job.id == id) {
                let job = control.jobs.remove(&key).unwrap();
                for consumer in job.consumers {
                    if let Some(task) = control.tasks.get(&consumer) {
                        let mut progress = task.progress.lock().unwrap();
                        if progress.state != State::Preparing {
                            continue;
                        }
                        if task.expires_at <= now() {
                            task.media_stop.cancel();
                            progress.state = State::Cancelled;
                        } else {
                            match &outcome {
                                Ok(file) => {
                                    progress.file = Some(file.clone());
                                    progress.state = State::Ready;
                                }
                                Err(error) => {
                                    progress.state = State::Failed;
                                    progress.error = Some(error.code);
                                }
                            }
                        }
                    }
                }
            }
            // The cache future has finished closing partial files before this
            // permit is returned. Pending work cannot overbook those resources.
            drop(permit);
        }
        self.preparation_changed.notify_one();
        self.flush_metrics();
    }

    async fn prepare_for_consumer(
        &self,
        key: &str,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        let mut tried = HashSet::new();
        loop {
            if cancel.is_cancelled() {
                return Err(error(409, "cancelled", "准备已取消"));
            }
            let task = {
                let control = self.control.lock().unwrap();
                control
                    .jobs
                    .get(key)
                    .filter(|job| job.id == id)
                    .into_iter()
                    .flat_map(|job| &job.consumers)
                    .filter(|candidate| !tried.contains(*candidate))
                    .filter_map(|candidate| control.tasks.get(candidate))
                    .filter(|task| {
                        task.expires_at > now()
                            && task.progress.lock().unwrap().state == State::Preparing
                    })
                    .min_by_key(|task| task.expires_at)
                    .cloned()
            }
            .ok_or(error(409, "cancelled", "准备已取消"))?;
            tried.insert(task.id.clone());
            // Do not retain the first request's credentials while waiting. Use
            // a still-live consumer and recheck both policy and the source.
            let authorized = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(error(409, "cancelled", "准备已取消")),
                result = self.authorize_session(task.owner.as_deref(), &task.selection, Some(&task)) => result,
            };
            match authorized {
                Ok(allowed) => {
                    let live = {
                        let control = self.control.lock().unwrap();
                        control
                            .jobs
                            .get(key)
                            .is_some_and(|job| job.id == id && job.consumers.contains(&task.id))
                            && task.expires_at > now()
                            && task.progress.lock().unwrap().state == State::Preparing
                    };
                    if !live {
                        continue;
                    }
                    return self.cache_file(&allowed.entry, &allowed.auth, cancel).await;
                }
                // Navidrome can hide an inaccessible song with protocol 70.
                // That source-specific 404 says nothing about another user's
                // grant. Local missing entries still fail the whole work.
                Err(failure)
                    if matches!(
                        failure.status,
                        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                    ) || (failure.status == StatusCode::NOT_FOUND
                        && failure.code == "source_missing") =>
                {
                    let mut control = self.control.lock().unwrap();
                    let mut progress = task.progress.lock().unwrap();
                    if progress.state == State::Preparing {
                        progress.state = State::Failed;
                        progress.error = Some(failure.code);
                        task.media_stop.cancel();
                    }
                    if let Some(job) = control.jobs.get_mut(key).filter(|job| job.id == id) {
                        job.consumers.remove(&task.id);
                        if job.consumers.is_empty() {
                            job.cancel.cancel();
                        }
                    }
                }
                Err(failure) => return Err(failure),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::tests::{config, policy};

    fn fixture() -> (tempfile::TempDir, Arc<Library>) {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::new(config(directory.path(), "http://127.0.0.1:9".into())).unwrap();
        (directory, library)
    }
    fn entry(id: usize) -> Entry {
        let mut entry = policy("instance").tracks.remove(0);
        entry.song_id = format!("song-{id}");
        entry
    }
    fn session(library: &Library, user: &str, key: &str) -> Session {
        let value = Session {
            key: key.into(),
            user: User {
                id: user.into(),
                username: user.into(),
            },
            auth: library.config.source.auth.clone(),
            expires_at: now() + 60_000,
            revoked: CancellationToken::new(),
        };
        library
            .control
            .lock()
            .unwrap()
            .sessions
            .insert(value.key.clone(), value.clone());
        value
    }
    fn cancel_all(library: &Library) {
        let mut control = library.control.lock().unwrap();
        let ids: Vec<_> = control.tasks.keys().cloned().collect();
        for id in ids {
            library.cancel_locked(&mut control, &id);
        }
        assert!(control.jobs.is_empty());
        assert_eq!(control.pending.len(), 0);
    }

    #[test]
    fn round_robin_preserves_user_fifo_and_new_arrivals_do_not_jump_the_queue() {
        let mut queue = Queue::default();
        for (user, key) in [
            ("a", "a1"),
            ("a", "a2"),
            ("b", "b1"),
            ("b", "b2"),
            ("c", "c1"),
        ] {
            queue.push(Some(user.into()), key.into());
        }
        assert_eq!(queue.pop().as_deref(), Some("a1"));
        queue.push(Some("a".into()), "a3".into());
        assert_eq!(queue.pop().as_deref(), Some("b1"));
        queue.remove("a2");
        assert_eq!(queue.pop().as_deref(), Some("c1"));
        assert_eq!(queue.pop().as_deref(), Some("a3"));
        assert_eq!(queue.pop().as_deref(), Some("b2"));
        assert!(queue.pop().is_none());
    }

    #[tokio::test]
    async fn per_user_waiting_budget_spans_sessions_and_rejection_creates_no_task() {
        let (_directory, library) = fixture();
        let _held = library
            .downloads
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        let a = session(&library, "same-user", "first-session");
        let b = session(&library, "same-user", "second-session");
        for id in 0..4 {
            library.begin_task(entry(id), Some(a.clone())).unwrap();
        }
        let error = library.begin_task(entry(4), Some(b)).unwrap_err();
        assert_eq!(error.code, "preparation_user_limit");
        assert_eq!(library.control.lock().unwrap().tasks.len(), 4);
        assert_eq!(library.control.lock().unwrap().pending.len(), 4);
        assert_eq!(library.metrics.lock().unwrap().source_requests, 0);
        cancel_all(&library);
    }

    #[tokio::test]
    async fn global_waiting_budget_allows_joining_existing_work_but_bounds_new_files() {
        let (_directory, library) = fixture();
        let _held = library
            .downloads
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        for user in 0..4 {
            let owner = session(
                &library,
                &format!("user-{user}"),
                &format!("session-{user}"),
            );
            for offset in 0..4 {
                library
                    .begin_task(entry(user * 4 + offset), Some(owner.clone()))
                    .unwrap();
            }
        }
        let next = session(&library, "next-user", "next-session");
        assert_eq!(
            library
                .begin_task(entry(16), Some(next.clone()))
                .unwrap_err()
                .code,
            "preparation_queue_full"
        );
        library.begin_task(entry(0), Some(next)).unwrap();
        let control = library.control.lock().unwrap();
        assert_eq!(control.pending.len(), 16);
        assert_eq!(control.jobs.len(), 16);
        assert_eq!(control.tasks.len(), 17);
        drop(control);
        cancel_all(&library);
    }

    #[tokio::test]
    async fn anonymous_requests_share_one_waiting_budget() {
        let (_directory, library) = fixture();
        let _held = library
            .downloads
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        for id in 0..4 {
            library.begin_task(entry(id), None).unwrap();
        }
        assert_eq!(
            library.begin_task(entry(4), None).unwrap_err().code,
            "preparation_user_limit"
        );
        cancel_all(&library);
    }

    #[tokio::test]
    async fn partial_cancellation_keeps_shared_waiting_work_and_last_cancel_removes_it() {
        let (_directory, library) = fixture();
        let _held = library
            .downloads
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        let a = library.begin_task(entry(0), None).unwrap();
        let b = library.begin_task(entry(0), None).unwrap();
        let mut control = library.control.lock().unwrap();
        let before_deadline = control.jobs.values().next().unwrap().deadline;
        library.cancel_locked(&mut control, a["id"].as_str().unwrap());
        assert_eq!(control.pending.len(), 1);
        assert_eq!(control.jobs.values().next().unwrap().consumers.len(), 1);
        assert_eq!(
            control.jobs.values().next().unwrap().deadline,
            before_deadline
        );
        library.cancel_locked(&mut control, b["id"].as_str().unwrap());
        assert!(control.jobs.is_empty());
        assert_eq!(control.pending.len(), 0);
    }

    #[tokio::test]
    async fn expired_waiting_job_fails_all_consumers_without_extending_the_deadline() {
        let (_directory, library) = fixture();
        let _held = library
            .downloads
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        library.begin_task(entry(0), None).unwrap();
        library.begin_task(entry(0), None).unwrap();
        let mut control = library.control.lock().unwrap();
        control.jobs.values_mut().next().unwrap().deadline = Instant::now();
        library.expire_waiters(&mut control);
        assert!(control.jobs.is_empty());
        assert_eq!(control.pending.len(), 0);
        for task in control.tasks.values() {
            let progress = task.progress.lock().unwrap();
            assert!(progress.state == State::Failed);
            assert_eq!(progress.error, Some("preparation_timeout"));
        }
        assert_eq!(library.metrics.lock().unwrap().preparation_timeouts, 1);
        drop(control);
        library.begin_task(entry(0), None).unwrap();
        assert_eq!(library.control.lock().unwrap().pending.len(), 1);
        cancel_all(&library);
    }

    #[tokio::test]
    async fn stale_completion_cannot_remove_a_new_job_for_the_same_representation() {
        let (_directory, library) = fixture();
        let old_permit = library.downloads.clone().acquire_owned().await.unwrap();
        let _held = library.downloads.clone().acquire_owned().await.unwrap();
        let old = library.begin_task(entry(0), None).unwrap();
        let (key, old_id, old_cancel) = {
            let mut control = library.control.lock().unwrap();
            let (key, job) = control.jobs.iter().next().unwrap();
            let data = (key.clone(), job.id.clone(), job.cancel.clone());
            library.cancel_locked(&mut control, old["id"].as_str().unwrap());
            data
        };
        library.begin_task(entry(0), None).unwrap();
        let new_id = library.control.lock().unwrap().jobs[&key].id.clone();
        assert_ne!(old_id, new_id);
        library
            .clone()
            .run_preparation(key.clone(), old_id, old_cancel, old_permit)
            .await;
        assert_eq!(library.control.lock().unwrap().jobs[&key].id, new_id);
        cancel_all(&library);
    }

    async fn source_missing_case(peer_has_access: bool) {
        use axum::{Form, Json, response::IntoResponse, routing::post};
        let requests = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let metadata_requests = requests.clone();
        let media_requests = requests.clone();
        let upstream = Router::new()
            .route(
                "/rest/getSong.view",
                post(move |Form(form): Form<HashMap<String, String>>| {
                    let requests = metadata_requests.clone();
                    async move {
                        let user = form["u"].clone();
                        requests.lock().unwrap().push(("getSong".into(), user.clone()));
                        Json(if peer_has_access && user == "peer" {
                            json!({"subsonic-response":{"status":"ok","song":{"id":"song","size":4}}})
                        } else {
                            json!({"subsonic-response":{"status":"failed","error":{"code":70,"message":"Not found"}}})
                        })
                    }
                }),
            )
            .route(
                "/rest/stream.view",
                post(move |Form(form): Form<HashMap<String, String>>| {
                    let requests = media_requests.clone();
                    async move {
                        requests.lock().unwrap().push(("stream".into(), form["u"].clone()));
                        ([("content-type", "audio/flac")], b"test".to_vec()).into_response()
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let settings = config(directory.path(), format!("http://{address}"));
        let mut policy: Value =
            serde_json::from_slice(&std::fs::read(&settings.policy_file).unwrap()).unwrap();
        policy["tracks"][0]["access"] = json!("restricted");
        policy["tracks"][0]["allowedUserIds"] = json!(["first", "peer"]);
        std::fs::write(&settings.policy_file, serde_json::to_vec(&policy).unwrap()).unwrap();
        let library = Library::new(settings).unwrap();
        let held = library
            .downloads
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        let mut first = session(&library, "first", "first-session");
        let mut peer = session(&library, "peer", "peer-session");
        first.expires_at = now() + 30_000;
        peer.expires_at = now() + 60_000;
        for session in [&mut first, &mut peer] {
            session.auth.username = session.user.username.clone();
            library
                .control
                .lock()
                .unwrap()
                .sessions
                .insert(session.key.clone(), session.clone());
        }
        let entry = library.policy().await.unwrap().tracks.remove(0);
        let a = library.begin_task(entry.clone(), Some(first)).unwrap();
        let b = library.begin_task(entry, Some(peer)).unwrap();
        let (a, b) = {
            let control = library.control.lock().unwrap();
            (
                control.tasks[a["id"].as_str().unwrap()].clone(),
                control.tasks[b["id"].as_str().unwrap()].clone(),
            )
        };
        drop(held);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if !library.control.lock().unwrap().scheduler_running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let first = a.progress.lock().unwrap();
        assert!(first.state == State::Failed);
        assert_eq!(first.error, Some("source_missing"));
        assert!(first.file.is_none());
        let peer = b.progress.lock().unwrap();
        if peer_has_access {
            assert!(peer.state == State::Ready);
            assert_eq!(std::fs::read(peer.file.as_ref().unwrap()).unwrap(), b"test");
            assert_eq!(
                *requests.lock().unwrap(),
                vec![
                    ("getSong".into(), "first".into()),
                    ("getSong".into(), "peer".into()),
                    ("stream".into(), "peer".into())
                ]
            );
        } else {
            assert!(peer.state == State::Failed);
            assert_eq!(peer.error, Some("source_missing"));
            assert!(peer.file.is_none());
            assert!(
                !requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _)| method == "stream")
            );
        }
        assert_eq!(
            library.metrics.lock().unwrap().source_downloads,
            u64::from(peer_has_access)
        );
        assert!(library.control.lock().unwrap().jobs.is_empty());
        assert_eq!(library.downloads.available_permits(), 2);
        server.abort();
    }

    #[tokio::test]
    async fn source_missing_for_one_identity_does_not_fail_a_valid_co_consumer() {
        source_missing_case(true).await;
    }

    #[tokio::test]
    async fn source_missing_for_every_identity_never_downloads_or_publishes_bytes() {
        source_missing_case(false).await;
    }
}
