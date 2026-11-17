import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineAudioDownload, OFFLINE_AUDIO_MAX_BYTES } from '../../scripts/library-lab/download.mjs';

const options = { expectedBytes: 4, contentType: 'audio/mpeg' };
const bytes = new Uint8Array([1, 2, 3, 4]);
const audio = (body = bytes, headers = {}) => new Response(body, { headers: { 'content-type': 'audio/mpeg', ...headers } });
test('complete original is streamed once with actual byte progress and no credentials', async () => {
  const progress = []; let settings;
  const download = createOfflineAudioDownload({ fetchImpl: async (_url, value) => { settings = value; return audio(); } });
  const blob = await download('/fixture', { ...options, onProgress: item => progress.push(item.receivedBytes) });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(blob.type, 'audio/mpeg'); assert.equal(settings.credentials, 'omit'); assert.equal(settings.cache, 'no-store');
  assert.deepEqual(progress, [0, 4]);
});
test('invalid original size is rejected before network work or memory allocation', async () => {
  let calls = 0; const download = createOfflineAudioDownload({ fetchImpl: async () => { calls++; return audio(); } });
  for (const size of [0, -1, 1.5, OFFLINE_AUDIO_MAX_BYTES + 1]) await assert.rejects(download('/fixture', { ...options, expectedBytes: size }), /信息无效/);
  assert.equal(calls, 0);
});
test('HTTP errors, partial responses, MIME and declared length mismatches are rejected', async () => {
  for (const response of [new Response('', { status: 503 }), new Response(bytes, { status: 206 }),
    new Response(bytes, { headers: { 'content-type': 'text/html' } }), audio(bytes, { 'content-length': '100' })]) {
    await assert.rejects(createOfflineAudioDownload({ fetchImpl: async () => response })('/fixture', options));
  }
});
test('early EOF cannot become a saved complete original', async () => {
  await assert.rejects(createOfflineAudioDownload({ fetchImpl: async () => audio(bytes.subarray(0, 2)) })('/fixture', options), /不完整/);
});
test('chunked oversized body is cancelled before accepting bytes beyond the original length', async () => {
  let cancelled = false;
  const response = audio(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }));
  await assert.rejects(createOfflineAudioDownload({ fetchImpl: async () => response })('/fixture', options), /大小不匹配/);
  assert.equal(cancelled, true);
});
test('a stalled header or body has a cancellable idle deadline', async () => {
  const waitingHeaders = createOfflineAudioDownload({ idleMs: 20, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(waitingHeaders('/fixture', options), error => error.name === 'TimeoutError');
  let cancelled = false;
  const waitingBody = createOfflineAudioDownload({ idleMs: 20, fetchImpl: async () => audio(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(waitingBody('/fixture', options), error => error.name === 'TimeoutError'); assert.equal(cancelled, true);
});

test('headers and empty chunks do not reset the no-byte idle deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseHeaders, requestSignal;
  const download = createOfflineAudioDownload({ idleMs: 20, fetchImpl: (_url, value) => {
    requestSignal = value.signal; return new Promise(resolve => { releaseHeaders = resolve; });
  } });
  const pending = download('/fixture', options);
  const rejected = assert.rejects(pending, error => error.name === 'TimeoutError');
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(10);
  releaseHeaders(audio(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(0)); } })));
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(9);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1); await rejected;
});
test('received chunks reset only the idle deadline while total deadline still bounds a trickle', async () => {
  let interval;
  const response = audio(new ReadableStream({ start(controller) { interval = setInterval(() => controller.enqueue(new Uint8Array([1])), 8); }, cancel() { clearInterval(interval); } }));
  const download = createOfflineAudioDownload({ idleMs: 200, totalMs: 35, fetchImpl: async () => response });
  await assert.rejects(download('/fixture', { ...options, expectedBytes: 100 }), error => error.name === 'TimeoutError' && error.message.includes('用时过长'));
});
test('caller cancellation preserves AbortError and cancels the active reader', async () => {
  const controller = new AbortController(); let cancelled = false;
  const download = createOfflineAudioDownload({ fetchImpl: async () => audio(new ReadableStream({ cancel() { cancelled = true; } })) });
  const pending = download('/fixture', { ...options, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(cancelled, true);
});
test('late response after idle cancellation is discarded and its body released', async () => {
  let release, cancelled = false;
  const response = audio(new ReadableStream({ cancel() { cancelled = true; } }));
  const download = createOfflineAudioDownload({ idleMs: 10, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(download('/fixture', options), error => error.name === 'TimeoutError');
  release(response); await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});

test('many small chunks keep cancellation listeners bounded and remove them after completion', async () => {
  const active = new Set(); let peak = 0, emitted = 0;
  const download = createOfflineAudioDownload({ fetchImpl: async (_url, options) => {
    const add = options.signal.addEventListener.bind(options.signal), remove = options.signal.removeEventListener.bind(options.signal);
    options.signal.addEventListener = (type, listener, value) => { if (type === 'abort') { active.add(listener); peak = Math.max(peak, active.size); } return add(type, listener, value); };
    options.signal.removeEventListener = (type, listener, value) => { if (type === 'abort') active.delete(listener); return remove(type, listener, value); };
    return audio(new ReadableStream({ pull(controller) { if (emitted++ < 1024) controller.enqueue(new Uint8Array([1])); else controller.close(); } }));
  } });
  const blob = await download('/fixture', { ...options, expectedBytes: 1024 });
  assert.equal(blob.size, 1024); assert.ok(peak <= 1); assert.equal(active.size, 0);
});
