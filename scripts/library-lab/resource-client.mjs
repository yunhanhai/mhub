/** Shared real HTTP clients for resource experiments. No browser or fake clock. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBackend, apiBase, clientHeader } from './backend.mjs';

export const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const selection = (config, track) => ({ instanceId: config.source.instanceId, songId: track.songId, version: track.sha256 });
export async function until(predicate, label, timeout = 7000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (await predicate()) return performance.now() - started;
    await pause(50);
  }
  throw new Error('Timed out: ' + label);
}
export async function inventory(directory) {
  const files = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/\.(audio|partial)$/.test(name)) continue;
    const value = await stat(path.join(directory, name)).catch(() => null);
    if (value?.isFile()) files.push({ name, bytes: value.size });
  }
  return { files, bytes: files.reduce((sum, value) => sum + value.bytes, 0), partials: files.filter(value => value.name.endsWith('.partial')).length };
}
export async function request(app, route, { method = 'GET', data, cookie = app.cookie, headers = {}, signal } = {}) {
  const started = performance.now();
  const response = await fetch(app.origin + route, { method, signal: signal || AbortSignal.timeout(25000),
    headers: { origin: app.origin, [clientHeader]: '1', ...(cookie ? { cookie } : {}),
      ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body,
    value: /json/.test(response.headers.get('content-type') || '') && body.length ? JSON.parse(body) : null,
    milliseconds: performance.now() - started };
}
export async function startApp(config, directory, tracks, changes = {}) {
  await mkdir(directory, { recursive: true });
  const policyFile = path.join(directory, 'policy.json'), cacheDir = path.join(directory, 'cache');
  await writeFile(policyFile, JSON.stringify({ instanceId: config.source.instanceId, tracks }));
  const app = await createBackend({ ...config, ...changes, policyFile, cacheDir }, { exclusive: true });
  app.origin = await app.start(); app.cacheDir = cacheDir; app.policyFile = policyFile;
  return app;
}
export async function login(app, account) {
  const response = await request(app, apiBase + '/session', { method: 'POST', data: account });
  assert.equal(response.status, 200, 'Owned user login');
  app.cookie = response.headers.get('set-cookie').split(';')[0];
  return response.headers.get('set-cookie');
}
export async function createTask(app, config, track, options) {
  return request(app, apiBase + '/tasks', { method: 'POST', data: selection(config, track), ...options });
}
export async function ready(app, value) {
  let task = value;
  await until(async () => {
    const response = await request(app, apiBase + '/tasks/' + task.id);
    assert.equal(response.status, 200, 'Task status'); task = response.value;
    return task.state !== 'preparing';
  }, 'task preparation', 25000);
  assert.equal(task.state, 'ready', 'Task becomes ready'); return task;
}
export async function cancel(app, task) {
  return request(app, apiBase + '/tasks/' + task.id, { method: 'DELETE' });
}

/** A real HTTP/1 reader with bounded application buffering. A pace of zero
 * pauses after the first chunk; a positive pace meters reads every 100 ms.
 * The socket/OS may buffer more, so callers must verify server file leases.
 */
export async function pacedReader(app, mediaUrl, { bytesPerSecond = 0, cookie = app.cookie, headers = {}, timeout = 180000 } = {}) {
  const started = performance.now(), hash = createHash('sha256');
  let response, total = 0, status, length, firstByteMs, interval, finish, begin, credit = 0;
  let lastTick = performance.now(), unmetered = false, settled = false, aborted = false, hardTimer;
  const done = new Promise(resolve => { finish = resolve; });
  const opened = new Promise(resolve => { begin = resolve; });
  const result = error => {
    if (settled) return;
    settled = true; clearInterval(interval); clearTimeout(hardTimer);
    const value = { status, contentLength: length, bytes: total, firstByteMs,
      milliseconds: performance.now() - started, sha256: hash.digest('hex'), complete: Boolean(response?.complete),
      locallyAborted: aborted, ...(error ? { error: error.code || error.message } : {}) };
    finish(value); begin();
  };
  const consume = () => {
    if (!response || settled) return;
    while (unmetered || credit >= 1) {
      const available = response.readableLength;
      if (!available) break;
      const amount = unmetered ? available : Math.min(available, Math.floor(credit));
      const chunk = response.read(amount);
      if (!chunk) break;
      if (firstByteMs === undefined) firstByteMs = performance.now() - started;
      total += chunk.length; hash.update(chunk);
      if (!unmetered) credit -= chunk.length;
      begin();
    }
    // In readable mode, reading the exact remaining length can leave EOF
    // pending until another read. Account for a complete HTTP body explicitly.
    response.read(0);
    if (response.complete && total === length) result();
  };
  const req = http.get(app.origin + mediaUrl, { agent: false, highWaterMark: 65536,
    headers: { origin: app.origin, connection: 'close', ...(cookie ? { cookie } : {}), ...headers } }, incoming => {
    response = incoming; status = incoming.statusCode; length = Number(incoming.headers['content-length']);
    credit = bytesPerSecond ? bytesPerSecond / 10 : 65536;
    if (status !== 200 && status !== 206) unmetered = true;
    incoming.on('readable', consume); incoming.on('end', () => result()); incoming.on('error', result);
    incoming.on('aborted', () => result(Object.assign(new Error('response aborted'), { code: 'ECONNRESET' })));
    consume();
    interval = setInterval(() => {
      const now = performance.now();
      if (bytesPerSecond && !unmetered) credit = Math.min(bytesPerSecond, credit + bytesPerSecond * (now - lastTick) / 1000);
      lastTick = now; consume();
    }, 100);
  });
  req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('reader timed out'), { code: 'ETIMEDOUT' })));
  req.on('error', result);
  hardTimer = setTimeout(() => { response?.destroy(); req.destroy(); result(Object.assign(new Error('reader deadline'), { code: 'ETIMEDOUT' })); }, timeout);
  await opened;
  return { get bytes() { return total; }, get status() { return status; }, get firstByteMs() { return firstByteMs; },
    get settled() { return settled; }, done,
    resume() { unmetered = true; consume(); },
    close() { aborted = true; response?.destroy(); req.destroy(); result(); } };
}

export async function sourceProxy(config) {
  const stats = { streamsStarted: 0, streamsClosed: 0, activeStreams: 0, peakStreams: 0, metadataRequests: 0, deniedMetadata: 0, errors: [] };
  const control = { hold: false, denySongId: null, denyUsername: null }, pending = new Set();
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController(), isStream = req.url === '/rest/stream.view';
    let ended; const closed = new Promise(resolve => { ended = resolve; });
    res.once('close', () => { controller.abort(); ended(); });
    pending.add(res);
    let reader;
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      // Explicit fault injection after a real admission check. Never record
      // the form: it contains the owned source account's authentication values.
      if (req.url === '/rest/getSong.view' && control.denySongId) {
        const parameters = new URLSearchParams(Buffer.concat(chunks).toString());
        if (parameters.get('id') === control.denySongId && (!control.denyUsername || parameters.get('u') === control.denyUsername)) {
          stats.metadataRequests++; stats.deniedMetadata++;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 50, message: 'Controlled owned-fixture denial' } } }));
          return;
        }
      }
      const upstream = await fetch(config.source.baseUrl + req.url, { method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
        body: Buffer.concat(chunks), signal: controller.signal, redirect: 'error' });
      if (isStream && upstream.ok && /audio/.test(upstream.headers.get('content-type') || '')) {
        stats.streamsStarted++; stats.activeStreams++; stats.peakStreams = Math.max(stats.peakStreams, stats.activeStreams);
        reader = upstream.body.getReader();
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type'), 'content-length': upstream.headers.get('content-length') });
        if (control.hold) {
          let sent = 0;
          while (sent < 4096) {
            const part = await reader.read(); assert.ok(!part.done);
            const slice = part.value.subarray(0, Math.min(part.value.length, 4096 - sent));
            res.write(slice); sent += slice.length;
          }
          await closed;
        } else {
          while (!controller.signal.aborted) {
            const part = await reader.read(); if (part.done) break;
            if (!res.write(part.value)) await Promise.race([closed, new Promise(resolve => res.once('drain', resolve))]);
          }
          if (!controller.signal.aborted) res.end();
        }
      } else {
        stats.metadataRequests++;
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type'), 'content-length': body.length }).end(body);
      }
    } catch (error) {
      if (!controller.signal.aborted) { stats.errors.push(error.code || 'proxy_failure'); res.destroy(); }
    } finally {
      if (reader) {
        await reader.cancel().catch(() => {}); stats.activeStreams--; stats.streamsClosed++;
      }
      pending.delete(res);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { stats, control, source: { ...config.source, baseUrl: 'http://127.0.0.1:' + server.address().port },
    async close() { for (const res of pending) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export async function sampler(app, output, extraTargets = []) {
  if (process.platform !== 'win32' || !process.env.RESOURCE_PYTHON) return { async stop() {}, available: false };
  const stopFile = output + '.stop';
  const script = fileURLToPath(new URL('./sample-resource-processes.py', import.meta.url));
  const child = spawn(process.env.RESOURCE_PYTHON, [script, output, stopFile, 'rust:' + app.pid + ':' + new URL(app.origin).port,
    'generator:' + process.pid, ...extraTargets], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  await until(async () => Boolean((await stat(output).catch(() => null))?.size), 'native process sampler', 8000);
  return { available: true, async stop() {
    await writeFile(stopFile, 'stop\n'); const code = await closed;
    assert.equal(code, 0, 'Process sampler must complete: ' + errors);
  } };
}
