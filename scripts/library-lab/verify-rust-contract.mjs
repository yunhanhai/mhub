// Actual music-api executable with a deliberately simulated upstream protocol.
// LIBRARY_BACKEND=rust node scripts/library-lab/verify-rust-contract.mjs REPORT_DIR
// No real Navidrome accounts, personal files, Docker or external APIs are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend, rustBackend, apiBase } from './backend.mjs';

assert.ok(rustBackend, 'Set LIBRARY_BACKEND=rust; this check must run the real executable');
const output = process.argv[2]; assert.ok(output, 'Expected REPORT_DIR');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), 'mhub-contract-'));
const expectedDirectory = await realpath(temporary);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const generate = args => new Promise((resolve, reject) => execFile(process.env.FFMPEG_EXECUTABLE || 'ffmpeg',
  ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, encoding: 'buffer', timeout: 30000, maxBuffer: 1024 * 1024 },
  (error, stdout) => error ? reject(new Error('Generated media creation failed')) : resolve(stdout)));
const report = { startedAt: new Date().toISOString(), checks: [], errors: [],
  scope: 'Actual Rust music-api process and HTTP authorization/cache/artwork paths; generated MP3/JPEG and explicitly simulated native-login/Subsonic upstream. Does not verify a real Navidrome deployment, browser playback, physical phone or production capacity.' };
let upstream, app, origin, sourceOrigin;
const actors = {}, sourceRequests = [];
const accounts = Object.fromEntries(['service', 'a', 'b'].map(role => [role, { username: 'contract-' + role,
  id: 'generated-' + role, password: randomBytes(18).toString('base64url'), salt: randomBytes(12).toString('hex'), token: randomBytes(16).toString('hex') }]));
let sourceMissingForA = false, corruptStream = false;
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) }); assert.ok(passed, name); };
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
try {
  const executable = process.env.MHUB_RUST_BINARY || path.resolve('target/debug', process.platform === 'win32' ? 'music-api.exe' : 'music-api');
  report.executableSHA256 = hash(await readFile(executable));
  const audio = await generate(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-f', 'mp3', 'pipe:1']);
  const cover = await generate(['-f', 'lavfi', '-i', 'color=c=green:s=16x16', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
  const instanceId = 'generated-rust-contract';
  const artwork = { sha256: hash(cover), size: cover.length, width: 16, height: 16, contentType: 'image/jpeg' };
  const policy = { instanceId, tracks: ['public', 'private', 'corrupt'].map((kind, index) => ({ songId: kind, title: 'Generated ' + kind,
    artist: 'Protocol fixture', duration: 3000, format: 'mp3', contentType: 'audio/mpeg', size: audio.length,
    // The corruption case has its own immutable version so that it cannot hit the warm file.
    sha256: index === 2 ? hash(Buffer.concat([audio, Buffer.from('different-original')])) : hash(audio),
    modifiedAt: '2026-01-01T00:00:00Z', access: kind === 'private' ? 'restricted' : 'public', allowedUserIds: kind === 'private' ? [accounts.a.id] : [], artwork })) };
  const policyFile = path.join(temporary, 'policy.json'), artworkDir = path.join(temporary, 'artwork');
  await mkdir(artworkDir); await writeFile(path.join(artworkDir, artwork.sha256 + '.jpg'), cover);
  await writeFile(policyFile, JSON.stringify(policy));
  upstream = createServer(async (req, res) => {
    try {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      if (req.url === '/auth/login') {
        const input = JSON.parse(bytes), role = Object.keys(accounts).find(role => accounts[role].username === input.username && accounts[role].password === input.password);
        sourceRequests.push({ method: 'login', role: role || 'invalid', httpMethod: req.method, queryPresent: req.url.includes('?') });
        if (!role) return send(res, 401, {});
        const account = accounts[role];
        return send(res, 200, { id: account.id, username: account.username, subsonicSalt: account.salt, subsonicToken: account.token });
      }
      const input = new URLSearchParams(bytes), method = /^\/rest\/(\w+)\.view$/.exec(req.url)?.[1];
      const role = Object.keys(accounts).find(role => accounts[role].username === input.get('u') && accounts[role].salt === input.get('s') && accounts[role].token === input.get('t'));
      sourceRequests.push({ method, role: role || 'invalid', song: input.get('id'), httpMethod: req.method, queryPresent: req.url.includes('?') });
      const failure = code => send(res, 200, { 'subsonic-response': { status: 'failed', error: { code } } });
      if (!role) return failure(40);
      const entry = policy.tracks.find(t => t.songId === input.get('id'));
      if (method === 'search3') return send(res, 200, { 'subsonic-response': { status: 'ok', searchResult3: { song: policy.tracks
        .filter(t => input.get('query') === '""' || t.title.toLowerCase().includes(input.get('query').toLowerCase())).map(t => ({ id: t.songId, size: t.size })) } } });
      if (!entry || entry.access === 'restricted' && (role !== 'a' || sourceMissingForA)) return failure(70);
      if (method === 'getSong') return send(res, 200, { 'subsonic-response': { status: 'ok', song: { id: entry.songId, size: entry.size } } });
      if (method === 'stream') {
        const body = corruptStream ? Buffer.alloc(audio.length, 0) : audio;
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': body.length }); return res.end(body);
      }
      return failure(70);
    } catch { if (!res.headersSent) send(res, 500, {}); else res.destroy(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  sourceOrigin = 'http://127.0.0.1:' + upstream.address().port;
  app = await createBackend({ source: { instanceId, baseUrl: sourceOrigin, auth: { username: accounts.service.username, salt: accounts.service.salt, token: accounts.service.token } },
    cacheDir: path.join(temporary, 'cache'), policyFile, artworkDir }, { exclusive: true });
  origin = await app.start();
  report.backend = { kind: 'real Rust executable', pid: app.pid };
  const exchange = async (route, { method = 'GET', role, data, headers = {} } = {}) => {
    const response = await fetch(origin + route, { method, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { origin, 'x-mhub-library': '1', ...(actors[role] ? { cookie: actors[role] } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes, body: /json/.test(response.headers.get('content-type') || '') && bytes.length ? JSON.parse(bytes) : null };
  };
  const selector = entry => ({ instanceId, songId: entry.songId, version: entry.sha256 });
  const task = async (entry, role) => {
    const created = await exchange(apiBase + '/tasks', { method: 'POST', role, data: selector(entry) });
    assert.equal(created.status, 202, 'Real Rust task accepted');
    let value = created.body;
    for (let index = 0; value.state === 'preparing' && index < 100; index++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      const response = await exchange(apiBase + '/tasks/' + value.id, { role }); assert.equal(response.status, 200); value = response.body;
    }
    return value;
  };
  const secretValues = Object.values(accounts).flatMap(a => [a.password, a.token, a.salt]);
  const clean = value => secretValues.every(secret => !JSON.stringify(value).includes(secret));
  check('exclusive Rust site omits shared platform routes', (await exchange('/api/v1/platforms')).status === 404);
  const anonymous = await exchange(apiBase + '/search');
  check('anonymous catalogue excludes restricted entries', anonymous.status === 200 && anonymous.body.tracks.length === 2 && anonymous.body.tracks.every(t => t.access === 'public'));
  check('source credentials never appear in catalogue DTO', clean(anonymous.body));
  check('cross-origin catalogue request is rejected', (await exchange(apiBase + '/search', { headers: { origin: 'https://other.example.test' } })).status === 403);
  check('missing write-origin header cannot create tasks', (await exchange(apiBase + '/tasks', { method: 'POST', data: selector(policy.tracks[0]), headers: { origin: '' } })).status === 403);
  check('invalid credentials do not establish a session', (await exchange(apiBase + '/session', { method: 'POST', data: { username: 'generated', password: 'wrong' } })).status === 401);
  for (const role of ['a', 'b']) {
    const response = await exchange(apiBase + '/session', { method: 'POST', data: { username: accounts[role].username, password: accounts[role].password } });
    actors[role] = response.headers.get('set-cookie')?.split(';')[0];
    check(role + ' login uses upstream identity without returning source secrets', response.status === 200 && response.body.user.id === accounts[role].id && clean(response.body));
    check(role + ' session is opaque HttpOnly SameSite Strict', /^mhub_library_session=[A-Za-z0-9_-]{43}$/.test(actors[role]) && /HttpOnly/.test(response.headers.get('set-cookie')) && /SameSite=Strict/.test(response.headers.get('set-cookie')));
  }
  const aCatalogue = await exchange(apiBase + '/search', { role: 'a' }), bCatalogue = await exchange(apiBase + '/search', { role: 'b' });
  check('policy filters upstream results for the current identity', aCatalogue.body.tracks.length === 3 && bCatalogue.body.tracks.length === 2);
  const privateEntry = policy.tracks[1], privateTask = await task(privateEntry, 'a');
  check('private task reaches ready after original integrity verification', privateTask.state === 'ready');
  const mediaRoute = privateTask.mediaUrl.startsWith('/') ? privateTask.mediaUrl : new URL(privateTask.mediaUrl).pathname;
  const full = await exchange(mediaRoute, { role: 'a' });
  check('authorized private media equals generated original', full.status === 200 && full.bytes.equals(audio));
  check('private media forbids HTTP persistence', full.headers.get('cache-control').includes('no-store'));
  const beforeDenied = sourceRequests.length;
  for (const role of [undefined, 'b']) {
    for (const [method, headers] of [['GET', {}], ['GET', { range: 'bytes=1-16' }], ['HEAD', {}], ['GET', { 'if-none-match': full.headers.get('etag') }]]) {
      const response = await exchange(mediaRoute, { method, role, headers });
      check((role || 'anonymous') + ' cannot access warm media via ' + method + '/' + Object.keys(headers).join(','), response.status === (role ? 403 : 401)
        && !response.headers.has('etag') && !response.headers.has('content-range') && !response.headers.has('last-modified'));
    }
  }
  check('denied warm media does not contact the upstream', sourceRequests.length === beforeDenied);
  const wrongInstance = await exchange(apiBase + '/tasks', { method: 'POST', role: 'a', data: { ...selector(privateEntry), instanceId: 'other-instance' } });
  check('a different instance cannot reuse the local song identifier', wrongInstance.status === 404 && wrongInstance.body.error.code === 'instance_missing');
  check('a stale original version cannot reuse warm cached bytes', (await exchange(apiBase + '/tasks', { method: 'POST', role: 'a', data: { ...selector(privateEntry), version: '0'.repeat(64) } })).status === 409);
  const range = await exchange(mediaRoute, { role: 'a', headers: { range: 'bytes=11-63' } });
  check('authorized Range returns exact original bytes', range.status === 206 && range.bytes.equals(audio.subarray(11, 64)));
  check('authorized conditional response returns 304', (await exchange(mediaRoute, { role: 'a', headers: { 'if-none-match': full.headers.get('etag') } })).status === 304);
  const artRoute = apiBase + '/artwork/private?instanceId=' + instanceId + '&version=' + privateEntry.sha256;
  check('restricted artwork is served through real Rust authorization', (await exchange(artRoute, { role: 'a' })).bytes.equals(cover));
  check('restricted artwork rejects another account after warm read', (await exchange(artRoute, { role: 'b' })).status === 403);
  sourceMissingForA = true;
  const revoked = await exchange(mediaRoute, { role: 'a' });
  check('HTTP 200 Subsonic error 70 revokes warm media access', revoked.status === 404 && revoked.body.error.code === 'source_missing');
  sourceMissingForA = false;
  await exchange(apiBase + '/session', { method: 'DELETE', role: 'a' });
  check('logout invalidates the original opaque session cookie', (await exchange(mediaRoute, { role: 'a' })).status === 401);
  corruptStream = true;
  const corrupt = await task(policy.tracks[2]);
  check('mismatching original SHA never publishes a ready task', corrupt.state === 'failed');
  corruptStream = false;
  const publicTask = await task(policy.tracks[0]);
  const publicRoute = publicTask.mediaUrl.startsWith('/') ? publicTask.mediaUrl : new URL(publicTask.mediaUrl).pathname;
  check('public media remains available without a user session', publicTask.state === 'ready' && (await exchange(publicRoute)).bytes.equals(audio));
  check('source credentials travel in POST bodies without URL query secrets', sourceRequests.every(r => r.httpMethod === 'POST' && !r.queryPresent));
  await exchange(apiBase + '/tasks/' + publicTask.id, { method: 'DELETE' });
  await exchange(apiBase + '/session', { method: 'DELETE', role: 'b' });
  let finalMetrics;
  for (let index = 0; index < 100; index++) {
    await exchange(apiBase + '/session'); finalMetrics = app.metrics;
    if (['activeTasks', 'activeSessions', 'activeJobs', 'activeMediaResponses', 'activeFileLeases', 'runningPreparations', 'queuedPreparations'].every(key => finalMetrics[key] === 0)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  check('cancel and logout release active Rust resources before process teardown',
    ['activeTasks', 'activeSessions', 'activeJobs', 'activeMediaResponses', 'activeFileLeases', 'runningPreparations', 'queuedPreparations'].every(key => finalMetrics[key] === 0), finalMetrics);
  report.upstream = { kind: 'simulated native login/Subsonic protocol', requests: sourceRequests, generatedFormats: ['mp3', 'jpeg'] };
  report.metrics = app.metrics;
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; report.stack = error.stack; process.exitCode = 1; }
finally {
  if (app) {
    try { await app.close(); report.backendClosed = true; }
    catch (error) { report.passed = false; report.errors.push('Owned backend cleanup failed'); process.exitCode = 1; }
  }
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  // Delete only the checked disposable directory created above, never a
  // caller-provided collection or report path. Credentials existed in RAM and
  // the backend helper's separate temporary config, which close() removes.
  const current = await realpath(temporary);
  if (current !== expectedDirectory || !path.basename(current).startsWith('mhub-contract-')) throw new Error('Unexpected cleanup directory');
  await rm(current, { recursive: true, force: true });
  report.fixtureClosed = true; report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await writeFile(path.join(output, 'rust-contract.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, failure: report.failure }));
}
