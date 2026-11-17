import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryRequest } from '../../scripts/library-lab/request.mjs';
const make = options => createLibraryRequest({ apiBase: '/api/v1/library', clientHeader: 'x-mhub-library', ...options });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

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
