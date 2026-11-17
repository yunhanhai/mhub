// Compact geometric brand assets generated using Node's built-in PNG encoder.
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, bytes) {
  const type = Buffer.from(name);
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length, 0); type.copy(output, 4); bytes.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([type, bytes])), output.length - 4);
  return output;
}

export function iconPng(size) {
  const background = [20, 32, 25], foreground = [180, 215, 145];
  const raster = Buffer.alloc((size * 4 + 1) * size);
  const inside = (x, y) => {
    const leftNote = ((x - .34) / .092) ** 2 + ((y - .70) / .073) ** 2 < 1;
    const rightNote = ((x - .66) / .092) ** 2 + ((y - .63) / .073) ** 2 < 1;
    const leftStem = x >= .39 && x <= .435 && y >= .31 && y <= .70;
    const rightStem = x >= .71 && x <= .755 && y >= .235 && y <= .63;
    const beam = x >= .39 && x <= .755 && y >= .235 + (.755 - x) * .21 && y <= .325 + (.755 - x) * .21;
    return leftNote || rightNote || leftStem || rightStem || beam;
  };
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1); raster[offset] = 0;
    for (let x = 0; x < size; x++) {
      let samples = 0;
      for (const dy of [.25, .75]) for (const dx of [.25, .75]) samples += Number(inside((x + dx) / size, (y + dy) / size));
      for (let channel = 0; channel < 3; channel++) raster[offset + 1 + x * 4 + channel] = Math.round(background[channel] + (foreground[channel] - background[channel]) * samples / 4);
      raster[offset + 1 + x * 4 + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raster, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
