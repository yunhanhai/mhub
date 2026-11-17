/** Bound actual incomplete HTTP connections; only an isolated owned process. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rustBackend } from './backend.mjs';
import { json, pause, until, request, startApp, sampler } from './resource-client.mjs';
assert.ok(rustBackend);
const [configFile, fixtureFile, output] = process.argv.slice(2);
const config = await json(configFile), fixture = await json(fixtureFile);
await mkdir(output, { recursive: true });
const app = await startApp(config, path.join(output, 'server'), [fixture.track]);
const monitor = await sampler(app, path.join(output, 'transport-process.jsonl'));
const checks = [], clients = [];
const report = { recordedAt: new Date().toISOString(), checks };
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
try {
  for (let index = 0; index < 136; index++) {
    const client = { connected: false, closed: false, bytes: 0 };
    client.socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(app.origin).port) });
    const opened = new Promise(resolve => {
      client.socket.once('connect', () => { client.connected = true;
        client.socket.write('GET /health HTTP/1.1\r\nHost: ' + new URL(app.origin).host + '\r\nX-Incomplete: '); resolve(); });
      client.socket.once('error', () => resolve());
    });
    client.socket.on('error', error => { client.error = error.code; });
    client.socket.on('data', chunk => { client.bytes += chunk.length; });
    client.socket.on('close', () => { client.closed = true; });
    clients.push(client); await opened;
  }
  await pause(700);
  const active = clients.filter(client => client.connected && !client.closed).length;
  check('at most 128 incomplete connections remain admitted', active > 100 && active <= 128, { attempted: clients.length, active });
  check('overflow connections close before receiving an HTTP body', clients.some(client => client.closed) && clients.filter(client => client.closed).every(client => client.bytes === 0));
  const started = performance.now();
  await until(() => clients.every(client => client.closed), 'header deadlines', 13000);
  check('incomplete request headers expire without another request', performance.now() - started <= 13000);
  check('incomplete connections never reach source authorization', app.metrics.sourceRequests === 0);
  const healthy = await request(app, '/health');
  check('HTTP service recovers after all incomplete connections expire', healthy.status === 200);
  report.activeAtPeak = active;
} catch (error) { check('transport scenario completes without a harness failure', false, { error: error.message }); }
finally {
  for (const client of clients) client.socket.destroy();
  await pause(1100); await monitor.stop(); await app.close();
  report.clients = clients.map(({ socket, ...record }) => record);
  report.checkCount = checks.length; report.passed = checks.every(value => value.passed);
  await writeFile(path.join(output, 'transport.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(value => !value.passed).map(value => value.name) }));
  if (!report.passed) process.exitCode = 1;
}
