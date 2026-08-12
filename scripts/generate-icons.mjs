import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [xi, yi] = points[index];
    const [xj, yj] = points[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function createIcon(size) {
  const scanline = size * 4 + 1;
  const pixels = Buffer.alloc(scanline * size);
  const yellowShapes = [
    [[0.164, 0.713], [0.348, 0.227], [0.49, 0.227], [0.307, 0.713]],
    [[0.471, 0.713], [0.655, 0.227], [0.836, 0.227], [0.744, 0.469], [0.836, 0.469], [0.742, 0.713]],
  ];

  for (let row = 0; row < size; row += 1) {
    const y = (row + 0.5) / size;
    pixels[row * scanline] = 0;
    for (let column = 0; column < size; column += 1) {
      const x = (column + 0.5) / size;
      const offset = row * scanline + 1 + column * 4;
      let color = [8, 11, 18, 255];
      if (yellowShapes.some((shape) => insidePolygon(x, y, shape))) color = [235, 255, 0, 255];
      if (x >= 0.14 && x <= 0.86 && Math.abs(y - 0.79) <= 0.018) color = [245, 247, 251, 255];
      pixels.set(color, offset);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(resolve('public', name), createIcon(size));
}
