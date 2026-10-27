/**
 * 生成应用图标 build/icon.ico（多尺寸 ICO，内含 PNG 帧）
 * 纯 Node 实现，无第三方依赖。用法：node test/tools/make-icon.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ---------- 极简绘图：直接写 RGBA 像素 ---------- */
function makeFrame(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    if (a >= 255) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; return; }
    // 简单 source-over
    const sa = a / 255, da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };
  const blend = (x, y, r, g, b, a) => {
    if (a <= 0) return;
    // 3x3 超采样抗锯齿
    let acc = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = x + dx * 0.34, sy = y + dy * 0.34;
      if (shape(sx, sy)) acc++;
      n++;
    }
    set(x, y, r, g, b, Math.round((acc / n) * a));
  };

  const cx = size / 2, cy = size / 2;
  const R = size * 0.40;        // 圆角方块半宽
  const rad = size * 0.16;      // 圆角半径
  // 谷粒（椭圆，带轻微弯曲感）：中心、半轴、倾角
  const gx = cx, gy = cy - size * 0.055;
  const ga = size * 0.175, gb = size * 0.265;
  const ang = -0.32;
  const ca = Math.cos(ang), sa = Math.sin(ang);

  function shape(x, y) {
    // 圆角方形底
    const qx = Math.abs(x - cx) - (R - rad);
    const qy = Math.abs(y - cy) - (R - rad);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    const inRound = (x >= cx - R && x <= cx + R && y >= cy - R && y <= cy + R) &&
      (outside <= rad) && (Math.abs(x - cx) <= R && Math.abs(y - cy) <= R);
    if (!inRound) return null;
    // 谷粒形状：旋转椭圆 + 顶部收尖
    const dx = x - gx, dy = y - gy;
    const u = dx * ca + dy * sa;
    const v = (-dx * sa + dy * ca) / gb;
    const uu = u / ga;
    const tip = 1 - Math.max(0, -v) * 0.28;          // 下端略尖
    const inEll = uu * uu + v * v <= tip * tip;
    return inEll ? 'grain' : 'bg';
  }

  // 底：深色渐变
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = shape(x + 0.5, y + 0.5);
    if (!s) continue;
    const t = (x / size) * 0.4 + (y / size) * 0.6;
    if (s === 'bg') {
      const r = Math.round(0x0f + (0x1d - 0x0f) * t);
      const g = Math.round(0x13 + (0x2a - 0x13) * t);
      const b = Math.round(0x19 + (0x3a - 0x19) * t);
      set(x, y, r, g, b, 255);
    }
  }
  // 谷粒：金色渐变 + 高光
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = shape(x + 0.5, y + 0.5);
    if (s !== 'grain') continue;
    const t = y / size;
    const r = Math.round(0xf2 + (0xd9 - 0xf2) * t);
    const g = Math.round(0xc9 + (0xa8 - 0xc9) * t);
    const b = Math.round(0x7a + (0x4e - 0x7a) * t);
    set(x, y, r, g, b, 255);
  }
  // 高光
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = shape(x + 0.5, y + 0.5);
    if (s !== 'grain') continue;
    const dx = (x - (gx - ga * 0.32)), dy = (y - (gy - gb * 0.34));
    const d = Math.hypot(dx / (ga * 0.40), dy / (gb * 0.30));
    if (d < 1) blend(x, y, 255, 255, 255, Math.round(120 * (1 - d)));
  }
  // 底部标尺意象：三条短横线
  const barY = Math.round(cy + R * 0.60);
  const barW = Math.round(size * 0.075), gap = Math.round(size * 0.035);
  const barH = Math.max(1, Math.round(size * 0.045));
  const x0 = Math.round(cx - (barW * 3 + gap * 2) / 2);
  for (let i = 0; i < 3; i++) {
    const bx = x0 + i * (barW + gap);
    for (let y = barY; y < barY + barH; y++) for (let x = bx; x < bx + barW; x++) {
      if (x >= size || y >= size) continue;
      const s = shape(x + 0.5, y + 0.5);
      if (!s) continue;
      set(x, y, 0x4d, 0x9f, 0xff, 235);
    }
  }
  return px;
}

/* ---------- PNG 编码 ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO 组装 ---------- */
const frames = SIZES.map((s) => {
  const rgba = makeFrame(s);
  return { size: s, png: encodePNG(s, rgba), rgba };
});
// 同时导出一张 512 PNG 备用
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), encodePNG(256, frames.at(-1).rgba));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
const dir = Buffer.alloc(16 * frames.length);
let offset = header.length + dir.length;
frames.forEach((f, i) => {
  const o = i * 16;
  dir[o] = f.size >= 256 ? 0 : f.size;
  dir[o + 1] = f.size >= 256 ? 0 : f.size;
  dir[o + 2] = 0; dir[o + 3] = 0;
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(f.png.length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += f.png.length;
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, dir, ...frames.map((f) => f.png)]));
console.log('已生成', OUT, fs.statSync(OUT).size, 'bytes; 尺寸', SIZES.join(','));