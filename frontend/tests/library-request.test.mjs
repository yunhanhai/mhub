import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryRequest } from '../../scripts/library-lab/request.mjs';
const make = options => createLibraryRequest({ apiBase: '/api/v1/library', clientHeader: 'x-mhub-library', ...options });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(pending) {
  let timer;
  try { return await Promise.race([pending, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('request did not settle after cancellation/deadline')), 300);
  })]); } finally { clearTimeout(timer); }
}

test('control requests preserve same-origin credentials, headers and API mapping', async () => {
  let called;
  const request = make({ fetchImpl: async (...args) => { called = args; return json({ user: null }); } });
  assert.deepEqual(await request('/api/session', { method: 'POST', data: { username: 'fixture', password: 'test-only' } }), { user: null });
  assert.equal(called[0], '/api/v1/library/session'); assert.equal(called[1].credentials, 'same-origin');
  assert.equal(called[1].headers['x-mhub-library'], '1'); assert.equal(called[1].cache, 'no-store');
});
test('HTTP failure keeps its status and safe structured message', async () => {
  const request = make({ fetchImpl: async () => new Response('{"error":{"message":"try later"}}', { status: 503, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(request('/api/search'), error => error.kind === 'http' && error.status === 503 && error.message === 'try later');
});
test('HTML, malformed JSON and scalar payloads are rejected without exposing response text', async () => {
  for (const response of [new Response('<html>private fixture</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('broken', { headers: { 'content-type': 'application/json' } }), json(null)]) {
    await assert.rejects(make({ fetchImpl: async () => response })('/api/search'), error => !error.message.includes('private fixture') && !error.message.includes('broken'));
  }
});
test('deadline aborts a stalled response body as well as the initial fetch', async () => {
  let cancelled = false;
  const request = make({ timeoutMs: 20, fetchImpl: async (_url, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => { cancelled = true; controller.error(options.signal.reason); }); },
  }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(request('/api/session'), error => error.name === 'TimeoutError'); assert.equal(cancelled, true);
});
test('caller cancellation remains AbortError and does not become a timeout/network error', async () => {
  const controller = new AbortController();
  const request = make({ fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))) });
  const pending = request('/api/tasks', { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});
test('byte bound also applies to streamed JSON without content-length', async () => {
  let cancelled = false;
  const request = make({ maxBytes: 8, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"oversized":true}')); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(request('/api/search'), /超过/); assert.equal(cancelled, true);
});
test('network failures are distinguishable from valid HTTP and protocol failures', async () => {
  await assert.rejects(make({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })('/api/search'), error => error.kind === 'network');
});
test('late response cannot succeed after its own deadline even if a transport ignores cancellation', async () => {
  const request = make({ timeoutMs: 15, fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return json({ user: null }); } });
  await assert.rejects(request('/api/session'), error => error.name === 'TimeoutError');
});
test('early protocol rejection cancels its unread body without waiting for cleanup', async () => {
  let cancelled = false;
  const request = make({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(request('/api/session'), /格式无效/); assert.equal(cancelled, true);
});

test('deadline settles even when the initial transport never acknowledges abort', async () => {
  const request = make({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(bounded(request('/api/session')), error => error.name === 'TimeoutError');
});

test('deadline settles a stalled body and releases its reader without awaiting cancellation', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } });
  const request = make({ timeoutMs: 20, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(bounded(request('/api/session')), error => error.name === 'TimeoutError');
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
});

test('caller cancellation settles an uncooperative fetch with the original reason', async () => {
  const controller = new AbortController(), reason = new DOMException('selected another track', 'AbortError');
  const request = make({ timeoutMs: 50, fetchImpl: () => new Promise(() => {}) });
  const pending = request('/api/tasks', { signal: controller.signal }); controller.abort(reason);
  await assert.rejects(bounded(pending), error => error === reason);
});

test('caller cancellation settles an uncooperative body and releases its reader', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } });
  const controller = new AbortController();
  const request = make({ timeoutMs: 50, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  const pending = request('/api/tasks', { signal: controller.signal }); await turn(); controller.abort();
  await assert.rejects(bounded(pending), error => error === controller.signal.reason);
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
});

test('late old response is cancelled after an independent manual retry succeeds', async () => {
  let release, calls = 0, cancelled = 0;
  const request = make({ timeoutMs: 20, fetchImpl: () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : json({ user: null }) });
  await assert.rejects(bounded(request('/api/session')), error => error.name === 'TimeoutError');
  assert.deepEqual(await request('/api/session'), { user: null });
  release(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } }));
  await turn(); assert.equal(cancelled, 1); assert.equal(calls, 2);
});

test('late fetch rejection after timeout is consumed without an unhandled rejection', async () => {
  let reject;
  const request = make({ timeoutMs: 20, fetchImpl: () => new Promise((_resolve, fail) => { reject = fail; }) });
  await assert.rejects(bounded(request('/api/session')), error => error.name === 'TimeoutError');
  reject(new TypeError('late transport failure')); await turn();
});

test('already cancelled callers never send a request', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(make({ fetchImpl: () => { calls++; return json({}); } })('/api/session', { signal: controller.signal }), error => error === controller.signal.reason);
  assert.equal(calls, 0);
});

test('synchronous transport cancellation still consumes its rejecting promise', async () => {
  const controller = new AbortController();
  const request = make({ fetchImpl: () => { controller.abort(); return Promise.reject(new TypeError('transport rejected during cancellation')); } });
  await assert.rejects(request('/api/session', { signal: controller.signal }), error => error === controller.signal.reason);
  await turn();
});

test('cancellation between fetch completion and its continuation releases the unread body', async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } });
  const request = make({ fetchImpl: () => {
    const ready = Promise.resolve(response); void ready.then(() => controller.abort()); return ready;
  } });
  await assert.rejects(request('/api/session', { signal: controller.signal }), error => error === controller.signal.reason);
  await turn(); assert.equal(cancelled, 1);
});

test('many small chunks keep abort listeners bounded and remove caller and internal listeners', async () => {
  const active = new Set(), callerActive = new Set(); let peak = 0, emitted = 0;
  const watch = (signal, listeners) => {
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, value) => { if (type === 'abort') { listeners.add(listener); peak = Math.max(peak, listeners.size); } return add(type, listener, value); };
    signal.removeEventListener = (type, listener, value) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, value); };
  };
  const controller = new AbortController(); watch(controller.signal, callerActive);
  const request = make({ fetchImpl: async (_url, options) => {
    watch(options.signal, active);
    const bytes = new TextEncoder().encode(JSON.stringify({ value: 'x'.repeat(2048) }));
    return new Response(new ReadableStream({ pull(stream) { if (emitted < bytes.length) stream.enqueue(bytes.subarray(emitted, ++emitted)); else stream.close(); } }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal((await request('/api/search', { signal: controller.signal })).value.length, 2048);
  assert.ok(peak <= 1); assert.equal(active.size, 0); assert.equal(callerActive.size, 0);
});

test('the total deadline is shared by headers and all body chunks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, stream, settled = false;
  const request = make({ timeoutMs: 25, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = request('/api/search').catch(error => { settled = true; return error; });
  t.mock.timers.tick(15);
  release(new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'application/json' } }));
  await turn(); stream.enqueue(new TextEncoder().encode('{"value":')); await turn();
  t.mock.timers.tick(9); await turn(); assert.equal(settled, false);
  stream.enqueue(new TextEncoder().encode('true')); await turn();
  t.mock.timers.tick(1); await turn(); assert.equal(settled, true);
  assert.equal((await pending).name, 'TimeoutError');
});
