use super::*;
use axum::{
    http::{HeaderMap, HeaderValue},
    routing::post,
};

pub(super) fn policy(instance: &str) -> Policy {
    serde_json::from_value(json!({"instanceId":instance,"tracks":[{
        "songId":"song","title":"Generated","artist":"Test","duration":1000,
        "format":"flac","contentType":"audio/flac","size":4,"sha256":hex_hash(b"test"),
        "modifiedAt":"2026-01-01T00:00:00Z","access":"public","allowedUserIds":[]
    }]}))
    .unwrap()
}
pub(super) fn config(directory: &Path, source: String) -> Config {
    let policy_file = directory.join("policy.json");
    std::fs::write(
        &policy_file,
        serde_json::to_vec(&json!({"instanceId":"instance","tracks":[{
            "songId":"song","title":"Generated","artist":"Test","duration":1000,
            "format":"flac","contentType":"audio/flac","size":4,"sha256":hex_hash(b"test"),
            "modifiedAt":"2026-01-01T00:00:00Z","access":"public","allowedUserIds":[]
        }]}))
        .unwrap(),
    )
    .unwrap();
    Config {
        origin: "http://127.0.0.1:8001".into(),
        source: SourceConfig {
            instance_id: "instance".into(),
            base_url: source,
            auth: SourceAuth {
                username: "service".into(),
                salt: "fixture".into(),
                token: "0".repeat(32),
            },
        },
        policy_file,
        cache_dir: directory.join("cache"),
        artwork_dir: None,
        cache_max_bytes: default_cache_limit(),
        session_ttl_seconds: default_session_ttl(),
        task_ttl_seconds: default_task_ttl(),
    }
}

#[test]
fn representation_identity_matches_browser_encoding_and_separates_boundaries() {
    assert_eq!(
        representation_key("a:b", "音 乐/!()'", "v%"),
        "library-lab:a%3Ab:%E9%9F%B3%20%E4%B9%90%2F!()':v%25:raw"
    );
    assert_ne!(
        representation_key("a", "id", "v1"),
        representation_key("b", "id", "v1")
    );
    assert_ne!(
        representation_key("a", "id", "v1"),
        representation_key("a", "id", "v2")
    );
    assert_ne!(
        representation_key("a:b", "c", "v1"),
        representation_key("a", "b:c", "v1")
    );
}

#[test]
fn untrusted_origins_and_invalid_catalogues_fail_closed() {
    for url in [
        "file:///tmp/audio",
        "https://example.test/path",
        "https://example.test/?key=value",
        "https://name:secret@example.test",
        "https://example.test/#fragment",
    ] {
        assert!(plain_origin(url).is_err());
    }
    let mut value = policy("instance");
    assert!(validate_policy(&value, "another-instance").is_err());
    value.tracks.push(value.tracks[0].clone());
    assert!(validate_policy(&value, "instance").is_err());
    value.tracks.pop();
    value.tracks[0].size = MAX_FILE + 1;
    assert!(validate_policy(&value, "instance").is_err());
    value.tracks[0].size = 4;
    value.tracks[0].sha256 = "../not-a-digest".into();
    assert!(validate_policy(&value, "instance").is_err());
}

#[test]
fn subsonic_http_success_cannot_hide_protocol_failure() {
    for code in [10, 40, 50, 70, 0] {
        let failure = source::envelope(
            json!({"subsonic-response":{"status":"failed","error":{"code":code}}}),
        )
        .unwrap_err();
        assert!(!failure.status.is_success());
        if code == 40 {
            assert_eq!(failure.code, "source_auth");
        }
    }
    assert!(source::envelope(json!({"song":{"id":"fake"}})).is_err());
}

#[test]
fn ranges_cover_overflow_suffix_and_unsupported_multiple_ranges() {
    use routes::{ByteRange::*, byte_range};
    assert_eq!(byte_range("bytes=2-99", 10), Slice(2, 9));
    assert_eq!(byte_range("bytes=-3", 10), Slice(7, 9));
    assert_eq!(byte_range("bytes=-100", 10), Slice(0, 9));
    assert_eq!(byte_range("bytes=10-", 10), Unsatisfied);
    assert_eq!(byte_range("bytes=4-2", 10), Unsatisfied);
    assert_eq!(byte_range("bytes=-0", 10), Unsatisfied);
    assert_eq!(byte_range("bytes=18446744073709551616-", 10), Unsatisfied);
    assert_eq!(byte_range("bytes=0-2,5-8", 10), Ignore);
    assert_eq!(byte_range("bytes=abc-2", 10), Ignore);
}

#[tokio::test]
async fn secure_sessions_reject_unprefixed_and_ambiguous_cookies() {
    let directory = tempfile::tempdir().unwrap();
    let mut value = config(directory.path(), "http://127.0.0.1:9".into());
    value.origin = "https://music.example.test".into();
    let library = Library::new(value).unwrap();
    let token = opaque::<32>();
    let key = hex_hash(token.as_bytes());
    library.control.lock().unwrap().sessions.insert(
        key.clone(),
        Session {
            key,
            user: User {
                id: "a".into(),
                username: "a".into(),
            },
            auth: SourceAuth {
                username: "a".into(),
                salt: "test".into(),
                token: "0".repeat(32),
            },
            expires_at: now() + 60_000,
            revoked: CancellationToken::new(),
        },
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("{SECURE_COOKIE}={token}").parse().unwrap(),
    );
    assert_eq!(library.session(&headers).unwrap().user.id, "a");
    headers.insert("cookie", format!("{COOKIE}={token}").parse().unwrap());
    assert!(library.session(&headers).is_none());
    headers.insert(
        "cookie",
        format!("{SECURE_COOKIE}={token}; {SECURE_COOKIE}=invalid")
            .parse()
            .unwrap(),
    );
    assert!(library.session(&headers).is_none());
    headers.insert(
        "cookie",
        format!("{SECURE_COOKIE}={token}").parse().unwrap(),
    );
    headers.append(
        "cookie",
        format!("{SECURE_COOKIE}={token}").parse().unwrap(),
    );
    assert!(library.session(&headers).is_none());
}

#[tokio::test]
async fn a_policy_transition_during_metadata_io_cannot_borrow_the_service_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("policy.json");
    let change_path = path.clone();
    let upstream = Router::new().route(
        "/rest/getSong.view",
        post(move || {
            let path = change_path.clone();
            async move {
                let mut value: Value =
                    serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
                value["tracks"][0]["access"] = json!("restricted");
                value["tracks"][0]["allowedUserIds"] = json!(["a"]);
                tokio::fs::write(path, serde_json::to_vec(&value).unwrap())
                    .await
                    .unwrap();
                Json(json!({"subsonic-response":{"status":"ok","song":{"id":"song","size":4}}}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let library = Library::new(config(directory.path(), source)).unwrap();
    let token = opaque::<32>();
    let key = hex_hash(token.as_bytes());
    library.control.lock().unwrap().sessions.insert(
        key.clone(),
        Session {
            key,
            user: User {
                id: "a".into(),
                username: "a".into(),
            },
            auth: SourceAuth {
                username: "a".into(),
                salt: "fixture".into(),
                token: "0".repeat(32),
            },
            expires_at: now() + SESSION_MS,
            revoked: CancellationToken::new(),
        },
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::COOKIE,
        HeaderValue::from_str(&format!("{COOKIE}={token}")).unwrap(),
    );
    let result = library
        .authorize(
            &headers,
            &Selection {
                instance_id: "instance".into(),
                song_id: "song".into(),
                version: hex_hash(b"test"),
            },
            None,
        )
        .await;
    assert!(matches!(
        result,
        Err(Error {
            code: "policy_changed",
            ..
        })
    ));
    assert_eq!(library.metrics.lock().unwrap().media_opens, 0);
    assert_eq!(library.metrics.lock().unwrap().source_downloads, 0);
    server.abort();
}

#[tokio::test]
async fn absent_config_registers_no_library_routes() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server =
        tokio::spawn(async move { axum::serve(listener, configured_router("")).await.unwrap() });
    let response = reqwest::get(format!("{origin}{API_PREFIX}/session"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    server.abort();
}

#[test]
fn cache_directory_lock_is_exclusive_and_released_with_its_owner() {
    let dir = tempfile::tempdir().unwrap();
    let current = HashSet::new();
    let first = disk::Disk::open(dir.path(), 10, &current).unwrap();
    assert!(disk::Disk::open(dir.path(), 10, &current).is_err());
    drop(first);
    assert!(disk::Disk::open(dir.path(), 10, &current).is_ok());
}

#[test]
fn crash_recovery_only_removes_owned_regular_files() {
    let dir = tempfile::tempdir().unwrap();
    let partial = format!("{}.{}.partial", "a".repeat(64), "b".repeat(16));
    std::fs::write(dir.path().join(&partial), b"incomplete").unwrap();
    std::fs::write(dir.path().join("user.partial"), b"keep").unwrap();
    let nested = dir.path().join(format!("{}.audio", "c".repeat(64)));
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join("keep"), b"keep").unwrap();
    let _disk = disk::Disk::open(dir.path(), 10, &HashSet::new()).unwrap();
    assert!(!dir.path().join(partial).exists());
    assert_eq!(
        std::fs::read(dir.path().join("user.partial")).unwrap(),
        b"keep"
    );
    assert_eq!(std::fs::read(nested.join("keep")).unwrap(), b"keep");
}

#[test]
fn an_open_response_lease_survives_version_retirement_and_quota_pressure() {
    let dir = tempfile::tempdir().unwrap();
    let name = disk::name("v1");
    std::fs::write(dir.path().join(&name), b"original").unwrap();
    let disk = disk::Disk::open(dir.path(), 8, &HashSet::from([name.clone()])).unwrap();
    let reader = disk.lease(&name);
    let current = HashSet::from([disk::name("v2")]);
    disk.maintain(&current, &HashSet::new()).unwrap();
    assert!(matches!(
        disk.reserve(&disk::name("v2"), 8, &current, &HashSet::new()),
        Err(Error {
            code: "cache_capacity",
            ..
        })
    ));
    assert_eq!(std::fs::read(dir.path().join(&name)).unwrap(), b"original");
    drop(reader);
    disk.maintain(&current, &HashSet::new()).unwrap();
    assert!(!dir.path().join(&name).exists());
    assert!(
        disk.reserve(&disk::name("v2"), 8, &current, &HashSet::new())
            .is_ok()
    );
}

#[test]
fn reservations_protect_future_bytes_and_cancel_without_leaking_space() {
    let dir = tempfile::tempdir().unwrap();
    let disk = disk::Disk::open(dir.path(), 10, &HashSet::new()).unwrap();
    let a = disk
        .reserve(&disk::name("a"), 7, &HashSet::new(), &HashSet::new())
        .unwrap();
    assert!(
        disk.reserve(&disk::name("b"), 4, &HashSet::new(), &HashSet::new())
            .is_err()
    );
    drop(a);
    assert!(
        disk.reserve(&disk::name("b"), 10, &HashSet::new(), &HashSet::new())
            .is_ok()
    );
}

#[tokio::test]
async fn lifetime_configuration_is_bounded_and_typo_safe() {
    let directory = tempfile::tempdir().unwrap();
    for seconds in [0, default_session_ttl() + 1, u64::MAX] {
        let mut value = config(directory.path(), "http://127.0.0.1:9".into());
        value.session_ttl_seconds = seconds;
        assert!(Library::new(value).is_err());
    }
    for seconds in [0, default_task_ttl() + 1, u64::MAX] {
        let mut value = config(directory.path(), "http://127.0.0.1:9".into());
        value.task_ttl_seconds = seconds;
        assert!(Library::new(value).is_err());
    }
    let value = json!({
        "origin":"http://127.0.0.1:8001",
        "source":{"instanceId":"instance","baseUrl":"http://127.0.0.1:9", "auth":{"username":"test","salt":"test","token":"00000000000000000000000000000000"}},
        "policyFile":"policy.json", "cacheDir":"cache", "sessionTtlSecond":12
    });
    assert!(serde_json::from_value::<Config>(value).is_err());
}

#[tokio::test]
async fn expiry_between_authorization_and_admission_cannot_start_a_private_job() {
    let directory = tempfile::tempdir().unwrap();
    let library = Library::new(config(directory.path(), "http://127.0.0.1:9".into())).unwrap();
    let session = Session {
        key: "expired".into(),
        user: User {
            id: "a".into(),
            username: "a".into(),
        },
        auth: SourceAuth {
            username: "a".into(),
            salt: "test".into(),
            token: "0".repeat(32),
        },
        expires_at: now().saturating_sub(1),
        revoked: CancellationToken::new(),
    };
    library
        .control
        .lock()
        .unwrap()
        .sessions
        .insert(session.key.clone(), session.clone());
    let mut entry = policy("instance").tracks.remove(0);
    entry.access = Access::Restricted;
    let result = library.begin_task(entry, Some(session));
    assert!(matches!(
        result,
        Err(Error {
            code: "login_required",
            ..
        })
    ));
    let control = library.control.lock().unwrap();
    assert!(control.tasks.is_empty() && control.jobs.is_empty());
}

#[tokio::test]
async fn retirement_preserves_a_response_but_later_logout_still_cancels_it() {
    let directory = tempfile::tempdir().unwrap();
    let library = Library::new(config(directory.path(), "http://127.0.0.1:9".into())).unwrap();
    let task = Arc::new(Task {
        id: "active".into(),
        key: "old-version".into(),
        selection: policy("instance").tracks[0].selection("instance"),
        owner: Some("a-session".into()),
        expires_at: now() + 60_000,
        progress: Mutex::new(Progress {
            state: State::Ready,
            file: None,
            error: None,
        }),
        media_stop: CancellationToken::new(),
    });
    let mut control = library.control.lock().unwrap();
    control.tasks.insert(task.id.clone(), task.clone());
    library.cancel_with_media_locked(&mut control, &task.id, false);
    assert!(!task.media_stop.is_cancelled());
    assert!(task.progress.lock().unwrap().state == State::Cancelled);
    library.revoke_locked(&mut control, "a-session");
    assert!(task.media_stop.is_cancelled());
}

#[tokio::test]
async fn session_revocation_reaches_a_retired_response_after_task_record_reclamation() {
    let directory = tempfile::tempdir().unwrap();
    let library = Library::new(config(directory.path(), "http://127.0.0.1:9".into())).unwrap();
    let revoked = CancellationToken::new();
    let response = revoked.child_token();
    let session = Session {
        key: "active-session".into(),
        user: User {
            id: "a".into(),
            username: "a".into(),
        },
        auth: SourceAuth {
            username: "a".into(),
            salt: "test".into(),
            token: "0".repeat(32),
        },
        expires_at: now() + 60_000,
        revoked,
    };
    let mut control = library.control.lock().unwrap();
    control.sessions.insert(session.key.clone(), session);
    // The media response keeps the child token even when no task is retained.
    assert!(control.tasks.is_empty());
    assert!(!response.is_cancelled());
    library.revoke_locked(&mut control, "active-session");
    assert!(response.is_cancelled());
    assert!(control.sessions.is_empty());
}
