import { mkdirSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

mkdirSync('web/public', { recursive: true });

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function render(size, maskable = false) {
  const rgba = new Uint8Array(size * size * 4);
  const scale = maskable ? 0.72 : 1;
  const bg = [20, 18, 15];
  const cream = [244, 239, 228];
  const warm = [217, 119, 87];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5 - size / 2) / size;
      const v = (y + 0.5 - size / 2) / size;
      const r = 0.18;
      const a = 0.5 - r;
      const qx = Math.abs(u) - a;
      const qy = Math.abs(v) - a;
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const bgCov = smoothstep(0.012, -0.012, d);

      let cr = bg[0], cg = bg[1], cb = bg[2], ca = bgCov;

      // warm blob
      const wcx = 0.16 * scale, wcy = 0.12 * scale, wr = 0.20 * scale;
      const wd = Math.hypot(u - wcx, v - wcy);
      const wCov = smoothstep(wr + 0.012, wr - 0.012, wd);
      const wA = wCov * bgCov;
      cr = cr * (1 - wA) + warm[0] * wA;
      cg = cg * (1 - wA) + warm[1] * wA;
      cb = cb * (1 - wA) + warm[2] * wA;

      // cream blob
      const ccx = -0.12 * scale, ccy = -0.06 * scale, crad = 0.26 * scale;
      const cd = Math.hypot(u - ccx, v - ccy);
      const cCov = smoothstep(crad + 0.012, crad - 0.012, cd);
      const cA = cCov * bgCov;
      cr = cr * (1 - cA) + cream[0] * cA;
      cg = cg * (1 - cA) + cream[1] * cA;
      cb = cb * (1 - cA) + cream[2] * cA;

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(cr);
      rgba[i + 1] = Math.round(cg);
      rgba[i + 2] = Math.round(cb);
      rgba[i + 3] = Math.round(ca * 255);
    }
  }
  return encodePng(size, size, rgba);
}

writeFileSync('web/public/icon-192.png', render(192));
writeFileSync('web/public/icon-512.png', render(512));
writeFileSync('web/public/icon-maskable-512.png', render(512, true));
console.log('icons written');
