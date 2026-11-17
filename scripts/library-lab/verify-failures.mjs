/** Controlled transport faults around a REAL Navidrome source.
 * node scripts/library-lab/verify-failures.mjs CONFIG CREDENTIALS REPORT_DIR
 * The loopback proxy withholds original bytes or invalidates a stream token;
 * all identity, metadata and protocol-error responses still come from Navidrome.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createBackend as createLibraryLab, apiRoute, clientHeader, rustBackend } from './backend.mjs';

const [configPath, credentialsPath, reportDir] = process.argv.slice(2);
if (![configPath, credentialsPath, reportDir].every(Boolean)) throw new Error('Expected CONFIG CREDENTIALS REPORT_DIR');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const config = await json(configPath), credentials = await json(credentialsPath), policy = await json(config.policyFile);
await mkdir(reportDir, { recursive: true });
const run = await mkdtemp(path.join(reportDir, 'fault-run-')), cacheDir = path.join(run, 'cache');
let mode = 'hold-original', prefixDelivered = false, downstreamClosed = false, rawProtocol;
const checks = [], errors = [];
const report = { recordedAt: new Date().toISOString(), backend: rustBackend ? 'music-api Rust' : 'Node reference', scope: 'Controlled loopback proxy; real Navidrome accounts, original audio and actual protocol errors.', checks };
const check = (name, condition) => { checks.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cacheFiles = async () => (await readdir(cacheDir)).filter(name => name !== '.mhub-library.lock');
async function until(predicate) { const end = Date.now() + 8000; while (Date.now() < end) { if (await predicate()) return; await sleep(50); } throw new Error('Fault test condition timed out'); }
const proxy = http.createServer(async (request, response) => {
  const controller = new AbortController(); let interrupted;
  const closed = new Promise(resolve => { interrupted = resolve; });
  response.on('close', () => { controller.abort(); interrupted(); });
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    const stream = request.url === '/rest/stream.view';
    if (stream && mode === 'invalid-stream-token') { const form = new URLSearchParams(body.toString()); form.set('t', '0'.repeat(32)); body = Buffer.from(form.toString()); }
    const upstream = await fetch(new URL(request.url, config.source.baseUrl), { method: request.method, redirect: 'error', signal: controller.signal,
      headers: { 'content-type': request.headers['content-type'] || 'application/x-www-form-urlencoded' }, body });
    const headers = Object.fromEntries(['content-type', 'content-length'].filter(h => upstream.headers.has(h)).map(h => [h, upstream.headers.get(h)]));
    if (stream && mode === 'hold-original') {
      response.writeHead(upstream.status, headers);
      const reader = upstream.body.getReader(), prefix = Buffer.alloc(4096);
      let received = 0;
      while (received < prefix.length) {
        const part = await reader.read();
        if (part.done) throw new Error('Expected a real original-file prefix');
        const length = Math.min(part.value.length, prefix.length - received);
        prefix.set(part.value.subarray(0, length), received); received += length;
      }
      response.write(prefix); prefixDelivered = true;
      await closed; downstreamClosed = true;
      await reader.cancel().catch(() => {});
      return;
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (stream && mode === 'invalid-stream-token') {
      const envelope = JSON.parse(bytes)['subsonic-response'];
      rawProtocol = { http: upstream.status, status: envelope.status, code: envelope.error.code, bytes: bytes.length };
    }
    // fetch may decompress JSON; its original Content-Length no longer describes
    // the decoded body forwarded by this test proxy.
    response.writeHead(upstream.status, { ...headers, 'content-length': bytes.length }).end(bytes);
  } catch (e) {
    if (!controller.signal.aborted) { errors.push(e.message); response.destroy(); }
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyOrigin = 'http://127.0.0.1:' + proxy.address().port;
const app = await createLibraryLab({ ...config, port: 0, cacheDir, source: { ...config.source, baseUrl: proxyOrigin } }, { ui: false });
const origin = await app.start();
let cookie = '';
async function request(route, { method = 'GET', data, anonymous = false } = {}) {
  const r = await fetch(origin + apiRoute(route), { method, signal: AbortSignal.timeout(10000), headers: { origin, [clientHeader]: '1', ...(data ? { 'content-type': 'application/json' } : {}), ...(cookie && !anonymous ? { cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const b = await r.json(); return { status: r.status, body: b, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const wanted = entry => ({ instanceId: config.source.instanceId, songId: entry.songId, version: entry.sha256 });
try {
  const login = await request('/api/session', { method: 'POST', data: credentials.accounts.a }); cookie = login.cookie;
  report.login = { http: login.status, error: login.body.error?.code };
  check('real A login through controlled proxy', login.status === 200 && login.body.user.id === credentials.accounts.a.id);
  const entry = policy.tracks.find(t => t.access === 'restricted');
  const task = await request('/api/tasks', { method: 'POST', data: wanted(entry) });
  check('restricted task is preparing', task.status === 202 && task.body.state === 'preparing');
  await until(async () => {
    const partial = (await readdir(cacheDir)).find(f => f.endsWith('.partial'));
    return prefixDelivered && partial && (await stat(path.join(cacheDir, partial))).size >= 4096;
  });
  check('original bytes reached an incomplete private cache file', prefixDelivered && (await readdir(cacheDir)).some(f => f.endsWith('.partial')));
  const logout = await request('/api/session', { method: 'DELETE' });
  check('logout succeeds while original download is incomplete', logout.status === 200);
  await until(async () => downstreamClosed && (await cacheFiles()).length === 0);
  check('logout aborts the upstream stream and removes partial bytes', downstreamClosed && (await cacheFiles()).length === 0 && app.metrics.cancelled === 1);
  const stale = await request('/api/tasks/' + task.body.id);
  check('the stale cookie cannot inspect the cancelled task', stale.status === 401);
  mode = 'invalid-stream-token'; cookie = '';
  const publicEntry = policy.tracks.find(t => t.access === 'public');
  const created = await request('/api/tasks', { method: 'POST', data: wanted(publicEntry), anonymous: true });
  check('metadata authorization succeeds before the injected stream failure', created.status === 202);
  let completed;
  await until(async () => { completed = (await request('/api/tasks/' + created.body.id)).body; return completed.state !== 'preparing'; });
  check('media endpoint HTTP-200 auth error is rejected as protocol failure', completed.state === 'failed' && completed.error === 'source_auth' && rawProtocol?.http === 200 && rawProtocol.status === 'failed' && rawProtocol.code === 40);
  check('JSON auth error publishes no cached media', (await cacheFiles()).length === 0 && app.metrics.protocolFailures === 1);
  check('fault proxy has no unrelated failures', errors.length === 0);
  report.passed = true;
} catch (e) { report.passed = false; report.failure = e.message; process.exitCode = 1; }
finally {
  report.metrics = { ...app.metrics }; report.rawProtocol = rawProtocol; report.checkCount = checks.length; report.proxyErrors = errors;
  report.transportAtCompletion = { prefixDelivered, downstreamClosed, cacheFiles: await readdir(cacheDir).catch(() => []) };
  await app.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  await writeFile(path.join(reportDir, 'faults.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
}
