/**
 * pipeline.js — 端到端处理流程
 * 图像 → 分割 → 逐粒轮廓 → 形状描述子 → 颜色统计 → 标定换算 → 样本表
 */
import {
  segmentGrains, traceContour, findContourSeed, regionMask, rgbToLab, rgbToHsv, deltaE76,
} from './segmentation/image.js';
import { describeShape } from './geometry/shape.js';
import { makeScaler } from './calibration/calibrate.js';

/** 计算图像内 ROI 的颜色统计（仅前景像素，边缘内缩避免背景污染） */
export function colorStats(img, labels, label, region, inset = 2) {
  const { width: w, data } = img;
  let n = 0;
  let L = 0, A = 0, B = 0, H = 0, S = 0, V = 0;
  let lMin = 255, lMax = 0;
  const hues = [];
  for (let y = region.minY + inset; y <= region.maxY - inset; y++) {
    for (let x = region.minX + inset; x <= region.maxX - inset; x++) {
      if (x < 0 || y < 0 || x >= w) continue;
      const p = y * w + x;
      if (labels[p] !== label) continue;
      const i = p * 4;
      if (data[i + 3] < 128) continue;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      L += lab.L; A += lab.a; B += lab.b; H += hsv.h; S += hsv.s; V += hsv.v;
      if (lab.L < lMin) lMin = lab.L;
      if (lab.L > lMax) lMax = lab.L;
      hues.push(hsv.h);
      n++;
    }
  }
  if (n === 0) return null;
  const meanH = H / n;
  // 圆周均值（避免 0/360 断裂）
  let sx = 0, sy = 0;
  for (const h of hues) { sx += Math.cos((h * Math.PI) / 180); sy += Math.sin((h * Math.PI) / 180); }
  const hueCircular = ((Math.atan2(sy / n, sx / n) * 180) / Math.PI + 360) % 360;
  return {
    n,
    L: L / n, a: A / n, b: B / n,
    hue: hueCircular, sat: S / n, val: V / n,
    chroma: Math.hypot(A / n, B / n),
    Lmin: lMin, Lmax: lMax, Lrange: lMax - lMin,
    chromaMean: hues.length ? Math.hypot(A / n, B / n) : 0,
  };
}

/**
 * 主流程：处理一张图片
 * @param {{data,width,height}} img ImageData 形态
 * @param {object} opts {mmPerPx, group, sampleName, minArea, maxAreaFrac, contourSimplify}
 * @returns {{samples:[], meta:{}}}
 */
export function processImage(img, opts = {}) {
  const w = img.width, h = img.height;
  const { labels, regions, mask, meta } = segmentGrains(img, opts);
  const scaler = opts.mmPerPx ? makeScaler(opts.mmPerPx) : null;
  const samples = [];

  for (const reg of regions) {
    const seed = findContourSeed(labels, reg, w, h);
    if (!seed) continue;
    // 用该连通域的独立掩膜追踪，避免颗粒相邻时逃逸
    const rMask = regionMask(labels, w, h, reg.label);
    let contour = traceContour(rMask, w, h, seed);
    if (contour.length < 8) continue;      // 太小，形状不可靠
    contour = simplify(contour, opts.tolerance ?? 0.2);
    const shape = describeShape(contour);
    const color = colorStats(img, labels, reg.label, reg, opts.colorInset ?? 2);

    const s = {
      imageId: opts.imageId ?? null,
      group: opts.group ?? '未分组',
      sample: opts.sampleName ?? '',
      areaPx: shape.area,
      area: shape.area,
      perimeterPx: shape.perimeter,
      lengthPx: shape.length,
      widthPx: shape.width,
      feretPx: shape.feretMax,
      eqDiameterPx: shape.equivalentDiameter,
      thicknessPx: shape.thickness,
      volumePx3: shape.volumeEllipsoid,
      circularity: shape.circularity,
      solidity: shape.solidity,
      aspectRatio: shape.aspectRatio,
      roundness: shape.roundness,
      angleRad: shape.angle,
      ellipseA: shape.ellipse?.a ?? NaN,
      ellipseB: shape.ellipse?.b ?? NaN,
      cx: shape.centroid.x, cy: shape.centroid.y,
      contour,
      bbox: { x: reg.minX, y: reg.minY, w: reg.maxX - reg.minX + 1, h: reg.maxY - reg.minY + 1 },
      color,
    };
    if (scaler) {
      s.lengthMM = scaler.toMm(s.lengthPx);
      s.widthMM = scaler.toMm(s.widthPx);
      s.feretMM = scaler.toMm(s.feretPx);
      s.eqDiameterMM = scaler.toMm(s.eqDiameterPx);
      s.thicknessMM = scaler.toMm(s.thicknessPx);
      s.areaMM2 = scaler.toMm(Math.sqrt(s.areaPx)) ** 2;
      s.volumeMM3 = scaler.toMm(Math.cbrt(s.volumePx3)) ** 3;
    }
    samples.push(s);
  }
  return { samples, meta: { width: w, height: h, count: regions.length, ...meta } };
}

/** Douglas-Peucker 轮廓简化 */
export function simplify(pts, tol = 0.6) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const p1 = pts[a], p2 = pts[b];
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(p.x - p1.x, p.y - p1.y);
      else {
        let t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(p.x - (p1.x + t * dx), p.y - (p1.y + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 数据集构建：把多样本按指标聚合为分组样本集 */
export function groupSamples(samples, valueKey) {
  const map = new Map();
  for (const s of samples) {
    const k = s.group;
    if (!map.has(k)) map.set(k, []);
    const v = s[valueKey];
    if (isFinite(v)) map.get(k).push(v);
  }
  return [...map.entries()].map(([label, values]) => ({ label, values }));
}