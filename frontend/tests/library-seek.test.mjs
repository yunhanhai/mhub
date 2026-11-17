import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeekInput } from '../../scripts/library-lab/seek.mjs';

function harness() {
  const state = { key: 'instance:song:v1:source', enabled: true, duration: 12, position: 2 };
  const calls = [];
  const control = createSeekInput({ readState: () => state, seek: value => calls.push(value) });
  return { state, calls, control };
}
test('idle focused control follows actual position rather than retaining a stale draft', () => {
  const h = harness(); assert.equal(h.control.view().value, 2);
  h.state.position = 4; assert.equal(h.control.view().value, 4); assert.equal(h.control.view().preview, false);
});
test('pointer movement previews many positions and commits exactly once at release', () => {
  const h = harness(); h.control.begin(1); h.control.input(4); h.control.input(6); h.control.input(8);
  assert.equal(h.control.view().value, 8); assert.deepEqual(h.calls, []);
  h.control.end(1); assert.deepEqual(h.calls, [8000]); h.control.change(8); assert.deepEqual(h.calls, [8000]);
});
test('native change before pointerup confirms once and repeated end cannot confirm twice', () => {
  const h = harness(); h.control.begin(4); h.control.input(7); h.control.change(7); h.control.end(4);
  assert.deepEqual(h.calls, [7000]);
});
test('keyboard input commits immediately while its following change is not repeated', () => {
  const h = harness(); h.control.input(3); h.control.change(3); assert.deepEqual(h.calls, [3000]);
  h.control.input(3); h.control.change(3); assert.deepEqual(h.calls, [3000, 3000]);
});
test('change-only accessible input also commits a requested position', () => {
  const h = harness(); h.control.change(6); assert.deepEqual(h.calls, [6000]);
});
test('Escape-style cancellation ignores remaining pointer inputs until the same gesture ends', () => {
  const h = harness(); h.control.begin(2); h.control.input(9); h.control.cancel(); h.control.input(10); h.control.change(10); h.control.end(2);
  assert.deepEqual(h.calls, []); assert.equal(h.control.view().value, 2);
});
test('pointerup before change after cancellation cannot commit a discarded gesture', () => {
  const h = harness(); h.control.begin(2); h.control.input(9); h.control.cancel(); h.control.end(2); h.control.change(9);
  assert.deepEqual(h.calls, []); h.control.input(4); h.control.change(4); assert.deepEqual(h.calls, [4000]);
});
test('lost capture ignores later native drag input until an external pointerup closes it', () => {
  const h = harness(); h.control.begin(1); h.control.input(7); h.control.cancel(); h.control.input(8);
  assert.equal(h.control.view().editing, true); h.control.end(1); h.control.change(8);
  assert.deepEqual(h.calls, []); assert.equal(h.control.view().editing, false);
});
test('pointer cancellation releases editing and a later keyboard seek remains possible', () => {
  const h = harness(); h.control.begin(2); h.control.input(9); h.control.cancel({ release: true });
  h.control.input(4); assert.deepEqual(h.calls, [4000]);
});
test('new source or identity cancels old draft before it can affect the newly selected audio', () => {
  const h = harness(); h.control.begin(2); h.control.input(11); h.state.key = 'instance:song:v2:other-source'; h.state.position = 0;
  assert.equal(h.control.view().value, 0); h.control.input(8); h.control.end(2); assert.deepEqual(h.calls, []);
});
test('source preparation disables commit and discards a draft from the preceding source', () => {
  const h = harness(); h.control.begin(3); h.control.input(7); h.state.enabled = false;
  h.control.end(3); assert.deepEqual(h.calls, []); assert.equal(h.control.view().enabled, false);
});
test('values clamp to current duration and second pointer cannot replace an active gesture', () => {
  const h = harness(); h.control.begin(1); assert.equal(h.control.begin(2), false);
  h.control.input(20); assert.equal(h.control.view().value, 12); assert.equal(h.control.end(2), false);
  h.control.end(1); assert.deepEqual(h.calls, [12000]); h.control.input(-1); assert.deepEqual(h.calls, [12000, 0]);
});
test('no-movement gesture and nonfinite input do not generate a seek', () => {
  const h = harness(); h.control.begin(1); h.control.end(1); h.control.input(NaN);
  assert.deepEqual(h.calls, []);
});
test('held keyboard arrows preview repeated five-second steps and commit once at keyup', () => {
  const h = harness(); h.control.keydown('ArrowRight'); h.control.keydown('ArrowRight');
  assert.equal(h.control.view().value, 12); assert.equal(h.control.view().preview, true); assert.deepEqual(h.calls, []);
  h.control.keyup('ArrowRight'); assert.deepEqual(h.calls, [12000]); assert.equal(h.control.view().editing, false);
});
test('keyboard Escape-style cancel and source replacement both discard preview without commit', () => {
  const h = harness(); h.control.keydown('End'); h.control.cancel(); h.control.keyup('End'); assert.deepEqual(h.calls, []);
  h.control.keydown('ArrowRight'); h.state.key = 'other-source'; h.control.keyup('ArrowRight'); assert.deepEqual(h.calls, []);
});
test('native change following committed keyboard operation cannot repeat the native seek', () => {
  const h = harness(); h.control.keydown('ArrowRight'); h.control.keyup('ArrowRight'); h.control.change(7);
  assert.deepEqual(h.calls, [7000]);
});
