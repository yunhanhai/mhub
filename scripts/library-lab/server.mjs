/**
 * Loopback-only Navidrome contract experiment, not the MHub Rust backend.
 * Run: node scripts/library-lab/server.mjs /absolute/private/config.json
 * Configuration, credentials, policy, audio and reports belong outside this repo.
 */
import http from 'node:http';
import { readFile, mkdir, open, stat, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { representationKey } from './identity.mjs';
import { html } from './shell.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(directory, '../../frontend');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const COOKIE = 'mhub_lab_session';
const MAX_FILE = 32 * 1024 * 1024;
const SESSION_MS = 60 * 60 * 1000;
const TASK_MS = 15 * 60 * 1000;

class Failure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new Failure(status, code, message); };
async function readJson(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
async function boundedBytes(body, maximum) {
  const chunks = []; let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > maximum) fail(502, 'source_too_large', '响应超过此实验允许的大小');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail(502, 'source_protocol', '曲库返回了无法识别的数据'); }
}
function protocolFailure(body) {
  const envelope = body?.['subsonic-response'];
  if (!envelope || envelope.status !== 'ok') {
    const code = Number(envelope?.error?.code);
    if ([10, 40].includes(code)) fail(401, 'source_auth', '曲库身份已失效，请重新登录');
    if (code === 50) fail(403, 'source_permission', '曲库拒绝访问');
    if (code === 70) fail(404, 'source_missing', '曲库中没有这首曲目');
    fail(502, 'source_protocol', '曲库协议请求失败');
  }
  return envelope;
}
function selector(track) { return { instanceId: track.instanceId, songId: track.songId, version: track.version }; }
function publicTrack(entry, instanceId) {
  const key = representationKey(instanceId, entry.songId, entry.sha256);
  return { ...selector({ instanceId, songId: entry.songId, version: entry.sha256 }), id: key, source_id: key,
    platform: 'navidrome', quality: 'raw', title: entry.title, artist: entry.artist,
    duration: entry.duration, format: entry.format, content_type: entry.contentType,
    byte_size: entry.size, access: entry.access, offlineAllowed: entry.access === 'public', streaming_mode: '' };
}
// RFC 9110 permits ignoring unsupported/malformed ranges. Only one byte range
// is supported here; a syntactically valid but unsatisfiable one returns 416.
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header || '');
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]), second = Number(match[2]);
  if (![first, second].every(Number.isSafeInteger)) return { unsatisfied: true };
  const start = match[1] ? first : Math.max(0, size - second);
  const end = match[1] && match[2] ? Math.min(second, size - 1) : size - 1;
  return start >= size || start > end || (!match[1] && second === 0) ? { unsatisfied: true } : { start, end };
}

export async function createLibraryLab(config, { ui = true } = {}) {
  const source = new URL(config.source.baseUrl);
  if (config.host !== '127.0.0.1' || source.protocol !== 'http:' || source.hostname !== '127.0.0.1' || source.username || source.password || source.pathname !== '/' || source.search || source.hash) {
    throw new Error('This experiment accepts only a configured loopback source and listener.');
  }
  if (!config.source.instanceId || !config.policyFile || !config.cacheDir) throw new Error('Incomplete private config');
  await mkdir(config.cacheDir, { recursive: true });
  const sessions = new Map(), tasks = new Map(), jobs = new Map();
  const metrics = { sourceRequests: 0, protocolFailures: 0, sourceDownloads: 0, cacheHits: 0, cacheMisses: 0, cacheValidations: 0, mediaOpens: 0, bytesServed: 0, denied: 0, cancelled: 0 };
  let bundle = '', origin, nativeLogins = 0;
  if (ui) {
    const require = createRequire(path.join(frontend, 'package.json'));
    const result = await require('esbuild').build({ entryPoints: [path.join(directory, 'client.mjs')], nodePaths: [path.join(frontend, 'node_modules')], bundle: true, write: false, format: 'iife', minify: false });
    bundle = result.outputFiles[0].text;
  }
  async function policy() {
    const value = await readJson(config.policyFile);
    if (value.instanceId !== config.source.instanceId || !Array.isArray(value.tracks) || value.tracks.length > 100) throw new Error('Invalid trusted catalogue');
    const ids = new Set(); let total = 0;
    for (const item of value.tracks) {
      if (typeof item.songId !== 'string' || ids.has(item.songId) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_FILE || !['public', 'restricted'].includes(item.access) || !Array.isArray(item.allowedUserIds) || !['audio/mpeg', 'audio/flac'].includes(item.contentType) || !Number.isFinite(Date.parse(item.modifiedAt))) throw new Error('Invalid trusted catalogue entry');
      ids.add(item.songId); total += item.size;
    }
    if (total > 128 * 1024 * 1024) throw new Error('Catalogue exceeds the experiment disk budget');
    return value;
  }
  await policy();
  async function sourceFetch(method, auth, params = {}, signal) {
    metrics.sourceRequests++;
    try {
      return await fetch(new URL('/rest/' + method + '.view', source), {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ v: '1.16.1', c: 'mhub-library-lab', f: 'json', u: auth.username, s: auth.salt, t: auth.token, ...params }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(10000),
      });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      fail(502, 'source_unavailable', '暂时无法连接曲库');
    }
  }
  async function subsonic(method, auth, params) {
    const response = await sourceFetch(method, auth, params);
    if (!response.ok) { await response.body?.cancel(); fail(502, 'source_http', '曲库 HTTP 请求失败'); }
    try { return protocolFailure(parseJson(await boundedBytes(response.body, 1024 * 1024))); }
    catch (e) { metrics.protocolFailures++; throw e; }
  }
  function session(request) {
    const id = /(?:^|;\s*)mhub_lab_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const value = sessions.get(id);
    return value && value.expiresAt > Date.now() ? { id, ...value } : null;
  }
  const permitted = (entry, user) => entry.access === 'public' || Boolean(user && entry.allowedUserIds.includes(user.userId));
  async function localAuthorization(request, wanted, task) {
    if (wanted?.instanceId !== config.source.instanceId) fail(404, 'instance_missing', '曲库实例不存在');
    const entry = (await policy()).tracks.find(t => t.songId === wanted.songId);
    if (!entry) fail(404, 'track_missing', '曲目不存在');
    const user = session(request);
    // Scope belongs to the task as well as the current catalogue. Publishing a
    // previously restricted song must not make its old private task transferable.
    if (entry.access === 'restricted' || task?.ownerSessionId) {
      if (!user) fail(401, 'login_required', '请先登录');
      if (task?.ownerSessionId && task.ownerSessionId !== user.id) fail(403, 'task_owner', '此播放任务属于另一个会话');
    }
    if (!permitted(entry, user)) fail(403, 'track_permission', '当前账号无法访问这首曲目');
    if (wanted.version !== entry.sha256) fail(409, 'version_changed', '曲目版本已变化，请重新搜索');
    return { entry, user, auth: entry.access === 'public' ? config.source.auth : user.auth };
  }
  async function authorize(request, wanted, task) {
    const allowed = await localAuthorization(request, wanted, task);
    const original = (await subsonic('getSong', allowed.auth, { id: wanted.songId })).song;
    if (original?.id !== wanted.songId || Number(original.size) !== allowed.entry.size) fail(409, 'source_changed', '原文件与当前清单不一致');
    // Recheck logout and policy changes that happened during upstream I/O.
    return localAuthorization(request, wanted, task);
  }
  async function cacheFile(entry, auth, signal) {
    const key = representationKey(config.source.instanceId, entry.songId, entry.sha256);
    const file = path.join(config.cacheDir, sha256(key) + '.audio');
    let found = false;
    try { found = (await stat(file)).isFile(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (found) {
      metrics.cacheValidations++;
      // This bounded experiment hashes existing files too, rather than trusting
      // a filename or accepting a partially written file after a restart.
      const info = await stat(file);
      if (info.size === entry.size && sha256(await readFile(file)) === entry.sha256) { metrics.cacheHits++; return file; }
      await unlink(file);
    }
    signal.throwIfAborted(); metrics.cacheMisses++;
    const response = await sourceFetch('stream', auth, { id: entry.songId, format: 'raw' }, signal);
    if (/json|xml|text\//i.test(response.headers.get('content-type') || '')) {
      metrics.protocolFailures++;
      protocolFailure(parseJson(await boundedBytes(response.body, 65536)));
      fail(502, 'source_media', '曲库返回了非音频数据');
    }
    if (response.status !== 200) { await response.body?.cancel(); fail(502, 'source_media', '原文件下载失败'); }
    const length = response.headers.get('content-length');
    if (length && Number(length) !== entry.size) { await response.body.cancel(); fail(409, 'source_changed', '原文件大小已变化'); }
    metrics.sourceDownloads++;
    const partial = file + '.' + randomBytes(8).toString('hex') + '.partial';
    const handle = await open(partial, 'wx', 0o600); let size = 0; const hash = createHash('sha256');
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > entry.size) fail(409, 'source_changed', '原文件超过清单大小');
        hash.update(chunk); await handle.writeFile(chunk);
      }
      signal.throwIfAborted();
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) fail(409, 'integrity_failed', '原文件校验失败');
      await handle.close();
      await rename(partial, file);
      return file;
    } finally { await handle.close().catch(() => {}); await unlink(partial).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  function cancelTask(task) {
    if (task.state === 'cancelled') return;
    task.state = 'cancelled'; metrics.cancelled++;
    const job = jobs.get(task.key);
    job?.consumers.delete(task.id);
    if (job && job.consumers.size === 0) job.controller.abort();
  }
  function revokeSession(id) {
    sessions.delete(id);
    for (const task of tasks.values()) if (task.ownerSessionId === id) cancelTask(task);
  }
  function cleanup() {
    for (const [id, user] of sessions) if (user.expiresAt <= Date.now()) revokeSession(id);
    for (const [id, task] of tasks) if (task.expiresAt <= Date.now()) { cancelTask(task); tasks.delete(id); }
  }
  function beginTask(entry, user, auth) {
    if (tasks.size >= 256) fail(429, 'task_limit', '此实验的播放任务已满');
    const key = representationKey(config.source.instanceId, entry.songId, entry.sha256);
    let job = jobs.get(key);
    if (!job && jobs.size >= 2) fail(429, 'download_limit', '正在准备其他曲目，请稍后重试');
    const task = { id: randomBytes(24).toString('base64url'), key, instanceId: config.source.instanceId, songId: entry.songId, version: entry.sha256,
      ownerSessionId: entry.access === 'restricted' ? user.id : null, state: 'preparing', expiresAt: Date.now() + TASK_MS };
    tasks.set(task.id, task);
    if (!job) {
      const controller = new AbortController();
      job = { controller, consumers: new Set(), promise: cacheFile(entry, auth, controller.signal) };
      jobs.set(key, job);
      void job.promise.finally(() => { if (jobs.get(key) === job) jobs.delete(key); }).catch(() => {});
    }
    job.consumers.add(task.id);
    void job.promise.then(file => {
      if (task.state === 'preparing') { task.file = file; task.state = 'ready'; }
    }, error => {
      if (task.state !== 'cancelled') { task.state = 'failed'; task.error = error instanceof Failure ? error.code : 'source_unavailable'; }
    }).finally(() => job.consumers.delete(task.id));
    return task;
  }
  function taskView(task, entry) {
    return { id: task.id, state: task.state, error: task.error, expiresAt: task.expiresAt,
      track: publicTrack(entry, config.source.instanceId), mediaUrl: '/api/tasks/' + task.id + '/audio' };
  }
  function json(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
  }
  async function body(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) fail(415, 'json_required', '需要 JSON 请求');
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) fail(413, 'body_too_large', '请求过大');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json', '请求格式无效'); }
  }
  async function media(request, response, task, entry) {
    if (task.state !== 'ready') fail(409, 'task_not_ready', '音频尚未就绪');
    const etag = '"' + entry.sha256 + '"';
    const modified = Math.floor(Date.parse(entry.modifiedAt) / 1000) * 1000;
    const headers = { 'content-type': entry.contentType, 'cache-control': 'no-store', 'accept-ranges': 'bytes',
      etag, 'last-modified': new Date(modified).toUTCString(), vary: 'Cookie' };
    const h = request.headers;
    const tags = value => String(value).split(',').map(v => v.trim());
    const matches = (value, weak = false) => tags(value).some(t => t === '*' || (weak ? t.replace(/^W\//, '') : t) === etag);
    // These headers are evaluated only AFTER authorize(), even for a 304/416.
    if (h['if-match'] && !matches(h['if-match'])) return response.writeHead(412, headers).end();
    if (!h['if-match'] && h['if-unmodified-since'] && Date.parse(h['if-unmodified-since']) < modified) return response.writeHead(412, headers).end();
    if (h['if-none-match'] ? matches(h['if-none-match'], true) : h['if-modified-since'] && Date.parse(h['if-modified-since']) >= modified) return response.writeHead(304, headers).end();
    const ifRange = h['if-range'];
    const range = request.method === 'GET' && (!ifRange || ifRange === etag || Date.parse(ifRange) === modified) ? byteRange(h.range, entry.size) : null;
    if (range?.unsatisfied) return response.writeHead(416, { ...headers, 'content-range': 'bytes */' + entry.size }).end();
    const start = range?.start ?? 0, end = range?.end ?? entry.size - 1;
    const info = await stat(task.file);
    if (info.size !== entry.size) fail(409, 'cache_changed', '缓存文件已变化，请重新创建播放任务');
    response.writeHead(range ? 206 : 200, { ...headers, 'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${entry.size}` } : {}) });
    if (request.method === 'HEAD') return response.end();
    metrics.mediaOpens++;
    const stream = createReadStream(task.file, { start, end });
    stream.on('data', chunk => { metrics.bytesServed += chunk.length; });
    await pipeline(stream, response);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      cleanup();
      if (request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'origin_denied', '请求来源不受支持');
      const url = new URL(request.url, origin);
      if (!['GET', 'HEAD'].includes(request.method) && (request.headers.origin !== origin || request.headers['x-library-lab'] !== '1')) fail(403, 'origin_denied', '请求来源不受支持');
      if (request.method === 'GET' && url.pathname === '/' && ui) return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
      if (request.method === 'GET' && url.pathname === '/app.js' && ui) return response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(bundle);
      if (request.method === 'GET' && url.pathname === '/api/session') {
        const user = session(request);
        return json(response, 200, { instanceId: config.source.instanceId, user: user ? { id: user.userId, username: user.username } : null });
      }
      if (request.method === 'POST' && url.pathname === '/api/session') {
        const input = await body(request);
        if (typeof input.username !== 'string' || typeof input.password !== 'string' || !input.username || input.username.length > 128 || !input.password || input.password.length > 1024) fail(400, 'credentials_required', '请输入账号和密码');
        if (nativeLogins >= 2 || sessions.size >= 64) fail(429, 'session_limit', '请稍后重试登录');
        nativeLogins++;
        let result;
        try {
          result = await fetch(new URL('/auth/login', source), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: input.username, password: input.password }), signal: AbortSignal.timeout(10000) });
        } catch { fail(502, 'source_unavailable', '暂时无法连接曲库'); }
        finally { nativeLogins--; }
        if (result.status === 429) { await result.body?.cancel(); fail(429, 'login_rate_limit', '曲库限制了登录频率，请稍后重试'); }
        if (!result.ok) { await result.body?.cancel(); fail(401, 'login_failed', '账号或密码不正确'); }
        const identity = parseJson(await boundedBytes(result.body, 65536));
        if (!identity.id || !identity.username || !identity.subsonicSalt || !identity.subsonicToken) fail(502, 'source_protocol', '曲库身份响应无效');
        const previous = session(request); if (previous) revokeSession(previous.id);
        const id = randomBytes(32).toString('base64url');
        sessions.set(id, { userId: identity.id, username: identity.username, expiresAt: Date.now() + SESSION_MS,
          auth: { username: identity.username, salt: identity.subsonicSalt, token: identity.subsonicToken } });
        // Secure cookies require HTTPS. This service is deliberately loopback HTTP.
        return json(response, 200, { instanceId: config.source.instanceId, user: { id: identity.id, username: identity.username } }, { 'set-cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      if (request.method === 'DELETE' && url.pathname === '/api/session') {
        const user = session(request); if (user) revokeSession(user.id);
        return json(response, 200, { user: null }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (request.method === 'GET' && url.pathname === '/api/search') {
        const query = url.searchParams.get('q') || '';
        if (query.length > 200) fail(400, 'query_too_long', '搜索文字过长');
        const user = session(request);
        const result = await subsonic('search3', user?.auth || config.source.auth, { query: query || '""', songCount: '500', albumCount: '0', artistCount: '0' });
        const catalogue = await policy(); const current = session(request);
        const ids = new Set((result.searchResult3?.song || []).map(s => s.id));
        return json(response, 200, { instanceId: config.source.instanceId, tracks: catalogue.tracks.filter(t => ids.has(t.songId) && permitted(t, current)).map(t => publicTrack(t, config.source.instanceId)) });
      }
      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        const wanted = await body(request); const { entry, user, auth } = await authorize(request, wanted);
        return json(response, 202, taskView(beginTask(entry, user, auth), entry));
      }
      const match = /^\/api\/tasks\/([A-Za-z0-9_-]{32})(\/audio)?$/.exec(url.pathname);
      if (match && ['GET', 'HEAD', 'DELETE'].includes(request.method)) {
        const task = tasks.get(match[1]); if (!task) fail(404, 'task_missing', '播放任务不存在或已过期');
        const { entry } = await authorize(request, task, task);
        if (match[2] && ['GET', 'HEAD'].includes(request.method)) return await media(request, response, task, entry);
        if (!match[2] && request.method === 'GET') return json(response, 200, taskView(task, entry));
        if (!match[2] && request.method === 'DELETE') { cancelTask(task); return json(response, 200, { state: 'cancelled' }); }
      }
      fail(404, 'route_missing', '接口不存在');
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) return response.destroy();
      const status = error instanceof Failure ? error.status : 500;
      if ([401, 403].includes(status)) metrics.denied++;
      // Never serialize upstream URLs, tokens, request bodies or native errors.
      json(response, status, { error: { code: error instanceof Failure ? error.code : 'internal_error', message: error instanceof Failure ? error.message : '实验服务暂时不可用' } });
    }
  });
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;
  return {
    server, metrics,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 0, '127.0.0.1', resolve); });
      origin = 'http://127.0.0.1:' + server.address().port;
      return origin;
    },
    async close() {
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map(job => job.promise));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass a private config path outside the repository');
  const app = await createLibraryLab(await readJson(path.resolve(process.argv[2])));
  console.log('Library contract experiment: ' + await app.start());
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit()); });
}
