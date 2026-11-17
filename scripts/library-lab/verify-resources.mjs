/** Real resource boundaries, compatible with the frozen pre-fix Rust binary.
 * LIBRARY_BACKEND=rust node verify-resources.mjs CONFIG CREDENTIALS FIXTURE_STATE OUTPUT
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiBase, rustBackend } from './backend.mjs';
import { json, pause, digest, until, inventory, request, startApp, login, createTask, ready, cancel, pacedReader, sourceProxy, sampler } from './resource-client.mjs';

assert.ok(rustBackend, 'Actual Rust backend required');
const [configFile, credentialsFile, fixtureFile, output] = process.argv.slice(2);
const config = await json(configFile), credentials = await json(credentialsFile), fixture = await json(fixtureFile);
const originalPolicy = await json(config.policyFile);
assert.ok(['127.0.0.1', '[::1]'].includes(new URL(config.source.baseUrl).hostname));
await mkdir(output, { recursive: true });
const checks = [], cases = [], apps = [], readers = [], samplers = [];
const report = { recordedAt: new Date().toISOString(), scope: 'Owned real Rust, Navidrome and TCP readers; no fake clock.', fixture: { bytes: fixture.track.size, sha256: fixture.track.sha256 }, checks, cases };
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
const first = originalPolicy.tracks.find(value => value.access === 'public');
const publicLarge = { ...fixture.track, access: 'public', allowedUserIds: [] };
const tracks = [...originalPolicy.tracks.filter(value => value.access === 'public'), publicLarge];
async function start(name, catalogue = tracks, changes = {}) {
  const app = await startApp(config, path.join(output, name), catalogue, changes); apps.push(app); return app;
}
async function scenario(name, action) {
  const begin = checks.length, started = performance.now();
  try { const details = await action(); cases.push({ name, completed: true, milliseconds: performance.now() - started, checks: checks.length - begin, ...details }); }
  catch (error) { check(name + ' completes without a harness failure', false, { error: error.message }); cases.push({ name, completed: false }); }
  console.log(JSON.stringify({ scenario: name, checks: checks.length - begin, failures: checks.slice(begin).filter(value => !value.passed).map(value => value.name) }));
}
const proxy = await sourceProxy(config);
try {
  await scenario('cancelled task admission recovers', async () => {
    const app = await start('churn', [first]); let completed = 0, rejection;
    for (let index = 0; index < 260; index++) {
      const created = await createTask(app, config, first);
      if (created.status !== 202) { rejection = { index, status: created.status, error: created.value?.error?.code }; break; }
      const task = await ready(app, created.value);
      assert.equal((await cancel(app, task)).status, 200); completed++;
    }
    check('260 create-ready-cancel cycles preserve admission', completed === 260, { completed, rejection });
    const admitted = await createTask(app, config, first);
    check('a cancelled task cannot exhaust the next playback slot for fifteen minutes', admitted.status === 202, { status: admitted.status, error: admitted.value?.error?.code });
    if (admitted.status === 202) { const task = await ready(app, admitted.value); await cancel(app, task); }
    check('churn keeps one verified cached representation', (await inventory(app.cacheDir)).files.filter(value => value.name.endsWith('.audio')).length === 1);
    const counters = app.metrics; await app.close(); return { completed, counters };
  });
  await scenario('one cold original has multiple independent consumers', async () => {
    proxy.control.hold = true;
    const before = { ...proxy.stats }, app = await start('shared-download', [publicLarge], { source: proxy.source });
    const tasks = [];
    for (let index = 0; index < 16; index++) {
      const value = await createTask(app, config, publicLarge); assert.equal(value.status, 202); tasks.push(value.value);
    }
    await until(async () => (await inventory(app.cacheDir)).bytes >= 4096, 'a real shared partial');
    check('sixteen cold tasks share one original transfer', proxy.stats.streamsStarted - before.streamsStarted === 1 && app.metrics.sourceDownloads === 1);
    for (const task of tasks.slice(0, -1)) assert.equal((await cancel(app, task)).status, 200);
    check('cancelling fifteen consumers preserves the remaining transfer', proxy.stats.activeStreams === 1 && (await inventory(app.cacheDir)).partials === 1);
    const started = performance.now(); await cancel(app, tasks.at(-1));
    const elapsed = await until(async () => proxy.stats.activeStreams === 0 && (await inventory(app.cacheDir)).partials === 0 && app.metrics.reservedBytes === 0, 'last consumer resource release');
    check('last consumer closes the real source and partial within seven seconds', elapsed <= 7000);
    check('cancelled shared original leaves no complete file', (await inventory(app.cacheDir)).bytes === 0);
    const counters = app.metrics; await app.close(); proxy.control.hold = false;
    return { releaseMilliseconds: performance.now() - started, counters };
  });
  await scenario('download admission queues and recovers', async () => {
    proxy.control.hold = true;
    const app = await start('download-limit', tracks, { source: proxy.source }), tasks = [];
    for (const track of tracks.slice(0, 2)) { const response = await createTask(app, config, track); assert.equal(response.status, 202); tasks.push(response.value); }
    await until(() => proxy.stats.activeStreams === 2, 'two real held upstream streams');
    const queued = await createTask(app, config, publicLarge);
    check('third distinct cold original waits behind two active preparations', queued.status === 202 && queued.value?.state === 'preparing');
    check('waiting opens no third source stream', proxy.stats.activeStreams === 2);
    if (queued.status === 202) await cancel(app, queued.value);
    for (const task of tasks) await cancel(app, task);
    await until(async () => proxy.stats.activeStreams === 0 && app.metrics.reservedBytes === 0, 'download slots recover');
    proxy.control.hold = false;
    const replacement = await createTask(app, config, publicLarge); check('released download slots admit a new original', replacement.status === 202);
    const task = await ready(app, replacement.value), body = await request(app, task.mediaUrl);
    check('recovered original equals the real source', body.status === 200 && body.body.length === fixture.track.size && digest(body.body) === fixture.track.sha256);
    await cancel(app, task); await app.close();
  });
  await scenario('logout while a private TCP reader is stalled', async () => {
    const app = await start('logout', [fixture.track]); await login(app, credentials.accounts.a);
    const created = await createTask(app, config, fixture.track); assert.equal(created.status, 202);
    const task = await ready(app, created.value);
    const monitor = await sampler(app, path.join(output, 'logout-process.jsonl')); samplers.push(monitor);
    const reader = await pacedReader(app, task.mediaUrl); readers.push(reader);
    await pause(1500); await request(app, apiBase + '/session');
    check('private reader produces real backpressure before EOF', reader.bytes > 0 && reader.bytes < fixture.track.size && app.metrics.activeFileLeases > 0,
      { bytesRead: reader.bytes, fileBytes: fixture.track.size, leases: app.metrics.activeFileLeases });
    const before = { ...app.metrics }, revokedAt = new Date().toISOString();
    assert.equal((await request(app, apiBase + '/session', { method: 'DELETE' })).status, 200);
    let released = false, releaseMilliseconds;
    try { releaseMilliseconds = await until(() => app.metrics.activeFileLeases === 0, 'logout releases a stalled media file'); released = true; } catch {}
    check('logout releases the stalled private media file within seven seconds', released, { before: before.activeFileLeases, after: app.metrics.activeFileLeases });
    const opens = app.metrics.mediaOpens, denied = await request(app, task.mediaUrl, { headers: { range: 'bytes=100-200' } });
    check('revoked cookie cannot start another private Range', denied.status === 401 && app.metrics.mediaOpens === opens);
    const stalled = { ...app.metrics }, beforeDrain = reader.bytes;
    reader.resume(); const delivery = await reader.done;
    check('logout prevents completing an undelivered private original', !delivery.complete && delivery.bytes < fixture.track.size,
      { complete: delivery.complete, bytes: delivery.bytes, fileBytes: fixture.track.size });
    reader.close(); await until(() => app.metrics.activeFileLeases === 0, 'closed TCP reader lease');
    check('client disconnect eventually releases the private response lease', app.metrics.activeFileLeases === 0);
    await pause(1500); await monitor.stop(); await app.close();
    return { revokedAt, beforeDrain, releaseMilliseconds, before, stalled, delivery };
  });
  await scenario('one task cannot open unlimited media responses', async () => {
    const app = await start('media-limit', [publicLarge]);
    const task = await ready(app, (await createTask(app, config, publicLarge)).value);
    const monitor = await sampler(app, path.join(output, 'media-limit-process.jsonl')); samplers.push(monitor);
    const held = [], responses = [];
    for (let index = 0; index < 40; index++) {
      const reader = await pacedReader(app, task.mediaUrl); readers.push(reader); held.push(reader); responses.push(reader.status);
    }
    await request(app, apiBase + '/session');
    const accepted = responses.filter(value => value === 200).length, rejected = responses.filter(value => value === 429).length;
    check('media admission bounds one task to at most thirty-two concurrent responses', accepted <= 32 && rejected >= 8, { accepted, rejected, leases: app.metrics.activeFileLeases });
    const during = { ...app.metrics };
    for (const reader of held) reader.close();
    await until(() => app.metrics.activeFileLeases === 0, 'all disconnected response leases');
    check('all disconnected readers release their cached file leases', app.metrics.activeFileLeases === 0);
    const restored = await request(app, task.mediaUrl, { headers: { range: 'bytes=65536-69631' } });
    check('media admission recovers after clients disconnect', restored.status === 206 && restored.body.length === 4096);
    await cancel(app, task); await monitor.stop(); await app.close();
    return { accepted, rejected, during };
  });
} finally {
  for (const reader of readers) reader.close();
  for (const monitor of samplers) await monitor.stop().catch(() => {});
  for (const app of apps.reverse()) await app.close().catch(() => {});
  await proxy.close(); report.proxy = proxy.stats;
  report.checkCount = checks.length; report.passed = checks.every(value => value.passed) && !proxy.stats.errors.length;
  await writeFile(path.join(output, 'resources.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(value => !value.passed).map(value => value.name) }));
  if (!report.passed) process.exitCode = 1;
}
