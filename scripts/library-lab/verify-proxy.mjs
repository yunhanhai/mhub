/** Actual Caddy + Rust + owned Navidrome, with measured TLS ciphertext pacing.
 * LIBRARY_BACKEND=rust CADDY_EXECUTABLE=... OPENSSL_EXECUTABLE=... RESOURCE_PYTHON=...
 * node verify-proxy.mjs CONFIG CREDENTIALS FIXTURE_STATE OUTPUT
 * PROXY_CASES selects calibration,protocols,slow,reset,logout,expiry,total-timeout,stalled,browser.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTcpShaper } from './tcp-shaper.mjs';
import { createCaddyFixture } from './caddy-fixture.mjs';
import { http1Client, http2Client } from './proxy-client.mjs';
import { apiBase } from './backend.mjs';
import { json, digest, pause, until, sampler } from './resource-client.mjs';

const [configFile, credentialsFile, fixtureFile, output] = process.argv.slice(2);
assert.ok([configFile, credentialsFile, fixtureFile, output, process.env.MHUB_RUST_BINARY, process.env.RESOURCE_PYTHON].every(Boolean));
const config = await json(configFile), credentials = await json(credentialsFile), fixture = await json(fixtureFile);
assert.ok(!fixture.removedAt && fixture.sourceMatches);
const policy = await json(config.policyFile), big = fixture.track, original = await readFile(fixture.file);
assert.equal(digest(original), big.sha256);
const tracks = [...policy.tracks, big], publicTrack = policy.tracks.find(track => track.access === 'public' && track.format === 'flac');
assert.ok(publicTrack);
try { await stat(path.join(output, 'proxy.json')); throw new Error('Use a fresh output directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
const selected = process.env.PROXY_CASES?.split(','), checks = [], cases = [], logins = [];
const shape = { downBytesPerSecond: 128 * 1024, upBytesPerSecond: 64 * 1024, oneWayDelayMs: 75 };
const transient = ['activeFileLeases', 'activeMediaResponses', 'activeTasks', 'activeJobs', 'reservedBytes', 'queuedPreparations', 'runningPreparations'];
const report = { startedAt: new Date().toISOString(), checks, cases, logins, selectedCases: selected || null,
  binarySHA256: digest(await readFile(process.env.MHUB_RUST_BINARY)), caddySHA256: digest(await readFile(process.env.CADDY_EXECUTABLE)),
  fixture: { bytes: original.length, sha256: big.sha256, decodedPcmSHA256: fixture.decodedPcmSHA256, duration: big.duration },
  scope: 'Actual portable Caddy on loopback, real TLS and Navidrome; bounded ciphertext pacing is not a WAN or packet-loss model.',
  metricObservation: 'Existing anonymous session reads over unshaped loopback refresh the private counters. Natural expiry is observed at the client before any such probe.',
  systemTrustChanged: false, globalIgnoreHTTPSErrors: false, publicDeployment: false };
report.toolHashes = {};
for (const file of ['verify-proxy.mjs', 'caddy-fixture.mjs', 'tcp-shaper.mjs', 'proxy-client.mjs', 'backend.mjs', 'resource-client.mjs', 'sample-resource-processes.py']) report.toolHashes[file] = digest(await readFile(new URL('./' + file, import.meta.url)));
const save = () => writeFile(path.join(output, 'proxy.json'), JSON.stringify(report, null, 2) + '\n');
const check = (name, value, details) => checks.push({ name, passed: Boolean(value), ...(details ? { details } : {}) });
let lastLogin = 0;
async function login(client, role = 'a') {
  await pause(Math.max(0, 8500 - (Date.now() - lastLogin))); lastLogin = Date.now();
  const response = await client.request(apiBase + '/session', { method: 'POST', data: credentials.accounts[role] });
  logins.push({ role, status: response.status, identityMatches: response.value?.user?.id === credentials.accounts[role].id });
  assert.equal(response.status, 200, 'Owned native login must succeed');
  assert.equal(response.value.user.id, credentials.accounts[role].id);
  const value = response.headers['set-cookie'][0]; client.cookie = value.split(';')[0];
  return value;
}

if (!selected || selected.includes('calibration')) {
  const started = performance.now(), payload = Buffer.alloc(256 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  let relay, socket, received = Buffer.alloc(0), uploaded = Buffer.alloc(0), uploadStart, uploadEnd, downEnd, firstDown;
  const peers = new Set();
  const sink = net.createServer(peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('error', () => {});
    peer.write(payload);
    peer.on('data', bytes => { uploaded = Buffer.concat([uploaded, bytes]); if (uploaded.length === payload.length) uploadEnd = performance.now(); });
  });
  const offset = checks.length, details = { name: 'calibration' };
  try {
    await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
    relay = await createTcpShaper({ targetPort: sink.address().port, ...shape });
    const connectionStart = performance.now();
    socket = net.createConnection({ host: '127.0.0.1', port: relay.port }); socket.on('error', () => {});
    socket.on('data', bytes => {
      firstDown ??= performance.now(); received = Buffer.concat([received, bytes]);
      if (received.length === payload.length) { downEnd = performance.now(); uploadStart = performance.now(); socket.write(payload); }
    });
    await until(() => uploadEnd, 'both raw calibration directions complete', 15000);
    details.downMilliseconds = downEnd - connectionStart; details.upMilliseconds = uploadEnd - uploadStart;
    details.firstDownMilliseconds = firstDown - connectionStart; details.payloadBytes = payload.length; details.payloadSHA256 = digest(payload);
    check('TCP relay preserves every calibration byte in both directions', received.equals(payload) && uploaded.equals(payload));
    check('downlink has the requested sustained pace and propagation delay', details.downMilliseconds >= 1800 && details.downMilliseconds <= 3000 && details.firstDownMilliseconds >= 60, details);
    check('uplink has its independently requested sustained pace', details.upMilliseconds >= 3500 && details.upMilliseconds <= 5500);
    socket.destroy(); await until(() => relay.activeLinks === 0, 'calibration peer close propagates');
    check('relay queues are bounded and owned connections close', relay.records.every(value => value.closed && value.down.peakQueueBytes <= 65536 && value.up.peakQueueBytes <= 65536));
  } catch (error) { details.failure = error.message; check('calibration prerequisites and observation complete', false, { error: error.message }); }
  finally {
    socket?.destroy(); for (const peer of peers) peer.destroy(); await new Promise(resolve => sink.close(resolve));
    await relay?.close(); details.links = relay?.records; details.milliseconds = performance.now() - started; details.checkCount = checks.length - offset; cases.push(details); await save();
  }
}

async function scenario(name, action, options = {}) {
  if (selected && !selected.includes(name)) return;
  const started = performance.now(), offset = checks.length, directory = path.join(output, name), tasks = [], clients = [], readers = [], samples = [];
  const details = { name, startedAt: new Date().toISOString() }; let lab, monitor, timer;
  try {
    lab = await createCaddyFixture(config, tracks, directory, { ...options, strictSniHost: process.env.PROXY_STRICT_SNI_HOST !== '0' });
    details.rustPid = lab.app.pid; details.proxyPid = lab.proxyPid; details.certificate = lab.certificate; details.configuration = lab.configuration;
    monitor = await sampler(lab.app, path.join(directory, 'process-samples.jsonl'), ['proxy:' + lab.proxyPid + ':' + lab.tlsPort,
      ...(process.env.RESOURCE_NAV_PID ? ['navidrome:' + process.env.RESOURCE_NAV_PID + ':4533'] : [])]);
    assert.ok(monitor.available); timer = setInterval(() => samples.push({ recordedAt: new Date().toISOString(), ...lab.app.metrics }), 100);
    const clientFor = async protocol => { const client = protocol === 'h2' ? await http2Client(lab) : http1Client(lab); clients.push(client); return client; };
    const taskFor = async (client, track = big) => {
      const started = performance.now();
      let response = await client.request(apiBase + '/tasks', { method: 'POST', data: { instanceId: config.source.instanceId, songId: track.songId, version: track.sha256 } });
      assert.equal(response.status, 202, 'Owned task admission'); const task = response.value; tasks.push({ client, task });
      await until(async () => { response = await client.request(apiBase + '/tasks/' + task.id); return response.status !== 200 || response.value.state !== 'preparing'; }, 'proxied preparation reaches a terminal state', 15000);
      assert.equal(response.status, 200); assert.equal(response.value.state, 'ready', 'Owned proxied task must become ready');
      return { ...response.value, preparationMilliseconds: performance.now() - started };
    };
    const media = async (client, task, options) => { const reader = await client.media(task.mediaUrl, options); readers.push(reader); return reader; };
    await action({ lab, clientFor, taskFor, media, details, directory });
    for (const reader of readers) reader.close();
    for (const { client, task } of tasks) {
      const cleanup = http1Client(lab); cleanup.cookie = client.cookie;
      await cleanup.request(apiBase + '/tasks/' + task.id, { method: 'DELETE', timeout: 4000 }).catch(() => {});
    }
    await until(async () => { const metrics = await lab.refreshMetrics(); return transient.every(key => metrics[key] === 0); }, 'proxied scenario transient resources return to zero', 8000);
    details.after = { ...lab.app.metrics };
    check(name + ': transient resources return to zero', transient.every(key => details.after[key] === 0));
  } catch (error) { details.failure = error.message; check(name + ': prerequisites and observation complete', false, { error: error.message }); }
  finally {
    clearInterval(timer);
    if (lab) details.beforeTeardown = { metrics: { ...lab.app.metrics }, relayConnections: lab.relay.activeLinks, diagnosticProbeRequests: lab.diagnosticProbeRequests };
    for (const reader of readers) reader.close();
    for (const client of clients) await client.close().catch(() => {});
    if (lab) {
      try {
        const elapsed = await until(() => lab.relay.activeLinks === 0, 'client close drains both relay sockets before stopping processes', 3000);
        details.clientClose = { milliseconds: elapsed, remainingRelayLinks: lab.relay.activeLinks, beforeProcessTeardown: true };
        check(name + ': client closure propagates through the relay before process teardown', true);
      } catch (error) {
        details.clientClose = { remainingRelayLinks: lab.relay.activeLinks, beforeProcessTeardown: true, error: error.message };
        check(name + ': client closure propagates through the relay before process teardown', false, details.clientClose);
      }
    }
    await monitor?.stop();
    if (lab) {
      await lab.close(); details.links = lab.relay.records; details.privateFilesRemoved = lab.privateFilesRemoved;
      check(name + ': temporary TLS files removed and relay connections closed', lab.privateFilesRemoved && lab.relay.activeLinks === 0);
      check(name + ': relay application queues stay within their byte budget', lab.relay.records.every(value => value.down.peakQueueBytes <= 65536 && value.up.peakQueueBytes <= 65536));
    }
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'library-samples.json'), JSON.stringify(samples) + '\n');
    details.finishedAt = new Date().toISOString(); details.milliseconds = performance.now() - started; details.checkCount = checks.length - offset;
    cases.push(details); await save();
    console.log(JSON.stringify({ scenario: name, checks: details.checkCount, failures: checks.slice(offset).filter(value => !value.passed).map(value => value.name), failure: details.failure }));
  }
}

await scenario('protocols', async ({ lab, clientFor, taskFor, details }) => {
  const h1 = await clientFor('h1'), h2 = await clientFor('h2');
  const one = await h1.request('/health'), two = await h2.request('/health');
  check('real Caddy negotiates trusted TLS and HTTP/1.1', one.status === 200 && one.authorized && one.alpn === 'http/1.1', { tls: one.tls, alpn: one.alpn });
  check('real Caddy negotiates trusted TLS and HTTP/2', two.status === 200 && two.authorized && two.alpn === 'h2', h2.transport);
  let untrusted, wrongName;
  try { await h1.request('/health', { trust: false }); } catch (error) { untrusted = error.code; }
  try { await h1.request('https://wrong.example.test:' + new URL(lab.origin).port + '/health'); } catch (error) { wrongName = error.code; }
  check('a client without the test CA rejects the proxy certificate', /CERT|ISSUER|SIGNATURE/.test(untrusted || ''), { error: untrusted });
  check('a different TLS server name cannot use the proxy identity', Boolean(wrongName), { error: wrongName });
  const cookie = await login(h2); h1.cookie = h2.cookie;
  check('the real proxied login issues the secure host cookie', cookie.startsWith('__Host-mhub_library_session=') && /Path=\//.test(cookie) && /Secure/.test(cookie) && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && !/Domain=/i.test(cookie));
  const authenticated = await h1.request(apiBase + '/session');
  check('external Host and port are preserved through HTTP/1 upstream conversion', authenticated.value?.user?.id === credentials.accounts.a.id);
  for (const [label, headers] of [
    ['wrong authority', { ':authority': 'wrong.example.test' }],
    ['wrong port authority', { ':authority': new URL(lab.origin).hostname + ':1' }],
    ['foreign Origin', { origin: 'https://wrong.example.test' }],
    ['null Origin', { origin: 'null' }],
    ['missing write Origin', { origin: undefined }],
  ]) {
    const response = await h2.request(apiBase + '/tasks', { method: 'POST', data: {}, headers });
    check('proxy boundary rejects ' + label, [400, 403, 404, 421].includes(response.status), { status: response.status, bytes: response.bytes, errorCode: response.value?.error?.code });
  }
  const forged = await h2.request(apiBase + '/session', { headers: { 'x-forwarded-host': 'wrong.example.test', 'x-forwarded-proto': 'http', forwarded: 'host=wrong.example.test;proto=http' } });
  check('untrusted forwarding fields cannot replace the actual authority', forged.status === 200 && forged.value?.user?.id === credentials.accounts.a.id);
  const denied = await h2.request(apiBase + '/session', { headers: { ':authority': 'wrong.example.test', 'x-forwarded-host': new URL(lab.origin).host, 'x-forwarded-proto': 'https' } });
  check('forged forwarding fields cannot rescue a wrong authority', [400, 403, 404, 421].includes(denied.status), { status: denied.status, bytes: denied.bytes, errorCode: denied.value?.error?.code });
  for (const route of ['/api/v1/platforms', '/api/v1/auth/config', '/index.html', '/sw.js']) check('the proxy exposes no omitted legacy route ' + route, (await h2.request(route)).status === 404);
  const task = await taskFor(h2), first = 12345, last = first + 65535;
  const range = await h2.request(task.mediaUrl, { headers: { range: `bytes=${first}-${last}` } });
  check('HTTP/2 Range bytes identify the exact original', range.status === 206 && range.body.equals(original.subarray(first, last + 1)) && range.headers['content-range'] === `bytes ${first}-${last}/${original.length}`);
  check('private media stays no-store through the proxy', /no-store/.test(range.headers['cache-control'] || ''));
  const same = await h1.request(task.mediaUrl, { headers: { range: `bytes=${first}-${last}`, 'if-range': range.headers.etag } });
  check('HTTP/1.1 and HTTP/2 preserve the same representation and ETag', same.status === 206 && same.headers.etag === range.headers.etag && same.body.equals(range.body));
  const conditional = await h2.request(task.mediaUrl, { headers: { 'if-none-match': range.headers.etag } });
  check('authorized conditional access is preserved through Caddy', conditional.status === 304 && conditional.bytes === 0);
  const other = await clientFor('h2'); await login(other, 'b');
  const hidden = await other.request(task.mediaUrl, { headers: { range: 'bytes=0-31', 'if-none-match': range.headers.etag } });
  check('another account receives no private Range or validators', [403, 404].includes(hidden.status) && !hidden.headers.etag && !hidden.headers['content-range']);
  details.representations = { first, last, etag: range.headers.etag, sha256: range.sha256, h1SHA256: same.sha256 };
});

await scenario('slow', async ({ clientFor, taskFor, details }) => {
  const client = await clientFor('h2');
  const started = performance.now(), task = await taskFor(client, publicTrack);
  const response = await client.request(task.mediaUrl);
  const publicFinished = performance.now();
  const startup = task.preparationMilliseconds + response.firstByteMs;
  check('healthy slow TLS delivers the complete public original', response.status === 200 && response.complete && response.bytes === publicTrack.size && response.sha256 === publicTrack.sha256);
  check('healthy slow task-to-first-byte meets its declared startup budget', startup <= 3000, { milliseconds: startup, includesTLSConnection: false });
  await login(client); const privateTask = await taskFor(client);
  const range = await client.request(privateTask.mediaUrl, { headers: { range: 'bytes=0-1048575' } });
  check('idle timeout allows a progressing response longer than four seconds', range.status === 206 && range.complete && range.milliseconds > 4000 && range.body.equals(original.subarray(0, 1048576)), { milliseconds: range.milliseconds, bytes: range.bytes });
  const control = await client.request(apiBase + '/session');
  check('slow-network control requests remain responsive', control.status === 200 && control.milliseconds <= 2000, { milliseconds: control.milliseconds });
  details.public = { taskToFirstByteMilliseconds: startup, totalMilliseconds: publicFinished - started,
    tlsConnectionMilliseconds: client.transport.connectionMilliseconds,
    connectionPlusTaskToFirstByteMilliseconds: client.transport.connectionMilliseconds + startup,
    firstByteIsNotAudiblePlayback: true, coldApplicationCache: true, bytes: response.bytes, sha256: response.sha256 };
  details.range = { milliseconds: range.milliseconds, bytes: range.bytes, sha256: range.sha256, complete: range.complete };
}, { shaping: shape, writeIdleSeconds: 4 });

await scenario('reset', async ({ lab, clientFor, taskFor, media, details }) => {
  const h2 = await clientFor('h2'); await login(h2); const task = await taskFor(h2);
  const reader = await media(h2, task, { pauseFirst: true });
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 1, 'a real paused HTTP/2 response is active');
  const start = performance.now(); reader.close();
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 0, 'HTTP/2 RST_STREAM reaches the Rust response', 3000);
  const h2Released = performance.now() - start, result = await reader.done;
  check('HTTP/2 single-stream cancellation releases the backend promptly', h2Released <= 3000 && !result.complete, { milliseconds: h2Released });
  check('the remaining HTTP/2 connection still serves controls', (await h2.request(apiBase + '/session')).value?.user?.id === credentials.accounts.a.id);
  const h1 = await clientFor('h1'); h1.cookie = h2.cookie;
  const second = await media(h1, task, { pauseFirst: true });
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 1, 'a real paused HTTP/1 response is active');
  const closedAt = performance.now(); second.close();
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 0, 'HTTP/1 disconnect reaches Rust', 3000);
  const h1Released = performance.now() - closedAt;
  check('HTTP/1 TCP disconnect releases the backend promptly', h1Released <= 3000, { milliseconds: h1Released });
  details.cancelled = { h2ReleaseMilliseconds: h2Released, h1ReleaseMilliseconds: h1Released,
    bytes: result.bytes, sha256: result.sha256, expectedPrefixSHA256: digest(original.subarray(0, result.bytes)) };
  check('the cancelled response contained only the correct original prefix', details.cancelled.sha256 === details.cancelled.expectedPrefixSHA256);
}, { shaping: shape });

await scenario('logout', async ({ lab, clientFor, taskFor, media, details }) => {
  const client = await clientFor('h2'); await login(client);
  const task = await taskFor(client), reader = await media(client, task);
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 1, 'slow private response is active before logout');
  await pause(700); const start = performance.now(), bytesBefore = reader.bytes;
  const loggedOut = await client.request(apiBase + '/session', { method: 'DELETE' });
  check('real logout succeeds through the same slow HTTP/2 connection', [200, 204].includes(loggedOut.status) && loggedOut.milliseconds <= 2000, { milliseconds: loggedOut.milliseconds });
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 0, 'logout releases the Rust response', 3000);
  const backendReleaseMilliseconds = performance.now() - start;
  const result = await reader.done;
  const responseEndMilliseconds = performance.now() - start;
  check('logout interrupts the large response while preserving its correct prefix', !result.complete && result.bytes < original.length && result.sha256 === digest(original.subarray(0, result.bytes)));
  const denied = await client.request(task.mediaUrl, { headers: { range: 'bytes=0-31' } });
  const accessRecheckedMilliseconds = performance.now() - start;
  check('logged-out Range access is denied without validators', denied.status === 401 && !denied.headers.etag && !denied.headers['content-range']);
  const publicTask = await taskFor(client, publicTrack), publicBytes = await client.request(publicTask.mediaUrl);
  check('the same connection can still play public content after logout', publicBytes.complete && publicBytes.sha256 === publicTrack.sha256);
  details.revocation = { bytesBefore, bytesAfter: result.bytes, backendReleaseMilliseconds, responseEndMilliseconds,
    accessRecheckedMilliseconds, publicPlaybackMilliseconds: publicBytes.milliseconds, sha256: result.sha256,
    alreadyBufferedBytesAreNotRetractable: true, complete: result.complete, error: result.error };
}, { shaping: shape });

await scenario('expiry', async ({ lab, clientFor, taskFor, media, details }) => {
  const client = await clientFor('h2'); await login(client);
  const task = await taskFor(client), start = performance.now(), reader = await media(client, task);
  await until(() => lab.app.metrics.activeMediaResponses === 1, 'a private response is active before real session expiry');
  await until(() => reader.settled, 'real clock session expiration interrupts the client without diagnostic probes', 10000);
  const result = await reader.done;
  const responseEndMilliseconds = performance.now() - start;
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 0, 'confirm resources after independently observed natural expiration', 2000);
  const resourceConfirmationMilliseconds = performance.now() - start;
  check('natural session expiry interrupts only the correct original prefix', !result.complete && result.sha256 === digest(original.subarray(0, result.bytes)));
  const denied = await client.request(task.mediaUrl, { headers: { range: 'bytes=0-31' } });
  const accessRecheckedMilliseconds = performance.now() - start;
  check('the expired task cannot reconnect to cached private bytes', denied.status === 404 && denied.value?.error?.code === 'task_missing' && !denied.headers.etag && !denied.headers['content-range'], { status: denied.status, errorCode: denied.value?.error?.code });
  const opens = lab.app.metrics.mediaOpens;
  const reconnect = await client.request(apiBase + '/tasks', { method: 'POST', data: { instanceId: config.source.instanceId, songId: big.songId, version: big.sha256 } });
  check('the expired identity cannot create a new private playback task', reconnect.status === 401 && lab.app.metrics.mediaOpens === opens, { status: reconnect.status, errorCode: reconnect.value?.error?.code });
  check('the proxy remains usable after upstream authorization expires', (await client.request('/health')).status === 200);
  details.expiry = { resourceConfirmationMilliseconds, responseEndMilliseconds, accessRecheckedMilliseconds, passiveUntilResponseEnded: true,
    measuredFrom: 'media request start', sessionTtlSeconds: 6, bytes: result.bytes, complete: result.complete, error: result.error };
}, { shaping: shape, sessionTtlSeconds: 6 });

await scenario('total-timeout', async ({ clientFor, taskFor, details }) => {
  const client = await clientFor('h2'); await login(client); const task = await taskFor(client);
  const result = await client.request(task.mediaUrl, { headers: { range: 'bytes=0-1048575' } });
  details.expectedNegativeControl = true;
  details.body = { status: result.status, bytes: result.bytes, milliseconds: result.milliseconds, complete: result.complete, error: result.error,
    sha256: result.sha256, expectedFullBytes: 1048576, expectedPrefixSHA256: digest(original.subarray(0, result.bytes)) };
  check('a hard total write limit truncates a still-progressing slow response', result.status === 206 && !result.complete && result.bytes > 0 && result.bytes < 1048576 && result.sha256 === details.body.expectedPrefixSHA256, details.body);
}, { shaping: shape, writeIdleSeconds: -1, writeTotalSeconds: 4 });

await scenario('stalled', async ({ lab, clientFor, taskFor, media, details }) => {
  const client = await clientFor('h2'); await login(client); const task = await taskFor(client);
  const reader = await media(client, task);
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 1, 'response is active before ciphertext delivery is stopped');
  const start = performance.now(); lab.relay.pauseDown(true);
  await until(async () => (await lab.refreshMetrics()).activeMediaResponses === 0, 'edge write-idle deadline cancels the backend', 12000);
  const released = performance.now() - start;
  check('a stalled encrypted connection releases Rust within the configured observation bound', released <= 12000, { milliseconds: released });
  lab.relay.pauseDown(false); const result = await reader.done;
  check('resuming transport reveals an incomplete correct prefix after the idle cutoff', !result.complete && result.sha256 === digest(original.subarray(0, result.bytes)));
  details.stall = { releaseMilliseconds: released, bytes: result.bytes, complete: result.complete, error: result.error };
}, { shaping: shape });

await scenario('browser', async ({ lab, details, directory }) => {
  const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, args: lab.browserArgs, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: 'block', viewport: { width: 1280, height: 920 } });
  const ownedBrowserTasks = [], captures = [];
  try {
    const page = await context.newPage(), failures = [];
    page.on('response', response => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== apiBase + '/tasks' || response.status() !== 202) return;
      captures.push(response.json().then(task => { if (task.id) ownedBrowserTasks.push(task.id); }).catch(() => {}));
    });
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(lab.origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
    check('real Edge sees the proxied origin as a secure context', await page.evaluate(() => window.isSecureContext));
    await pause(Math.max(0, 8500 - (Date.now() - lastLogin))); lastLogin = Date.now();
    await page.locator('#username').fill(credentials.accounts.a.username); await page.locator('#password').fill(credentials.accounts.a.password);
    await page.locator('#login-form button').click();
    await page.waitForFunction(id => window.libraryLab.snapshot().user?.id === id, credentials.accounts.a.id);
    const cookies = await context.cookies(lab.origin), cookie = cookies.find(value => value.name === '__Host-mhub_library_session');
    check('the browser accepts the secure host cookie through actual Caddy', cookie && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/' && cookie.domain === new URL(lab.origin).hostname);
    const row = page.locator('#results .track').filter({ hasText: publicTrack.title });
    await row.locator('.play-track').click();
    await page.waitForFunction(() => window.libraryLab.snapshot().audio.some(value => value.time > .3 && !value.paused));
    check('the actual player advances during slow proxied playback', await page.evaluate(() => window.libraryLab.snapshot().audio.some(value => value.time > .3 && !value.paused)));
    await page.screenshot({ path: path.join(directory, 'proxy-playback.png'), fullPage: true });
    await page.locator('#results .track').filter({ hasText: big.title }).locator('.play-track').click();
    await page.waitForFunction(id => { const value = window.libraryLab.snapshot(); return value.track?.songId === id && value.audio.some(audio => audio.time > .3 && !audio.paused); }, big.songId);
    check('the browser plays the real restricted original through slow TLS', await page.evaluate(() => window.libraryLab.snapshot().track?.access === 'restricted'));
    const logout = page.locator('#logout'); await logout.click();
    await page.waitForFunction(() => !window.libraryLab.snapshot().user);
    check('browser logout removes the secure session cookie', !(await context.cookies(lab.origin)).some(value => value.name === '__Host-mhub_library_session'));
    await page.waitForFunction(() => { const value = window.libraryLab.snapshot(); return !value.track && value.pending === 0 && value.audio.every(audio => audio.paused && !audio.attached); });
    check('browser logout detaches restricted audio and clears pending playback', await page.evaluate(() => { const value = window.libraryLab.snapshot(); return !value.track && value.pending === 0 && value.audio.every(audio => audio.paused && !audio.attached); }));
    check('the proxied player produces no JavaScript exception', failures.length === 0, { failures });
    details.browser = browser.version(); details.browserTrust = 'Per-leaf SPKI exception only; Node independently validates CA and server name.';
  } finally {
    try {
    await Promise.all(captures);
    const cleanup = http1Client(lab), cookies = await context.cookies(lab.origin);
    const cookie = cookies.find(value => value.name === '__Host-mhub_library_session');
    if (cookie) cleanup.cookie = cookie.name + '=' + cookie.value;
    details.browserTaskCleanup = [];
    for (const id of ownedBrowserTasks) {
      const response = await cleanup.request(apiBase + '/tasks/' + id, { method: 'DELETE', timeout: 4000 });
      details.browserTaskCleanup.push({ status: response.status, errorCode: response.value?.error?.code });
    }
    } finally { await context.close().finally(() => browser.close()); }
  }
}, { shaping: shape });

report.finishedAt = new Date().toISOString(); report.checkCount = checks.length; report.passed = checks.every(value => value.passed);
await save(); console.log(JSON.stringify({ passed: report.passed, checks: checks.length, scenarios: cases.length }));
if (!report.passed) process.exitCode = 1;
