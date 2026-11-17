//! Authorized original-file library in the main music-api process.
//!
//! Byte storage is shared by immutable representation; authorization is checked
//! separately for every task and media request, including cache and 304 hits.
mod artwork;
mod cache;
mod disk;
mod preparation;
mod routes;
mod source;
mod transport;
pub use transport::serve_bounded;
#[cfg(test)]
mod tests;

use axum::{
    Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub const API_PREFIX: &str = "/api/v1/library";
pub const COOKIE: &str = "mhub_library_session";
pub const SECURE_COOKIE: &str = "__Host-mhub_library_session";
pub const CLIENT_HEADER: &str = "x-mhub-library";
const MAX_FILE: u64 = 32 * 1024 * 1024;
const SESSION_MS: u64 = 3_600_000;
const TASK_MS: u64 = 900_000;
const MEDIA_LIMIT: usize = 32;
const PREPARATION_LIMIT: usize = 2;

#[derive(Clone, Copy, Debug)]
struct Error {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}
type Result<T> = std::result::Result<T, Error>;
fn error(status: u16, code: &'static str, message: &'static str) -> Error {
    Error {
        status: StatusCode::from_u16(status).unwrap(),
        code,
        message,
    }
}
fn internal() -> Error {
    error(500, "internal_error", "曲库服务暂时不可用")
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}

// Deliberately no Debug/Serialize: these fields must never enter API responses
// or request/error logs. Only the small public DTOs below are serialized.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub origin: String,
    source: SourceConfig,
    policy_file: PathBuf,
    cache_dir: PathBuf,
    #[serde(default)]
    artwork_dir: Option<PathBuf>,
    #[serde(default = "default_cache_limit")]
    cache_max_bytes: u64,
    #[serde(default = "default_session_ttl")]
    session_ttl_seconds: u64,
    #[serde(default = "default_task_ttl")]
    task_ttl_seconds: u64,
}
fn default_session_ttl() -> u64 {
    SESSION_MS / 1000
}
fn default_task_ttl() -> u64 {
    TASK_MS / 1000
}
fn default_cache_limit() -> u64 {
    128 * 1024 * 1024
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceConfig {
    instance_id: String,
    base_url: String,
    auth: SourceAuth,
}
#[derive(Clone, Deserialize)]
struct SourceAuth {
    username: String,
    salt: String,
    token: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    instance_id: String,
    tracks: Vec<Entry>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    song_id: String,
    title: String,
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    track_number: Option<u32>,
    #[serde(default)]
    year: Option<u32>,
    #[serde(default)]
    artwork: Option<Artwork>,
    duration: u64,
    format: String,
    content_type: String,
    size: u64,
    sha256: String,
    modified_at: String,
    access: Access,
    allowed_user_ids: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Artwork {
    sha256: String,
    size: u64,
    width: u32,
    height: u32,
    content_type: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Access {
    Public,
    Restricted,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    instance_id: String,
    song_id: String,
    version: String,
}
impl Entry {
    fn selection(&self, instance: &str) -> Selection {
        Selection {
            instance_id: instance.to_owned(),
            song_id: self.song_id.clone(),
            version: self.sha256.clone(),
        }
    }
    fn permits(&self, session: Option<&Session>) -> bool {
        self.access == Access::Public
            || session.is_some_and(|s| self.allowed_user_ids.contains(&s.user.id))
    }
    fn public(&self, instance: &str) -> Value {
        let key = representation_key(instance, &self.song_id, &self.sha256);
        json!({ "instanceId":instance, "songId":self.song_id, "version":self.sha256,
            "id":key, "source_id":key, "platform":"navidrome", "quality":"raw",
            "title":self.title, "artist":self.artist, "duration":self.duration,
            "album":self.album, "trackNumber":self.track_number, "year":self.year,
            "artwork":self.artwork,
            "cover_url":self.artwork.as_ref().map(|_| format!("{API_PREFIX}/artwork/{}?instanceId={}&version={}", component(&self.song_id), component(instance), component(&self.sha256))),
            "format":self.format, "content_type":self.content_type, "byte_size":self.size,
            "access":self.access, "offlineAllowed":self.access == Access::Public, "streaming_mode":"" })
    }
}

#[derive(Clone, Serialize)]
struct User {
    id: String,
    username: String,
}
#[derive(Clone)]
struct Session {
    key: String,
    user: User,
    auth: SourceAuth,
    expires_at: u64,
    revoked: CancellationToken,
}
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum State {
    Preparing,
    Ready,
    Failed,
    Cancelled,
}
struct Progress {
    state: State,
    file: Option<PathBuf>,
    error: Option<&'static str>,
}
struct Task {
    id: String,
    key: String,
    selection: Selection,
    owner: Option<String>,
    expires_at: u64,
    progress: Mutex<Progress>,
    media_stop: CancellationToken,
}
impl Task {
    fn public(&self, entry: &Entry) -> Value {
        let progress = self.progress.lock().unwrap();
        json!({ "id":self.id, "state":progress.state, "error":progress.error,
            "expiresAt":self.expires_at, "track":entry.public(&self.selection.instance_id),
            "mediaUrl":format!("{API_PREFIX}/tasks/{}/audio", self.id) })
    }
}
struct Job {
    id: String,
    cancel: CancellationToken,
    consumers: HashSet<String>,
    waiting: bool,
    enqueued_at: Instant,
    deadline: Instant,
}
#[derive(Default)]
struct Control {
    sessions: HashMap<String, Session>,
    tasks: HashMap<String, Arc<Task>>,
    jobs: HashMap<String, Job>,
    pending: preparation::Queue,
    scheduler_running: bool,
}

/// Private diagnostics for regression tests. No HTTP endpoint exposes counters.
/// Enabled only by an explicit MUSIC_API_LIBRARY_METRICS_FILE path.
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counters {
    source_requests: u64,
    protocol_failures: u64,
    source_downloads: u64,
    cache_hits: u64,
    cache_misses: u64,
    cache_validations: u64,
    media_opens: u64,
    denied: u64,
    cancelled: u64,
    cache_bytes: u64,
    reserved_bytes: u64,
    recovered_partials: u64,
    cache_evictions: u64,
    active_file_leases: u64,
    task_slots: usize,
    active_tasks: usize,
    active_sessions: usize,
    active_jobs: usize,
    active_media_responses: usize,
    interrupted_media: u64,
    queued_preparations: usize,
    running_preparations: usize,
    preparation_starts: u64,
    preparation_wait_ms: u64,
    preparation_timeouts: u64,
    preparation_queue_rejections: u64,
    preparation_user_rejections: u64,
}
pub struct Library {
    config: Config,
    source_url: url::Url,
    authority: String,
    secure_cookie: bool,
    http: reqwest::Client,
    control: Mutex<Control>,
    downloads: Arc<Semaphore>,
    preparation_changed: Notify,
    logins: Semaphore,
    media: Arc<Semaphore>,
    metrics: Mutex<Counters>,
    metrics_file: Option<PathBuf>,
    metrics_write: Mutex<()>,
    disk: Arc<disk::Disk>,
}
struct Authorization {
    entry: Entry,
    session: Option<Session>,
    auth: SourceAuth,
}

pub fn configured_router(file: &str) -> Router {
    if file.trim().is_empty() {
        return Router::new();
    }
    let config = std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
        .expect("invalid library.config_file; check the private JSON configuration");
    let library = Library::new(config)
        .unwrap_or_else(|_| panic!("invalid library configuration or catalogue"));
    let weak = Arc::downgrade(&library);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let Some(library) = weak.upgrade() else { break };
            library.cleanup();
            if let Ok(policy) = library.policy().await {
                let mut control = library.control.lock().unwrap();
                let current = library.current_files(&policy);
                library.cancel_obsolete(&mut control, &current);
                let pinned = library.pinned_files(&control, &current);
                let _ = library.disk.maintain(&current, &pinned);
            }
            library.flush_metrics();
        }
    });
    Router::new().nest(API_PREFIX, routes::router(library))
}

impl Library {
    fn new(mut config: Config) -> Result<Arc<Self>> {
        let origin = plain_origin(&config.origin)?;
        let source_url = plain_origin(&config.source.base_url)?;
        if (origin.scheme() != "https" && !is_loopback(&origin))
            || (source_url.scheme() != "https" && !is_loopback(&source_url))
        {
            return Err(error(500, "invalid_config", "非回环地址必须使用 HTTPS"));
        }
        if config.source.instance_id.is_empty()
            || config.source.instance_id.len() > 128
            || config.source.auth.username.is_empty()
            || config.source.auth.salt.is_empty()
            || config.source.auth.token.len() != 32
            || config.cache_dir.as_os_str().is_empty()
            || !(1..=default_session_ttl()).contains(&config.session_ttl_seconds)
            || !(1..=default_task_ttl()).contains(&config.task_ttl_seconds)
        {
            return Err(internal());
        }
        config.origin = origin.origin().ascii_serialization();
        let policy: Policy =
            serde_json::from_slice(&std::fs::read(&config.policy_file).map_err(|_| internal())?)
                .map_err(|_| internal())?;
        validate_policy(&policy, &config.source.instance_id)?;
        let current = policy
            .tracks
            .iter()
            .map(|e| {
                disk::name(&representation_key(
                    &policy.instance_id,
                    &e.song_id,
                    &e.sha256,
                ))
            })
            .collect();
        let disk = disk::Disk::open(&config.cache_dir, config.cache_max_bytes, &current)?;
        config.cache_dir = disk.path("");
        let metrics_file = std::env::var_os("MUSIC_API_LIBRARY_METRICS_FILE").map(PathBuf::from);
        let mut http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20));
        // A configured loopback source must remain a direct connection. System
        // proxies can keep downloading after the caller has cancelled its body.
        if is_loopback(&source_url) {
            http = http.no_proxy();
        }
        let library = Arc::new(Self {
            authority: origin[url::Position::BeforeHost..url::Position::AfterPort].to_owned(),
            secure_cookie: origin.scheme() == "https",
            config,
            source_url,
            http: http.build().map_err(|_| internal())?,
            control: Mutex::new(Control::default()),
            downloads: Arc::new(Semaphore::new(PREPARATION_LIMIT)),
            preparation_changed: Notify::new(),
            logins: Semaphore::new(2),
            media: Arc::new(Semaphore::new(MEDIA_LIMIT)),
            metrics: Mutex::new(Counters::default()),
            metrics_file,
            metrics_write: Mutex::new(()),
            disk,
        });
        library.flush_metrics();
        Ok(library)
    }
    fn count(&self, update: impl FnOnce(&mut Counters)) {
        update(&mut self.metrics.lock().unwrap());
    }
    fn flush_metrics(&self) {
        let Some(file) = &self.metrics_file else {
            return;
        };
        let _guard = self.metrics_write.lock().unwrap();
        // A private diagnostic file is never used for an authorization decision.
        // Readers retry if they observe this short, synchronous replacement.
        let mut counters = self.metrics.lock().unwrap().clone();
        {
            let control = self.control.lock().unwrap();
            counters.task_slots = control.tasks.len();
            counters.active_tasks = control
                .tasks
                .values()
                .filter(|task| {
                    matches!(
                        task.progress.lock().unwrap().state,
                        State::Preparing | State::Ready
                    )
                })
                .count();
            counters.active_sessions = control.sessions.len();
            counters.active_jobs = control.jobs.len();
            counters.queued_preparations = control.pending.len();
        }
        counters.running_preparations = PREPARATION_LIMIT - self.downloads.available_permits();
        counters.active_media_responses = MEDIA_LIMIT - self.media.available_permits();
        self.disk.diagnostics(&mut counters);
        if let Ok(bytes) = serde_json::to_vec(&counters) {
            let _ = std::fs::write(file, bytes);
        }
    }
    fn current_files(&self, policy: &Policy) -> HashSet<String> {
        policy
            .tracks
            .iter()
            .map(|e| {
                disk::name(&representation_key(
                    &policy.instance_id,
                    &e.song_id,
                    &e.sha256,
                ))
            })
            .collect()
    }
    fn pinned_files(&self, control: &Control, current: &HashSet<String>) -> HashSet<String> {
        control
            .tasks
            .values()
            .filter(|task| {
                task.expires_at > now()
                    && matches!(
                        task.progress.lock().unwrap().state,
                        State::Preparing | State::Ready
                    )
            })
            .map(|task| disk::name(&task.key))
            .filter(|name| current.contains(name))
            .collect()
    }
    fn cancel_obsolete(&self, control: &mut Control, current: &HashSet<String>) {
        let obsolete: Vec<_> = control
            .tasks
            .values()
            .filter(|task| !current.contains(&disk::name(&task.key)))
            .map(|t| t.id.clone())
            .collect();
        for id in obsolete {
            // Retirement blocks new requests but preserves an already
            // authorized response's old bytes until its ordinary deadline.
            self.cancel_with_media_locked(control, &id, false);
        }
    }
    async fn reserve_file(&self, entry: &Entry, name: &str) -> Result<disk::Reservation> {
        let policy = self.policy().await?;
        let current = self.current_files(&policy);
        if !current.contains(name) {
            return Err(error(409, "version_changed", "曲目版本已变化，请重新搜索"));
        }
        // Control -> disk is the only nested lock order. Keep the task snapshot
        // stable until admission/eviction has finished; no awaits in this scope.
        let mut control = self.control.lock().unwrap();
        self.cancel_obsolete(&mut control, &current);
        let pinned = self.pinned_files(&control, &current);
        self.disk.reserve(name, entry.size, &current, &pinned)
    }
    async fn policy(&self) -> Result<Policy> {
        let size = tokio::fs::metadata(&self.config.policy_file)
            .await
            .map_err(|_| internal())?
            .len();
        if size > 1024 * 1024 {
            return Err(internal());
        }
        let policy = serde_json::from_slice(
            &tokio::fs::read(&self.config.policy_file)
                .await
                .map_err(|_| internal())?,
        )
        .map_err(|_| internal())?;
        validate_policy(&policy, &self.config.source.instance_id)?;
        Ok(policy)
    }
    fn cookie_name(&self) -> &'static str {
        if self.secure_cookie {
            SECURE_COOKIE
        } else {
            COOKIE
        }
    }
    fn cookie_path(&self) -> &'static str {
        // __Host- requires Secure, Path=/ and no Domain. A sibling origin
        // cannot plant a parent-domain session under this name.
        if self.secure_cookie { "/" } else { API_PREFIX }
    }
    fn session(&self, headers: &axum::http::HeaderMap) -> Option<Session> {
        let mut values = headers
            .get_all(axum::http::header::COOKIE)
            .iter()
            .filter_map(|header| header.to_str().ok())
            .flat_map(|header| header.split(';'))
            .filter_map(|part| {
                let (name, value) = part.trim().split_once('=')?;
                (name == self.cookie_name()).then_some(value)
            });
        let token = values.next()?;
        // Do not resolve cookie collisions by header or creation order, even
        // when one of the duplicate values is malformed or already expired.
        if values.next().is_some()
            || token.len() != 43
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        self.control
            .lock()
            .unwrap()
            .sessions
            .get(&hex_hash(token.as_bytes()))
            .filter(|s| s.expires_at > now())
            .cloned()
    }
    async fn local_authorize_session(
        &self,
        session_key: Option<&str>,
        selection: &Selection,
        task: Option<&Task>,
    ) -> Result<Authorization> {
        if selection.instance_id != self.config.source.instance_id {
            return Err(error(404, "instance_missing", "曲库实例不存在"));
        }
        let entry = self
            .policy()
            .await?
            .tracks
            .into_iter()
            .find(|e| e.song_id == selection.song_id)
            .ok_or(error(404, "track_missing", "曲目不存在"))?;
        // Resolve again after reading policy: a queued consumer's saved key is
        // not a durable grant, and another request may have revoked it.
        let session = session_key.and_then(|key| {
            self.control
                .lock()
                .unwrap()
                .sessions
                .get(key)
                .filter(|session| session.expires_at > now())
                .cloned()
        });
        if entry.access == Access::Restricted || task.is_some_and(|t| t.owner.is_some()) {
            let user = session
                .as_ref()
                .ok_or(error(401, "login_required", "请先登录"))?;
            if task
                .and_then(|t| t.owner.as_ref())
                .is_some_and(|owner| owner != &user.key)
            {
                return Err(error(403, "task_owner", "此播放任务属于另一个会话"));
            }
        }
        if !entry.permits(session.as_ref()) {
            return Err(error(403, "track_permission", "当前账号无法访问这首曲目"));
        }
        if selection.version != entry.sha256 {
            return Err(error(409, "version_changed", "曲目版本已变化，请重新搜索"));
        }
        let auth = match entry.access {
            Access::Public => self.config.source.auth.clone(),
            Access::Restricted => session
                .as_ref()
                .ok_or(error(401, "login_required", "请先登录"))?
                .auth
                .clone(),
        };
        Ok(Authorization {
            entry,
            session,
            auth,
        })
    }
    async fn authorize(
        &self,
        headers: &axum::http::HeaderMap,
        selection: &Selection,
        task: Option<&Task>,
    ) -> Result<Authorization> {
        let key = self.session(headers).map(|session| session.key);
        self.authorize_session(key.as_deref(), selection, task)
            .await
    }
    async fn authorize_session(
        &self,
        session_key: Option<&str>,
        selection: &Selection,
        task: Option<&Task>,
    ) -> Result<Authorization> {
        let before = self
            .local_authorize_session(session_key, selection, task)
            .await?;
        let song = self
            .subsonic("getSong", &before.auth, &[("id", &selection.song_id)])
            .await?;
        let song = &song["song"];
        if song["id"].as_str() != Some(&selection.song_id)
            || song["size"].as_u64() != Some(before.entry.size)
        {
            return Err(error(409, "source_changed", "原文件与当前清单不一致"));
        }
        let after = self
            .local_authorize_session(session_key, selection, task)
            .await?;
        // A public/private transition changes which upstream principal must be
        // checked. Never combine one principal's check with another's policy.
        if before.entry.access != after.entry.access || before.auth.username != after.auth.username
        {
            return Err(error(409, "policy_changed", "曲目权限已变化，请重试"));
        }
        Ok(after)
    }
    fn cancel_locked(&self, control: &mut Control, id: &str) {
        self.cancel_with_media_locked(control, id, true);
    }
    fn cancel_with_media_locked(&self, control: &mut Control, id: &str, stop_media: bool) {
        let Some(task) = control.tasks.get(id).cloned() else {
            return;
        };
        if stop_media {
            task.media_stop.cancel();
        }
        let mut progress = task.progress.lock().unwrap();
        if progress.state == State::Cancelled {
            return;
        }
        progress.state = State::Cancelled;
        drop(progress);
        self.count(|m| m.cancelled += 1);
        let mut remove_waiting = false;
        if let Some(job) = control.jobs.get_mut(&task.key) {
            job.consumers.remove(id);
            if job.consumers.is_empty() {
                job.cancel.cancel();
                remove_waiting = job.waiting;
            }
        }
        if remove_waiting {
            control.pending.remove(&task.key);
            control.jobs.remove(&task.key);
        }
        self.preparation_changed.notify_one();
    }
    fn revoke_locked(&self, control: &mut Control, key: &str) {
        if let Some(session) = control.sessions.remove(key) {
            // Response cancellation must outlive a bounded task tombstone.
            // A retired response may still be draining after that record was
            // reclaimed to admit another playback.
            session.revoked.cancel();
        }
        let ids: Vec<_> = control
            .tasks
            .values()
            .filter(|t| t.owner.as_deref() == Some(key))
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            self.cancel_locked(control, &id);
        }
    }
    fn cleanup(&self) {
        let mut control = self.control.lock().unwrap();
        let sessions: Vec<_> = control
            .sessions
            .values()
            .filter(|s| s.expires_at <= now())
            .map(|s| s.key.clone())
            .collect();
        for key in sessions {
            self.revoke_locked(&mut control, &key);
        }
        let ids: Vec<_> = control
            .tasks
            .values()
            .filter(|t| t.expires_at <= now())
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            self.cancel_locked(&mut control, &id);
            control.tasks.remove(&id);
        }
    }
}

fn plain_origin(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value).map_err(|_| internal())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(internal());
    }
    Ok(url)
}
fn is_loopback(url: &url::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
    })
}
fn validate_policy(policy: &Policy, instance: &str) -> Result<()> {
    if policy.instance_id != instance || policy.tracks.len() > 100 {
        return Err(internal());
    }
    let mut ids = HashSet::new();
    let mut total = 0;
    for e in &policy.tracks {
        if e.song_id.is_empty()
            || e.song_id.len() > 256
            || !ids.insert(&e.song_id)
            || e.size == 0
            || e.size > MAX_FILE
            || e.sha256.len() != 64
            || !e
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !matches!(
                (e.format.as_str(), e.content_type.as_str()),
                ("mp3", "audio/mpeg") | ("flac", "audio/flac")
            )
            || chrono::DateTime::parse_from_rfc3339(&e.modified_at).is_err()
            || e.title.len() > 2048
            || e.artist.len() > 2048
            || e.album.len() > 2048
            || e.track_number.is_some_and(|number| number > 9999)
            || e.year.is_some_and(|year| !(1000..=9999).contains(&year))
            || e.artwork.as_ref().is_some_and(|art| !artwork::valid(art))
        {
            return Err(internal());
        }
        total += e.size;
    }
    if total > 128 * 1024 * 1024 {
        return Err(internal());
    }
    Ok(())
}
fn component(value: &str) -> String {
    // Match JavaScript encodeURIComponent exactly at the shared cache boundary.
    urlencoding::encode(value)
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%2A", "*")
}
pub fn representation_key(instance: &str, song: &str, version: &str) -> String {
    format!(
        "library-lab:{}:{}:{}:raw",
        component(instance),
        component(song),
        component(version)
    )
}
fn hex_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn opaque<const N: usize>() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; N];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
