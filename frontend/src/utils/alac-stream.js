const HEADER_BYTES = 24;
const STREAM_MAGIC = "SPLALAC1";
const STREAM_VERSION = 2;
const CACHE_READ_BYTES = 2 * 1024 * 1024;

function readU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function concatBytes(left, right) {
  if (!left?.byteLength) return right.slice();
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

export class AlacPacketStreamParser {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.header = null;
  }

  // Parse with a read offset. Re-slicing the remaining buffer after every
  // packet copied each network chunk once per packet it contained. Packets
  // are read-only views; only an incomplete tail is copied into the next push.
  push(chunk) {
    if (chunk?.byteLength) {
      this.buffer = concatBytes(this.buffer.subarray(this.offset), chunk);
      this.offset = 0;
    }
    const packets = [];
    if (!this.header && this.buffer.byteLength - this.offset >= HEADER_BYTES) {
      const start = this.offset;
      const magic = new TextDecoder().decode(this.buffer.subarray(start, start + 8));
      const version = readU32(this.buffer, start + 8);
      const cookieLength = readU16(this.buffer, start + 18);
      if (magic !== STREAM_MAGIC || version !== STREAM_VERSION || cookieLength < 24 || cookieLength > 64) {
        throw new Error("ALAC 流协议版本或配置无效");
      }
      const headerLength = HEADER_BYTES + cookieLength;
      if (this.buffer.byteLength - start < headerLength) return packets;
      this.headerBytes = this.buffer.slice(start, start + headerLength);
      this.header = {
        sampleRate: readU32(this.buffer, start + 12),
        channels: this.buffer[start + 16],
        bits: this.buffer[start + 17],
        maxSamples: readU32(this.buffer, start + 20),
        cookie: this.buffer.slice(start + HEADER_BYTES, start + headerLength),
      };
      this.offset += headerLength;
    }
    if (!this.header) return packets;
    while (this.buffer.byteLength - this.offset >= 8) {
      const start = this.offset;
      const packetLength = readU32(this.buffer, start);
      const duration = readU32(this.buffer, start + 4);
      if (!packetLength || packetLength > 16 * 1024 * 1024) throw new Error("ALAC 流包含非法 packet 长度");
      if (this.buffer.byteLength - start < 8 + packetLength) break;
      packets.push({ duration, bytes: this.buffer.subarray(start + 8, start + 8 + packetLength) });
      this.offset = start + 8 + packetLength;
    }
    return packets;
  }

  finish() {
    if (!this.header || this.buffer.byteLength > this.offset) throw new Error("ALAC 流在完整 packet 边界前结束");
  }
}

/** Check packet framing before an ALAC Blob becomes a complete cache entry. */
export async function validateAlacStreamBlob(blob, { signal } = {}) {
  const parser = new AlacPacketStreamParser();
  let packets = 0;
  // Prefetch does not run the decoder. Share the player's parser and scan in
  // bounded windows, without loading Web Audio/WASM or copying the whole song.
  for (let offset = 0; offset < blob.size; offset += CACHE_READ_BYTES) {
    if (signal?.aborted) throw new DOMException("音频缓存已取消", "AbortError");
    const bytes = new Uint8Array(await blob.slice(offset, offset + CACHE_READ_BYTES).arrayBuffer());
    if (signal?.aborted) throw new DOMException("音频缓存已取消", "AbortError");
    const batch = parser.push(bytes);
    if (parser.header && (!parser.header.sampleRate || !parser.header.channels || parser.header.channels > 2)) {
      throw new Error("当前播放器仅支持单声道或立体声 ALAC");
    }
    for (const packet of batch) {
      if (!packet.duration || packet.duration > parser.header.maxSamples) throw new Error("ALAC packet 时长无效");
      packets += 1;
    }
  }
  parser.finish();
  if (!packets) throw new Error("ALAC 流没有音频 packet");
  // Framing cannot detect missing whole packets or corrupt codec payloads.
  // Transport length/identity and actual decoding remain separate checks.
}
