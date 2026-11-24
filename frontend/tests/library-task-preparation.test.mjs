import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskPreparation } from '../../scripts/library-lab/task-preparation.mjs';

const track = { instanceId: 'generated', songId: 'one', version: 'a'.repeat(64) }, id = 'a'.repeat(32), otherId = 'b'.repeat(32);
const task = state => ({ id, state, track, mediaUrl: '/api/v1/library/tasks/' + id + '/audio' });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const harness = request => {
  const owned = [], released = [], calls = [];
  const prepare = createTaskPreparation({ request: (url, options) => { calls.push({ url, options }); return request(url, options, calls.length); },
    ownTask: value => owned.push(value), releaseTask: value => released.push(value), timeoutMs: 25, pollMs: 5 });
  return { prepare, owned, released, calls };
};

test('a ready created task transfers ownership once without polling or cancellation', async () => {
  const h = harness(() => task('ready')); assert.deepEqual(await h.prepare(track), task('ready'));
  assert.deepEqual(h.owned, [id]); assert.deepEqual(h.released, []); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.method, 'POST'); assert.deepEqual(h.calls[0].options.data, track);
});

test('one total deadline includes the create request and a stalled status request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const creating = deferred(), polling = deferred();
  const h = harness((_url, _options, count) => count === 1 ? creating.promise : polling.promise); let settled = false;
  const pending = h.prepare(track).catch(error => { settled = true; return error; });
  t.mock.timers.tick(15); creating.resolve(task('preparing')); await turn(); t.mock.timers.tick(5); await turn();
  assert.equal(h.calls.length, 2); t.mock.timers.tick(4); await turn(); assert.equal(settled, false);
  t.mock.timers.tick(1); await turn(); assert.equal(settled, true); assert.equal((await pending).name, 'TimeoutError');
  assert.deepEqual(h.released, [id]); polling.resolve(task('ready')); await turn(); assert.equal(h.calls.length, 2);
});

test('a never completing task creation settles on its total deadline without inventing an ID', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = harness(() => new Promise(() => {})); let settled = false;
  const pending = h.prepare(track).catch(error => { settled = true; return error; });
  t.mock.timers.tick(25); await turn(); assert.equal(settled, true); assert.equal((await pending).name, 'TimeoutError');
  assert.deepEqual(h.owned, []); assert.deepEqual(h.released, []); assert.equal(h.calls.length, 1);
});

test('cancelling during a pending poll releases the originally owned task promptly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const polling = deferred(), controller = new AbortController();
  const h = harness((_url, _options, count) => count === 1 ? task('preparing') : polling.promise); let settled = false;
  const pending = h.prepare(track, controller.signal).catch(error => { settled = true; return error; });
  await turn(); t.mock.timers.tick(5); await turn(); controller.abort(); await turn();
  assert.equal(settled, true); assert.equal(await pending, controller.signal.reason); assert.deepEqual(h.released, [id]);
  polling.reject(new Error('late generated status failure')); await turn();
});

test('cancelling the polling interval never submits another status request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const controller = new AbortController(), h = harness(() => task('preparing'));
  let settled = false; const pending = h.prepare(track, controller.signal).catch(error => { settled = true; return error; });
  await turn(); controller.abort(); await turn(); assert.equal(settled, true); assert.equal(await pending, controller.signal.reason);
  t.mock.timers.tick(25); await turn(); assert.equal(h.calls.length, 1); assert.deepEqual(h.released, [id]);
});

test('an invalid or replaced polling ID cannot leak the original task or release a different one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const response of [null, {}, { ...task('ready'), id: otherId }, { ...task('preparing'), id: '../unexpected' }]) {
    const h = harness((_url, _options, count) => count === 1 ? task('preparing') : response);
    const pending = h.prepare(track).then(() => null, error => error); await turn(); t.mock.timers.tick(5); await turn();
    const error = await pending; assert.equal(error?.kind, 'protocol'); assert.deepEqual(h.released, [id]); assert.equal(h.calls.length, 2);
  }
});

test('status failures preserve the protocol reason and release the original task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness((_url, _options, count) => count === 1 ? task('preparing') : { ...task('failed'), error: 'version_changed' });
  const pending = assert.rejects(h.prepare(track), error => error.kind === 'task' && error.code === 'version_changed');
  await turn(); t.mock.timers.tick(5); await pending; assert.deepEqual(h.released, [id]);
});

test('HTTP poll errors keep their original classification without resubmitting task creation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const reason = Object.assign(new Error('generated failure'), { kind: 'http', code: 'task_owner', status: 403 });
  const h = harness((_url, _options, count) => { if (count === 1) return task('preparing'); throw reason; });
  const pending = assert.rejects(h.prepare(track), error => error === reason); await turn(); t.mock.timers.tick(5); await pending;
  assert.equal(h.calls.filter(x => x.options.method === 'POST').length, 1); assert.deepEqual(h.released, [id]);
});

test('invalid creation IDs are rejected before resource ownership or cleanup', async () => {
  for (const value of [null, {}, { ...task('ready'), id: 'short' }, { ...task('ready'), id: '../unexpected' }]) {
    const h = harness(() => value); await assert.rejects(h.prepare(track), error => error.kind === 'protocol');
    assert.deepEqual(h.owned, []); assert.deepEqual(h.released, []);
  }
});

test('already cancelled callers never submit task creation', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness(() => task('ready'));
  await assert.rejects(h.prepare(track, controller.signal), error => error === controller.signal.reason); assert.equal(h.calls.length, 0);
});

test('an expired identity generation releases its task before any poll', async () => {
  const released = [], owned = [], reason = new DOMException('generated generation change', 'AbortError');
  const prepare = createTaskPreparation({ request: async () => task('ready'), ownTask: value => owned.push(value), releaseTask: value => released.push(value),
    checkCurrent: () => { throw reason; } });
  await assert.rejects(prepare(track), error => error === reason); assert.deepEqual(owned, [id]); assert.deepEqual(released, [id]);
});

test('caller listeners are removed after a ready task is handed off', async () => {
  const controller = new AbortController(), active = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => { if (type === 'abort') active.add(listener); return add(type, listener, options); };
  controller.signal.removeEventListener = (type, listener, options) => { if (type === 'abort') active.delete(listener); return remove(type, listener, options); };
  await harness(() => task('ready')).prepare(track, controller.signal); assert.equal(active.size, 0);
});

test('many preparing replies keep wait listeners bounded and remove them at handoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const active = new Set(); let peak = 0, polls = 0, observed = false;
  const prepare = createTaskPreparation({ timeoutMs: 1000, pollMs: 1, ownTask() {}, releaseTask() {},
    request: (_url, { signal }) => {
      if (!observed) {
        observed = true; const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = (type, listener, options) => { if (type === 'abort') { active.add(listener); peak = Math.max(peak, active.size); } return add(type, listener, options); };
        signal.removeEventListener = (type, listener, options) => { if (type === 'abort') active.delete(listener); return remove(type, listener, options); };
      }
      return task(polls++ < 100 ? 'preparing' : 'ready');
    } });
  const pending = prepare(track); await turn();
  for (let index = 0; index < 100; index++) { t.mock.timers.tick(1); await turn(); }
  assert.equal((await pending).state, 'ready'); assert.ok(peak <= 1); assert.equal(active.size, 0);
});

test('invalid state is rejected while retaining cleanup ownership of a valid created ID', async () => {
  const h = harness(() => ({ ...task('ready'), state: 'unknown' }));
  await assert.rejects(h.prepare(track), error => error.kind === 'protocol');
  assert.deepEqual(h.owned, [id]); assert.deepEqual(h.released, [id]);
});

test('synchronous cancellation during request submission consumes its late rejected promise', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return Promise.reject(new Error('generated late failure')); });
  await assert.rejects(h.prepare(track, controller.signal), error => error === controller.signal.reason); await turn();
  assert.deepEqual(h.owned, []); assert.deepEqual(h.released, []);
});
