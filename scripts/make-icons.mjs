// Generates public/icon-192.png and public/icon-512.png without any dependency.
// Shapes are rasterised with signed distance functions (anti-aliased).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const sdRoundRect = (px, py, x, y, w, h, r) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - w / 2 + r;
  const qy = Math.abs(py - cy) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
};

// road: cubic from (96,356) to (300,156) then line to (420,156) — in a 512 box
const road = [];
for (let i = 0; i <= 40; i++) {
  const t = i / 40;
  const u = 1 - t;
  const x = u * u * u * 96 + 3 * u * u * t * 190 + 3 * u * t * t * 190 + t * t * t * 300;
  const y = u * u * u * 356 + 3 * u * u * t * 356 + 3 * u * t * t * 156 + t * t * t * 156;
  road.push([x, y]);
}
road.push([420, 156]);

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = 512 / size;
  const layers = [
    { c: hex('#F4EFE6'), d: (x, y) => sdRoundRect(x, y, 0, 0, 512, 512, 116) },
    {
      c: hex('#4F5361'),
      d: (x, y) => {
        let m = Infinity;
        for (let i = 0; i + 1 < road.length; i++) m = Math.min(m, sdSegment(x, y, ...road[i], ...road[i + 1]));
        return m - 32;
      },
    },
    { c: hex('#3F8FDB'), d: (x, y) => sdRoundRect(x, y, 330, 300, 112, 112, 26) },
    { c: hex('#F06B5B'), d: (x, y) => sdRoundRect(x, y, 88, 104, 84, 84, 20) },
    { c: hex('#F2B233'), d: (x, y) => sdRoundRect(x, y, 226, 140, 46, 30, 9) },
  ];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * s;
      const y = (py + 0.5) * s;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const L of layers) {
        const cov = Math.max(0, Math.min(1, 0.5 - L.d(x, y) / s));
        if (cov <= 0) continue;
        r = r * (1 - cov) + L.c[0] * cov;
        g = g * (1 - cov) + L.c[1] * cov;
        b = b * (1 - cov) + L.c[2] * cov;
        a = a * (1 - cov) + cov;
      }
      const o = (py * size + px) * 4;
      // colours were composited premultiplied: store straight alpha
      buf[o] = a > 0 ? Math.round(r / a) : 0;
      buf[o + 1] = a > 0 ? Math.round(g / a) : 0;
      buf[o + 2] = a > 0 ? Math.round(b / a) : 0;
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, buf);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), render(size));
  console.log(`icon-${size}.png`);
}
