import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioUrlPool, createOfflineOperations } from '../../scripts/library-lab/operations.mjs';

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('repeated save for the same representation shares one pending operation', async () => {
  const gate = deferred(); let calls = 0;
  const operations = createOfflineOperations({ locks: null });
  const first = operations.run('instance:song:v1', 'save', async () => { calls++; await gate.promise; return 'saved'; });
  const second = operations.run('instance:song:v1', 'save', async () => { calls++; });
  assert.equal(first, second); await tick(); assert.equal(calls, 1);
  assert.deepEqual(operations.state('instance:song:v1'), { kind: 'save', phase: 'running' });
  gate.resolve(); assert.equal(await second, 'saved'); assert.equal(operations.size, 0);
});

test('remove requested during save waits and runs after save settles', async () => {
  const gate = deferred(), order = [], operations = createOfflineOperations({ locks: null });
  const save = operations.run('song', 'save', async () => { order.push('saving'); await gate.promise; order.push('saved'); });
  const remove = operations.run('song', 'remove', async () => { order.push('removed'); });
  await tick(); assert.deepEqual(order, ['saving']); gate.resolve(); await Promise.all([save, remove]);
  assert.deepEqual(order, ['saving', 'saved', 'removed']);
});

test('different file versions do not block each other', async () => {
  const gate = deferred(), operations = createOfflineOperations({ locks: null });
  const first = operations.run('song:v1', 'save', async () => gate.promise);
  let secondRan = false;
  await operations.run('song:v2', 'save', async () => { secondRan = true; });
  assert.equal(secondRan, true); assert.equal(operations.size, 1); gate.resolve(); await first;
});

test('failed save releases pending state and can be retried', async () => {
  const operations = createOfflineOperations({ locks: null });
  await assert.rejects(operations.run('song', 'save', async () => { throw new Error('request failed'); }), /request failed/);
  assert.equal(operations.size, 0);
  assert.equal(await operations.run('song', 'save', async () => true), true);
});

test('cancel all also cancels an opposite operation queued behind a failed save', async () => {
  const gate = deferred(), operations = createOfflineOperations({ locks: null });
  const first = operations.run('song', 'save', async signal => { await gate.promise; signal.throwIfAborted(); });
  let removeCalled = false;
  const next = operations.run('song', 'remove', async () => { removeCalled = true; });
  const settled = Promise.allSettled([first, next]);
  await tick(); operations.cancelAll(); gate.resolve();
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(removeCalled, false); assert.equal(operations.size, 0);
});

test('Web Lock handoff records waiting and forwards cancellation signal', async () => {
  const gate = deferred(); let received, called = false;
  const operations = createOfflineOperations({ locks: { async request(name, options, execute) {
    received = { name, options }; await gate.promise; return execute();
  } } });
  const request = operations.run('song', 'save', async () => { called = true; });
  await tick(); assert.equal(operations.state('song').phase, 'waiting');
  assert.equal(received.name, 'mhub-library-offline:song'); assert.equal(received.options.mode, 'exclusive');
  operations.cancelAll(); assert.equal(received.options.signal.aborted, true); gate.resolve();
  await assert.rejects(request, error => error.name === 'AbortError'); assert.equal(called, false); assert.equal(operations.size, 0);
});

test('audio URL handoff grace retains attached/prepared sources and releases abandoned URLs', () => {
  let time = 0, count = 0; const revoked = [];
  const pool = createAudioUrlPool({ createUrl: () => 'blob:' + ++count, revokeUrl: url => revoked.push(url), now: () => time, handoffMs: 1000 });
  const current = pool.create({}), next = pool.create({}), abandoned = pool.create({});
  pool.sweep(new Set([current, next])); assert.equal(pool.size, 3);
  time = 1000; pool.sweep(new Set([current, next])); assert.deepEqual(revoked, [abandoned]);
  pool.release(next); pool.release(next); assert.equal(revoked.length, 2);
  pool.clear(); assert.equal(pool.size, 0); assert.deepEqual(revoked, [abandoned, next, current]);
});

test('cancel one representation preserves an independent save', async () => {
  const gate = deferred(), operations = createOfflineOperations({ locks: null });
  const first = operations.run('one', 'save', async signal => { await gate.promise; signal.throwIfAborted(); });
  const second = operations.run('two', 'save', async signal => { await gate.promise; signal.throwIfAborted(); return true; });
  const settled = Promise.allSettled([first, second]); await tick();
  assert.equal(operations.cancel('one'), true); assert.equal(operations.cancel('one'), false);
  gate.resolve(); const results = await settled;
  assert.equal(results[0].reason.name, 'AbortError'); assert.equal(results[1].value, true); assert.equal(operations.size, 0);
});

test('cancel a waiting Web Lock operation prevents its callback and allows retry', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const operations = createOfflineOperations({ locks: { async request(_name, _options, run) { await gate; return run(); } } });
  let ran = false; const pending = operations.run('song', 'save', async () => { ran = true; });
  await tick(); assert.equal(operations.cancel('song'), true); release();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(ran, false);
  assert.equal(await operations.run('song', 'save', async () => true), true);
});
