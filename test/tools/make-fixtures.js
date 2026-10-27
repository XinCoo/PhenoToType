/**
 * 生成测试用合成籽粒图像 + 真值文件（truth.json）。
 * 场景定义（贴近真实散落照）：
 *   - group_A.png：12 颗深色长粒，彼此分离不接触，含 10 mm 标尺条
 *   - group_B.png：12 颗浅色圆粒，同上
 *   - touching.png：4 颗，其中 2 组各 2 颗轻微接触（验证粘连分离）
 * 每个真值记录半轴 rx/ry（像素），配合标定 0.05 mm/px 可算出期望长度。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

const MM_PER_PX = 0.05;      // 标尺 10 mm = 200 px
const BAR = { x0: 520, x1: 720, y0: 266, y1: 272 };

function crc32(buf) {
  let c; const t = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function writePNG(file, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function blank(w, h, bg) {
  const d = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) { d[p * 4] = bg[0]; d[p * 4 + 1] = bg[1]; d[p * 4 + 2] = bg[2]; d[p * 4 + 3] = 255; }
  return { w, h, d };
}
function ellipse(img, cx, cy, rx, ry, ang, col) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const R = Math.ceil(Math.max(rx, ry)) + 2;
  for (let y = Math.max(0, cy - R); y < Math.min(img.h, cy + R); y++) {
    for (let x = Math.max(0, cx - R); x < Math.min(img.w, cx + R); x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if ((u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1) {
        const i = (y * img.w + x) * 4;
        img.d[i] = col[0]; img.d[i + 1] = col[1]; img.d[i + 2] = col[2];
      }
    }
  }
}
function drawBar(img) {
  for (let y = BAR.y0; y < BAR.y1; y++) {
    for (let x = BAR.x0; x < BAR.x1; x++) {
      const i = (y * img.w + x) * 4;
      img.d[i] = 20; img.d[i + 1] = 20; img.d[i + 2] = 20;
    }
  }
}

const truth = { mmPerPx: MM_PER_PX, bar: BAR, groups: {} };

/* ---- 场景 1、2：12 颗分离籽粒 ---- */
function makeSeparated(name, base, palette) {
  const img = blank(880, 300, [248, 248, 245]);
  const seeds = [];
  // 3 行 × 4 列，间距远大于粒径，保证互不接触
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      const rx = 26 + ((i * 7) % 9);      // 26..34
      const ry = 13 + ((i * 5) % 6);       // 13..18
      const cx = 120 + col * 200;
      const cy = 90 + row * 78;
      const ang = ((i % 3) - 1) * 0.22;
      const shade = [(i * 17) % 20, (i * 11) % 16, (i * 7) % 12];
      ellipse(img, cx, cy, rx, ry, ang, [base[0] + shade[0], base[1] + shade[1], base[2] + shade[2]]);
      seeds.push({ i, cx, cy, rx, ry, angle: ang });
    }
  }
  drawBar(img);
  writePNG(path.join(FIX, name + '.png'), img.w, img.h, img.d);
  truth.groups[name] = { count: seeds.length, seeds };
  console.log(`${name}.png  ${img.w}x${img.h}  ${seeds.length} 粒（均分离）`);
}

/* ---- 场景 3：两组轻微接触 ---- */
function makeTouching(name) {
  const img = blank(880, 300, [248, 248, 245]);
  const seeds = [];
  // 组 1：两粒中心相距 46 px（各自 r=22，轻微重叠 2 px 量级）
  ellipse(img, 200, 120, 24, 15, 0.1, [110, 66, 40]);
  ellipse(img, 246, 120, 24, 15, -0.1, [118, 72, 44]);
  seeds.push({ i: 0, cx: 200, cy: 120, rx: 24, ry: 15, angle: 0.1 });
  seeds.push({ i: 1, cx: 246, cy: 120, rx: 24, ry: 15, angle: -0.1 });
  // 组 2：两粒轻微接触
  ellipse(img, 560, 180, 22, 14, 0.05, [124, 78, 46]);
  ellipse(img, 602, 180, 22, 14, -0.05, [112, 68, 42]);
  seeds.push({ i: 2, cx: 560, cy: 180, rx: 22, ry: 14, angle: 0.05 });
  seeds.push({ i: 3, cx: 602, cy: 180, rx: 22, ry: 14, angle: -0.05 });
  // 两个孤立粒
  ellipse(img, 340, 210, 26, 16, -0.2, [106, 62, 38]);
  ellipse(img, 720, 110, 25, 15, 0.15, [116, 70, 42]);
  seeds.push({ i: 4, cx: 340, cy: 210, rx: 26, ry: 16, angle: -0.2 });
  seeds.push({ i: 5, cx: 720, cy: 110, rx: 25, ry: 15, angle: 0.15 });
  drawBar(img);
  writePNG(path.join(FIX, name + '.png'), img.w, img.h, img.d);
  truth.groups[name] = { count: seeds.length, seeds, expectSplit: [0, 2] };
  console.log(`${name}.png  ${img.w}x${img.h}  ${seeds.length} 粒（其中 2 组轻微接触）`);
}

/* ---- 场景 4：低对比度（浅灰籽粒 on 浅灰台面，前景背景色差小） ---- */
function makeHardLowContrast(name) {
  const bg = [225, 224, 220];
  const img = blank(880, 300, bg);
  const seeds = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      const rx = 26 + (i % 9), ry = 13 + (i % 6);
      const cx = 120 + col * 200, cy = 90 + row * 78;
      const ang = ((i % 3) - 1) * 0.22;
      const off = 26 + (i % 5) * 3;   // 前景仅比背景略暗一点（低对比度但可恢复）
      ellipse(img, cx, cy, rx, ry, ang, [bg[0] - off, bg[1] - off, bg[2] - off]);
      seeds.push({ i, cx, cy, rx, ry, angle: ang });
    }
  }
  drawBar(img);
  writePNG(path.join(FIX, name + '.png'), img.w, img.h, img.d);
  truth.groups[name] = { count: seeds.length, seeds, hard: 'low_contrast' };
  console.log(`${name}.png  ${img.w}x${img.h}  ${seeds.length} 粒（低对比度）`);
}

/* ---- 场景 5：背景杂点（背景里混入与籽粒同色的暗斑，验证噪声鲁棒性） ---- */
function makeHardSpecks(name) {
  const img = blank(880, 300, [248, 248, 245]);
  const seeds = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      const rx = 26 + (i % 9), ry = 13 + (i % 6);
      const cx = 120 + col * 200, cy = 90 + row * 78;
      const ang = ((i % 3) - 1) * 0.22;
      ellipse(img, cx, cy, rx, ry, ang, [104, 62, 38]);
      seeds.push({ i, cx, cy, rx, ry, angle: ang });
    }
  }
  // 背景杂点（与籽粒同色，但不计入真值）：真实拍照的灰尘/污点多为近圆形，
  // 与长椭球投影的籽粒不同；算法应靠形状（离心率）把它们滤除。
  // 用 ellipse() 画实心圆，保证整块区域都落到前景阈值以下（不被中心破洞）。
  const specks = [[60, 40, 12], [380, 30, 12], [780, 60, 12], [260, 285, 12], [440, 285, 13]];
  for (const [sx, sy, sr] of specks) ellipse(img, sx, sy, sr, sr, 0, [104, 62, 38]);
  writePNG(path.join(FIX, name + '.png'), img.w, img.h, img.d);
  truth.groups[name] = { count: seeds.length, seeds, hard: 'specks' };
  console.log(`${name}.png  ${img.w}x${img.h}  ${seeds.length} 粒（背景杂点）`);
}

/* ---- 场景 6：籽粒表面高光（局部接近背景色，验证破洞/漏检） ---- */
function makeHardGlare(name) {
  const img = blank(880, 300, [248, 248, 245]);
  const seeds = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      const rx = 26 + (i % 9), ry = 13 + (i % 6);
      const cx = 120 + col * 200, cy = 90 + row * 78;
      const ang = ((i % 3) - 1) * 0.22;
      ellipse(img, cx, cy, rx, ry, ang, [104, 62, 38]);
      // 中心叠一个接近背景色的亮斑（高光/反光）
      ellipse(img, cx, cy, Math.max(4, rx * 0.35), Math.max(3, ry * 0.35), ang, [244, 244, 240]);
      seeds.push({ i, cx, cy, rx, ry, angle: ang });
    }
  }
  drawBar(img);
  writePNG(path.join(FIX, name + '.png'), img.w, img.h, img.d);
  truth.groups[name] = { count: seeds.length, seeds, hard: 'glare' };
  console.log(`${name}.png  ${img.w}x${img.h}  ${seeds.length} 粒（表面高光）`);
}

/* ---- 场景 7：背景阴影梯度（光照不均，验证局部自适应兜底） ---- */
function makeHardShadow(name) {
  const img = blank(880, 300, [248, 248, 245]);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const gg = Math.round(-150 * (x / img.w) + 75); // 左暗(-75)右亮(+75)，Lab 梯度明显（均匀灰梯度）
      const i = (y * img.w + x) * 4;
      img.d[i] = Math.max(0, Math.min(255, img.d[i] + gg));
      img.d[i + 1] = Math.max(0, Math.min(255, img.d[i + 1] + gg));
      img.d[i + 2] = Math.max(0, Math.min(255, img.d[i + 2] + gg));
    }
  }
  const seeds = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col;
      const rx = 26 + (i % 9), ry = 13 + (i % 6);
      const cx = 120 + col * 200, cy = 90 + row * 78;
      const ang = ((i % 3) - 1) * 0.22;
      ellipse(img, cx, cy, rx, ry, ang, [120, 80, 55]); // 比背景仅略暗，配合强阴影制造难点
      seeds.push({ i, cx, cy, rx, ry, angle: ang });
    }
  }
  drawBar(img);
  writePNG(path.join(FIX, name + '.png'), img.w, img.h, img.d);
  truth.groups[name] = { count: seeds.length, seeds, hard: 'shadow' };
  console.log(`${name}.png  ${img.w}x${img.h}  ${seeds.length} 粒（背景阴影）`);
}

makeHardShadow('hard_shadow');
makeHardLowContrast('hard_low_contrast');
makeHardSpecks('hard_specks');
makeHardGlare('hard_glare');

makeSeparated('group_A', [104, 62, 38]);
makeSeparated('group_B', [198, 176, 118]);
makeTouching('touching');

fs.writeFileSync(path.join(FIX, 'truth.json'), JSON.stringify(truth, null, 2));
console.log('truth.json 已写出');