import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayIntents } from '../../scripts/library-lab/play-intent.mjs';
const intent = (key, trackKey = key) => ({ key, trackKey });
const gate = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };

test('duplicate current intent returns the exact promise and runs its player action synchronously once', async () => {
  const pending = gate(), actions = createPlayIntents(); let calls = 0;
  const first = actions.run(intent('one'), () => { calls++; return pending.promise; });
  assert.equal(calls, 1);
  const second = actions.run(intent('one'), () => { calls++; });
  assert.equal(second, first); assert.equal(actions.pendingCount, 1);
  pending.resolve(true); assert.equal(await second, true); assert.equal(calls, 1); assert.equal(actions.state(), null);
});

test('different target aborts old intent and late old settlement cannot clear the new one', async () => {
  const a = gate(), b = gate(), actions = createPlayIntents(); let oldSignal;
  const first = actions.run(intent('one'), signal => { oldSignal = signal; return a.promise; });
  const second = actions.run(intent('two'), () => b.promise);
  assert.equal(oldSignal.aborted, true); assert.equal(actions.pendingCount, 2);
  a.resolve(false); await first; assert.deepEqual(actions.state(), intent('two')); assert.equal(actions.pendingCount, 1);
  b.resolve(true); await second; assert.equal(actions.state(), null); assert.equal(actions.pendingCount, 0);
});

test('cancelled intent allows a new same-song request while old work is still settling', async () => {
  const old = gate(), next = gate(), actions = createPlayIntents(); let signal;
  const first = actions.run(intent('same'), value => { signal = value; return old.promise; });
  actions.cancel(); assert.equal(signal.aborted, true); assert.equal(actions.state(), null); assert.equal(actions.pendingCount, 1);
  const second = actions.run(intent('same'), () => next.promise); assert.notEqual(second, first);
  old.resolve(false); await first; assert.deepEqual(actions.state(), intent('same'));
  next.resolve(true); await second; assert.equal(actions.pendingCount, 0);
});

test('selection and replacement for one song remain distinct intents', async () => {
  const firstWork = gate(), actions = createPlayIntents(); let replacement = false;
  const first = actions.run(intent('select:one', 'one'), () => firstWork.promise);
  const second = actions.run(intent('replace:one,two', 'one'), () => { replacement = true; return true; });
  assert.equal(replacement, true); assert.notEqual(second, first); assert.equal(await second, true);
  firstWork.resolve(false); await first;
});

test('failure and synchronous errors release state for explicit retry', async () => {
  const actions = createPlayIntents();
  await assert.rejects(actions.run(intent('one'), () => { throw new Error('failed'); }), /failed/);
  assert.equal(actions.state(), null); assert.equal(actions.pendingCount, 0);
  assert.equal(await actions.run(intent('one'), () => true), true);
});

test('rapid one-two-one selection does not merge the renewed one with its cancelled predecessor', async () => {
  const a = gate(), b = gate(), c = gate(), actions = createPlayIntents();
  const one = actions.run(intent('one'), () => a.promise);
  const two = actions.run(intent('two'), () => b.promise);
  const renewed = actions.run(intent('one'), () => c.promise); assert.notEqual(one, renewed);
  a.resolve(false); b.resolve(false); await Promise.all([one, two]); assert.deepEqual(actions.state(), intent('one'));
  c.resolve(true); await renewed; assert.equal(actions.state(), null);
});

test('an incomplete target never starts player work', async () => {
  const actions = createPlayIntents(); let calls = 0;
  assert.equal(await actions.run(intent('', ''), () => { calls++; }), false); assert.equal(calls, 0);
});
