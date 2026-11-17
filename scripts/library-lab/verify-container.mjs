/** Real endpoint checks before/after recreating a container with its data volume.
 * node verify-container.mjs before|after ORIGIN CREDENTIALS POLICY MUSIC_DIR PRIVATE_STATE OUTPUT
 * PRIVATE_STATE contains session cookies and must stay outside published evidence.
 * Run before, recreate the owned container without deleting its volume, then run after.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [phase, origin, credentialsFile, policyFile, musicDirectory, stateFile, output] = process.argv.slice(2);
assert.ok(['before', 'after'].includes(phase) && output, 'Expected phase and seven arguments');
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Only an explicitly owned loopback endpoint is supported');
const parse = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = data => createHash('sha256').update(data).digest('hex');
const credentials = await parse(credentialsFile), policy = await parse(policyFile);
const checks = [], exchanges = [], cookies = {}, tasks = [];
const report = { phase, startedAt: new Date().toISOString(), checks, exchanges,
  scope: 'Real loopback Linux container API and original fixture bytes; no capacity or mobile claim.' };
await mkdir(output, { recursive: true });
const check = (name, condition, detail) => {
  checks.push({ name, passed: Boolean(condition), ...(detail === undefined ? {} : { detail }) });
  assert.ok(condition, name);
};
const original = new Map();
async function scan(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await scan(file);
    else if (/\.(mp3|flac)$/i.test(item.name)) {
      const bytes = await readFile(file); original.set(hash(bytes), bytes);
    }
  }
}
const api = '/api/v1/library';
async function request(name, route, { actor, cookie, method = 'GET', data, headers = {} } = {}) {
  const r = await fetch(origin + route, { method, redirect: 'manual', signal: AbortSignal.timeout(25000),
    headers: { origin, 'x-mhub-library': '1', ...(cookie || cookies[actor] ? { cookie: cookie || cookies[actor] } : {}),
      ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  const bytes = Buffer.from(await r.arrayBuffer());
  const body = /json/.test(r.headers.get('content-type') || '') && bytes.length ? JSON.parse(bytes) : null;
  exchanges.push({ name, method, route, actor: actor || 'anonymous', status: r.status,
    length: bytes.length, sha256: hash(bytes), headers: Object.fromEntries(
      ['content-type', 'content-length', 'content-range', 'etag', 'cache-control'].filter(k => r.headers.has(k)).map(k => [k, r.headers.get(k)])) });
  return { status: r.status, headers: r.headers, bytes, body };
}
async function login(role) {
  const { username, password, id } = credentials.accounts[role];
  const result = await request(role + ' login', api + '/session', { method: 'POST', data: { username, password } });
  check(role + ' authenticates to the original identity', result.status === 200 && result.body?.user?.id === id);
  const setCookie = result.headers.get('set-cookie') || '';
  check(role + ' receives an opaque HttpOnly Strict cookie', /^mhub_library_session=[A-Za-z0-9_-]{43};/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie));
  check(role + ' login exposes no source credentials', !/subsonic|password|token|salt/i.test(JSON.stringify(result.body)));
  cookies[role] = setCookie.split(';')[0];
  await new Promise(resolve => setTimeout(resolve, 8500));
}
async function task(entry, actor) {
  const created = await request('create task', api + '/tasks', { actor, method: 'POST',
    data: { instanceId: policy.instanceId, songId: entry.songId, version: entry.sha256 } });
  check(entry.title + ' task accepted', created.status === 202);
  let value = created.body;
  for (let tries = 0; value.state === 'preparing' && tries < 160; tries++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const polled = await request('poll task', api + '/tasks/' + value.id, { actor });
    assert.equal(polled.status, 200); value = polled.body;
  }
  check(entry.title + ' becomes ready', value.state === 'ready');
  tasks.push({ id: value.id, actor }); return value;
}
try {
  await scan(musicDirectory);
  for (const entry of policy.tracks) check(entry.title + ' trusted original matches', original.get(entry.sha256)?.length === entry.size);
  const privateEntry = policy.tracks.find(t => t.access === 'restricted');
  const publicEntries = policy.tracks.filter(t => t.access === 'public');
  check('fixture has two public tracks and a private track', publicEntries.length === 2 && Boolean(privateEntry));
  check('health endpoint responds', (await request('health', '/health')).status === 200);
  const anonymous = await request('anonymous catalogue', api + '/search');
  check('anonymous sees only public tracks', anonymous.status === 200 && anonymous.body.tracks.length === 2 && anonymous.body.tracks.every(t => t.access === 'public'));
  if (phase === 'before') {
    check('root redirects to dedicated library', (await request('root', '/')).headers.get('location') === '/library/');
    for (const route of ['/api/v1/platforms', '/api/v1/auth/session', '/config/config.toml', '/api/v1/library/metrics']) {
      check('unpublished route is inaccessible: ' + route, (await request('unpublished route', route)).status === 404);
    }
    check('wrong Origin is rejected', (await request('wrong origin', api + '/session', { headers: { origin: 'http://localhost:8001' } })).status === 403);
    await login('a'); await login('b');
    const a = await request('A catalogue', api + '/search', { actor: 'a' });
    const b = await request('B catalogue', api + '/search', { actor: 'b' });
    check('A sees private track, B does not', a.body.tracks.length === 3 && b.body.tracks.length === 2);
    for (const entry of publicEntries) {
      const item = await task(entry);
      const response = await request('public original', item.mediaUrl);
      check(entry.title + ' full bytes and length match original', response.status === 200 && response.bytes.equals(original.get(entry.sha256)));
    }
    const item = await task(privateEntry, 'a');
    const bytes = original.get(privateEntry.sha256);
    const full = await request('private original', item.mediaUrl, { actor: 'a' });
    check('private bytes equal original', full.status === 200 && full.bytes.equals(bytes));
    check('private response forbids persistent caching', full.headers.get('cache-control')?.includes('no-store'));
    const etag = full.headers.get('etag');
    for (const [name, headers, status, wanted] of [
      ['nonzero Range', { range: 'bytes=123-4218' }, 206, bytes.subarray(123, 4219)],
      ['suffix Range', { range: 'bytes=-257' }, 206, bytes.subarray(-257)],
      ['unsatisfiable Range', { range: 'bytes=' + bytes.length + '-' }, 416, Buffer.alloc(0)],
      ['matching If-Range', { range: 'bytes=123-4218', 'if-range': etag }, 206, bytes.subarray(123, 4219)],
      ['mismatched If-Range', { range: 'bytes=123-4218', 'if-range': '"wrong"' }, 200, bytes],
      ['If-None-Match', { 'if-none-match': etag }, 304, Buffer.alloc(0)],
    ]) {
      const r = await request(name, item.mediaUrl, { actor: 'a', headers });
      check(name + ' status and original bytes', r.status === status && r.bytes.equals(wanted));
    }
    const head = await request('HEAD with Range', item.mediaUrl, { actor: 'a', method: 'HEAD', headers: { range: 'bytes=0-3' } });
    check('HEAD describes full file without a body', head.status === 200 && head.bytes.length === 0 && Number(head.headers.get('content-length')) === bytes.length);
    for (const [actor, status] of [[undefined, 401], ['b', 403]]) {
      const denied = await request('unauthorized cached Range', item.mediaUrl, { actor, headers: { range: 'bytes=0-3', 'if-none-match': etag } });
      check((actor || 'anonymous') + ' cannot reuse private cache', denied.status === status && !denied.headers.has('etag') && !denied.headers.has('content-range'));
    }
    await writeFile(stateFile, JSON.stringify({ cookie: cookies.a, privateTask: item.id, privateMedia: item.mediaUrl,
      publicMedia: tasks.filter(t => !t.actor).map(t => api + '/tasks/' + t.id + '/audio'), originalVersion: privateEntry.sha256 }, null, 2), { mode: 0o600, flag: 'wx' });
    report.nextStep = 'Recreate both owned containers, retaining the application data volume; then run after with the private state.';
  } else {
    const previous = await parse(stateFile);
    const oldSession = await request('old session after recreate', api + '/session', { cookie: previous.cookie });
    check('old session is invalid after process recreation', oldSession.status === 200 && oldSession.body.user === null);
    check('old task is absent', (await request('old task after recreate', api + '/tasks/' + previous.privateTask, { cookie: previous.cookie })).status === 404);
    const oldMedia = await request('old private media after recreate', previous.privateMedia, { cookie: previous.cookie });
    check('old private URL is absent after task reset', oldMedia.status === 404 && !oldMedia.headers.has('etag') && !oldMedia.headers.has('content-range'));
    await login('a');
    for (const entry of [publicEntries[0], privateEntry]) {
      const actor = entry.access === 'restricted' ? 'a' : undefined;
      const value = await task(entry, actor);
      const r = await request('new task after recreate', value.mediaUrl, { actor });
      check(entry.title + ' retained original still matches', r.status === 200 && r.bytes.equals(original.get(entry.sha256)));
    }
    await request('logout', api + '/session', { method: 'DELETE', actor: 'a' });
    const privateTask = tasks.find(t => t.actor === 'a');
    check('logout blocks a newly authorized private task', (await request('after logout', api + '/tasks/' + privateTask.id + '/audio', { actor: 'a', headers: { range: 'bytes=0-3' } })).status === 401);
    for (const item of tasks.filter(t => !t.actor)) await request('cancel own public task', api + '/tasks/' + item.id, { method: 'DELETE' });
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.checkCount = checks.length;
  await writeFile(path.join(output, 'container-api.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ phase, passed: report.passed, checks: checks.length, ...(report.failure ? { failure: report.failure } : {}) }));
}
