use super::*;
use axum::{
    Extension,
    body::Body,
    extract::{
        DefaultBodyLimit, Path as RoutePath, Query, Request, State as AppState,
        rejection::JsonRejection,
    },
    http::{HeaderMap, HeaderValue, Method, header},
    middleware::{self, Next},
    routing::{get, post},
};
use futures::StreamExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

pub(super) fn router(library: Arc<Library>) -> Router {
    Router::new()
        .route("/session", get(session).post(login).delete(logout))
        .route("/search", get(search))
        .route("/artwork/:song", get(artwork))
        .route("/tasks", post(create_task))
        .route("/tasks/:id", get(task).delete(cancel))
        .route("/tasks/:id/audio", get(media))
        .fallback(|| async { error(404, "route_missing", "接口不存在") })
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::from_fn_with_state(library.clone(), boundary))
        .with_state(library)
}

async fn boundary(
    AppState(library): AppState<Arc<Library>>,
    request: Request,
    next: Next,
) -> Response {
    library.cleanup();
    let headers = request.headers();
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
    let read = matches!(*request.method(), Method::GET | Method::HEAD);
    let allowed = header("host") == Some(library.authority.as_str())
        && header("sec-fetch-site").is_none_or(|v| matches!(v, "same-origin" | "none"))
        && header("origin").is_none_or(|v| v == library.config.origin)
        && (read
            || (header("origin") == Some(library.config.origin.as_str())
                && header(CLIENT_HEADER) == Some("1")));
    let mut response = if allowed {
        next.run(request).await
    } else {
        error(403, "origin_denied", "请求来源不受支持").into_response()
    };
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        library.count(|m| m.denied += 1);
    }
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.append(header::VARY, HeaderValue::from_static("Cookie"));
    library.flush_metrics();
    response
}

async fn session(AppState(library): AppState<Arc<Library>>, headers: HeaderMap) -> Json<Value> {
    Json(
        json!({"instanceId":library.config.source.instance_id, "user":library.session(&headers).map(|s| s.user)}),
    )
}
#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeIdentity {
    id: String,
    username: String,
    subsonic_salt: String,
    subsonic_token: String,
}
fn input<T>(value: std::result::Result<Json<T>, JsonRejection>) -> Result<T> {
    value
        .map(|j| j.0)
        .map_err(|_| error(400, "invalid_json", "请求格式无效"))
}
fn cookie(library: &Library, token: &str, age: u64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{}={token}; HttpOnly; SameSite=Strict; Path={}; Max-Age={age}{}",
        library.cookie_name(),
        library.cookie_path(),
        if library.secure_cookie {
            "; Secure"
        } else {
            ""
        }
    ))
    .unwrap()
}
async fn login(
    AppState(library): AppState<Arc<Library>>,
    headers: HeaderMap,
    body: std::result::Result<Json<Credentials>, JsonRejection>,
) -> Result<Response> {
    let value = input(body)?;
    if value.username.is_empty()
        || value.username.len() > 128
        || value.password.is_empty()
        || value.password.len() > 1024
    {
        return Err(error(400, "credentials_required", "请输入账号和密码"));
    }
    let _permit = library
        .logins
        .try_acquire()
        .map_err(|_| error(429, "session_limit", "请稍后重试登录"))?;
    let response = library
        .http
        .post(
            library
                .source_url
                .join("/auth/login")
                .map_err(|_| internal())?,
        )
        .json(&json!({"username":value.username,"password":value.password}))
        .send()
        .await
        .map_err(|_| error(502, "source_unavailable", "暂时无法连接曲库"))?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err(error(
            429,
            "login_rate_limit",
            "曲库限制了登录频率，请稍后重试",
        ));
    }
    if !response.status().is_success() {
        return Err(error(401, "login_failed", "账号或密码不正确"));
    }
    let identity: NativeIdentity =
        serde_json::from_value(source::bounded_json(response, 65536).await?)
            .map_err(|_| error(502, "source_protocol", "曲库身份响应无效"))?;
    if identity.id.is_empty()
        || identity.username.is_empty()
        || identity.subsonic_salt.is_empty()
        || identity.subsonic_token.len() != 32
    {
        return Err(error(502, "source_protocol", "曲库身份响应无效"));
    }
    let token = opaque::<32>();
    let user = User {
        id: identity.id,
        username: identity.username,
    };
    let next = Session {
        key: hex_hash(token.as_bytes()),
        user: user.clone(),
        expires_at: now() + library.config.session_ttl_seconds * 1000,
        revoked: CancellationToken::new(),
        auth: SourceAuth {
            username: user.username.clone(),
            salt: identity.subsonic_salt,
            token: identity.subsonic_token,
        },
    };
    let previous = library.session(&headers);
    let mut control = library.control.lock().unwrap();
    if control.sessions.len() >= 64 {
        return Err(error(429, "session_limit", "登录会话已满，请稍后重试"));
    }
    if let Some(previous) = previous {
        library.revoke_locked(&mut control, &previous.key);
    }
    control.sessions.insert(next.key.clone(), next);
    let mut response =
        Json(json!({"instanceId":library.config.source.instance_id,"user":user})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie(&library, &token, library.config.session_ttl_seconds),
    );
    Ok(response)
}
async fn logout(AppState(library): AppState<Arc<Library>>, headers: HeaderMap) -> Response {
    if let Some(session) = library.session(&headers) {
        library.revoke_locked(&mut library.control.lock().unwrap(), &session.key);
    }
    let mut response = Json(json!({"user":null})).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, cookie(&library, "", 0));
    response
}
#[derive(Deserialize)]
struct Search {
    #[serde(default)]
    q: String,
}
async fn search(
    AppState(library): AppState<Arc<Library>>,
    headers: HeaderMap,
    Query(query): Query<Search>,
) -> Result<Json<Value>> {
    if query.q.len() > 800 {
        return Err(error(400, "query_too_long", "搜索文字过长"));
    }
    let session = library.session(&headers);
    let auth = session
        .as_ref()
        .map(|s| &s.auth)
        .unwrap_or(&library.config.source.auth);
    let result = library
        .subsonic(
            "search3",
            auth,
            &[
                ("query", if query.q.is_empty() { "\"\"" } else { &query.q }),
                ("songCount", "500"),
                ("albumCount", "0"),
                ("artistCount", "0"),
            ],
        )
        .await?;
    let ids: HashSet<_> = result["searchResult3"]["song"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["id"].as_str())
        .collect();
    let policy = library.policy().await?;
    let current = library.session(&headers);
    let tracks: Vec<_> = policy
        .tracks
        .iter()
        .filter(|e| ids.contains(e.song_id.as_str()) && e.permits(current.as_ref()))
        .map(|e| e.public(&library.config.source.instance_id))
        .collect();
    Ok(Json(
        json!({"instanceId":library.config.source.instance_id,"tracks":tracks}),
    ))
}
async fn create_task(
    AppState(library): AppState<Arc<Library>>,
    headers: HeaderMap,
    body: std::result::Result<Json<Selection>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>)> {
    let selection = input(body)?;
    let allowed = library.authorize(&headers, &selection, None).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(library.begin_task(allowed.entry, allowed.session)?),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtworkQuery {
    instance_id: String,
    version: String,
}
async fn artwork(
    AppState(library): AppState<Arc<Library>>,
    headers: HeaderMap,
    RoutePath(song_id): RoutePath<String>,
    Query(query): Query<ArtworkQuery>,
) -> Result<Response> {
    let selection = Selection {
        instance_id: query.instance_id,
        song_id,
        version: query.version,
    };
    let allowed = library.authorize(&headers, &selection, None).await?;
    let bytes = library.artwork_bytes(&allowed.entry).await?;
    // A logout or policy edit during file I/O must still reject the response.
    let current = library
        .local_authorize_session(
            allowed.session.as_ref().map(|session| session.key.as_str()),
            &selection,
            None,
        )
        .await?;
    if current.entry.artwork.as_ref().map(|art| &art.sha256)
        != allowed.entry.artwork.as_ref().map(|art| &art.sha256)
        || current.entry.access != allowed.entry.access
    {
        return Err(error(409, "policy_changed", "封面权限或版本已变化"));
    }
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}
fn find_task(library: &Library, id: &str) -> Result<Arc<Task>> {
    library
        .control
        .lock()
        .unwrap()
        .tasks
        .get(id)
        .cloned()
        .ok_or(error(404, "task_missing", "播放任务不存在或已过期"))
}
async fn task(
    AppState(library): AppState<Arc<Library>>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    let task = find_task(&library, &id)?;
    let allowed = library
        .authorize(&headers, &task.selection, Some(&task))
        .await?;
    Ok(Json(task.public(&allowed.entry)))
}
async fn cancel(
    AppState(library): AppState<Arc<Library>>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    let task = find_task(&library, &id)?;
    library
        .authorize(&headers, &task.selection, Some(&task))
        .await?;
    library.cancel_locked(&mut library.control.lock().unwrap(), &id);
    Ok(Json(json!({"state":"cancelled"})))
}
fn value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}
fn matches_etag(value: &str, etag: &str, weak: bool) -> bool {
    value.split(',').map(str::trim).any(|tag| {
        tag == "*"
            || (if weak {
                tag.strip_prefix("W/").unwrap_or(tag)
            } else {
                tag
            }) == etag
    })
}
fn http_date(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|d| d.timestamp())
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ByteRange {
    Ignore,
    Unsatisfied,
    Slice(u64, u64),
}
pub(super) fn byte_range(value: &str, size: u64) -> ByteRange {
    let Some((unit, spec)) = value.split_once('=') else {
        return ByteRange::Ignore;
    };
    if !unit.eq_ignore_ascii_case("bytes") || spec.contains(',') {
        return ByteRange::Ignore;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return ByteRange::Ignore;
    };
    if (first.is_empty() && last.is_empty())
        || !first
            .bytes()
            .chain(last.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return ByteRange::Ignore;
    }
    if first.is_empty() {
        return match last.parse::<u64>() {
            Ok(0) | Err(_) => ByteRange::Unsatisfied,
            Ok(suffix) => ByteRange::Slice(size.saturating_sub(suffix), size - 1),
        };
    }
    let Ok(start) = first.parse::<u64>() else {
        return ByteRange::Unsatisfied;
    };
    let end = if last.is_empty() {
        size - 1
    } else {
        match last.parse::<u64>() {
            Ok(v) => v.min(size - 1),
            Err(_) => return ByteRange::Unsatisfied,
        }
    };
    if start >= size || start > end {
        ByteRange::Unsatisfied
    } else {
        ByteRange::Slice(start, end)
    }
}
async fn media(
    AppState(library): AppState<Arc<Library>>,
    connection: Option<Extension<transport::ConnectionControl>>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
    method: Method,
) -> Result<Response> {
    let task = find_task(&library, &id)?;
    let entry = library
        .authorize(&headers, &task.selection, Some(&task))
        .await?
        .entry;
    let file = {
        let progress = task.progress.lock().unwrap();
        if progress.state != State::Ready {
            return Err(error(409, "task_not_ready", "音频尚未就绪"));
        }
        progress.file.clone().ok_or(internal())?
    };
    let etag = format!("\"{}\"", entry.sha256);
    let modified = chrono::DateTime::parse_from_rfc3339(&entry.modified_at)
        .map_err(|_| internal())?
        .timestamp();
    let last_modified = chrono::DateTime::from_timestamp(modified, 0)
        .ok_or(internal())?
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let mut builder = axum::http::Response::builder()
        .header(header::CONTENT_TYPE, &entry.content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, &etag)
        .header(header::LAST_MODIFIED, last_modified);
    // All representation metadata and conditions are reached only after auth.
    let if_match = value(&headers, "if-match");
    if if_match.is_some_and(|v| !matches_etag(v, &etag, false))
        || (if_match.is_none()
            && value(&headers, "if-unmodified-since")
                .and_then(http_date)
                .is_some_and(|v| v < modified))
    {
        return builder
            .status(412)
            .body(Body::empty())
            .map_err(|_| internal());
    }
    let not_modified = if let Some(v) = value(&headers, "if-none-match") {
        matches_etag(v, &etag, true)
    } else {
        value(&headers, "if-modified-since")
            .and_then(http_date)
            .is_some_and(|v| v >= modified)
    };
    if not_modified {
        return builder
            .status(304)
            .body(Body::empty())
            .map_err(|_| internal());
    }
    let if_range = value(&headers, "if-range");
    let range = if method == Method::GET
        && if_range.is_none_or(|v| v == etag || http_date(v) == Some(modified))
    {
        value(&headers, "range")
            .map(|v| byte_range(v, entry.size))
            .unwrap_or(ByteRange::Ignore)
    } else {
        ByteRange::Ignore
    };
    let (start, end) = match range {
        ByteRange::Unsatisfied => {
            return builder
                .status(416)
                .header(header::CONTENT_RANGE, format!("bytes */{}", entry.size))
                .body(Body::empty())
                .map_err(|_| internal());
        }
        ByteRange::Slice(start, end) => {
            builder = builder.status(206).header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{}", entry.size),
            );
            (start, end)
        }
        ByteRange::Ignore => (0, entry.size - 1),
    };
    builder = builder.header(header::CONTENT_LENGTH, end - start + 1);
    if method == Method::HEAD {
        return builder.body(Body::empty()).map_err(|_| internal());
    }
    let permit = library
        .media
        .clone()
        .try_acquire_owned()
        .map_err(|_| error(429, "media_limit", "同时播放连接已满，请稍后重试"))?;
    let lease = library.disk.lease(&disk::name(&task.key));
    let mut input = tokio::fs::File::open(file)
        .await
        .map_err(|_| error(409, "cache_changed", "缓存文件已变化，请重新创建任务"))?;
    library.count(|m| m.media_opens += 1);
    if input.metadata().await.map_err(|_| internal())?.len() != entry.size {
        return Err(error(
            409,
            "cache_changed",
            "缓存文件已变化，请重新创建任务",
        ));
    }
    input
        .seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|_| internal())?;
    library.disk.touch(&disk::name(&task.key));
    let done = CancellationToken::new();
    let guard = MediaGuard {
        done: done.clone(),
        _permit: permit,
        _lease: lease,
    };
    let deadline =
        tokio::time::Instant::now() + Duration::from_millis(task.expires_at.saturating_sub(now()));
    let cancelled = task.media_stop.clone();
    if let Some(Extension(connection)) = connection {
        let completed = done.clone();
        let cancelled = cancelled.clone();
        let library = Arc::downgrade(&library);
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = completed.cancelled() => return,
                _ = cancelled.cancelled() => {},
                _ = tokio::time::sleep_until(deadline) => {},
            }
            // The transport may be waiting on a full TCP send buffer and no
            // longer polling this response body. Close its HTTP/1 connection
            // from here so the file/permit are still released promptly.
            connection.abort.cancel();
            if let Some(library) = library.upgrade() {
                library.count(|metrics| metrics.interrupted_media += 1);
            }
        });
    }
    let interrupted = async move {
        tokio::select! {
            _ = cancelled.cancelled() => {},
            _ = tokio::time::sleep_until(deadline) => {},
        }
    };
    builder
        .body(Body::from_stream(
            ReaderStream::with_capacity(input.take(end - start + 1), 65536)
                .take_until(interrupted)
                .map(move |chunk| {
                    // The lease belongs to the response body, including while the
                    // client applies backpressure. Dropping the body releases it.
                    let _keep_alive = &guard;
                    chunk
                }),
        ))
        .map_err(|_| internal())
}

struct MediaGuard {
    done: CancellationToken,
    _permit: tokio::sync::OwnedSemaphorePermit,
    _lease: disk::Lease,
}
impl Drop for MediaGuard {
    fn drop(&mut self) {
        self.done.cancel();
    }
}
