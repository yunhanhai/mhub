import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(pending) {
  let timer;
  try { return await Promise.race([pending, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('storage did not settle after cancellation/deadline')), 300);
  })]); } finally { clearTimeout(timer); }
}
async function harness(t, { delayOpen = false } = {}) {
  const previous = globalThis.indexedDB, records = new Map(), transactions = [], controls = [];
  const db = { closed: false, close() { this.closed = true; }, transaction(_name, mode) {
    const settings = controls.shift() || {}, staged = new Map(records), transaction = { mode, error: null, aborted: false };
    transactions.push(transaction);
    const finish = () => { if (transaction.aborted || settings.stall) return;
      if (mode === 'readwrite') { records.clear(); for (const [key, value] of staged) records.set(key, value); }
      transaction.oncomplete?.();
    };
    transaction.release = () => { settings.stall = false; finish(); };
    transaction.abort = () => { transaction.aborted = true; queueMicrotask(() => transaction.onabort?.()); };
    transaction.objectStore = () => {
      const request = value => { const result = { result: value }; queueMicrotask(() => {
        if (transaction.aborted) return; result.onsuccess?.(); queueMicrotask(finish);
      }); return result; };
      return {
        get: key => request(staged.get(key)), getAll: () => request([...staged.values()]),
        put(value, key) { if (settings.quota) throw new DOMException('generated quota failure', 'QuotaExceededError'); staged.set(key, value); return request(key); },
        delete(key) { staged.delete(key); return request(); }, clear() { staged.clear(); return request(); },
      };
    };
    return transaction;
  } };
  let opening, failOpening;
  globalThis.indexedDB = { open() {
    const request = { result: db };
    opening = () => request.onsuccess?.(); failOpening = () => { request.error = new Error('generated open failure'); request.onerror?.(); };
    if (!delayOpen) queueMicrotask(opening); return request;
  } };
  t.after(() => { globalThis.indexedDB = previous; });
  const cache = await import('../src/services/localCache.js?storage-test=' + ++instance);
  return { cache, records, transactions, controls, db, open: () => opening(), failOpen: () => failOpening() };
}

test('cancellation while opening storage settles before the shared open completes', async t => {
  const h = await harness(t, { delayOpen: true }), controller = new AbortController();
  const pending = h.cache.getCachedTrack('song', { signal: controller.signal }); controller.abort();
  await assert.rejects(bounded(pending), error => error === controller.signal.reason);
  assert.equal(h.transactions.length, 0); h.open(); await turn(); assert.equal(h.transactions.length, 0);
  assert.equal(await h.cache.getCachedTrack('song'), undefined);
});

test('cancelling one open waiter does not cancel another caller or close the shared database', async t => {
  const h = await harness(t, { delayOpen: true }), controller = new AbortController();
  h.records.set('song', { key: 'song', title: 'generated' });
  const cancelled = h.cache.getCachedTrack('song', { signal: controller.signal });
  const retained = h.cache.getCachedTrack('song'); controller.abort();
  await assert.rejects(bounded(cancelled), error => error.name === 'AbortError'); h.open();
  assert.equal((await retained).title, 'generated'); assert.equal(h.db.closed, false);
});

test('a default write deadline aborts its transaction without deleting the existing record', async t => {
  const h = await harness(t); await h.cache.getCachedTrack('old');
  h.records.set('old', { key: 'old' }); h.controls.push({ stall: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = h.cache.deleteCachedTrack('old').catch(error => error); await turn();
  t.mock.timers.tick(9999); await turn(); assert.equal(h.transactions.at(-1).aborted, false);
  t.mock.timers.tick(1); await turn(); assert.equal(h.transactions.at(-1).aborted, true);
  assert.equal((await pending).name, 'TimeoutError'); assert.equal(h.records.has('old'), true);
  await h.cache.deleteCachedTrack('old'); assert.equal(h.records.size, 0);
});

test('request callback quota errors abort once, retain old audio and do not retry the write', async t => {
  const h = await harness(t); h.records.set('song', { key: 'song', blob: new Blob(['old']) }); h.controls.push({ quota: true });
  await assert.rejects(h.cache.putCachedTrack('song', { blob: new Blob(['new']) }), error => error.name === 'QuotaExceededError');
  assert.equal(h.transactions.length, 1); assert.equal(h.transactions[0].aborted, true);
  assert.equal(await h.records.get('song').blob.text(), 'old');
});

test('caller cancellation of a pending write rolls back bytes and leaves later saves usable', async t => {
  const h = await harness(t), controller = new AbortController(); h.controls.push({ stall: true });
  const pending = h.cache.putCachedTrack('song', { blob: new Blob(['generated'], { type: 'audio/mpeg' }) }, { signal: controller.signal });
  await turn(); controller.abort(); await assert.rejects(pending, error => error === controller.signal.reason);
  assert.equal(h.records.size, 0); assert.equal(h.transactions[0].aborted, true);
  assert.equal((await h.cache.putCachedTrack('song', { blob: new Blob(['retry'], { type: 'audio/mpeg' }) })).blob.size, 5);
});

test('cancelling after commit releases the caller while shared eviction finishes independently', async t => {
  const h = await harness(t), controller = new AbortController(); h.controls.push({}, { stall: true });
  let committed = false;
  const pending = h.cache.putCachedTrack('song', { blob: new Blob(['generated'], { type: 'audio/mpeg' }) },
    { signal: controller.signal, onCommit: () => { committed = true; } });
  const rejected = assert.rejects(bounded(pending), error => error === controller.signal.reason);
  await turn(); assert.equal(committed, true); assert.equal(h.records.has('song'), true);
  controller.abort(); await rejected;
  assert.equal(h.transactions[0].aborted, false); assert.equal(h.transactions[1].aborted, false);
  h.transactions[1].release(); await turn();
  assert.equal((await h.cache.putCachedTrack('other', { blob: new Blob(['retry'], { type: 'audio/mpeg' }) })).blob.size, 5);
});

test('a late database open failure after cancellation is consumed and a fresh open can recover', async t => {
  const h = await harness(t, { delayOpen: true }), controller = new AbortController();
  const pending = h.cache.getCachedTrack('song', { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, error => error === controller.signal.reason); h.failOpen(); await turn();
  const retry = h.cache.getCachedTrack('song'); h.open(); assert.equal(await retry, undefined);
});

test('cancellation during readback retains its committed audio and propagates the caller reason', async t => {
  const h = await harness(t), controller = new AbortController();
  h.records.set('song', { key: 'song', blob: new Blob(['generated'], { type: 'audio/mpeg' }) }); h.controls.push({}, { stall: true });
  const pending = h.cache.putCachedTrack('song', { track: { title: 'generated' } }, { signal: controller.signal });
  await turn(); controller.abort(); await assert.rejects(pending, error => error === controller.signal.reason);
  assert.equal(h.transactions[1].aborted, true); assert.equal(h.records.get('song').blob.size, 9);
  assert.equal((await h.cache.getCachedTrack('song')).track.title, 'generated');
});

test('every caller abort listener is removed after storage completion', async t => {
  const h = await harness(t), controller = new AbortController(), listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, value) => { if (type === 'abort') listeners.add(listener); return add(type, listener, value); };
  controller.signal.removeEventListener = (type, listener, value) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, value); };
  await h.cache.getCachedTrack('song', { signal: controller.signal }); assert.equal(listeners.size, 0);
});
