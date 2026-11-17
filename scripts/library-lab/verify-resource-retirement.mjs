/** A revoked session must still reach a stream after its task tombstone is reclaimed. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiBase, rustBackend } from './backend.mjs';
import { json, pause, digest, until, request, startApp, login, createTask, ready, cancel, pacedReader, sampler } from './resource-client.mjs';
assert.ok(rustBackend);
const [configFile, credentialsFile, fixtureFile, output] = process.argv.slice(2);
const config = await json(configFile), credentials = await json(credentialsFile), fixture = await json(fixtureFile);
const first = (await json(config.policyFile)).tracks.find(track => track.access === 'public');
const bytes = await readFile(fixture.file); assert.equal(digest(bytes), fixture.track.sha256);
await mkdir(output, { recursive: true });
const app = await startApp(config, path.join(output, 'server'), [fixture.track, first]);
const checks = [], report = { recordedAt: new Date().toISOString(), checks };
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
let reader, monitor;
try {
  await login(app, credentials.accounts.a);
  const task = await ready(app, (await createTask(app, config, fixture.track)).value);
  monitor = await sampler(app, path.join(output, 'process-samples.jsonl'));
  reader = await pacedReader(app, task.mediaUrl, { bytesPerSecond: 32768, timeout: 180000 });
  // Retire the original without mutating its actual source or cached bytes.
  await writeFile(app.policyFile, JSON.stringify({ instanceId: config.source.instanceId, tracks: [first] }));
  await pause(5200);
  let completed = 0, rejected;
  for (let index = 0; index < 260; index++) {
    const value = await createTask(app, config, first);
    if (value.status !== 202) { rejected = { status: value.status, error: value.value?.error?.code }; break; }
    const current = await ready(app, value.value); await cancel(app, current); completed++;
  }
  check('task churn succeeds while a retired private response is still live', completed === 260 && app.metrics.activeFileLeases > 0 && reader.bytes < bytes.length, { completed, rejected, received: reader.bytes, leases: app.metrics.activeFileLeases });
  const old = await request(app, apiBase + '/tasks/' + task.id);
  check('the retired task record has actually been reclaimed', old.status === 404 && old.value?.error?.code === 'task_missing');
  report.beforeLogout = { recordedAt: new Date().toISOString(), ...app.metrics };
  assert.equal((await request(app, apiBase + '/session', { method: 'DELETE' })).status, 200);
  let released = false;
  try { await until(() => app.metrics.activeFileLeases === 0 && app.metrics.activeMediaResponses === 0, 'retired stream receives session revocation'); released = true; } catch {}
  check('logout reaches a private response after its task record was reclaimed', released);
  report.afterLogout = { recordedAt: new Date().toISOString(), ...app.metrics };
  reader.resume(); const body = await reader.done;
  check('reclaimed task records cannot let a logged-out response finish the original', !body.complete && body.bytes < bytes.length && body.sha256 === digest(bytes.subarray(0, body.bytes)), { bytes: body.bytes, complete: body.complete });
  report.body = body;
  const normal = await ready(app, (await createTask(app, config, first)).value);
  const media = await request(app, normal.mediaUrl);
  check('normal public playback remains available after cleanup', media.status === 200 && digest(media.body) === first.sha256);
  await cancel(app, normal);
} catch (error) { check('retirement resource scenario completes without a harness failure', false, { error: error.message }); }
finally {
  reader?.close(); await monitor?.stop().catch(() => {}); await app.close();
  report.checkCount = checks.length; report.passed = checks.every(value => value.passed);
  await writeFile(path.join(output, 'retirement.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(value => !value.passed).map(value => value.name) }));
  if (!report.passed) process.exitCode = 1;
}
