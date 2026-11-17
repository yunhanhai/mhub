/** Natural expiry with real clocks, real sessions and a stalled TCP receiver.
 * LIBRARY_BACKEND=rust node verify-resource-expiry.mjs CONFIG CREDENTIALS FIXTURE_STATE OUTPUT
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiBase, rustBackend } from './backend.mjs';
import { json, pause, digest, until, inventory, request, startApp, login, createTask, ready, cancel, pacedReader, sourceProxy, sampler } from './resource-client.mjs';

assert.ok(rustBackend);
const [configFile, credentialsFile, fixtureFile, output] = process.argv.slice(2);
const config = await json(configFile), credentials = await json(credentialsFile), fixture = await json(fixtureFile);
const original = await readFile(fixture.file), originalPolicy = await json(config.policyFile);
assert.equal(digest(original), fixture.track.sha256);
const publicLarge = { ...fixture.track, access: 'public', allowedUserIds: [] };
const first = originalPolicy.tracks.find(track => track.access === 'public');
await mkdir(output, { recursive: true });
const checks = [], cases = [], apps = [], readers = [], monitors = [];
const report = { recordedAt: new Date().toISOString(), clock: 'Real wall clock and Tokio timers; no system time change.', checks, cases };
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
const proxy = await sourceProxy(config);
async function start(name, tracks, changes) { const app = await startApp(config, path.join(output, name), tracks, changes); apps.push(app); return app; }
async function observe(app, name) {
  const monitor = await sampler(app, path.join(output, name + '-process.jsonl')); monitors.push(monitor); return monitor;
}
async function scenario(name, action) {
  const before = checks.length;
  try { cases.push({ name, completed: true, ...await action() }); }
  catch (error) { check(name + ' completes without a harness failure', false, { error: error.message }); cases.push({ name, completed: false }); }
  console.log(JSON.stringify({ scenario: name, checks: checks.length - before, failures: checks.slice(before).filter(value => !value.passed).map(value => value.name) }));
}
try {
  await scenario('session expiry cancels a held original without another HTTP request', async () => {
    proxy.control.hold = true;
    const app = await start('preparing', [fixture.track], { source: proxy.source, sessionTtlSeconds: 12, taskTtlSeconds: 60 });
    const cookie = await login(app, credentials.accounts.a);
    check('short session uses the real twelve-second cookie lifetime', /Max-Age=12(?:;|$)/.test(cookie));
    const task = (await createTask(app, config, fixture.track)).value;
    assert.ok(task.id); const expectedExpiry = task.expiresAt;
    const monitor = await observe(app, 'preparing');
    await until(async () => proxy.stats.activeStreams === 1 && (await inventory(app.cacheDir)).bytes === 4096, 'held private original');
    const before = { ...app.metrics }, quietFrom = new Date().toISOString();
    const remaining = Math.max(0, expectedExpiry - Date.now());
    await until(async () => app.metrics.activeSessions === 0 && app.metrics.activeTasks === 0 && app.metrics.taskSlots === 0 && app.metrics.activeJobs === 0
      && app.metrics.reservedBytes === 0 && app.metrics.activeFileLeases === 0 && proxy.stats.activeStreams === 0 && (await inventory(app.cacheDir)).bytes === 0,
    'natural session cleanup without HTTP', remaining + 7000);
    const releasedAt = Date.now(), after = { ...app.metrics };
    check('natural expiry removes session task job partial and reservation without traffic', true, { delayAfterExpiryMs: releasedAt - expectedExpiry });
    check('expiry closes the upstream before its twenty-second request timeout', releasedAt - expectedExpiry < 7000 && releasedAt - Date.parse(quietFrom) < 19000);
    const sourceRequests = after.sourceRequests, denied = await createTask(app, config, fixture.track);
    check('expired cookie cannot open a new private original', denied.status === 401 && app.metrics.sourceRequests === sourceRequests);
    await monitor.stop(); await app.close(); proxy.control.hold = false;
    return { expectedExpiry, quietFrom, releasedAt, before, after };
  });
  await scenario('session expiry closes a backpressured private response', async () => {
    const app = await start('streaming', [fixture.track], { sessionTtlSeconds: 12, taskTtlSeconds: 60 });
    await login(app, credentials.accounts.a);
    const task = await ready(app, (await createTask(app, config, fixture.track)).value), expectedExpiry = task.expiresAt;
    const monitor = await observe(app, 'streaming');
    const reader = await pacedReader(app, task.mediaUrl, { timeout: 40000 }); readers.push(reader);
    await pause(1000); await request(app, apiBase + '/session');
    check('expiry scenario holds a real private file open under TCP backpressure', reader.bytes > 0 && reader.bytes < original.length && app.metrics.activeFileLeases === 1);
    const before = { ...app.metrics }, quietFrom = new Date().toISOString();
    await until(() => app.metrics.activeFileLeases === 0 && app.metrics.activeMediaResponses === 0 && app.metrics.activeSessions === 0 && app.metrics.taskSlots === 0,
      'expired stalled private response', Math.max(0, expectedExpiry - Date.now()) + 7000);
    const releasedAt = Date.now(), after = { ...app.metrics };
    check('natural session expiry releases the stalled file and response slot without traffic', releasedAt - expectedExpiry <= 7000 && after.interruptedMedia >= 1);
    reader.resume(); const body = await reader.done;
    check('expired private response cannot complete its original', !body.complete && body.bytes < original.length && body.sha256 === digest(original.subarray(0, body.bytes)), { bytes: body.bytes, fileBytes: original.length });
    const opens = after.mediaOpens, denied = await createTask(app, config, fixture.track);
    check('expired session denial does not reopen cached private bytes', denied.status === 401 && app.metrics.mediaOpens === opens);
    check('expiry retains a valid cached representation for future authorized reuse', (await inventory(app.cacheDir)).bytes === original.length && app.metrics.reservedBytes === 0);
    await pause(1100); await monitor.stop(); await app.close();
    return { expectedExpiry, quietFrom, releasedAt, before, after, body };
  });
  await scenario('public task expiry releases readers and cache eviction pins', async () => {
    const app = await start('task', [publicLarge, first], { taskTtlSeconds: 8, cacheMaxBytes: publicLarge.size });
    const task = await ready(app, (await createTask(app, config, publicLarge)).value), expectedExpiry = task.expiresAt;
    const monitor = await observe(app, 'task');
    const reader = await pacedReader(app, task.mediaUrl, { timeout: 35000 }); readers.push(reader);
    await pause(700); await request(app, apiBase + '/session');
    check('public expiry scenario holds a file lease before the deadline', app.metrics.activeFileLeases === 1);
    const quietFrom = new Date().toISOString();
    await until(() => app.metrics.taskSlots === 0 && app.metrics.activeMediaResponses === 0 && app.metrics.activeFileLeases === 0,
      'natural public task expiry', Math.max(0, expectedExpiry - Date.now()) + 7000);
    const releasedAt = Date.now(), after = { ...app.metrics };
    check('natural task expiry removes its task and stalled response without traffic', releasedAt - expectedExpiry <= 7000);
    reader.resume(); const body = await reader.done;
    check('expired task stops before sending the whole file', !body.complete && body.bytes < original.length && body.sha256 === digest(original.subarray(0, body.bytes)));
    check('old expired task URL is no longer usable', (await request(app, task.mediaUrl)).status === 404);
    const reused = await ready(app, (await createTask(app, config, publicLarge)).value);
    const range = await request(app, reused.mediaUrl, { headers: { range: 'bytes=65536-69631' } });
    check('a new valid task reuses verified bytes after expiry', range.status === 206 && range.body.equals(original.subarray(65536, 69632)) && app.metrics.sourceDownloads === 1 && app.metrics.cacheHits >= 1);
    await cancel(app, reused);
    const replacement = await ready(app, (await createTask(app, config, first)).value);
    check('expired and cancelled tasks do not prevent quota eviction', replacement.state === 'ready' && (await inventory(app.cacheDir)).bytes === first.size && app.metrics.cacheEvictions >= 1);
    await cancel(app, replacement); await monitor.stop(); await app.close();
    return { expectedExpiry, quietFrom, releasedAt, after, body };
  });
  await scenario('explicit task cancellation closes a stalled public response', async () => {
    const app = await start('cancel', [publicLarge]);
    const task = await ready(app, (await createTask(app, config, publicLarge)).value);
    const reader = await pacedReader(app, task.mediaUrl); readers.push(reader);
    await pause(700); await request(app, apiBase + '/session');
    assert.equal(app.metrics.activeFileLeases, 1);
    const started = performance.now(); assert.equal((await cancel(app, task)).status, 200);
    await until(() => app.metrics.activeFileLeases === 0 && app.metrics.activeMediaResponses === 0, 'explicit task cancellation');
    check('explicit task cancellation releases a stalled response within seven seconds', performance.now() - started < 7000);
    reader.resume(); const body = await reader.done;
    check('explicit cancellation stops at a valid prefix of the original', !body.complete && body.bytes < original.length && body.sha256 === digest(original.subarray(0, body.bytes)));
    await app.close(); return { body };
  });
  await scenario('write inactivity closes a stalled receiver and frees its slot', async () => {
    const app = await start('write-idle', [publicLarge]);
    const task = await ready(app, (await createTask(app, config, publicLarge)).value);
    const monitor = await observe(app, 'write-idle');
    const reader = await pacedReader(app, task.mediaUrl, { timeout: 45000 }); readers.push(reader);
    await pause(800); await request(app, apiBase + '/session'); assert.equal(app.metrics.activeFileLeases, 1);
    const quietFrom = new Date().toISOString(), started = performance.now();
    await until(() => app.metrics.activeFileLeases === 0 && app.metrics.activeMediaResponses === 0, 'write idle deadline', 23000);
    const elapsed = performance.now() - started, after = { ...app.metrics };
    check('write inactivity releases the file and media slot', elapsed <= 23000 && after.activeTasks === 1 && after.interruptedMedia === 0, { milliseconds: elapsed });
    reader.resume(); const body = await reader.done;
    check('timed-out response contains only an incomplete valid original prefix', !body.complete && body.bytes < original.length && body.sha256 === digest(original.subarray(0, body.bytes)));
    const retry = await request(app, task.mediaUrl, { headers: { range: 'bytes=4096-8191' } });
    check('the task can open another correct Range after write inactivity', retry.status === 206 && retry.body.equals(original.subarray(4096, 8192)));
    await cancel(app, task); await monitor.stop(); await app.close(); return { quietFrom, elapsed, after, body };
  });
} finally {
  for (const reader of readers) reader.close();
  for (const monitor of monitors) await monitor.stop().catch(() => {});
  for (const app of apps.reverse()) await app.close().catch(() => {});
  await proxy.close(); report.proxy = proxy.stats;
  report.checkCount = checks.length; report.passed = checks.every(value => value.passed) && !proxy.stats.errors.length;
  await writeFile(path.join(output, 'expiry.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(value => !value.passed).map(value => value.name) }));
  if (!report.passed) process.exitCode = 1;
}
