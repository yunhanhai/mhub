import test from "node:test";
import assert from "node:assert/strict";
import { AlacPacketStreamParser, validateAlacStreamBlob } from "../src/utils/alac-stream.js";

// Protocol fixtures only. Real codec samples are covered by the browser
// ALAC regression; these bytes exercise framing, truncation and cancellation.
function fixture(lengths = [3, 7, 5]) {
  const bytes = new Uint8Array(48 + lengths.reduce((sum, length) => sum + 8 + length, 0));
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("SPLALAC1"));
  view.setUint32(8, 2); view.setUint32(12, 44100);
  bytes[16] = 2; bytes[17] = 16;
  view.setUint16(18, 24); view.setUint32(20, 4096);
  let offset = 48;
  const ends = [];
  for (const length of lengths) {
    view.setUint32(offset, length); view.setUint32(offset + 4, 1024);
    bytes.fill(ends.length + 1, offset + 8, offset + 8 + length);
    offset += 8 + length; ends.push(offset);
  }
  return { bytes, ends };
}

test("network chunk boundaries do not change packet bytes or duration", async () => {
  const { bytes } = fixture();
  const original = bytes.slice();
  for (let split = 1; split < bytes.length; split++) {
    const parser = new AlacPacketStreamParser();
    const packets = [...parser.push(bytes.subarray(0, split)), ...parser.push(bytes.subarray(split))];
    parser.finish();
    assert.deepEqual(packets.map(packet => packet.duration), [1024, 1024, 1024]);
    assert.deepEqual(packets.map(packet => [...packet.bytes]), [[1, 1, 1], Array(7).fill(2), Array(5).fill(3)]);
  }
  await validateAlacStreamBlob(new Blob([bytes]));
  assert.deepEqual(bytes, original);
});

test("every truncated header, cookie, packet framing and payload is rejected", async () => {
  const { bytes, ends } = fixture();
  for (let length = 0; length < bytes.length; length++) {
    if (ends.includes(length)) continue;
    await assert.rejects(validateAlacStreamBlob(new Blob([bytes.subarray(0, length)])), Error, `prefix ${length}`);
  }
});

test("a valid header without any packet cannot become cached audio", async () => {
  await assert.rejects(validateAlacStreamBlob(new Blob([fixture([]).bytes])), /没有音频 packet/);
});

test("invalid packet sizes and durations fail before cache acceptance", async () => {
  for (const [offset, value] of [[48, 0], [48, 16 * 1024 * 1024 + 1], [52, 0], [52, 4097]]) {
    const { bytes } = fixture();
    new DataView(bytes.buffer).setUint32(offset, value);
    await assert.rejects(validateAlacStreamBlob(new Blob([bytes])), /packet/);
  }
});

test("a packet spanning cache read windows remains complete without a whole Blob read", async () => {
  const { bytes } = fixture([2 * 1024 * 1024 + 37, 5]);
  const blob = new Blob([bytes]);
  const slice = blob.slice.bind(blob);
  let reads = 0;
  blob.arrayBuffer = () => { throw new Error("Must not materialize the complete song"); };
  blob.slice = (start, end) => { reads++; assert.ok(end - start <= 2 * 1024 * 1024); return slice(start, end); };
  await validateAlacStreamBlob(blob);
  assert.ok(reads > 1);
});

test("cancellation during an asynchronous Blob read prevents acceptance", async () => {
  const controller = new AbortController();
  const blob = new Blob([fixture().bytes]);
  const slice = blob.slice.bind(blob);
  blob.slice = (...args) => {
    const part = slice(...args), read = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => { const bytes = await read(); controller.abort(); return bytes; };
    return part;
  };
  await assert.rejects(validateAlacStreamBlob(blob, { signal: controller.signal }), { name: "AbortError" });
});

test("framing alone cannot establish that a whole final packet is present", async () => {
  const { bytes, ends } = fixture();
  // The protocol has no trusted total frame count. A valid shorter stream
  // needs transport length or source metadata to distinguish it from loss.
  await validateAlacStreamBlob(new Blob([bytes.subarray(0, ends[0])]));
});
