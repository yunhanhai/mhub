/** Real Navidrome integration evidence. All arguments must point outside the repo.
 * node scripts/library-lab/verify-api.mjs CONFIG CREDENTIALS FIXTURE_DIR REPORT_DIR
 * Creates isolated policy/cache copies. Does not alter the live catalogue/users.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createBackend as createLibraryLab, apiRoute, cookieName, clientHeader, rustBackend, forbidsStorage } from './backend.mjs';
import { representationKey } from './identity.mjs';

const [configPath, credentialsPath, fixtureDir, reportDir] = process.argv.slice(2);
if (![configPath, credentialsPath, fixtureDir, reportDir].every(Boolean)) throw new Error('Expected CONFIG CREDENTIALS FIXTURE_DIR REPORT_DIR');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const config = await json(configPath), credentials = await json(credentialsPath), originalPolicy = await json(config.policyFile);
await mkdir(reportDir, { recursive: true });
const runDir = await mkdtemp(path.join(reportDir, 'api-run-'));
const policyFile = path.join(runDir, 'policy.json'), cacheDir = path.join(runDir, 'cache');
await save(policyFile, originalPolicy);
const app = await createLibraryLab({ ...config, port: 0, cacheDir, policyFile }, { ui: false });
const origin = await app.start();
const additional = [], actors = {}, checks = [], exchanges = [];
const report = { recordedAt: new Date().toISOString(), backend: rustBackend ? 'music-api Rust' : 'Node reference', scope: 'Real loopback Navidrome, original generated files, isolated application policy and cache.', checks, exchanges };
const check = (name, condition, details) => { checks.push({ name, passed: Boolean(condition), ...(details ? { details } : {}) }); assert.ok(condition, name); };
const wanted = entry => ({ instanceId: config.source.instanceId, songId: entry.songId, version: entry.sha256 });
const mediaCounters = () => ({ sourceDownloads: app.metrics.sourceDownloads, cacheValidations: app.metrics.cacheValidations, mediaOpens: app.metrics.mediaOpens, bytesServed: app.metrics.bytesServed });
async function exchange(name, route, { actor, method = 'GET', data, headers = {}, target = origin } = {}) {
  route = apiRoute(route);
  const r = await fetch(target + route, { method, redirect: 'error', signal: AbortSignal.timeout(25000), headers: { origin: target, [clientHeader]: '1', ...(actors[actor] ? { cookie: actors[actor] } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const bytes = Buffer.from(await r.arrayBuffer());
  const selected = Object.fromEntries(['content-type', 'content-length', 'content-range', 'etag', 'last-modified', 'cache-control'].filter(h => r.headers.has(h)).map(h => [h, r.headers.get(h)]));
  let body; if (bytes.length && /json/.test(selected['content-type'] || '')) body = JSON.parse(bytes);
  exchanges.push({ name, request: { method, route, actor: actor || 'anonymous', headers: Object.fromEntries(Object.entries(headers).filter(([key]) => !/cookie|authorization/i.test(key))) }, response: { status: r.status, headers: selected, bytes: bytes.length, sha256: digest(bytes), ...(body ? { body } : {}) } });
  return { status: r.status, headers: r.headers, bytes, body };
}
async function login(role) {
  const r = await exchange(role + ' real native login', '/api/session', { method: 'POST', data: credentials.accounts[role] });
  check(role + ' identity matches the owned Navidrome account', r.status === 200 && r.body.user.id === credentials.accounts[role].id);
  const cookie = r.headers.get('set-cookie') || '';
  check(role + ' session cookie is opaque, HttpOnly and SameSite Strict', new RegExp('^' + cookieName + '=[A-Za-z0-9_-]{43};').test(cookie) && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie));
  check(role + ' browser response has no upstream authentication fields', !/subsonic|password|token|salt/i.test(JSON.stringify(r.body)));
  actors[role] = cookie.split(';')[0]; return r;
}
async function taskFor(entry, actor, target = origin) {
  const created = await exchange('create ' + entry.title, '/api/tasks', { method: 'POST', actor, data: wanted(entry), target });
  check('playback task accepted: ' + entry.title, created.status === 202);
  let task = created.body;
  for (let i = 0; task.state === 'preparing' && i < 120; i++) {
    await new Promise(resolve => setTimeout(resolve, 75));
    const polled = await exchange('poll playback task', '/api/tasks/' + task.id, { actor, target });
    check('authorized task poll', polled.status === 200); task = polled.body;
  }
  return task;
}
try {
  const fixtureBytes = new Map();
  for (const name of await readdir(fixtureDir)) {
    if (!/\.(mp3|flac)$/i.test(name)) continue;
    const bytes = await readFile(path.join(fixtureDir, name)); fixtureBytes.set(digest(bytes), bytes);
  }
  for (const entry of originalPolicy.tracks) check('manifest independently matches original: ' + entry.title, fixtureBytes.get(entry.sha256)?.length === entry.size);
  const restricted = originalPolicy.tracks.find(t => t.access === 'restricted');
  const publicEntry = originalPolicy.tracks.find(t => t.access === 'public');
  const anon = await exchange('anonymous catalogue', '/api/search');
  check('anonymous sees only the two public tracks', anon.status === 200 && anon.body.tracks.length === 2 && anon.body.tracks.every(t => t.access === 'public'));
  await login('a'); await login('b');
  const aSearch = await exchange('A catalogue', '/api/search', { actor: 'a' });
  const bSearch = await exchange('B catalogue', '/api/search', { actor: 'b' });
  check('A sees the authorized restricted track', aSearch.body.tracks.some(t => t.songId === restricted.songId));
  check('B cannot discover the restricted track', bSearch.body.tracks.length === 2 && !bSearch.body.tracks.some(t => t.songId === restricted.songId));
  check('search actually filters the live source', (await exchange('actual upstream search', '/api/search?q=First', { actor: 'a' })).body.tracks.length === 1);
  const task = await taskFor(restricted, 'a');
  check('A task becomes ready after verified original download', task.state === 'ready' && app.metrics.sourceDownloads === 1);
  const full = await exchange('A warms restricted media', task.mediaUrl, { actor: 'a' });
  check('restricted bytes equal the independent original file', full.status === 200 && full.bytes.equals(fixtureBytes.get(restricted.sha256)));
  check('restricted media forbids browser HTTP persistence', forbidsStorage(full.headers.get('cache-control')));
  const downloads = app.metrics.sourceDownloads;
  const hit = await taskFor(restricted, 'a');
  check('second task reuses one server byte copy', hit.state === 'ready' && app.metrics.sourceDownloads === downloads && app.metrics.cacheHits === 1);

  for (const actor of [undefined, 'b']) {
    const before = mediaCounters();
    for (const [route, method, data, headers] of [
      ['/api/tasks', 'POST', wanted(restricted), {}],
      ['/api/tasks/' + task.id, 'GET', null, {}],
      [task.mediaUrl, 'GET', null, {}],
      [task.mediaUrl, 'GET', null, { range: 'bytes=123-4218' }],
      [task.mediaUrl, 'HEAD', null, {}],
      [task.mediaUrl, 'GET', null, { 'if-none-match': full.headers.get('etag') }],
      [task.mediaUrl, 'GET', null, { range: 'bytes=' + restricted.size + '-', 'if-range': full.headers.get('etag') }],
      [task.mediaUrl, 'GET', null, { 'if-modified-since': full.headers.get('last-modified') }],
    ]) {
      const r = await exchange((actor || 'anonymous') + ' denied after warm cache', route, { actor, method, data, headers });
      check((actor || 'anonymous') + ' denied: ' + method + ' ' + route.replace(task.id, '[task]') + ' ' + Object.keys(headers).join(','), r.status === (actor ? 403 : 401));
      check('denial has no media validators or range metadata', !r.headers.has('etag') && !r.headers.has('content-range') && !r.headers.has('last-modified'));
    }
    check((actor || 'anonymous') + ' denial opens no cache/media files and starts no download', JSON.stringify(before) === JSON.stringify(mediaCounters()));
  }
  const bytes = fixtureBytes.get(restricted.sha256), etag = full.headers.get('etag'), lastModified = full.headers.get('last-modified');
  for (const [name, headers, status, expected] of [
    ['nonzero Range', { range: 'bytes=123-4218' }, 206, bytes.subarray(123, 4219)],
    ['suffix Range', { range: 'bytes=-257' }, 206, bytes.subarray(bytes.length - 257)],
    ['open-ended Range', { range: 'bytes=10000-' }, 206, bytes.subarray(10000)],
    ['unsatisfiable Range', { range: 'bytes=' + bytes.length + '-' }, 416, Buffer.alloc(0)],
    ['zero suffix', { range: 'bytes=-0' }, 416, Buffer.alloc(0)],
    ['matching If-Range', { range: 'bytes=123-4218', 'if-range': etag }, 206, bytes.subarray(123, 4219)],
    ['matching date If-Range', { range: 'bytes=123-4218', 'if-range': lastModified }, 206, bytes.subarray(123, 4219)],
    ['mismatched If-Range', { range: 'bytes=123-4218', 'if-range': '"different"' }, 200, bytes],
    ['weak If-Range', { range: 'bytes=123-4218', 'if-range': 'W/' + etag }, 200, bytes],
    ['If-None-Match', { 'if-none-match': etag }, 304, Buffer.alloc(0)],
    ['weak If-None-Match', { 'if-none-match': 'W/' + etag }, 304, Buffer.alloc(0)],
    ['If-Modified-Since', { 'if-modified-since': lastModified }, 304, Buffer.alloc(0)],
    ['If-None-Match precedence', { 'if-none-match': '"different"', 'if-modified-since': lastModified }, 200, bytes],
    ['failed If-Match', { 'if-match': '"different"' }, 412, Buffer.alloc(0)],
    ['weak If-Match fails strong comparison', { 'if-match': 'W/' + etag }, 412, Buffer.alloc(0)],
    ['If-Unmodified-Since', { 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' }, 412, Buffer.alloc(0)],
    ['unsupported multi-range is ignored', { range: 'bytes=0-1,5-6' }, 200, bytes],
  ]) {
    const r = await exchange(name, task.mediaUrl, { actor: 'a', headers });
    check(name + ' status and bytes', r.status === status && r.bytes.equals(expected));
    if (status === 416) check(name + ' has valid unsatisfied length', r.headers.get('content-range') === 'bytes */' + bytes.length);
  }
  const head = await exchange('authorized HEAD ignores Range', task.mediaUrl, { actor: 'a', method: 'HEAD', headers: { range: 'bytes=0-10' } });
  check('HEAD describes full representation with no body', head.status === 200 && head.bytes.length === 0 && Number(head.headers.get('content-length')) === bytes.length);

  const revoked = structuredClone(originalPolicy); revoked.revision++; revoked.tracks.find(t => t.songId === restricted.songId).allowedUserIds = [];
  await save(policyFile, revoked);
  const beforeRevocation = mediaCounters();
  for (const [route, method, data, headers] of [
    ['/api/tasks', 'POST', wanted(restricted), {}], ['/api/tasks/' + task.id, 'GET', null, {}], [task.mediaUrl, 'GET', null, { range: 'bytes=0-4095' }], [task.mediaUrl, 'GET', null, { 'if-none-match': etag }],
  ]) check('policy revocation denies existing task/cache access', (await exchange('A after policy revocation', route, { actor: 'a', method, data, headers })).status === 403);
  check('revocation reads no cached audio', JSON.stringify(beforeRevocation) === JSON.stringify(mediaCounters()));
  await save(policyFile, originalPolicy);
  check('restoring policy restores authorized access', (await exchange('A after policy restored', task.mediaUrl, { actor: 'a', headers: { range: 'bytes=0-7' } })).status === 206);

  const beforeIdentity = mediaCounters();
  check('unknown source instance rejected', (await exchange('unknown instance', '/api/tasks', { actor: 'a', method: 'POST', data: { ...wanted(restricted), instanceId: 'unknown-instance' } })).status === 404);
  check('wrong version rejected before cache access', (await exchange('wrong version', '/api/tasks', { actor: 'a', method: 'POST', data: { ...wanted(restricted), version: '0'.repeat(64) } })).status === 409);
  check('invalid identity reads no cached audio', JSON.stringify(beforeIdentity) === JSON.stringify(mediaCounters()));
  check('key contains distinct source and version identity', representationKey('a', 'same-id', restricted.sha256) !== representationKey('b', 'same-id', restricted.sha256) && representationKey('a', 'same-id', restricted.sha256) !== representationKey('a', 'same-id', '0'.repeat(64)));

  const publicTask = await taskFor(publicEntry);
  const anonymousMedia = await exchange('anonymous public media', publicTask.mediaUrl);
  check('anonymous public media equals original', anonymousMedia.status === 200 && anonymousMedia.bytes.equals(fixtureBytes.get(publicEntry.sha256)));
  const secondPolicy = { ...originalPolicy, instanceId: randomUUID() };
  const secondPolicyFile = path.join(runDir, 'second-instance-policy.json'); await save(secondPolicyFile, secondPolicy);
  // Each process owns its directory. Seed independent directories with the
  // first instance's actual warm files to retain the cache-identity challenge.
  async function seededCache(name) {
    const destination = path.join(runDir,name); await mkdir(destination);
    for (const file of await readdir(cacheDir)) if(file.endsWith('.audio')) await copyFile(path.join(cacheDir,file),path.join(destination,file));
    return destination;
  }
  const secondCache = await seededCache('second-cache'), badCache = await seededCache('bad-source-cache');
  const second = await createLibraryLab({ ...config, port: 0, source: { ...config.source, instanceId: secondPolicy.instanceId }, policyFile: secondPolicyFile, cacheDir: secondCache }, { ui: false });
  additional.push(second); const secondOrigin = await second.start();
  const secondCreated = await exchange('same song in another configured instance', '/api/tasks', { method: 'POST', data: { ...wanted(publicEntry), instanceId: secondPolicy.instanceId }, target: secondOrigin });
  let secondTask = secondCreated.body;
  for (let i = 0; secondTask.state === 'preparing' && i < 100; i++) { await new Promise(r => setTimeout(r, 75)); secondTask = (await exchange('second instance task poll', '/api/tasks/' + secondTask.id, { target: secondOrigin })).body; }
  check('another instance cannot reuse the first instance cache', secondTask.state === 'ready' && second.metrics.sourceDownloads === 1 && second.metrics.cacheHits === 0);

  const filesBefore = new Set((await readdir(cacheDir)).filter(f => f.endsWith('.audio')));
  const changed = structuredClone(originalPolicy); changed.tracks.find(t => t.songId === publicEntry.songId).sha256 = '0'.repeat(64);
  await save(policyFile, changed);
  check('old task invalidated by manifest version update', (await exchange('old version after update', publicTask.mediaUrl)).status === 409);
  const failed = await taskFor(changed.tracks.find(t => t.songId === publicEntry.songId));
  check('wrong manifest digest fails a real original download', failed.state === 'failed' && failed.error === 'integrity_failed');
  const filesAfter = await readdir(cacheDir);
  check('failed digest publishes no audio and leaves no partial', filesAfter.filter(f => f.endsWith('.audio')).every(f => filesBefore.has(f)) && !filesAfter.some(f => f.endsWith('.partial')));
  await save(policyFile, originalPolicy);

  const badSource = await createLibraryLab({ ...config, port: 0, source: { ...config.source, auth: { ...config.source.auth, token: '0'.repeat(32) } }, policyFile, cacheDir: badCache }, { ui: false });
  additional.push(badSource); const badOrigin = await badSource.start();
  const badSearch = await exchange('actual HTTP-200 protocol auth failure', '/api/search', { target: badOrigin });
  check('OpenSubsonic failed envelope maps to an auth failure', badSearch.status === 401 && badSearch.body.error.code === 'source_auth' && badSource.metrics.protocolFailures === 1);
  const badTask = await exchange('bad source identity cannot use a warm public cache', '/api/tasks', { target: badOrigin, method: 'POST', data: wanted(publicEntry) });
  check('source authentication rechecked before warm cache use', badTask.status === 401 && badSource.metrics.sourceDownloads === 0 && badSource.metrics.cacheValidations === 0);
  const raw = await fetch(new URL('/rest/stream.view', config.source.baseUrl), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ u: config.source.auth.username, s: config.source.auth.salt, t: '0'.repeat(32), v: '1.16.1', c: 'mhub-library-lab-test', f: 'json', id: publicEntry.songId, format: 'raw' }), signal: AbortSignal.timeout(10000) });
  const rawBody = await raw.json();
  report.actualProtocolError = { http: raw.status, contentType: raw.headers.get('content-type'), protocolStatus: rawBody['subsonic-response']?.status, errorCode: rawBody['subsonic-response']?.error?.code };
  check('real source sends HTTP 200 with error 40 instead of audio', raw.status === 200 && report.actualProtocolError.protocolStatus === 'failed' && report.actualProtocolError.errorCode === 40);

  const oldA = actors.a;
  check('logout accepted', (await exchange('A logout', '/api/session', { actor: 'a', method: 'DELETE' })).status === 200);
  actors.oldA = oldA; delete actors.a;
  const beforeLogout = mediaCounters();
  for (const [route, headers] of [['/api/tasks/' + task.id, {}], [task.mediaUrl, {}], [task.mediaUrl, { range: 'bytes=0-4095' }], [task.mediaUrl, { 'if-none-match': etag }]]) {
    check('logged-out old cookie cannot read task/media/conditional response', (await exchange('stale logged-out session', route, { actor: 'oldA', headers })).status === 401);
  }
  check('logout denial reads no cache', JSON.stringify(beforeLogout) === JSON.stringify(mediaCounters()));
  check('cross-site mutation rejected', (await exchange('cross-site request', '/api/tasks', { method: 'POST', data: wanted(publicEntry), headers: { origin: 'https://example.test' } })).status === 403);
  // Node fetch normalizes Host to its destination; use raw HTTP for this case.
  const rebinding = await new Promise((resolve, reject) => {
    const req = http.get(origin + apiRoute('/api/search'), { headers: { host: 'untrusted.example.test' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Host test timeout'))); req.on('error', reject);
  });
  exchanges.push({ name: 'untrusted Host via raw HTTP', response: rebinding });
  check('DNS rebinding Host rejected', rebinding.status === 403 && rebinding.body.error.code === 'origin_denied');
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; process.exitCode = 1;
} finally {
  report.metrics = { ...app.metrics }; report.checkCount = checks.length;
  await save(policyFile, originalPolicy);
  await Promise.allSettled([app, ...additional].map(a => a.close()));
  await save(path.join(reportDir, 'api.json'), report);
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, metrics: report.metrics, ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
}
