import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryQueue, libraryTrackKey } from '../../scripts/library-lab/queue.mjs';

const track = (id, access = 'public', version = 'v1') => ({ instanceId: 'instance', songId: id, version,
  id: ['instance', id, version].join(':'), source_id: ['instance', id, version].join(':'), title: id,
  access, offlineAllowed: access === 'public' });
function harness(items = [], playIndex = -1) {
  const queue = { queue: [...items], get queueLength() { return this.queue.length; } };
  const status = { playIndex };
  const calls = [];
  const player = {
    insertManyToQueue(items) { const next = items.filter(item => !queue.queue.some(existing => libraryTrackKey(existing) === libraryTrackKey(item))); queue.queue.push(...next); return next.length; },
    queueNextMany(items) { calls.push({ kind: 'next', items }); return items.length; },
    playFrom(items, index) { calls.push({ kind: 'replace', items, index }); queue.queue = items; status.playIndex = index; return true; },
    playAtIndex(index) { calls.push({ kind: 'play', index }); status.playIndex = index; return true; },
    playNow(item) { calls.push({ kind: 'now', item }); return true; },
    removeFromQueue(index) { queue.queue.splice(index, 1); if (index < status.playIndex) status.playIndex--; },
  };
  return { control: createLibraryQueue({ player, queue, status }), queue, status, calls };
}

test('first play captures result order and later results cannot replace it', async () => {
  const h = harness(), items = [track('one'), track('two')];
  await h.control.play(items[1], items);
  assert.equal(h.status.playIndex, 1);
  items[0].title = 'edited search result'; items.reverse();
  assert.deepEqual(h.queue.queue.map(item => item.songId), ['one', 'two']);
  assert.equal(h.queue.queue[0].title, 'one');
  await h.control.play(track('one'), [track('different-result')]);
  assert.equal(h.calls.at(-1).kind, 'play');
  assert.equal(h.queue.queue.length, 2);
});

test('explicit replacement uses selected representation and ignores duplicate or incomplete items', async () => {
  const h = harness([track('old')], 0);
  assert.equal(await h.control.replace([track('one'), track('one'), null, track('two')], track('two')), true);
  assert.equal(h.status.playIndex, 1);
  assert.deepEqual(h.queue.queue.map(item => item.songId), ['one', 'two']);
  assert.equal(await h.control.replace([]), false);
});

test('queue identity includes instance and trusted file version', () => {
  const a = track('song'), b = track('song', 'public', 'v2'), c = { ...a, instanceId: 'other' };
  assert.notEqual(libraryTrackKey(a), libraryTrackKey(b));
  assert.notEqual(libraryTrackKey(a), libraryTrackKey(c));
  assert.equal(libraryTrackKey({ songId: 'song' }), '');
  const h = harness();
  assert.equal(h.control.append([a, b, c, a]), 3);
});

test('step obeys queue boundaries without implicit wrapping or selecting idle songs', async () => {
  const h = harness([track('one'), track('two')], 0);
  assert.equal(await h.control.step(-1), false);
  assert.equal(await h.control.step(1), true);
  assert.equal(await h.control.step(1), false);
  h.status.playIndex = -1;
  assert.equal(await h.control.step(1), false);
});

test('remove and clear upcoming preserve active selection and history', () => {
  const h = harness([track('past'), track('current'), track('next'), track('tail')], 1);
  assert.equal(h.control.remove(1), false);
  assert.equal(h.control.clearUpcoming(), 2);
  assert.deepEqual(h.queue.queue.map(item => item.songId), ['past', 'current']);
  assert.equal(h.control.remove(0), true);
  assert.equal(h.status.playIndex, 0);
});

test('offline pruning keeps playing public Blob but removes private and unavailable versions', () => {
  const h = harness([track('past'), track('current'), track('saved'), track('private', 'restricted'), track('changed', 'public', 'v1')], 1);
  assert.equal(h.control.restrictOffline([track('saved'), track('changed', 'public', 'v2'), track('private', 'restricted')], true), 3);
  assert.deepEqual(h.queue.queue.map(item => item.songId), ['current', 'saved']);
  assert.equal(h.status.playIndex, 0);
});

test('explicit play of an unqueued song delegates to play-now without replacing the existing queue', async () => {
  const h = harness([track('current'), track('next')], 0);
  await h.control.play(track('choice'), [track('choice')]);
  assert.equal(h.calls.at(-1).kind, 'now');
  assert.deepEqual(h.queue.queue.map(item => item.songId), ['current', 'next']);
});
