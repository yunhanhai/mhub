import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAudioVerifier, AUDIO_VERIFICATION_TIMEOUT_MS } from '../../scripts/library-lab/audio-integrity.mjs';
import { OFFLINE_AUDIO_MAX_BYTES } from '../../scripts/library-lab/download.mjs';

const bytes = new Uint8Array([1, 2, 3, 4]), blob = new Blob([bytes], { type: 'audio/mpeg' });
const options = { expectedBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
async function bounded(pending) {
  let timer;
  try { return await Promise.race([pending, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('verification did not settle after cancellation/deadline')), 300);
  })]); } finally { clearTimeout(timer); }
}

test('a complete original returns the same Blob only after its SHA-256 matches', async () => {
  assert.equal(AUDIO_VERIFICATION_TIMEOUT_MS, 10000);
  assert.equal(await createAudioVerifier()(blob, options), blob);
  await assert.rejects(createAudioVerifier()(blob, { ...options, sha256: '0'.repeat(64) }), error => error.offlineIntegrity === true && error.message.includes('校验失败'));
});

test('invalid metadata and byte bounds are rejected before reading or hashing', async () => {
  let reads = 0;
  const verify = createAudioVerifier({ readBlob: () => { reads++; throw new Error('must not read'); } });
  for (const patch of [{ expectedBytes: 0 }, { expectedBytes: -1 }, { expectedBytes: 1.5 },
    { expectedBytes: OFFLINE_AUDIO_MAX_BYTES + 1 }, { sha256: '' }, { sha256: 'A'.repeat(64) }, { sha256: '../invalid' }]) {
    await assert.rejects(verify(blob, { ...options, ...patch }), error => error.offlineIntegrity === true);
  }
  for (const value of [null, {}, new Blob(['x']), new Blob([new Uint8Array(5)])]) {
    await assert.rejects(verify(value, options), error => error.offlineIntegrity === true && error.message.includes('大小不匹配'));
  }
  assert.equal(reads, 0);
});

test('the largest supported 32 MiB original is verified with the production deadline', async () => {
  const bytes = new Uint8Array(OFFLINE_AUDIO_MAX_BYTES), original = new Blob([bytes], { type: 'audio/flac' });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await createAudioVerifier()(original, { expectedBytes: bytes.length, sha256 }), original);
});

test('an already cancelled caller never starts a Blob read', async () => {
  const controller = new AbortController(); controller.abort(); let reads = 0;
  await assert.rejects(createAudioVerifier({ readBlob: () => { reads++; } })(blob, { ...options, signal: controller.signal }), error => error === controller.signal.reason);
  assert.equal(reads, 0);
});

test('cancelling a stalled Blob read settles promptly and prevents a late digest', async () => {
  const reading = deferred(), controller = new AbortController(); let hashes = 0;
  const verify = createAudioVerifier({ readBlob: () => reading.promise, digestImpl: () => { hashes++; } });
  const pending = verify(blob, { ...options, signal: controller.signal }); controller.abort();
  await assert.rejects(bounded(pending), error => error === controller.signal.reason);
  reading.resolve(bytes.buffer); await turn(); assert.equal(hashes, 0);
});

test('cancelling a stalled digest does not block a later independent verification', async () => {
  const hashing = deferred(), controller = new AbortController(); let calls = 0;
  const verify = createAudioVerifier({ digestImpl: value => ++calls === 1 ? hashing.promise : crypto.subtle.digest('SHA-256', value) });
  const pending = verify(blob, { ...options, signal: controller.signal }); await turn(); controller.abort();
  await assert.rejects(bounded(pending), error => error === controller.signal.reason);
  assert.equal(await verify(blob, options), blob);
  hashing.resolve(await crypto.subtle.digest('SHA-256', bytes)); await turn(); assert.equal(calls, 2);
});

test('the verification deadline settles an unresponsive Blob read', async () => {
  let hashes = 0;
  const verify = createAudioVerifier({ timeoutMs: 20, readBlob: () => new Promise(() => {}), digestImpl: () => { hashes++; } });
  await assert.rejects(bounded(verify(blob, options)), error => error.name === 'TimeoutError' && !error.offlineIntegrity);
  assert.equal(hashes, 0);
});

test('the verification deadline settles an unresponsive digest and consumes its late failure', async () => {
  const hashing = deferred();
  await assert.rejects(bounded(createAudioVerifier({ timeoutMs: 20, digestImpl: () => hashing.promise })(blob, options)), error => error.name === 'TimeoutError');
  hashing.reject(new Error('late crypto failure')); await turn();
});

test('Blob reading and digest share one total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = deferred(), hashing = deferred(); let settled = false;
  const verify = createAudioVerifier({ timeoutMs: 25, readBlob: () => reading.promise, digestImpl: () => hashing.promise });
  const pending = verify(blob, options).catch(error => { settled = true; return error; });
  t.mock.timers.tick(15); reading.resolve(bytes.buffer); await turn();
  t.mock.timers.tick(9); await turn(); assert.equal(settled, false);
  t.mock.timers.tick(1); await turn(); assert.equal(settled, true); assert.equal((await pending).name, 'TimeoutError');
});

test('synchronous Blob cancellation still consumes its rejecting promise', async () => {
  const controller = new AbortController();
  const verify = createAudioVerifier({ readBlob: () => { controller.abort(); return Promise.reject(new Error('read failure after cancel')); } });
  await assert.rejects(verify(blob, { ...options, signal: controller.signal }), error => error === controller.signal.reason);
  await turn();
});

test('cancellation between the Blob read and continuation prevents digest submission', async () => {
  const controller = new AbortController(); let hashes = 0;
  const verify = createAudioVerifier({ readBlob: () => {
    const ready = Promise.resolve(bytes.buffer); void ready.then(() => controller.abort()); return ready;
  }, digestImpl: () => { hashes++; } });
  await assert.rejects(verify(blob, { ...options, signal: controller.signal }), error => error === controller.signal.reason);
  assert.equal(hashes, 0);
});

test('caller listeners are removed after success, integrity failure and cancellation', async () => {
  for (const mode of ['success', 'mismatch', 'cancel']) {
    const controller = new AbortController(), listeners = new Set();
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (type, listener, value) => { if (type === 'abort') listeners.add(listener); return add(type, listener, value); };
    controller.signal.removeEventListener = (type, listener, value) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, value); };
    const pending = createAudioVerifier(mode === 'cancel' ? { readBlob: () => new Promise(() => {}) } : {})(blob,
      { ...options, sha256: mode === 'mismatch' ? '0'.repeat(64) : options.sha256, signal: controller.signal });
    if (mode === 'cancel') controller.abort();
    await pending.catch(() => {}); assert.equal(listeners.size, 0);
  }
});

test('storage and cryptographic failures keep their original reason', async () => {
  for (const stage of ['readBlob', 'digestImpl']) {
    const reason = new DOMException('generated failure', 'OperationError');
    await assert.rejects(createAudioVerifier({ [stage]: () => { throw reason; } })(blob, options), error => error === reason);
  }
});
