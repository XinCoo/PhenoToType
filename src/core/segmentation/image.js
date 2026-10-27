/**
 * image.js — 籽粒图像预处理与分割
 * 纯函数模块：输入 {data:Uint8ClampedArray, width, height}（RGBA），输出掩膜与几何信息。
 * 不依赖 DOM，可在 Node 中直接单测。
 */

/* ---------------------------------------------------------------- 色彩空间 */

/** sRGB(0-255) -> CIE Lab (D65) */
export function rgbToLab(r, g, b) {
  let R = r / 255, G = g / 255, B = b / 255;
  // inverse sRGB companding
  const f = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  R = f(R); G = f(G); B = f(B);
  // linear RGB -> XYZ (sRGB D65 matrix)
  let X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
  let Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const fx = t(X), fy = t(Y), fz = t(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE Lab -> sRGB(0-255) */
export function labToRgb(L, a, bb) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  const inv = (u) => (u > 0.206893 ? u * u * u : (u - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  let R = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  let G = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
  let B = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
  const g = (u) => {
    u = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(Math.max(u, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(u * 255)));
  };
  return { r: g(R), g: g(G), b: g(B) };
}

export function rgbToHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** CIE76 色差 */
export function deltaE76(l1, a1, b1, l2, a2, b2) {
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/* ---------------------------------------------------------------- 掩膜工具 */

/** 二值掩膜：Uint8Array，长度 w*h，1=前景 */
export function makeMask(w, h) { return new Uint8Array(w * h); }

export function erode(mask, w, h, r = 1) {
  if (r <= 0) return mask.slice();
  const out = makeMask(w, h);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let keep = 1;
      for (let dy = -r; dy <= r && keep; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) { keep = 0; break; }
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w || mask[yy * w + xx] === 0) { keep = 0; break; }
        }
      }
      out[y * w + x] = keep;
    }
  }
  return out;
}

export function dilate(mask, w, h, r = 1) {
  if (r <= 0) return mask.slice();
  const out = makeMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) { hit = 1; break; }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

/** 用 3x3 邻域多数票去除椒盐噪点（只删不加，适合小颗粒） */
export function despeckle(mask, w, h, minNeighbours = 3) {
  const out = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          if (mask[yy * w + xx]) n++;
        }
      }
      if (n < minNeighbours) out[i] = 0;
    }
  }
  return out;
}

/** 填充掩膜内部孔洞（从边界洪水填充背景，剩余背景即孔洞） */
export function fillHoles(mask, w, h) {
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) {
    if (!mask[x]) { bg[x] = 1; stack.push(x); }
    const i = (h - 1) * w + x;
    if (!mask[i]) { bg[i] = 1; stack.push(i); }
  }
  for (let y = 0; y < h; y++) {
    const l = y * w, rI = y * w + w - 1;
    if (!mask[l]) { bg[l] = 1; stack.push(l); }
    if (!mask[rI]) { bg[rI] = 1; stack.push(rI); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && !bg[i - 1] && !mask[i - 1]) { bg[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !bg[i + 1] && !mask[i + 1]) { bg[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !bg[i - w] && !mask[i - w]) { bg[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !bg[i + w] && !mask[i + w]) { bg[i + w] = 1; stack.push(i + w); }
  }
  const out = mask.slice();
  for (let i = 0; i < out.length; i++) if (!mask[i] && !bg[i]) out[i] = 1;
  return out;
}

/* ---------------------------------------------------------- 连通域标记 */

/**
 * 连通域标记（4/8 邻域）
 * @returns {labels:Int32Array, regions:[{label,area,minX,minY,maxX,maxY,pixels?}]}
 */
export function connectedComponents(mask, w, h, connectivity = 8) {
  const labels = new Int32Array(w * h).fill(-1);
  const regions = [];
  const dq = connectivity === 8
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    const id = regions.length;
    const reg = { label: id, area: 0, minX: w, minY: h, maxX: -1, maxY: -1 };
    const stack = [s];
    labels[s] = id;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      reg.area++;
      if (x < reg.minX) reg.minX = x;
      if (x > reg.maxX) reg.maxX = x;
      if (y < reg.minY) reg.minY = y;
      if (y > reg.maxY) reg.maxY = y;
      for (const [dx, dy] of dq) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (mask[j] && labels[j] === -1) { labels[j] = id; stack.push(j); }
      }
    }
    regions.push(reg);
  }
  return { labels, regions };
}

/* -------------------------------------------------------------- 背景分离 */

/** 用图像四周边框像素估计背景 Lab（鲁棒中位数） */
export function estimateBackgroundLab(img, sampleFrac = 0.06) {
  const { width: w, height: h, data } = img;
  const mx = Math.max(2, Math.round(w * sampleFrac));
  const my = Math.max(2, Math.round(h * sampleFrac));
  const Ls = [], as = [], bs = [];
  for (let y = 0; y < h; y++) {
    const inY = y < my || y >= h - my;
    for (let x = 0; x < w; x++) {
      if (!inY && x >= mx && x < w - mx) continue;
      const i = (y * w + x) * 4;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      Ls.push(lab.L); as.push(lab.a); bs.push(lab.b);
    }
  }
  const med = (arr) => { const c = arr.slice().sort((p, q) => p - q); return c[c.length >> 1] ?? 0; };
  return { L: med(Ls), a: med(as), b: med(bs) };
}

/**
 * 基于 Lab 色差的自适应阈值分割：Otsu 在 ΔE 分布上取阈值。
 * 适合深色籽粒 on白/浅色台面，或浅色籽粒 on 深色台面。
 */
export function segmentByColorDelta(img, opts = {}) {
  const { width: w, height: h, data } = img;
  const bg = estimateBackgroundLab(img, opts.sampleFrac ?? 0.06);
  const de = new Float32Array(w * h);
  let maxDe = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (data[i + 3] < 128) { de[p] = 0; continue; }
    const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
    const d = deltaE76(bg.L, bg.a, bg.b, lab.L, lab.a, lab.b);
    de[p] = d;
    if (d > maxDe) maxDe = d;
  }
  // 透明区域强制为背景
  for (let p = 0; p < w * h; p++) if (data[p * 4 + 3] < 128) de[p] = 0;

  const baseThr = otsuThreshold(de);
  // 背景噪声门限：背景很干净时，阈值不应超过「背景均值 + K·标准差」，
  // 否则会把本可恢复的低对比度前景（如仅检出 2/12）切掉；干净背景下门限≈4，不影响正常图。
  const fr = opts.sampleFrac ?? 0.06;
  const mx = Math.max(2, Math.round(w * fr)), my = Math.max(2, Math.round(h * fr));
  let bs = 0, bn = 0;
  for (let y = 0; y < h; y++) {
    const inY = y < my || y >= h - my;
    for (let x = 0; x < w; x++) {
      if (!inY && x >= mx && x < w - mx) continue;
      bs += de[y * w + x]; bn++;
    }
  }
  const bgMean = bn ? bs / bn : 0;
  let bv = 0;
  for (let y = 0; y < h; y++) {
    const inY = y < my || y >= h - my;
    for (let x = 0; x < w; x++) {
      if (!inY && x >= mx && x < w - mx) continue;
      const d = de[y * w + x] - bgMean; bv += d * d;
    }
  }
  const bgStd = bn ? Math.sqrt(bv / bn) : 0;
  const gate = bgMean + 4 * Math.max(bgStd, 1);
  let thr = Math.max(2, Math.min(baseThr, gate));
  // thresholdShift：正值提高阈值（更保守，漏检风险），负值降低阈值
  thr = Math.max(2, thr + (opts.thresholdShift ?? 0));
  const mask = makeMask(w, h);
  let fg = 0;
  for (let p = 0; p < w * h; p++) {
    if (de[p] >= thr) { mask[p] = 1; fg++; }
  }
  // 若前景占比极端，说明阈值失效，用固定安全阈值兜底
  const frac = fg / (w * h);
  if (frac < 0.002 || frac > 0.98) {
    for (let p = 0; p < w * h; p++) mask[p] = de[p] >= (opts.fallbackThreshold ?? 12) ? 1 : 0;
  }
  return { mask, threshold: thr, bgLab: bg, deltaE: de };
}

/**
 * 局部自适应背景分割（兜底）：把背景估计为随位置变化的背景场，
 * 每个像素与其邻域背景比较，消除光照不均 / 空间渐变阴影导致的漏检。
 * 返回与 segmentByColorDelta 相同的形状。正常均匀背景下效果≈全局法，故可安全启用。
 */
export function segmentLocalAdaptive(img, opts = {}) {
  const { width: w, height: h, data } = img;
  const step = opts.localStep ?? 24;
  const nsx = Math.max(1, Math.ceil(w / step)), nsy = Math.max(1, Math.ceil(h / step));
  const bgL = new Float32Array(nsx * nsy);
  const bgA = new Float32Array(nsx * nsy);
  const bgB = new Float32Array(nsx * nsy);
  const win = Math.max(step, Math.round(step * 1.5));
  for (let gy = 0; gy < nsy; gy++) {
    for (let gx = 0; gx < nsx; gx++) {
      const cx = Math.min(w - 1, Math.round((gx + 0.5) * step));
      const cy = Math.min(h - 1, Math.round((gy + 0.5) * step));
      const Ls = [], As = [], Bs = [];
      const x0 = Math.max(0, cx - win), x1 = Math.min(w, cx + win);
      const y0 = Math.max(0, cy - win), y1 = Math.min(h, cy + win);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 128) continue;
        const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
        Ls.push(lab.L); As.push(lab.a); Bs.push(lab.b);
      }
      const med = (arr) => { const c = arr.slice().sort((p, q) => p - q); return c[c.length >> 1] ?? 0; };
      const idx = gy * nsx + gx;
      bgL[idx] = med(Ls); bgA[idx] = med(As); bgB[idx] = med(Bs);
    }
  }
  const de = new Float32Array(w * h);
  let maxDe = 0;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(nsy - 1, Math.floor(y / step));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(nsx - 1, Math.floor(x / step));
      const i = (y * w + x) * 4, p = y * w + x;
      if (data[i + 3] < 128) { de[p] = 0; continue; }
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      const d = deltaE76(bgL[gy * nsx + gx], bgA[gy * nsx + gx], bgB[gy * nsx + gx], lab.L, lab.a, lab.b);
      de[p] = d; if (d > maxDe) maxDe = d;
    }
  }
  // 局部背景场已消除渐变，故用固定低阈值（干净背景局部 ΔE≈0，前景即便偏弱也能捞出）
  const baseThr = opts.localThreshold ?? 6;
  const thr = Math.max(2, baseThr + (opts.thresholdShift ?? 0));
  const mask = makeMask(w, h);
  let fg = 0;
  for (let p = 0; p < w * h; p++) if (de[p] >= thr) { mask[p] = 1; fg++; }
  const frac = fg / (w * h);
  if (frac < 0.002 || frac > 0.98) {
    for (let p = 0; p < w * h; p++) mask[p] = de[p] >= (opts.fallbackThreshold ?? 12) ? 1 : 0;
  }
  return { mask, threshold: thr, bgLab: { L: bgL[0], a: bgA[0], b: bgB[0] }, deltaE: de };
}


/**
/**
 * Otsu 阈值（基于直方图，作用在非负实数值域）
 * 注意：输入若为「大量 0 + 少量大值」的双峰分布，Otsu 会把阈值放在谷底，
 * 这正是颜色分割需要的行为。
 */
export function otsuThreshold(values) {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (!(max > 0)) return 10;
  const BINS = 256;
  const hist = new Float64Array(BINS);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    // 背景（ΔE≈0）是重要的一类，必须参与直方图，否则 Otsu 会切进前景峰内部
    if (v <= 0) { hist[0]++; n++; continue; }
    let b = Math.floor((v / max) * (BINS - 1));
    if (b < 0) b = 0; if (b >= BINS) b = BINS - 1;
    hist[b]++; n++;
  }
  if (n === 0) return 10;
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < BINS; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = i; }
  }
  // 返回 bin 中心
  return ((best + 0.5) / (BINS - 1)) * max;
}

/**
 * 全流程：分割 -> 去噪 -> 填孔 -> 连通域 -> 面积过滤
 * @returns {{mask, labels, regions, meta}}
 */
export function segmentGrains(img, opts = {}) {
  const w = img.width, h = img.height;
  // 对原始掩膜做连通域统计（不过滤），用于判断全局法是否把背景误判为前景。
  const componentsRaw = (mask) => {
    const { regions } = connectedComponents(mask, w, h, 8);
    let total = 0, mx = 0;
    for (const r of regions) { total += r.area; if (r.area > mx) mx = r.area; }
    return { count: regions.length, maxFrac: total ? mx / total : 0 };
  };
  const minArea = opts.minArea ?? 40;             // 像素
  const maxAreaFrac = opts.maxAreaFrac ?? 0.6;     // 超过画面 60% 视为台面/阴影
  const g = segmentByColorDelta(img, opts);
  let m0 = g.mask, threshold = g.threshold, bgLab = g.bgLab;
  // 兜底：光照不均 / 渐变阴影会让全局阈值把整片暗背景当成前景（出现一个占据主导的连通块）。
  // 此时改用局部自适应背景场（按局部邻域中值消除渐变后再阈值）。
  // 判定：全局法若产生主导大块（最大块占前景 >50%）或完全未检出（0 块），改用局部法。
  if (opts.adaptive !== false) {
    const comps = componentsRaw(g.mask);
    if (comps.maxFrac > 0.5 || comps.count === 0) {
      const loc = segmentLocalAdaptive(img, { localStep: 24, ...opts });
      m0 = loc.mask; threshold = loc.threshold; bgLab = loc.bgLab;
    }
  }
  let mask = despeckle(m0, w, h, opts.minNeighbours ?? 3);
  mask = erode(mask, w, h, opts.erode ?? 1);
  mask = dilate(mask, w, h, opts.dilate ?? 1);
  mask = fillHoles(mask, w, h);
  let labels, regions;
  if (opts.splitTouching !== false) {
    const sp = splitTouching(mask, w, h, opts);
    labels = sp.labels; regions = sp.regions;
  } else {
    const cc = connectedComponents(mask, w, h, 8);
    labels = cc.labels; regions = cc.regions;
  }
  const maxArea = w * h * maxAreaFrac;
  // 碎片过滤：按形状合理性剔除细长条状噪声（如标尺条、划痕、文字）
  const kept = [];
  const remap = new Int32Array(w * h).fill(-1);
  const maxElongation = opts.maxElongation ?? 6.0;
  const minFill = opts.minFill ?? 0.35;
  for (const reg of regions) {
    if (reg.area < minArea || reg.area > maxArea) continue;
    // 长宽比粗筛（用包围盒）
    const bw = reg.maxX - reg.minX + 1, bh = reg.maxY - reg.minY + 1;
    const elong = Math.max(bw, bh) / Math.max(Math.min(bw, bh), 1);
    if (elong > maxElongation) continue;
    // 填充率：轮廓面积 / 包围盒面积，过低说明是稀疏噪声
    const fill = reg.area / (bw * bh);
    if (fill < minFill) continue;
    // 圆度过滤：剔除近圆形的背景杂点（如同色小圆斑）。真实籽粒为长椭球投影，
    // 离心率显著 > 阈值；噪声圆斑离心率≈0。可在 opts.filterSpecks=false 时关闭。
    if (opts.filterSpecks !== false) {
      let n = 0, sx = 0, sy = 0;
      for (let y = reg.minY; y <= reg.maxY; y++) {
        const base = y * w;
        for (let x = reg.minX; x <= reg.maxX; x++) {
          const p = base + x;
          if (mask[p] && labels[p] === reg.label) { sx += x; sy += y; n++; }
        }
      }
      if (n >= 2) {
        const cxc = sx / n, cyc = sy / n;
        let sxx = 0, syy = 0, sxy = 0;
        for (let y = reg.minY; y <= reg.maxY; y++) {
          const base = y * w;
          for (let x = reg.minX; x <= reg.maxX; x++) {
            const p = base + x;
            if (mask[p] && labels[p] === reg.label) {
              const dx = x - cxc, dy = y - cyc;
              sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
            }
          }
        }
        sxx /= n; syy /= n; sxy /= n;
        const tr = sxx + syy, det = sxx * syy - sxy * sxy;
        const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
        const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
        const ecc = l1 > 0 ? Math.sqrt(Math.max(0, 1 - l2 / l1)) : 0;
        if (ecc < (opts.minEccentricity ?? 0.45)) continue;
      }
    }
    const newId = kept.length;
    kept.push(reg);
    remap[reg.label] = newId;
  }
  for (let p = 0; p < w * h; p++) {
    const old = labels[p];
    mask[p] = old >= 0 && remap[old] >= 0 ? 1 : 0;
  }
  const finalLabels = new Int32Array(w * h).fill(-1);
  for (let p = 0; p < w * h; p++) finalLabels[p] = mask[p] ? remap[labels[p]] : -1;
  kept.forEach((reg, i) => { reg.label = i; });
  return { mask, labels: finalLabels, regions: kept, meta: { threshold, bgLab } };
}

/** 欧氏距离变换（两遍扫描，精确近似） */
export function distanceTransform(mask, w, h) {
  const INF = 1e12;
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  // 前向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 1);
      if (y > 0) m = Math.min(m, d[i - w] + 1);
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + 1.41421356);
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + 1.41421356);
      d[i] = m;
    }
  }
  // 反向
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
      if (y < h - 1) m = Math.min(m, d[i + w] + 1);
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + 1.41421356);
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + 1.41421356);
      d[i] = m;
    }
  }
  return d;
}

/**
 * 粘连分离：以距离变换峰值作标记，用分水岭式扩张把粘连块拆成单粒。
 * 对散落籽粒照片（颗粒轻微接触）效果稳定。
 * @returns {Int32Array} 每个像素的所属子粒 id（-1 为背景）
 */
export function splitTouching(mask, w, h, opts = {}) {
  const { labels, regions } = connectedComponents(mask, w, h, 8);
  if (regions.length === 0) return { labels, regions, splitCount: 0 };
  const minSplitArea = opts.minSplitArea ?? 60;
  const dist = distanceTransform(mask, w, h);
  const out = new Int32Array(w * h).fill(-1);
  let nextId = 0;
  let splitCount = 0;

  for (const reg of regions) {
    const pieces = splitRegion(reg, labels, dist, w, h, opts);
    if (pieces.length > 1) splitCount++;
    for (const piece of pieces) {
      const id = nextId++;
      for (const p of piece) out[p] = id;
    }
  }
  // 重建区域列表
  const finalRegions = [];
  const idxMap = new Map();
  for (let p = 0; p < w * h; p++) {
    const id = out[p];
    if (id < 0) continue;
    if (!idxMap.has(id)) { idxMap.set(id, finalRegions.length); finalRegions.push({ label: idxMap.get(id), area: 0, minX: w, minY: h, maxX: -1, maxY: -1 }); }
    const r = finalRegions[idxMap.get(id)];
    const x = p % w, y = (p / w) | 0;
    r.area++;
    if (x < r.minX) r.minX = x;
    if (x > r.maxX) r.maxX = x;
    if (y < r.minY) r.minY = y;
    if (y > r.maxY) r.maxY = y;
  }
  // 重映射 label 为连续索引
  for (let p = 0; p < w * h; p++) if (out[p] >= 0) out[p] = idxMap.get(out[p]);
  return { labels: out, regions: finalRegions, splitCount };
}

/** 单个连通域的内部拆分：按距离变换局部极大值作标记，再按路径归属扩张 */
function splitRegion(reg, labels, dist, w, h, opts) {
  const minSplitArea = opts.minSplitArea ?? 60;
  const maxDepth = opts.maxSplitDepth ?? 12;
  // 收集该域像素及其距离值
  const px = [];
  for (let p = reg.minY * w + reg.minX; p <= reg.maxY * w + reg.maxX; p++) {
    if (labels[p] === reg.label) px.push(p);
  }
  if (px.length < minSplitArea * 2) return [px];

  // 本域内距离最大值 ≈ 内切半径
  let localMax = 0;
  for (const p of px) if (dist[p] > localMax) localMax = dist[p];

  // 仅当"本可以容纳两个半径 >= localMax/2 的圆"时才尝试拆分，
  // 避免把单个大颗粒切碎。
  if (px.length < Math.PI * Math.pow(localMax / 2, 2) * 1.15 * 2) return [px];

  // 找"窄颈"：距离值明显低于本域最大距离
  const neckLevel = localMax * (opts.neckRatio ?? 0.62);

  // 标记：距离 > neckLevel 的像素（连接这些像素成块，每块是一个"核心"）
  const core = new Uint8Array(w * h);
  for (const p of px) if (dist[p] > neckLevel) core[p] = 1;
  const { labels: mkLabels, regions: mkRegions } = connectedComponents(core, w, h, 8);
  // 剔除过小的核心（多为噪声）
  const cores = mkRegions.filter((r) => r.area >= (opts.minCoreArea ?? Math.max(4, px.length * 0.005)));
  if (cores.length <= 1) return [px];
  // 把过小的核心并入最大核心，避免出现多余颗粒
  if (cores.length > 1) {
    cores.sort((a, b) => b.area - a.area);
    const main = cores[0];
    for (const c of cores.slice(1)) {
      if (c.area < main.area * 0.25) {
        for (let p = c.minY * w + c.minX; p <= c.maxY * w + c.maxX; p++) {
          if (mkLabels[p] === c.label) mkLabels[p] = main.label;
        }
      }
    }
  }

  // 分配：以距离值降序做多轮传播（分水岭思想）：
  // 距离大的（靠内部的）标记先占位，逐步向外扩张，直到填满整个域。
  const assign = new Int32Array(w * h).fill(-1);
  const push = (p, id) => { assign[p] = id; queue.push({ p, d: dist[p], id }); };
  const queue = [];
  for (const r of cores) {
    for (let p = r.minY * w + r.minX; p <= r.maxY * w + r.maxX; p++) {
      if (mkLabels[p] === r.label) push(p, r.label);
    }
  }
  // 简单的二分堆（按距离从大到小弹出）
  const heap = [];
  const hpush = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heap[par].d >= heap[i].d) break;
      [heap[par], heap[i]] = [heap[i], heap[par]];
      i = par;
    }
  };
  const hpop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].d > heap[m].d) m = l;
        if (r < heap.length && heap[r].d > heap[m].d) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const it of queue) hpush(it);

  while (heap.length) {
    const { p, id } = hpop();
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const q = yy * w + xx;
      if (labels[q] !== reg.label || assign[q] >= 0) continue;
      assign[q] = id;
      hpush({ p: q, d: dist[q], id });
    }
  }
  const pieces = new Map();
  for (const p of px) {
    const id = assign[p];
    if (id < 0) continue;
    if (!pieces.has(id)) pieces.set(id, []);
    pieces.get(id).push(p);
  }
  const result = [...pieces.values()].filter((v) => v.length >= minSplitArea);
  // 面积过小的碎片并回最大块
  const total = result.reduce((s, v) => s + v.length, 0);
  if (result.length === 0 || total < px.length * 0.5) return [px];
  return result;
}

/**
 * Moore 邻域轮廓追踪（Jacob's 停止准则）
 * @param {Uint8Array} mask
 * @param {number} w @param {number} h
 * @param {{x,y}} seed 前景像素，要求为该连通域最上方、最左的像素
 * @returns {{x,y}[]} 闭合轮廓点集（不含重复的起点）
 */
export function traceContour(mask, w, h, seed) {
  // 方向序（顺时针）：NW N NE E SE S SW W
  const DX = [-1, 0, 1, 1, 1, 0, -1, -1];
  const DY = [-1, -1, -1, 0, 1, 1, 1, 0];
  const fg = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);

  let px = seed.x, py = seed.y;
  const contour = [{ x: px, y: py }];
  // backtrack 初始为起点正西（最上最左像素的西侧必为背景）
  let bx = px - 1, by = py;
  let guard = 0;
  const limit = 8 * (w + h) * 4 + 2000;

  while (guard++ < limit) {
    // backtrack 相对当前像素的方向
    let sd = 7;
    for (let i = 0; i < 8; i++) {
      if (px + DX[i] === bx && py + DY[i] === by) { sd = i; break; }
    }
    // 从 backtrack 方向顺时针扫描，找第一个前景邻居
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (sd + k) % 8;
      const nx = px + DX[d], ny = py + DY[d];
      if (fg(nx, ny)) {
        const pd = (sd + k - 1) % 8;
        bx = px + DX[pd]; by = py + DY[pd];
        px = nx; py = ny;
        contour.push({ x: px, y: py });
        moved = true;
        break;
      }
    }
    if (!moved) break;
    // Jacob 停止准则：回到起点且 backtrack 仍在其正西
    if (px === seed.x && py === seed.y && bx === seed.x - 1 && by === seed.y) break;
  }
  if (contour.length > 1) {
    const last = contour[contour.length - 1];
    if (last.x === contour[0].x && last.y === contour[0].y) contour.pop();
  }
  return contour;
}

/** 提取单个连通域的独立掩膜（供轮廓追踪，避免相邻对象间逃逸） */
export function regionMask(labels, w, h, label) {
  const m = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (labels[p] === label) m[p] = 1;
  return m;
}

/** 在掩膜中为某个连通域找到轮廓起点（最上方再最左的像素） */
export function findContourSeed(labels, region, w, h) {
  for (let y = region.minY; y <= region.maxY; y++) {
    for (let x = region.minX; x <= region.maxX; x++) {
      if (labels[y * w + x] === region.label) return { x, y };
    }
  }
  return null;
}