/** Bounded preparation against owned Navidrome originals and a holding proxy.
 * LIBRARY_BACKEND=rust node verify-preparation-queue.mjs CONFIG CREDENTIALS FIXTURE_STATE OUTPUT
 * QUEUE_PUBLIC_ONLY=1 records the pre-queue binary's public admission counterexamples.
 * QUEUE_CASES=name,name selects a targeted retest. Private cases are paced before
 * starting their source blockers so native login throttling remains enabled.
 * A source-denial case injects a labelled protocol fault after real admission;
 * it does not change the Navidrome users or their permissions.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apiBase, rustBackend } from './backend.mjs';
import { json, pause, digest, until, inventory, request, startApp, login, createTask, ready, cancel, sourceProxy } from './resource-client.mjs';

assert.ok(rustBackend);
const [configFile, credentialsFile, fixtureFile, output] = process.argv.slice(2);
const config = await json(configFile), credentials = await json(credentialsFile), fixture = await json(fixtureFile);
const policy = await json(config.policyFile), publicTracks = policy.tracks.filter(track => track.access === 'public');
assert.equal(publicTracks.length, 2);
assert.equal(digest(await readFile(fixture.file)), fixture.track.sha256);
try { await stat(path.join(output, 'queue.json')); throw new Error('Use a new report directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.MHUB_RUST_BINARY || path.join(repo, 'target/debug/music-api.exe');
const checks = [], cases = [], publicOnly = process.env.QUEUE_PUBLIC_ONLY === '1';
const selected = process.env.QUEUE_CASES?.split(',').filter(Boolean);
let previousPrivateStart = 0;
const report = { recordedAt: new Date().toISOString(), binarySHA256: digest(await readFile(binary)),
  fixture: { bytes: fixture.track.size, sha256: fixture.track.sha256 }, selectedCases: selected || null, scope: publicOnly ? 'Public pre-queue admission comparison' : 'Real owned source; real elapsed deadlines; explicit source-denial fault only in its labelled case', checks, cases };
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
const publicLarge = { ...fixture.track, access: 'public', allowedUserIds: [] };

async function scenario(name, target, action, changes = {}) {
  if (selected && !selected.includes(name)) return;
  if (target.access === 'restricted') {
    await pause(Math.max(0, 30000 - (performance.now() - previousPrivateStart)) * Number(previousPrivateStart > 0));
    previousPrivateStart = performance.now();
  }
  const started = performance.now(), begin = checks.length, tasks = [];
  const proxy = await sourceProxy(config); proxy.control.hold = true;
  let app, details, failure;
  try {
    app = await startApp(config, path.join(output, name), [...publicTracks, target], { ...changes, source: proxy.source });
    const create = async (track, client = app) => {
      const response = await createTask(client, config, track);
      if (response.status === 202) tasks.push({ client, task: response.value });
      return response;
    };
    const blockers = [];
    for (const track of publicTracks) {
      const response = await create(track); assert.equal(response.status, 202, 'Owned blocking task admission'); blockers.push(response.value);
    }
    await until(() => proxy.stats.activeStreams === 2, 'two real source streams held');
    const admit = async (client = app) => {
      const response = await create(target, client);
      check(name + ': third representation enters bounded waiting', response.status === 202 && response.value?.state === 'preparing', { status: response.status, error: response.value?.error?.code });
      return response.status === 202 ? response.value : null;
    };
    const release = async () => {
      proxy.control.hold = false;
      for (const task of blockers) await cancel(app, task);
    };
    details = await action({ app, proxy, target, create, admit, release, blockers });
  } catch (error) {
    failure = error.message;
    check(name + ': no experiment prerequisite or harness failure', false, { error: failure });
  } finally {
    proxy.control.denySongId = null; proxy.control.denyUsername = null;
    if (app) {
      for (const { client, task } of tasks) await cancel(client, task).catch(() => {});
      await app.close();
    }
    await proxy.close();
  }
  cases.push({ name, milliseconds: performance.now() - started, checkCount: checks.length - begin, ...(details || {}), ...(failure ? { failure } : {}), proxy: { ...proxy.stats } });
  console.log(JSON.stringify({ scenario: name, checks: checks.length - begin, failures: checks.slice(begin).filter(item => !item.passed).map(item => item.name) }));
}
const unavailable = { dependentAssertionsSkipped: 'The old binary rejected admission, so there is no queued task to exercise.' };
async function verifyBody(app, task, name) {
  const value = await ready(app, task), body = await request(app, value.mediaUrl);
  check(name, body.status === 200 && body.body.length === fixture.track.size && digest(body.body) === fixture.track.sha256);
  return value;
}
const clientFor = async (app, role) => { const client = { origin: app.origin }; await login(client, credentials.accounts[role]); return client; };

await scenario('coalescing', publicLarge, async ({ app, proxy, create, admit, release }) => {
  const first = await admit(); if (!first) return unavailable;
  const consumers = [first];
  for (let index = 0; index < 7; index++) { const response = await create(publicLarge); assert.equal(response.status, 202); consumers.push(response.value); }
  await until(() => app.metrics.queuedPreparations === 1, 'one coalesced waiting representation');
  check('eight queued consumers occupy one job and no third source stream', app.metrics.activeJobs === 3 && proxy.stats.activeStreams === 2 && proxy.stats.streamsStarted === 2);
  const disk = await inventory(app.cacheDir);
  check('waiting owns no third partial file or disk reservation', disk.partials === 2 && app.metrics.reservedBytes === publicTracks.reduce((sum, track) => sum + track.size, 0));
  for (const task of consumers.slice(0, -1)) await cancel(app, task);
  check('partial cancellation keeps the remaining queued consumer', app.metrics.queuedPreparations === 1 && app.metrics.activeJobs === 3);
  await release();
  const task = await verifyBody(app, consumers.at(-1), 'queued original starts when a slot opens and matches source bytes');
  await cancel(app, task);
  await until(() => app.metrics.activeJobs === 0 && app.metrics.queuedPreparations === 0 && app.metrics.activeFileLeases === 0 && app.metrics.reservedBytes === 0, 'coalesced job release');
  check('preparation stays at two actual source streams through handoff', proxy.stats.peakStreams === 2 && proxy.stats.streamsStarted === 3);
  check('completed queued work releases transient resources', app.metrics.runningPreparations === 0 && app.metrics.activeTasks === 0);
  return { counters: app.metrics };
});

await scenario('cancel-and-reuse', publicLarge, async ({ app, proxy, admit, release }) => {
  const first = await admit(); if (!first) return unavailable;
  await pause(3500);
  await cancel(app, first);
  await until(() => app.metrics.queuedPreparations === 0 && app.metrics.activeJobs === 2, 'last queued consumer removal');
  check('last cancellation frees the waiting position without starting source I/O', proxy.stats.streamsStarted === 2);
  const next = await admit(); assert.ok(next);
  await pause(1800);
  const status = await request(app, apiBase + '/tasks/' + next.id);
  check('a retired deadline cannot expire new work for the same representation', status.value?.state === 'preparing' && app.metrics.preparationTimeouts === 0 && first.id !== next.id);
  await release(); await verifyBody(app, next, 'the replacement queued task completes correctly');
});

await scenario('wait-timeout', publicLarge, async ({ app, proxy, create, admit, release }) => {
  const started = performance.now(), first = await admit(); if (!first) return unavailable;
  await pause(3000);
  const join = await create(publicLarge); assert.equal(join.status, 202);
  // No HTTP requests while waiting for the monotonic queue deadline.
  await until(() => app.metrics.preparationTimeouts === 1 && app.metrics.queuedPreparations === 0, 'real queue timeout without traffic', 6000);
  const elapsed = performance.now() - started;
  check('joining consumers do not extend the five-second waiting deadline', elapsed >= 4000 && elapsed <= 7000, { observedMilliseconds: elapsed });
  const statuses = await Promise.all([first, join.value].map(task => request(app, apiBase + '/tasks/' + task.id)));
  check('all timed-out consumers expose failed preparation_timeout', statuses.every(response => response.status === 200 && response.value.state === 'failed' && response.value.error === 'preparation_timeout'));
  check('timed-out waiting never opened its source or reserved disk', proxy.stats.streamsStarted === 2 && app.metrics.activeJobs === 2 && (await inventory(app.cacheDir)).partials === 2);
  const next = await admit(); assert.ok(next); await release(); await verifyBody(app, next, 'retry after queue timeout succeeds with the real original');
  return { observedWaitMilliseconds: elapsed, counters: app.metrics };
});

await scenario('waiting-task-expiry', publicLarge, async ({ app, proxy, admit }) => {
  const task = await admit(); if (!task) return unavailable;
  await until(() => app.metrics.activeTasks === 0 && app.metrics.activeJobs === 0, 'public tasks expire without HTTP traffic', 7500);
  check('expired waiting task cannot consume a newly freed slot', proxy.stats.streamsStarted === 2 && app.metrics.queuedPreparations === 0);
  check('task expiry releases both held sources partials and reservations', proxy.stats.activeStreams === 0 && (await inventory(app.cacheDir)).partials === 0 && app.metrics.reservedBytes === 0);
  check('expired waiting task URL is no longer available', (await request(app, apiBase + '/tasks/' + task.id)).status === 404);
}, { taskTtlSeconds: 2 });

await scenario('waiting-retirement', publicLarge, async ({ app, proxy, admit, release }) => {
  const task = await admit(); if (!task) return unavailable;
  await writeFile(app.policyFile, JSON.stringify({ instanceId: config.source.instanceId, tracks: publicTracks }));
  await release();
  await until(() => app.metrics.activeJobs === 0 && app.metrics.queuedPreparations === 0, 'retired waiting work settles');
  check('retired representation is rechecked before opening its source', proxy.stats.streamsStarted === 2 && app.metrics.sourceDownloads === 2);
  check('retired queued task cannot expose media', (await request(app, apiBase + '/tasks/' + task.id + '/audio')).status === 404);
  check('retirement leaves no queued reservation or published bytes', app.metrics.reservedBytes === 0 && (await inventory(app.cacheDir)).bytes === 0);
});

if (!publicOnly) {
  const sharedPrivate = { ...fixture.track, allowedUserIds: [credentials.accounts.a.id, credentials.accounts.b.id] };
  await scenario('waiting-logout', sharedPrivate, async ({ app, proxy, create, admit, release }) => {
    const a = await clientFor(app, 'a'), b = await clientFor(app, 'b');
    const taskA = await admit(a); if (!taskA) return unavailable;
    const taskB = await create(sharedPrivate, b); assert.equal(taskB.status, 202, 'Owned B can join this explicitly shared test track');
    assert.equal((await request(a, apiBase + '/session', { method: 'DELETE' })).status, 200);
    check('logout removes only its own queued consumer', app.metrics.queuedPreparations === 1 && app.metrics.activeJobs === 3 && proxy.stats.streamsStarted === 2);
    check('logged-out consumer cannot reuse its waiting task', (await request(a, apiBase + '/tasks/' + taskA.id)).status === 401);
    await release(); await verifyBody(b, taskB.value, 'remaining live identity prepares and receives the original after creator logout');
  });

  await scenario('waiting-session-expiry', fixture.track, async ({ app, proxy, admit, release }) => {
    const a = await clientFor(app, 'a'), task = await admit(a); if (!task) return unavailable;
    await until(() => app.metrics.activeSessions === 0 && app.metrics.queuedPreparations === 0 && app.metrics.activeJobs === 2, 'session expires without later HTTP traffic', 7500);
    check('natural session expiry removes its waiting work without source I/O', proxy.stats.streamsStarted === 2);
    const denied = await request(a, apiBase + '/tasks/' + task.id);
    check('expired private waiting URL cannot be used', [401, 404].includes(denied.status), { status: denied.status });
    await release(); await pause(150);
    check('expired waiting identity cannot start late when slots become free', proxy.stats.streamsStarted === 2 && app.metrics.reservedBytes === 0);
  }, { sessionTtlSeconds: 2 });

  await scenario('waiting-policy-denial', fixture.track, async ({ app, proxy, admit, release }) => {
    const a = await clientFor(app, 'a'), task = await admit(a); if (!task) return unavailable;
    const denied = { ...fixture.track, allowedUserIds: [credentials.accounts.b.id] };
    await writeFile(app.policyFile, JSON.stringify({ instanceId: config.source.instanceId, tracks: [...publicTracks, denied] }));
    await release();
    await until(() => app.metrics.activeJobs === 0, 'queued local authorization denial settles');
    check('current allowlist is checked again before preparing private bytes', proxy.stats.streamsStarted === 2 && (await inventory(app.cacheDir)).bytes === 0);
    check('revoked consumer is denied on its queued task', (await request(a, apiBase + '/tasks/' + task.id)).status === 403);
    check('denied queued work releases its position and reservations', app.metrics.queuedPreparations === 0 && app.metrics.reservedBytes === 0);
  });

  await scenario('waiting-source-denial', sharedPrivate, async ({ app, proxy, create, admit, release }) => {
    const a = await clientFor(app, 'a'), b = await clientFor(app, 'b');
    const taskA = await admit(a); if (!taskA) return unavailable;
    const taskB = await create(sharedPrivate, b); assert.equal(taskB.status, 202);
    proxy.control.denySongId = fixture.track.songId;
    proxy.control.denyUsername = credentials.accounts.a.username;
    await release();
    await verifyBody(b, taskB.value, 'another valid consumer can prepare after the first source grant is denied');
    check('waiting rechecks source qualification after its original admission', proxy.stats.deniedMetadata >= 1);
    check('source-denied consumer cannot access its prepared task', (await request(a, apiBase + '/tasks/' + taskA.id)).status === 403);
    check('fallback authorization still shares one correct original download', proxy.stats.streamsStarted === 3 && proxy.stats.peakStreams === 2);
    return { injectedSourceDenial: true, navidromeAccountPermissionsChanged: false };
  });
}
report.checkCount = checks.length;
report.passed = checks.every(item => item.passed);
report.actualSourcePermissionChanges = false;
await writeFile(path.join(output, 'queue.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, cases: cases.length, failed: checks.filter(item => !item.passed).length }));
if (!report.passed) process.exitCode = 1;
