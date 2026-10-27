/**
 * calibrate.js — 尺度标定
 * 支持三种方式：手动输入已知长度、手动点选两点输入实际距离、自动识别图内标尺条。
 */

/** 由标尺像素长度换算 mm/px */
export function mmPerPixel(pxLength, realMm) {
  if (!(pxLength > 0) || !(realMm > 0)) return NaN;
  return realMm / pxLength;
}

/**
 * 自动检测图像中的标尺条。
 *
 * 语义说明：水平标尺条的"长度"是其左右两端点间的像素距离（列方向），
 * 而不是条带自身的厚度（行方向）。因此分两步：
 *   1) 用行/列投影 + 游程分析定位高对比、低方差的细长条带（带厚 3–40 px）；
 *   2) 在条带内沿其长度方向测量实际的连续延伸长度，取最长游程。
 *
 * @returns {{orientation:'h'|'v', length, contrast, thickness, x1,y1,x2,y2}[]}
 */
export function detectScaleBars(img, opts = {}) {
  const { width: w, height: h, data } = img;
  const gray = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const minThickness = opts.minThickness ?? 2;
  const maxThickness = opts.maxThickness ?? Math.max(8, Math.round(Math.min(w, h) * 0.08));
  const minContrast = opts.minContrast ?? 0.12;
  const pad = 8;

  const out = [];
  for (const axis of ['h', 'v']) {
    const n = axis === 'h' ? h : w;
    if (n < maxThickness + 2 * pad) continue;

    // 1) 投影
    const proj = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0;
      if (axis === 'h') { for (let q = 0; q < w; q++) s += gray[k * w + q]; }
      else { for (let q = 0; q < h; q++) s += gray[q * w + k]; }
      proj[k] = s / (axis === 'h' ? w : h);
    }

    // 2) 枚举条带（连续若干行/列投影值一致且与两侧有明显反差）
    const bands = [];
    let a = 0;
    while (a < n) {
      let b = a;
      while (b + 1 < n && Math.abs(proj[b + 1] - proj[a]) < 1.5) b++;
      const thickness = b - a + 1;
      if (thickness >= minThickness && thickness <= maxThickness) {
        const before = [], after = [];
        for (let k = Math.max(0, a - pad); k < a; k++) before.push(proj[k]);
        for (let k = b + 1; k < Math.min(n, b + 1 + pad); k++) after.push(proj[k]);
        if (before.length >= 3 && after.length >= 3) {
          const m = proj.slice(a, b + 1).reduce((s, v) => s + v, 0) / thickness;
          let varr = 0;
          for (let k = a; k <= b; k++) varr += (proj[k] - m) ** 2;
          varr = Math.sqrt(varr / thickness);
          const surround = (before.reduce((s, v) => s + v, 0) / before.length
            + after.reduce((s, v) => s + v, 0) / after.length) / 2;
          const contrast = Math.abs(surround - m) / 255;
          if (contrast >= minContrast && varr < 4) {
            bands.push({ a, b, m, contrast, thickness });
          }
        }
      }
      a = b + 1;
    }

    // 3) 在每个条带内，沿长度方向找最长连续游程（相对条带均值偏离的像素）
    for (const band of bands) {
      const mid = Math.floor((band.a + band.b) / 2);
      const along = axis === 'h' ? w : h;
      // 用条带内的极值确定"属于标尺"的像素（标尺条通常比背景更暗）
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < along; i++) {
        const p = axis === 'h' ? mid * w + i : i * w + mid;
        if (gray[p] < lo) lo = gray[p];
        if (gray[p] > hi) hi = gray[p];
      }
      const dark = [];
      for (let i = 0; i < along; i++) {
        const p = axis === 'h' ? mid * w + i : i * w + mid;
        dark.push(gray[p] < (lo + hi) / 2);
      }
      // 最长游程
      let bestStart = -1, bestLen = 0, cs = -1;
      for (let i = 0; i <= along; i++) {
        const on = i < along && dark[i];
        if (on && cs < 0) cs = i;
        if (!on && cs >= 0) {
          if (i - cs > bestLen) { bestLen = i - cs; bestStart = cs; }
          cs = -1;
        }
      }
      if (bestLen < (opts.minLength ?? Math.round(Math.min(w, h) * 0.08))) continue;
      out.push({
        orientation: axis,
        length: bestLen,
        thickness: band.thickness,
        contrast: band.contrast,
        meanGray: band.m,
        x1: axis === 'h' ? bestStart : band.a,
        y1: axis === 'h' ? band.a : bestStart,
        x2: axis === 'h' ? bestStart + bestLen : band.b,
        y2: axis === 'h' ? band.b : bestStart + bestLen,
      });
    }
  }
  out.sort((p, q) => q.contrast - p.contrast);
  return out.slice(0, 8);
}

/** 像素值 -> 物理单位换算器 */
export function makeScaler(mmPerPx) {
  const f = (px) => px * mmPerPx;
  const inv = (mm) => mm / mmPerPx;
  return { mmPerPx, toMm: f, toPx: inv };
}