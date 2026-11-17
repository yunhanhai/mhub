/** Simultaneous distinct-file preparation for eight real upstream identities.
 * LIBRARY_BACKEND=rust RESOURCE_PYTHON=... MHUB_RUST_BINARY=... node benchmark-cold-users.mjs CONFIG STATE OUTPUT
 * COLD_LEVELS=8,16 COLD_REPETITIONS=2 COLD_WINDOW_SECONDS=15 RESOURCE_NAV_PID=...
 * Every trial uses a fresh process and application cache. Source OS caches are uncontrolled.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiBase, rustBackend } from './backend.mjs';
import { json, pause, digest, until, inventory, request, startApp, createTask, cancel, pacedReader, sampler } from './resource-client.mjs';
import { clientFor, fixtureConfig, loginGapMs } from './multi-user-fixtures.mjs';

assert.ok(rustBackend && process.env.RESOURCE_PYTHON);
const [configFile, fixtureFile, output] = process.argv.slice(2);
const fixture = await json(fixtureFile), config = fixtureConfig(await json(configFile), fixture);
try { await stat(path.join(output, 'cold-users.json')); throw new Error('Use a fresh output directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
const levels = (process.env.COLD_LEVELS || '8,16').split(',').map(Number), repetitions = Number(process.env.COLD_REPETITIONS || 2), seconds = Number(process.env.COLD_WINDOW_SECONDS || 15);
assert.ok(levels.length > 0 && new Set(levels).size === levels.length && levels.every(level => [8, 16].includes(level))
  && Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3 && seconds >= 10 && seconds <= 60);
for (const file of fixture.files) assert.equal(digest(await readFile(file.file)), file.sha256);
const binary = process.env.MHUB_RUST_BINARY || fileURLToPath(new URL('../../target/release/music-api.exe', import.meta.url));
process.env.MHUB_RUST_BINARY = path.resolve(binary);
const phases = [], checks = [], logins = [];
const report = { recordedAt: new Date().toISOString(), profile: 'release-lto', binarySHA256: digest(await readFile(binary)), phases, checks, logins,
  host: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
  configuration: { realUsers: 8, levels, repetitions, seconds, bytesPerSecondPerClient: 128 * 1024, loginGapMs },
  methodology: 'All assigned different files start together after eight real logins. Fresh process/application cache per trial; direct Navidrome without a proxy; paced reading window followed by complete drain and original SHA-256 verification. No retry hides failed attempts; OS/page caches uncontrolled.',
  timing: 'beginMs, acceptedMs, readyMs, mediaRequestStartMs and firstByteFromBurstMs use the same burst clock. startupMs runs from task creation to the first application-read media byte, including authorization and status polling. mediaFirstByteMs starts at the media request; it is not total preparation latency.' };
report.toolHashes = {};
for (const name of ['benchmark-cold-users.mjs', 'multi-user-fixtures.mjs', 'resource-client.mjs', 'backend.mjs', 'sample-resource-processes.py']) report.toolHashes[name] = digest(await readFile(new URL('./' + name, import.meta.url)));
report.originals = fixture.files.map(({ label, bytes, sha256, decodedPcmSHA256 }) => ({ label, bytes, sha256, decodedPcmSHA256 }));
const save = () => writeFile(path.join(output, 'cold-users.json'), JSON.stringify(report, null, 2) + '\n');
const quantile = (values, proportion) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * proportion) - 1)] : null;
const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
const gone = app => ['activeFileLeases', 'activeMediaResponses', 'activeTasks', 'activeJobs', 'reservedBytes', 'queuedPreparations', 'runningPreparations'].every(key => app.metrics[key] === 0);

async function ready(client, created) {
  let response;
  await until(async () => {
    response = await request(client, apiBase + '/tasks/' + created.id);
    return response.status !== 200 || response.value?.state !== 'preparing';
  }, 'cold preparation settles', 25000);
  return response;
}
function controlProbe(clients) {
  let active = true, index = 0; const observations = [];
  const done = (async () => {
    while (active) {
      const client = clients[index++ % clients.length], start = performance.now();
      try {
        const response = await request(client, apiBase + '/session');
        observations.push({ role: client.role, status: response.status, milliseconds: response.milliseconds,
          correct: response.status === 200 && response.value?.user?.id === fixture.accounts[client.role].id });
      } catch (error) { observations.push({ role: client.role, correct: false, error: error.code || error.name, milliseconds: performance.now() - start }); }
      if (active) await pause(Math.max(0, 1000 - (performance.now() - start)));
    }
  })();
  return { observations, async stop() { active = false; await done; } };
}

async function trial(count, repetition) {
  const name = `cold-${count}-r${repetition}`, directory = path.join(output, name), outcomes = [], opened = [], tasks = [], samples = [];
  const phase = { name, files: count, realUsers: 8, repetition, startedAt: new Date().toISOString(), outcomes,
    plannedAttempts: count, startedAttempts: 0, measurementStarted: false };
  phases.push(phase); await save();
  let app, monitor, metricsTimer, probe;
  try {
    const tracks = fixture.tracks.slice(0, count);
    app = await startApp(config, directory, tracks); phase.pid = app.pid;
    const roles = Array.from({ length: 8 }, (_, index) => 'u' + (index + 1));
    if (repetition % 2 === 0) roles.reverse();
    const clients = [];
    for (const role of roles) clients.push(await clientFor(app, fixture, role, logins));
    phase.initialCache = await inventory(app.cacheDir);
    assert.equal(phase.initialCache.files.length, 0); assert.equal(app.metrics.sourceDownloads, 0);
    const extra = /^\d+$/.test(process.env.RESOURCE_NAV_PID || '') ? ['navidrome:' + process.env.RESOURCE_NAV_PID + ':4533'] : [];
    monitor = await sampler(app, path.join(directory, 'process-samples.jsonl'), extra);
    assert.ok(monitor.available);
    metricsTimer = setInterval(() => samples.push({ recordedAt: new Date().toISOString(), ...app.metrics }), 100);
    phase.idleBeforeStart = new Date().toISOString(); await pause(3000); phase.idleBeforeEnd = new Date().toISOString();
    phase.burstStart = new Date().toISOString(); phase.measurementStarted = true;
    const burstClock = performance.now(); probe = controlProbe(clients);
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const client = clients[index % clients.length], trackIndex = repetition % 2 ? index : (index + 7) % count;
      const track = tracks[trackIndex], base = { index, role: client.role, label: fixture.files[trackIndex].label, expectedBytes: track.size, expectedSHA256: track.sha256, beginMs: performance.now() - burstClock };
      phase.startedAttempts++;
      try {
        const response = await createTask(client, config, track); base.createResponseMs = performance.now() - burstClock;
        if (response.status !== 202) { outcomes.push({ ...base, stage: 'create', status: response.status, error: response.value?.error?.code, correct: false }); return; }
        base.acceptedMs = base.createResponseMs;
        tasks.push({ client, task: response.value });
        const status = await ready(client, response.value); base.readyMs = performance.now() - burstClock;
        if (status.status !== 200 || status.value?.state !== 'ready') { outcomes.push({ ...base, stage: 'preparation', status: status.status, state: status.value?.state, error: status.value?.error, correct: false }); return; }
        base.mediaRequestStartMs = performance.now() - burstClock;
        const reader = await pacedReader(client, status.value.mediaUrl, { bytesPerSecond: 128 * 1024, timeout: 120000 });
        if (Number.isFinite(reader.firstByteMs)) {
          base.firstByteFromBurstMs = base.mediaRequestStartMs + reader.firstByteMs;
          base.startupMs = base.firstByteFromBurstMs - base.beginMs;
        }
        opened.push({ client, reader, base });
      } catch (error) { outcomes.push({ ...base, stage: 'startup', error: error.code || error.message, correct: false }); }
    }));
    phase.windowStart = new Date().toISOString();
    await pause(seconds * 1000);
    phase.windowEnd = new Date().toISOString();
    phase.windowBytesBeforeDrain = opened.map(({ base, reader }) => ({ index: base.index, role: base.role, bytes: reader.bytes }));
    await probe.stop();
    for (const { reader } of opened) reader.resume();
    for (const { reader, base } of opened) {
      const { firstByteMs: mediaFirstByteMs, ...body } = await reader.done;
      outcomes.push({ ...base, stage: 'body', ...body, mediaFirstByteMs,
        correct: body.status === 200 && body.complete && body.bytes === base.expectedBytes && body.sha256 === base.expectedSHA256 });
    }
    phase.verifiedAt = new Date().toISOString();
    for (const { client, task } of tasks) await cancel(client, task);
    await until(() => gone(app), 'all distinct cold work and response resources released');
    phase.idleAfterStart = new Date().toISOString(); await pause(5000); phase.idleAfterEnd = new Date().toISOString();
    phase.after = { ...app.metrics }; phase.cache = await inventory(app.cacheDir);
    phase.attempted = outcomes.length; phase.failed = outcomes.filter(value => !value.correct).length;
    phase.completedCorrectOriginals = outcomes.filter(value => value.correct).length;
    phase.startupP95Ms = quantile(outcomes.filter(value => Number.isFinite(value.startupMs)).map(value => value.startupMs), .95);
    phase.controls = probe.observations; phase.controlErrors = probe.observations.filter(value => !value.correct).length;
    phase.controlP95Ms = quantile(probe.observations.filter(value => value.correct).map(value => value.milliseconds), .95);
    phase.users = roles.map(role => {
      const values = outcomes.filter(value => value.role === role);
      return { role, attempted: values.length, failed: values.filter(value => !value.correct).length,
        startupP95Ms: quantile(values.filter(value => Number.isFinite(value.startupMs)).map(value => value.startupMs), .95) };
    });
    const identityCoverage = new Set(outcomes.filter(value => value.correct).map(value => value.role)).size === 8;
    phase.passed = phase.attempted === count && phase.failed === 0 && identityCoverage
      && outcomes.every(value => Number.isFinite(value.startupMs)) && phase.startupP95Ms <= 2000
      && probe.observations.length > 0 && phase.controlErrors === 0 && phase.controlP95Ms <= 500;
    check(name + ': all real users receive their distinct complete originals within latency criteria', phase.passed);
    check(name + ': exactly one cold download per file and no transient resources retained', app.metrics.sourceDownloads === count && app.metrics.cacheBytes === tracks.reduce((sum, track) => sum + track.size, 0) && gone(app));
  } catch (error) {
    phase.failure = error.message; phase.passed = false;
    check(name + ': experiment completes without a prerequisite or harness failure', false);
  } finally {
    clearInterval(metricsTimer);
    for (const { reader } of opened) reader.close();
    const cleanupErrors = [];
    for (const close of [() => probe?.stop(), () => monitor?.stop(), () => app?.close()]) {
      try { await close(); } catch (error) { cleanupErrors.push(error.message); }
    }
    if (cleanupErrors.length) {
      phase.cleanupErrors = cleanupErrors; phase.passed = false;
      check(name + ': owned sampler and service cleanup completes', false);
    }
    phase.attempted = phase.startedAttempts;
    phase.outcomesRecorded = outcomes.length;
    phase.unrecordedAttempts = phase.startedAttempts - outcomes.length;
    phase.failed = outcomes.filter(value => !value.correct).length;
    phase.finishedAt = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'library-samples.json'), JSON.stringify(samples) + '\n');
    await save();
    console.log(JSON.stringify({ phase: name, passed: phase.passed, attempted: phase.attempted, failed: phase.failed, startupP95Ms: phase.startupP95Ms, controlP95Ms: phase.controlP95Ms, failure: phase.failure }));
  }
}

for (let repetition = 1; repetition <= repetitions; repetition++) for (const count of repetition % 2 ? levels : [...levels].reverse()) await trial(count, repetition);
report.finishedAt = new Date().toISOString(); report.checkCount = checks.length; report.passed = checks.every(value => value.passed);
await save();
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, trials: phases.length, attempted: phases.reduce((sum, phase) => sum + (phase.attempted || 0), 0), failed: phases.reduce((sum, phase) => sum + (phase.failed || 0), 0) }));
if (!report.passed) process.exitCode = 1;
