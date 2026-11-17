/** Closed-loop, paced original-file trials. All failures remain in denominators.
 * LIBRARY_BACKEND=rust RESOURCE_PYTHON=... node benchmark-resources.mjs CONFIG CREDENTIALS FIXTURE_STATE OUTPUT
 * RESOURCE_LEVELS=1,4,8,16,32 RESOURCE_WINDOW_SECONDS=20 RESOURCE_REPETITIONS=2
 * RESOURCE_SOAK_SECONDS=180 RESOURCE_SOAK_CLIENTS=16 RESOURCE_NAV_PID=<owned PID>
 * Use a fresh directory. This does not model open-loop arrivals or WAN shaping.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiBase, rustBackend } from './backend.mjs';
import { json, pause, digest, until, inventory, request, startApp, login, createTask, ready, cancel, pacedReader, sampler } from './resource-client.mjs';

assert.ok(rustBackend);
const [configFile, credentialsFile, fixtureFile, output] = process.argv.slice(2);
const config = await json(configFile), credentials = await json(credentialsFile), fixture = await json(fixtureFile);
const original = await readFile(fixture.file); assert.equal(digest(original), fixture.track.sha256);
assert.ok(['127.0.0.1', '[::1]'].includes(new URL(config.source.baseUrl).hostname));
try { await stat(path.join(output, 'capacity.json')); throw new Error('Benchmark output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
const levels = (process.env.RESOURCE_LEVELS || '1,4,8,16,32').split(',').map(Number);
const seconds = Number(process.env.RESOURCE_WINDOW_SECONDS || 20), repetitions = Number(process.env.RESOURCE_REPETITIONS || 2);
const soakSeconds = Number(process.env.RESOURCE_SOAK_SECONDS || 180), soakClients = Number(process.env.RESOURCE_SOAK_CLIENTS || 16);
const mixedLevels = (process.env.RESOURCE_MIXED_LEVELS || '4,8,16').split(',').map(Number);
const mixedSeconds = Number(process.env.RESOURCE_MIXED_SECONDS || 30);
assert.ok(levels.every(value => Number.isInteger(value) && value >= 1 && value <= 64));
assert.ok(seconds >= 2 && seconds <= 120 && repetitions >= 1 && repetitions <= 3 && soakSeconds >= 0 && soakSeconds <= 1200 && soakClients >= 1 && soakClients <= 32);
assert.ok(mixedSeconds >= 2 && mixedSeconds <= 120 && mixedLevels.every(value => Number.isInteger(value) && value >= 1 && value <= 32));
const pace = 128 * 1024, apps = [], readers = new Set(), samples = [], phases = [], checks = [];
let monitor, app, metricsTimer;
const quantile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
const report = { recordedAt: new Date().toISOString(), profile: process.env.RESOURCE_PROFILE || 'unspecified',
  methodology: 'Closed-loop clients, application-read pacing, real private Navidrome identity and immutable originals; source OS/page caches uncontrolled; final drain excluded from steady window.',
  host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBeforeBytes: os.freemem(), node: process.version },
  fixture: { bytes: original.length, sha256: fixture.track.sha256, durationMilliseconds: fixture.track.duration },
  configuration: { levels, seconds, repetitions, soakSeconds, soakClients, mixedLevels, mixedSeconds, bytesPerSecondPerClient: pace }, phases, checks };
const binary = process.env.MHUB_RUST_BINARY || fileURLToPath(new URL('../../target/debug/' + (process.platform === 'win32' ? 'music-api.exe' : 'music-api'), import.meta.url));
report.binarySHA256 = digest(await readFile(binary));
report.toolHashes = {};
for (const name of ['benchmark-resources.mjs', 'resource-client.mjs', 'sample-resource-processes.py', 'backend.mjs']) {
  report.toolHashes[name] = digest(await readFile(new URL('./' + name, import.meta.url)));
}
report.processes = [];
const save = () => writeFile(path.join(output, 'capacity.json'), JSON.stringify(report, null, 2) + '\n');
async function start(name, catalogue = [fixture.track]) {
  const value = await startApp(config, path.join(output, name), catalogue); apps.push(value);
  report.processes.push({ phase: name, pid: value.pid });
  await login(value, credentials.accounts.a); return value;
}
function controlProbe(target) {
  let active = true; const results = [];
  const done = (async () => {
    while (active) {
      const at = performance.now();
      try { const response = await request(target, apiBase + '/session'); results.push({ milliseconds: response.milliseconds, status: response.status }); }
      catch (error) { results.push({ milliseconds: performance.now() - at, error: error.code || error.name }); }
      if (active) await pause(Math.max(0, 1000 - (performance.now() - at)));
    }
  })();
  return { results, async stop() { active = false; await done; } };
}
async function warmPhase(count, repetition) {
  const name = 'warm-' + count + '-r' + repetition, tasks = [], opened = [], outcomes = [];
  const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
  const utilization = performance.eventLoopUtilization();
  const attemptAt = new Date().toISOString();
  const probe = controlProbe(app);
  try {
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const started = performance.now();
      try {
        const created = await createTask(app, config, fixture.track);
        if (created.status !== 202) { outcomes.push({ index, status: created.status, error: created.value?.error?.code, stage: 'create' }); return; }
        tasks.push(created.value);
        const task = await ready(app, created.value), reader = await pacedReader(app, task.mediaUrl, { bytesPerSecond: pace, timeout: 120000 });
        readers.add(reader); opened.push({ index, task, reader, startupMs: performance.now() - started });
      } catch (error) { outcomes.push({ index, error: error.code || error.message, stage: 'startup' }); }
    }));
    const windowStart = new Date().toISOString(), windowClock = performance.now();
    const startBytes = opened.map(value => value.reader.bytes);
    await pause(seconds * 1000);
    const windowEnd = new Date().toISOString(), windowSeconds = (performance.now() - windowClock) / 1000;
    const windowBytes = opened.map((value, index) => value.reader.bytes - startBytes[index]);
    const loopUtilization = performance.eventLoopUtilization(utilization);
    const loopDelayP95Ms = eventLoop.percentile(95) / 1e6;
    eventLoop.disable(); await probe.stop();
    // Drain after the measurement window to verify the entire real original.
    for (const { reader } of opened) reader.resume();
    for (const { index, reader, startupMs } of opened) {
      const body = await reader.done; readers.delete(reader);
      outcomes.push({ index, startupMs, ...body, correct: body.status === 200 && body.complete && body.bytes === original.length && body.sha256 === fixture.track.sha256 });
    }
    const starts = outcomes.filter(value => value.startupMs !== undefined).map(value => value.startupMs);
    const controls = probe.results.filter(value => value.status === 200).map(value => value.milliseconds);
    const failed = outcomes.filter(value => !value.correct).length;
    const phase = { name, kind: 'warm', repetition, attempted: count, attemptAt, windowStart, windowEnd, windowSeconds, windowBytes,
      appReadMbitPerSecond: windowBytes.reduce((sum, value) => sum + value, 0) * 8 / windowSeconds / 1e6,
      startupP50Ms: quantile(starts, .5), startupP95Ms: quantile(starts, .95), startupMaxMs: quantile(starts, 1),
      controlP95Ms: quantile(controls, .95), controlErrors: probe.results.length - controls.length, controlRequests: probe.results.length,
      generatorEventLoopUtilization: loopUtilization.utilization, generatorEventLoopDelayP95Ms: loopDelayP95Ms,
      outcomes: outcomes.sort((a, b) => a.index - b.index), failed };
    phase.passed = outcomes.length === count && failed === 0 && phase.controlErrors === 0 && phase.startupP95Ms <= 2000 && phase.controlP95Ms <= 500;
    phases.push(phase); await save();
    console.log(JSON.stringify({ phase: name, passed: phase.passed, failed, startupP95Ms: phase.startupP95Ms, controlP95Ms: phase.controlP95Ms, readMbitPerSecond: phase.appReadMbitPerSecond }));
  } finally {
    eventLoop.disable(); await probe.stop();
    for (const { reader } of opened) { reader.close(); readers.delete(reader); }
    await Promise.all(tasks.map(task => cancel(app, task).catch(() => {})));
    await until(() => app.metrics.activeFileLeases === 0 && app.metrics.activeMediaResponses === 0 && app.metrics.activeJobs === 0, 'warm phase resource drain');
    await pause(700);
  }
}
async function soak() {
  if (!soakSeconds) return;
  const outcomes = [], active = new Map(), starts = [], begin = performance.now();
  const windowStart = new Date().toISOString(), deadline = begin + soakSeconds * 1000;
  const probe = controlProbe(app), loopDelay = monitorEventLoopDelay({ resolution: 20 }); loopDelay.enable();
  const eventLoop = performance.eventLoopUtilization();
  const notify = setInterval(() => console.log(JSON.stringify({ phase: 'soak-progress', seconds: Math.floor((performance.now() - begin) / 1000), completedResponses: outcomes.length, readers: active.size })), 30000);
  const stop = setTimeout(() => { for (const reader of active.values()) reader.close(); }, soakSeconds * 1000);
  await Promise.all(Array.from({ length: soakClients }, async (_, index) => {
    let cycle = 0;
    while (performance.now() < deadline) {
      const started = performance.now(); let task, reader;
      try {
        const response = await createTask(app, config, fixture.track);
        if (response.status !== 202) { outcomes.push({ index, cycle, status: response.status, error: response.value?.error?.code, correct: false }); break; }
        task = await ready(app, response.value);
        reader = await pacedReader(app, task.mediaUrl, { bytesPerSecond: pace, timeout: 120000 });
        readers.add(reader); active.set(index, reader); starts.push(performance.now() - started);
        if (performance.now() >= deadline) reader.close();
        const body = await reader.done;
        const scheduledAbort = body.locallyAborted && performance.now() >= deadline - 100;
        const correct = body.status === 200 && body.sha256 === digest(original.subarray(0, body.bytes))
          && ((body.complete && body.bytes === original.length) || scheduledAbort);
        outcomes.push({ index, cycle, ...body, scheduledAbort, correct });
        if (!correct) break;
      } catch (error) { outcomes.push({ index, cycle, error: error.code || error.message, correct: false }); break; }
      finally {
        reader?.close(); if (reader) readers.delete(reader); active.delete(index);
        if (task) await cancel(app, task).catch(() => {});
      }
      cycle++;
    }
  }));
  clearTimeout(stop); clearInterval(notify); await probe.stop();
  const windowEnd = new Date().toISOString(), measuredSeconds = (performance.now() - begin) / 1000;
  const loopUtilization = performance.eventLoopUtilization(eventLoop), loopDelayP95Ms = loopDelay.percentile(95) / 1e6; loopDelay.disable();
  await until(() => app.metrics.activeFileLeases === 0 && app.metrics.activeMediaResponses === 0 && app.metrics.activeJobs === 0 && app.metrics.activeTasks === 0, 'soak cleanup');
  const control = probe.results.filter(value => value.status === 200).map(value => value.milliseconds);
  const phase = { name: 'soak-' + soakClients, kind: 'soak', clients: soakClients, windowStart, windowEnd, windowSeconds: measuredSeconds,
    scheduledSeconds: soakSeconds, startupP95Ms: quantile(starts, .95), controlP95Ms: quantile(control, .95), controlErrors: probe.results.length - control.length,
    completedResponses: outcomes.filter(value => value.complete && value.correct).length,
    scheduledAborts: outcomes.filter(value => value.scheduledAbort).length, failed: outcomes.filter(value => !value.correct).length,
    generatorEventLoopUtilization: loopUtilization.utilization, generatorEventLoopDelayP95Ms: loopDelayP95Ms, after: app.metrics, outcomes };
  phase.passed = phase.failed === 0 && phase.completedResponses >= soakClients && phase.controlErrors === 0 && phase.startupP95Ms <= 2000 && phase.controlP95Ms <= 500;
  phases.push(phase); await save(); console.log(JSON.stringify({ phase: phase.name, passed: phase.passed, seconds: measuredSeconds, completed: phase.completedResponses, scheduledAborts: phase.scheduledAborts, failures: phase.failed }));
}

async function mixed() {
  const catalogue = [fixture.track, ...(await json(config.policyFile)).tracks.filter(track => track.access === 'public')];
  assert.equal(catalogue.length, 3, 'Two existing public formats plus the large private original');
  app = await start('mixed', catalogue);
  const originals = new Map();
  for (const track of catalogue) {
    const task = await ready(app, (await createTask(app, config, track)).value), response = await request(app, task.mediaUrl);
    assert.equal(digest(response.body), track.sha256); originals.set(track.songId, response.body); await cancel(app, task);
  }
  const extra = /^\d+$/.test(process.env.RESOURCE_NAV_PID || '') ? ['navidrome:' + process.env.RESOURCE_NAV_PID + ':4533'] : [];
  monitor = await sampler(app, path.join(output, 'mixed-process-samples.jsonl'), extra);
  report.mixed = { catalogue: catalogue.map(track => ({ format: track.format, access: track.access, bytes: track.size, sha256: track.sha256 })), idleBeforeStart: new Date().toISOString() };
  report.mixed.loadPattern = 'Each client immediately starts another task after transfer completion; this is rapid restart pressure, not audio-duration pacing.';
  await pause(3000); report.mixed.idleBeforeEnd = new Date().toISOString();
  for (const count of mixedLevels) {
    const outcomes = [], active = new Map(), starts = [], begin = performance.now(), deadline = begin + mixedSeconds * 1000;
    const windowStart = new Date().toISOString(), probe = controlProbe(app);
    const stop = setTimeout(() => { for (const reader of active.values()) reader.close(); }, mixedSeconds * 1000);
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const track = catalogue[index % catalogue.length], reference = originals.get(track.songId); let attempt = 0;
      while (performance.now() < deadline) {
        const cycle = attempt++, started = performance.now(); let task, reader;
        try {
          const response = await createTask(app, config, track);
          if (response.status !== 202) {
            outcomes.push({ index, cycle, format: track.format, status: response.status, error: response.value?.error?.code, correct: false });
            // Bounded retries keep the trial running, but every rejection stays
            // a failure in the denominator and prevents a clean-capacity pass.
            await pause(500); continue;
          }
          task = await ready(app, response.value);
          reader = await pacedReader(app, task.mediaUrl, { bytesPerSecond: pace, timeout: 120000 });
          active.set(index, reader); readers.add(reader); starts.push(performance.now() - started);
          if (performance.now() >= deadline) reader.close();
          const body = await reader.done, scheduledAbort = body.locallyAborted && performance.now() >= deadline - 100;
          const correct = body.status === 200 && body.sha256 === digest(reference.subarray(0, body.bytes))
            && ((body.complete && body.bytes === track.size) || scheduledAbort);
          outcomes.push({ index, cycle, format: track.format, access: track.access, ...body, scheduledAbort, correct });
          if (!correct) await pause(500);
        } catch (error) { outcomes.push({ index, cycle, format: track.format, error: error.code || error.message, correct: false }); await pause(500); }
        finally { reader?.close(); if (reader) readers.delete(reader); active.delete(index); if (task) await cancel(app, task).catch(() => {}); }
      }
    }));
    clearTimeout(stop); await probe.stop();
    const windowEnd = new Date().toISOString();
    await until(() => app.metrics.activeFileLeases === 0 && app.metrics.activeMediaResponses === 0 && app.metrics.activeJobs === 0 && app.metrics.activeTasks === 0, 'mixed phase cleanup');
    const controls = probe.results.filter(value => value.status === 200).map(value => value.milliseconds);
    const phase = { name: 'mixed-' + count, kind: 'mixed', clients: count, windowStart, windowEnd, windowSeconds: (performance.now() - begin) / 1000,
      attempted: outcomes.length, failed: outcomes.filter(value => !value.correct).length,
      rejected429: outcomes.filter(value => value.status === 429).length,
      completedResponses: outcomes.filter(value => value.correct && value.complete).length,
      scheduledAborts: outcomes.filter(value => value.scheduledAbort).length,
      startupP95Ms: quantile(starts, .95), controlP95Ms: quantile(controls, .95), controlErrors: probe.results.length - controls.length, outcomes, after: app.metrics };
    phase.passed = new Set(outcomes.filter(value => value.correct).map(value => value.index)).size === count && phase.failed === 0 && phase.controlErrors === 0 && phase.startupP95Ms <= 2000 && phase.controlP95Ms <= 500;
    phases.push(phase); await save();
    console.log(JSON.stringify({ phase: phase.name, passed: phase.passed, attempts: phase.attempted, failures: phase.failed, rejected429: phase.rejected429, startupP95Ms: phase.startupP95Ms, controlP95Ms: phase.controlP95Ms }));
  }
  report.mixed.idleAfterStart = new Date().toISOString(); await pause(7000); report.mixed.idleAfterEnd = new Date().toISOString();
  report.mixed.after = app.metrics;
  check('mixed track trials retain all failures and meet clean-capacity criteria', phases.filter(value => value.kind === 'mixed').every(value => value.passed));
  check('mixed playback keeps three originals and releases transient resources', app.metrics.cacheBytes === catalogue.reduce((sum, track) => sum + track.size, 0)
    && app.metrics.sourceDownloads === 3 && app.metrics.activeTasks === 0 && app.metrics.activeMediaResponses === 0 && app.metrics.activeJobs === 0 && app.metrics.reservedBytes === 0 && app.metrics.taskSlots <= 256);
}
try {
  const cold = await start('cold'), coldStart = performance.now(), coldResults = [];
  await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const start = performance.now(), response = await createTask(cold, config, fixture.track);
    if (response.status !== 202) { coldResults.push({ index, status: response.status, error: response.value?.error?.code }); return; }
    try { const task = await ready(cold, response.value); coldResults.push({ index, readyMs: performance.now() - start, task }); }
    catch (error) { coldResults.push({ index, error: error.message }); }
  }));
  const coldMs = performance.now() - coldStart, available = coldResults.filter(value => value.task);
  const first = available[0] && await request(cold, available[0].task.mediaUrl);
  report.cold = { clients: 16, milliseconds: coldMs, startupP95Ms: quantile(available.map(value => value.readyMs), .95),
    results: coldResults.map(({ task, ...value }) => ({ ...value, ready: Boolean(task) })), metrics: cold.metrics, cache: await inventory(cold.cacheDir),
    originalVerified: Boolean(first && first.status === 200 && digest(first.body) === fixture.track.sha256) };
  check('sixteen application-cold consumers share one correct original', available.length === 16 && report.cold.originalVerified && cold.metrics.sourceDownloads === 1);
  await cold.close();
  app = await start('warm');
  const warm = await ready(app, (await createTask(app, config, fixture.track)).value);
  assert.equal(digest((await request(app, warm.mediaUrl)).body), fixture.track.sha256); await cancel(app, warm);
  const extra = /^\d+$/.test(process.env.RESOURCE_NAV_PID || '') ? ['navidrome:' + process.env.RESOURCE_NAV_PID + ':4533'] : [];
  monitor = await sampler(app, path.join(output, 'process-samples.jsonl'), extra);
  check('native process counters are available for the benchmark', monitor.available);
  metricsTimer = setInterval(() => samples.push({ recordedAt: new Date().toISOString(), ...app.metrics }), 250);
  report.idleBeforeStart = new Date().toISOString(); await pause(5000); report.idleBeforeEnd = new Date().toISOString();
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const count of repetition % 2 ? levels : [...levels].reverse()) await warmPhase(count, repetition);
  }
  await soak();
  report.idleAfterStart = new Date().toISOString(); await pause(7000); report.idleAfterEnd = new Date().toISOString();
  report.after = app.metrics;
  check('all paced trials meet integrity and latency criteria', phases.length > 0 && phases.every(value => value.passed));
  check('finished load releases files responses jobs and active tasks', report.after.activeFileLeases === 0 && report.after.activeMediaResponses === 0 && report.after.activeJobs === 0 && report.after.activeTasks === 0 && report.after.reservedBytes === 0);
  check('warm load does not repeatedly download the same original', report.after.sourceDownloads === 1 && report.after.cacheBytes === fixture.track.size);
  check('retained task records remain bounded during repeated playback', report.after.taskSlots <= 256);
  await monitor.stop(); await app.close();
  await mixed();
} catch (error) { report.failure = error.message; check('benchmark completes without a harness failure', false); }
finally {
  clearInterval(metricsTimer); for (const reader of readers) reader.close(); await monitor?.stop().catch(() => {});
  for (const app of apps.reverse()) await app.close().catch(() => {});
  report.freeMemoryAfterBytes = os.freemem(); report.checkCount = checks.length; report.passed = checks.every(value => value.passed);
  await writeFile(path.join(output, 'library-samples.json'), JSON.stringify(samples) + '\n'); await save();
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, phases: phases.length, failure: report.failure, failures: checks.filter(value => !value.passed).map(value => value.name) }));
  if (!report.passed) process.exitCode = 1;
}
