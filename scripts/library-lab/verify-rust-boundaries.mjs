/** Integration-specific checks against the actual music-api binary.
 * LIBRARY_BACKEND=rust node .../verify-rust-boundaries.mjs CONFIG CREDENTIALS REPORT_DIR
 * Optional SOURCE_ADMIN_CREDENTIALS enables a reversible library-permission test
 * for the explicitly supplied, owned non-admin A fixture account only.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBackend, apiBase, clientHeader, cookieName, rustBackend } from './backend.mjs';
if (!rustBackend) throw new Error('Select LIBRARY_BACKEND=rust for these checks');
const [configFile, credentialsFile, reportDir] = process.argv.slice(2);
if (![configFile, credentialsFile, reportDir].every(Boolean)) throw new Error('Expected CONFIG CREDENTIALS REPORT_DIR');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const config = await json(configFile), credentials = await json(credentialsFile), policy = await json(config.policyFile);
await mkdir(reportDir, { recursive: true });
const run = await mkdtemp(path.join(reportDir, 'boundaries-run-'));
const selected = policy.tracks.find(t => t.access === 'restricted' && t.allowedUserIds.includes(credentials.accounts.a.id));
assert.ok(selected, 'An owned A-only fixture is required');
const policyFile = path.join(run, 'policy.json'); await writeFile(policyFile, JSON.stringify(policy));
const isolated = { ...config, cacheDir: path.join(run, 'cache'), policyFile };
let app, origin, cookie = '', adminToken, librariesToRestore, emptyLibrary;
const checks = [], responses = [];
const report = { recordedAt: new Date().toISOString(), backend: 'music-api Rust', checks, responses };
const check = (name, condition) => { checks.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const wanted = { instanceId: policy.instanceId, songId: selected.songId, version: selected.sha256 };
const io = () => JSON.stringify({ mediaOpens: app.metrics.mediaOpens, cacheValidations: app.metrics.cacheValidations, sourceDownloads: app.metrics.sourceDownloads });
async function request(route, { method = 'GET', data, headers = {} } = {}) {
  const r = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { origin, [clientHeader]: '1', ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const bytes = Buffer.from(await r.arrayBuffer());
  const body = /json/.test(r.headers.get('content-type') || '') && bytes.length ? JSON.parse(bytes) : null;
  responses.push({ route, method, status: r.status, bodyHash: digest(bytes), bytes: bytes.length });
  return { status: r.status, body, headers: r.headers, bytes };
}
async function login() {
  const r = await request(apiBase + '/session', { method: 'POST', data: credentials.accounts.a });
  check('A native identity verified', r.status === 200 && r.body.user.id === credentials.accounts.a.id);
  const header = r.headers.get('set-cookie') || '';
  check('formal session cookie is scoped to the authorized namespace', header.startsWith(cookieName + '=') && header.includes('Path=' + apiBase));
  cookie = header.split(';')[0];
}
async function prepare() {
  const r = await request(apiBase + '/tasks', { method: 'POST', data: wanted }); check('authorized task created', r.status === 202);
  let task = r.body;
  for (let i = 0; task.state === 'preparing' && i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 75)); task = (await request(apiBase + '/tasks/' + task.id)).body; }
  check('authorized task completes', task.state === 'ready'); return task;
}
async function native(route, method = 'GET', body) {
  const r = await fetch(config.source.baseUrl + '/api/' + route, { method, headers: { 'x-nd-authorization': 'Bearer ' + adminToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  assert.ok(r.ok, 'Owned fixture administration failed: ' + method + ' HTTP ' + r.status);
  const text = await r.text(); return text ? JSON.parse(text) : null;
}
async function removeEmptyLibrary() {
  if (!emptyLibrary || librariesToRestore) return;
  const current = await native('library/' + emptyLibrary.id);
  assert.equal(path.resolve(current.path), emptyLibrary.path, 'Only the newly created empty fixture can be removed');
  assert.equal((await readdir(emptyLibrary.path)).length, 0, 'The temporary fixture must still be empty');
  await native('library/' + emptyLibrary.id, 'DELETE');
  await rmdir(emptyLibrary.path); emptyLibrary = null;
}
try {
  app = await createBackend(isolated); origin = await app.start();
  check('health comes from the real music-api process', (await request('/health')).body.service === 'music-api');
  await login(); const task = await prepare();
  const first = await request(task.mediaUrl);
  check('Rust bytes match the trusted original digest', first.status === 200 && digest(first.bytes) === selected.sha256);
  const before = io();
  const legacy = await request('/api/v1/playbacks/' + task.id + '/audio');
  check('legacy shared task route cannot read a restricted library task', legacy.status === 404 && !legacy.headers.has('etag'));
  const bypass = await request('/api/v1/search?platform=navidrome&q=Long');
  check('legacy platform selector cannot bypass the library adapter', bypass.status === 400);
  check('legacy attempts open no library cache files', io() === before);
  const crossSite = await request(task.mediaUrl, { headers: { origin: 'http://127.0.0.1:9', 'sec-fetch-site': 'same-site' } });
  check('another origin on the same machine cannot use a private session', crossSite.status === 403);
  check('private configuration is outside the served directory', (await request('/config/rust-library.local.json')).status === 404);
  const oldCookie = cookie;
  await app.close(); app = await createBackend(isolated); origin = await app.start(); cookie = oldCookie;
  const beforeRestartRequest = io();
  check('restart invalidates the previous in-memory session', (await request(apiBase + '/session')).body.user === null);
  check('old session cannot create a task against a warm disk cache', (await request(apiBase + '/tasks', { method: 'POST', data: wanted })).status === 401);
  check('restart denial does not open the cached representation', io() === beforeRestartRequest);
  cookie = ''; await login(); const restored = await prepare();
  check('new authorized session reuses the validated persistent file', app.metrics.sourceDownloads === 0 && app.metrics.cacheHits === 1);
  const replay = await request(restored.mediaUrl);
  check('restart replay has the original bytes', digest(replay.bytes) === selected.sha256);
  if (process.env.SOURCE_ADMIN_CREDENTIALS) {
    assert.ok(['127.0.0.1', '[::1]'].includes(new URL(config.source.baseUrl).hostname), 'Fixture administration is limited to an explicitly owned loopback source');
    const admin = await json(process.env.SOURCE_ADMIN_CREDENTIALS);
    const r = await fetch(config.source.baseUrl + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: admin.username, password: admin.password }), signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, 200, 'Fixture administrator authentication failed'); adminToken = (await r.json()).token;
    const users = await native('user');
    const owned = users.find(u => u.id === credentials.accounts.a.id && u.userName === credentials.accounts.a.username);
    check('only the explicitly owned non-admin fixture user is changed', Boolean(owned) && owned.isAdmin === false);
    const route = 'user/' + encodeURIComponent(owned.id) + '/library';
    librariesToRestore = { route, ids: (await native(route)).map(l => l.id) };
    await writeFile(path.join(run, 'restore-libraries.json'), JSON.stringify(librariesToRestore));
    // Navidrome requires at least one library per regular user. Assign this
    // newly created empty local fixture while removing access to the originals.
    const emptyPath = path.resolve(run, 'empty-source'); await mkdir(emptyPath);
    const createdLibrary = await native('library', 'POST', { name: 'MHub revocation fixture ' + path.basename(run), path: emptyPath, defaultNewUsers: false });
    const emptyId = Number(createdLibrary.id);
    assert.ok(Number.isInteger(emptyId) && emptyId > 0, 'Empty fixture creation must return an id');
    emptyLibrary = { id: emptyId, path: emptyPath };
    await writeFile(path.join(run, 'empty-library.json'), JSON.stringify(emptyLibrary));
    await native(route, 'PUT', { libraryIds: [emptyLibrary.id] });
    const beforeSourceRevocation = io();
    const denied = await request(restored.mediaUrl, { headers: { range: 'bytes=0-4095', 'if-none-match': replay.headers.get('etag') } });
    check('real upstream library revocation rejects an already cached private task', [401,403,404].includes(denied.status) && !denied.headers.has('etag') && !denied.headers.has('content-range'));
    check('upstream permission failure reads no cached audio', io() === beforeSourceRevocation);
    await native(route, 'PUT', { libraryIds: librariesToRestore.ids }); librariesToRestore = null;
    check('restoring upstream library access restores media access', (await request(restored.mediaUrl, { headers: { range: 'bytes=0-7' } })).status === 206);
    await removeEmptyLibrary();
    report.upstreamRevocationTest = 'Real Navidrome fixture user assigned to an empty library, original access restored, temporary library removed.';
  }
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.message; process.exitCode = 1; }
finally {
  if (librariesToRestore) {
    try { await native(librariesToRestore.route, 'PUT', { libraryIds: librariesToRestore.ids }); librariesToRestore = null; report.restoredInFinally = true; }
    catch { report.restoreFailed = true; report.passed = false; process.exitCode = 1; }
  }
  try { await removeEmptyLibrary(); }
  catch { report.fixtureCleanupFailed = true; report.passed = false; process.exitCode = 1; }
  report.metrics = app ? { ...app.metrics } : {}; report.checkCount = checks.length;
  await app?.close();
  await writeFile(path.join(reportDir, 'boundaries.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, ...(report.failure ? { failure: report.failure } : {}), ...(report.restoreFailed ? { restoreFailed: true } : {}) }, null, 2));
}
