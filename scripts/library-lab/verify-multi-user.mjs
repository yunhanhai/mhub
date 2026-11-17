/** Real-account queue fairness, isolation and Navidrome permission revocation.
 * LIBRARY_BACKEND=rust SOURCE_ADMIN_CREDENTIALS=... node verify-multi-user.mjs CONFIG STATE OUTPUT
 * MULTI_USER_CASES=source-revocation,round-robin,limits,logout selects scenarios.
 * The proxy only gates real media bodies; it does not fabricate authorization.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apiBase, rustBackend } from './backend.mjs';
import { json, pause, digest, until, inventory, request, startApp, createTask, cancel } from './resource-client.mjs';
import { administrator, source, clientFor, fixtureConfig, loginGapMs } from './multi-user-fixtures.mjs';

assert.ok(rustBackend, 'Select the real Rust backend');
const [configFile, fixtureFile, output] = process.argv.slice(2);
const base = await json(configFile), fixture = await json(fixtureFile), config = fixtureConfig(base, fixture);
assert.equal(fixture.tracks.length, 20);
for (const file of fixture.files) assert.equal(digest(await readFile(file.file)), file.sha256);
try { await stat(path.join(output, 'multi-user.json')); throw new Error('Use a fresh output directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
const binary = process.env.MHUB_RUST_BINARY || fileURLToPath(new URL('../../target/debug/music-api.exe', import.meta.url));
const selected = process.env.MULTI_USER_CASES?.split(',');
const checks = [], cases = [], logins = [], processes = [];
const report = { recordedAt: new Date().toISOString(), binarySHA256: digest(await readFile(binary)), checks, cases, logins, processes,
  scope: 'Real non-admin Navidrome users and original audio; proxy gates bodies but never changes authorization or media bytes.',
  actualSourcePermissionChanges: true, loginGapMs, selectedCases: selected || null };
report.toolHashes = {};
for (const name of ['verify-multi-user.mjs', 'multi-user-fixtures.mjs', 'resource-client.mjs', 'backend.mjs']) report.toolHashes[name] = digest(await readFile(new URL('./' + name, import.meta.url)));
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
const trackLabel = id => fixture.files[fixture.tracks.findIndex(track => track.songId === id)]?.label || 'unknown';

async function gatedSource() {
  const started = performance.now(), traces = [], stats = { activeStreams: 0, peakStreams: 0, openedStreams: 0, closedStreams: 0, errors: [] };
  const controls = new Map(), responses = new Set(); let allowAll = false;
  const record = value => traces.push({ atMs: performance.now() - started, ...value });
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController(); let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    res.once('close', () => { abort.abort(); resolveClosed(); }); responses.add(res);
    let reader, counted = false;
    try {
      assert.ok(req.method === 'POST' && (/^\/rest\/\w+\.view$/.test(req.url) || req.url === '/auth/login'));
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks), form = new URLSearchParams(body.toString());
      const login = req.url === '/auth/login', username = login ? JSON.parse(body).username : form.get('u');
      const role = Object.entries(fixture.accounts).find(([, account]) => account.username === username)?.[0] || 'unknown';
      const label = trackLabel(form.get('id'));
      const upstream = await fetch(config.source.baseUrl + req.url, { method: 'POST',
        headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
        body, signal: abort.signal, redirect: 'error' });
      const type = upstream.headers.get('content-type') || '';
      if (req.url === '/rest/stream.view' && upstream.ok && type.includes('audio')) {
        assert.notEqual(role, 'unknown');
        stats.activeStreams++; stats.peakStreams = Math.max(stats.peakStreams, stats.activeStreams); stats.openedStreams++; counted = true;
        record({ event: 'stream-open', role, label });
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        controls.set(label, release);
        reader = upstream.body.getReader();
        res.writeHead(upstream.status, { 'content-type': type, 'content-length': upstream.headers.get('content-length') }); res.flushHeaders();
        if (!allowAll) await Promise.race([gate, closed]);
        while (!abort.signal.aborted) {
          const part = await reader.read(); if (part.done) break;
          if (!res.write(part.value)) await Promise.race([closed, new Promise(resolve => res.once('drain', resolve))]);
        }
        if (!abort.signal.aborted) res.end();
      } else {
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (req.url === '/rest/getSong.view') {
          const value = JSON.parse(bytes)['subsonic-response'];
          record({ event: 'getSong', role, label, httpStatus: upstream.status, status: value?.status, ...(value?.error ? { protocolCode: value.error.code } : {}) });
        }
        res.writeHead(upstream.status, { 'content-type': type, 'content-length': bytes.length }).end(bytes);
      }
    } catch (error) {
      if (!abort.signal.aborted) { stats.errors.push(error.code || error.name); res.destroy(); }
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      if (counted) { stats.activeStreams--; stats.closedStreams++; record({ event: 'stream-close' }); }
      responses.delete(res);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { traces, stats, source: { ...config.source, baseUrl: 'http://127.0.0.1:' + server.address().port },
    release(label) { assert.ok(controls.has(label), 'Release an observed source stream'); record({ event: 'release', label }); controls.get(label)(); },
    releaseAll() { allowAll = true; for (const release of controls.values()) release(); record({ event: 'release-all' }); },
    async close() { for (const response of responses) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function settled(client, task) {
  let response;
  await until(async () => {
    response = await request(client, apiBase + '/tasks/' + task.id);
    return response.status !== 200 || response.value?.state !== 'preparing';
  }, 'queued task reaches a terminal preparation state', 12000);
  return response;
}
async function verifyBody(client, task, track, name) {
  const status = await settled(client, task);
  if (status.status !== 200 || status.value?.state !== 'ready') {
    check(name, false, { status: status.status, state: status.value?.state, error: status.value?.error }); return false;
  }
  const response = await request(client, status.value.mediaUrl);
  check(name, response.status === 200 && response.body.length === track.size && digest(response.body) === track.sha256);
  return true;
}
const transientGone = app => ['activeJobs', 'activeTasks', 'activeFileLeases', 'activeMediaResponses', 'reservedBytes', 'queuedPreparations', 'runningPreparations'].every(key => app.metrics[key] === 0);

async function scenario(name, roles, action) {
  if (selected && !selected.includes(name)) return;
  const start = performance.now(), offset = checks.length, tasks = [], details = {};
  const proxy = await gatedSource(); let app, failure;
  try {
    const tracks = fixture.tracks.map((track, index) => index < 2 ? { ...track, access: 'public', allowedUserIds: [] } : track);
    app = await startApp(config, path.join(output, name), tracks, { source: proxy.source }); processes.push({ scenario: name, pid: app.pid });
    const clients = {};
    for (const role of roles) clients[role] = await clientFor(app, fixture, role, logins);
    const admit = async (index, client = app) => {
      const response = await createTask(client, config, tracks[index]);
      if (response.status === 202) tasks.push({ client, task: response.value, index });
      return response;
    };
    const accept = async (index, client = app) => {
      const response = await admit(index, client); assert.equal(response.status, 202, 'Owned task admission'); return response.value;
    };
    const block = async () => {
      const first = await accept(0), second = await accept(1);
      await until(() => proxy.stats.activeStreams === 2, 'two owned originals held at their media bodies');
      return [first, second];
    };
    await action({ app, proxy, clients, admit, accept, block, tracks, details });
    for (const { client, task } of [...tasks].reverse()) await cancel(client, task).catch(() => {});
    await until(() => transientGone(app) && proxy.stats.activeStreams === 0, 'scenario transient resources return to zero');
    check(name + ': all transient resources released without exceeding two source bodies', transientGone(app) && proxy.stats.peakStreams <= 2 && proxy.stats.errors.length === 0);
    details.after = { ...app.metrics };
  } catch (error) {
    failure = error.message; check(name + ': scenario setup and observation complete', false, { error: failure });
  } finally {
    if (app) { for (const { client, task } of [...tasks].reverse()) await cancel(client, task).catch(() => {}); await app.close(); }
    await proxy.close();
    cases.push({ name, milliseconds: performance.now() - start, checkCount: checks.length - offset, ...details,
      ...(failure ? { failure } : {}), source: { stats: { ...proxy.stats }, traces: proxy.traces } });
    await writeFile(path.join(output, 'multi-user.json'), JSON.stringify({ ...report, checkCount: checks.length, passed: checks.every(item => item.passed) }, null, 2) + '\n');
    console.log(JSON.stringify({ scenario: name, checks: checks.length - offset, failed: checks.slice(offset).filter(item => !item.passed).map(item => item.name) }));
  }
}

await scenario('source-revocation', ['u1', 'u2'], async ({ app, proxy, clients, accept, block, tracks, details }) => {
  const admin = await administrator(base), account = fixture.accounts.u1;
  const route = 'user/' + encodeURIComponent(account.id) + '/library';
  const original = (await admin.native(route)).map(value => Number(value.id));
  assert.deepEqual(original, [fixture.libraries.audio.id]);
  let changed = false;
  try {
    await block();
    const first = await accept(2, clients.u1); await pause(20);
    const other = await accept(2, clients.u2), neighbor = await accept(3, clients.u2);
    await until(() => app.metrics.queuedPreparations === 2, 'shared file and independent peer file are waiting');
    const queuedAt = performance.now();
    await admin.native(route, 'PUT', { libraryIds: [fixture.libraries.empty.id] }); changed = true;
    const denied = await source(base, account.sourceAuth, 'getSong', { id: tracks[2].songId });
    const allowed = await source(base, fixture.accounts.u2.sourceAuth, 'getSong', { id: tracks[2].songId });
    details.permissionChange = { realNativeLibraryAssignment: true, deniedHttpStatus: denied.status, deniedProtocolStatus: denied.value?.status,
      deniedProtocolCode: denied.value?.error?.code, peerProtocolStatus: allowed.value?.status, millisecondsWhileQueued: performance.now() - queuedAt };
    check('real upstream grant is removed only from u1 while its existing session remains', denied.value?.status === 'failed' && allowed.value?.status === 'ok' && (await request(clients.u1, apiBase + '/session')).value?.user?.id === account.id, details.permissionChange);
    proxy.releaseAll();
    await verifyBody(clients.u2, other, tracks[2], 'a live co-consumer survives another user’s real source revocation');
    await verifyBody(clients.u2, neighbor, tracks[3], 'the independent peer file also succeeds during another user’s revocation');
    const revoked = await request(clients.u1, apiBase + '/tasks/' + first.id + '/audio');
    check('the revoked user cannot receive the shared original', [401, 403, 404].includes(revoked.status) && !revoked.headers.has('etag') && !revoked.headers.has('content-range'));
    check('dispatch observed the actual source denial after its original successful admission', proxy.traces.some(item => item.event === 'getSong' && item.role === 'u1' && item.label === fixture.files[2].label && item.status === 'failed'));
    await admin.native(route, 'PUT', { libraryIds: original }); changed = false;
    const recovered = await accept(2, clients.u1);
    await verifyBody(clients.u1, recovered, tracks[2], 'a new task works after restoring the real upstream grant');
    details.originalAssignmentRestored = true;
  } finally {
    if (changed) { await admin.native(route, 'PUT', { libraryIds: original }); details.originalAssignmentRestored = true; }
  }
});

await scenario('round-robin', ['u1', 'u2', 'u3'], async ({ app, proxy, clients, accept, block, tracks, details }) => {
  await block();
  const created = [];
  for (const [index, role] of [[2, 'u1'], [3, 'u1'], [4, 'u2'], [5, 'u2'], [6, 'u3'], [7, 'u3']]) created.push({ index, role, task: await accept(index, clients[role]) });
  await until(() => app.metrics.queuedPreparations === 6, 'six distinct waiting files');
  const initialBytes = (await inventory(app.cacheDir)).bytes;
  check('six waiting files own no extra file or disk reservation', (await inventory(app.cacheDir)).partials === 2 && app.metrics.reservedBytes === tracks[0].size + tracks[1].size && proxy.stats.openedStreams === 2);
  let releaseIndex = 0;
  const expected = [[2, 'u1'], [4, 'u2'], [6, 'u3'], [3, 'u1'], [5, 'u2'], [7, 'u3'], [8, 'u1']];
  const observed = [];
  for (let step = 0; step < expected.length; step++) {
    const [index, role] = expected[step];
    proxy.release(fixture.files[releaseIndex].label);
    await until(() => proxy.traces.filter(item => item.event === 'stream-open').length >= 3 + step, 'next single permitted source body');
    const event = proxy.traces.filter(item => item.event === 'stream-open')[2 + step]; observed.push({ label: event.label, role: event.role });
    check('dispatch ' + (step + 1) + ' preserves user rotation and within-user FIFO', event.label === fixture.files[index].label && event.role === role);
    releaseIndex = index;
    if (step === 0) created.push({ index: 8, role: 'u1', task: await accept(8, clients.u1) });
  }
  proxy.releaseAll();
  for (const { index, role, task } of created) await verifyBody(clients[role], task, tracks[index], 'scheduled ' + fixture.files[index].label + ' has its exact original bytes');
  details.expected = expected.map(([index, role]) => ({ label: fixture.files[index].label, role })); details.observed = observed; details.initialPartialBytes = initialBytes;
});

await scenario('limits', ['u1', 'u2', 'u3', 'u4'], async ({ app, proxy, clients, accept, admit, block, tracks, details }) => {
  const second = await clientFor(app, fixture, 'u1', logins);
  await block(); const queued = [];
  for (let index = 2; index < 6; index++) queued.push({ client: clients.u1, task: await accept(index, clients.u1) });
  const refused = await admit(6, second);
  check('another session of the same real user shares the four-file waiting budget', refused.status === 429 && refused.value?.error?.code === 'preparation_user_limit');
  const firstPeer = await accept(6, clients.u2); queued.push({ client: clients.u2, task: firstPeer });
  check('another real user can still use its own waiting budget', firstPeer.state === 'preparing');
  for (let index = 7; index < 18; index++) {
    const role = index < 10 ? 'u2' : index < 14 ? 'u3' : 'u4';
    queued.push({ client: clients[role], task: await accept(index, clients[role]) });
  }
  await until(() => app.metrics.queuedPreparations === 16, 'sixteen waiting representations across four users');
  const full = await admit(18, clients.u4);
  check('sixteen waiting representations impose the global limit', full.status === 429 && full.value?.error?.code === 'preparation_queue_full');
  const shared = await accept(2, clients.u2);
  check('a co-consumer can join existing work when the global queue is full', shared.state === 'preparing' && app.metrics.queuedPreparations === 16);
  check('waiting across four identities still opens only two source files', proxy.stats.openedStreams === 2 && (await inventory(app.cacheDir)).partials === 2 && app.metrics.reservedBytes === tracks[0].size + tracks[1].size);
  await cancel(clients.u1, queued[0].task);
  check('partial cancellation retains a co-consumer’s waiting position', app.metrics.queuedPreparations === 16);
  await cancel(clients.u2, shared);
  await until(() => app.metrics.queuedPreparations === 15, 'last consumer cancellation frees one shared position');
  const replacement = await accept(18, second);
  await until(() => app.metrics.queuedPreparations === 16, 'replacement occupies the newly freed place');
  check('last cancellation frees both the global and original user allowance', replacement.state === 'preparing' && app.metrics.queuedPreparations === 16);
  details.peakWaiting = 16; details.realUsers = 4; details.sameUserSessions = 2;
});

await scenario('logout', ['u1', 'u2'], async ({ app, proxy, clients, accept, block, tracks, details }) => {
  await block();
  const first = await accept(2, clients.u1), other = await accept(2, clients.u2), removed = await accept(3, clients.u1), independent = await accept(4, clients.u2);
  await until(() => app.metrics.queuedPreparations === 3, 'three waiting representations');
  const response = await request(clients.u1, apiBase + '/session', { method: 'DELETE' });
  check('u1 logout succeeds through its own live session', [200, 204].includes(response.status));
  await until(() => app.metrics.queuedPreparations === 2, 'logout removes only work without another live consumer');
  const peer = await request(clients.u2, apiBase + '/session');
  check('u1 logout preserves the independent u2 session', peer.value?.user?.id === fixture.accounts.u2.id);
  proxy.releaseAll();
  await verifyBody(clients.u2, other, tracks[2], 'u2 receives the shared original after u1 logout');
  await verifyBody(clients.u2, independent, tracks[4], 'u2 receives its separate original after u1 logout');
  for (const task of [first, removed]) check('a logged-out consumer cannot use its former task', [401, 404].includes((await request(clients.u1, apiBase + '/tasks/' + task.id + '/audio')).status));
  check('the u1-only waiting file never starts after logout', !proxy.traces.some(item => item.event === 'stream-open' && item.label === fixture.files[3].label));
  check('the remaining shared download uses the live upstream identity', proxy.traces.some(item => item.event === 'stream-open' && item.label === fixture.files[2].label && item.role === 'u2'));
  details.realUsers = 2;
});

report.checkCount = checks.length; report.passed = checks.every(item => item.passed);
await writeFile(path.join(output, 'multi-user.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, scenarios: cases.length }));
if (!report.passed) process.exitCode = 1;
