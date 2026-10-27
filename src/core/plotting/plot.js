/**
 * plot.js — 科研级（SCI 规范）矢量绘图引擎
 * 输出 SVG 字符串：文字为真实 text（可选转曲）、线宽按 pt 语义、尺寸可精确到 mm。
 * 不依赖 DOM，便于 Node 端测试与主进程直接导出。
 */

/* ------------------------------------------------------- 主题与配色 */

export const DEFAULT_THEME = {
  fontFamily: 'Arial, Helvetica, sans-serif',
  fontSize: 8,           // pt
  lineWidth: 0.8,        // pt
  axisLineWidth: 0.8,
  tickLength: 2,         // pt
  colors: [
    '#2E5C8A', '#C0504D', '#4F8A3D', '#8064A2', '#E8A33D',
    '#3AA8A0', '#A24B8F', '#7A7A7A', '#8C6239', '#5B6B8C',
  ],
  background: 'transparent',
};

export const PALETTES = {
  nature: ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F', '#8491B4'],
  lancet: ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F', '#FDAF91'],
  science: ['#3B4992', '#EE0000', '#008B45', '#631879', '#008280', '#BB0021'],
  wiley: ['#000000', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2'],
  grayscale: ['#000000', '#4D4D4D', '#7F7F7F', '#A6A6A6', '#CCCCCC', '#EBEBEB'],
  okabeIto: ['#000000', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'],
};

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const n = (v) => (Math.round(v * 1000) / 1000).toString();

/* --------------------------------------------------------- 刻度算法 */

/** "nice" 刻度：返回 {min,max,step,ticks[]} */
export function niceTicks(min, max, count = 6) {
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (min === max) { const d = Math.abs(min) || 1; min -= d * 0.1; max += d * 0.1; }
  const range = max - min;
  const raw = range / Math.max(count, 2);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const stepMul = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = stepMul * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(12)));
  return { min: lo, max: hi, step, ticks };
}

/** 数字格式化：自动选择有效位数 */
export function tickLabel(v, step) {
  const dec = step >= 1 ? 0 : Math.min(6, Math.max(0, Math.ceil(-Math.log10(step))));
  const s = v.toFixed(dec);
  return s.replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m));
}

/* ------------------------------------------------------------ 画布类 */

export class SvgCanvas {
  /**
   * @param {object} cfg {widthMm, heightMm, dpi, theme}
   */
  constructor(cfg = {}) {
    const th = { ...DEFAULT_THEME, ...(cfg.theme || {}) };
    // theme 可能只覆盖部分字段（如仅 fontSize），需补齐字体族等默认值
    th.fontFamily = cfg.theme?.fontFamily ?? DEFAULT_THEME.fontFamily;
    th.colors = cfg.theme?.colors ?? DEFAULT_THEME.colors;
    if (cfg.palette && PALETTES[cfg.palette]) th.colors = PALETTES[cfg.palette];
    this.theme = th;
    this.widthMm = cfg.widthMm ?? 85;
    this.heightMm = cfg.heightMm ?? 65;
    this.dpi = cfg.dpi ?? 600;
    // 内部坐标单位：pt（1pt = 1/72 inch）；mm -> pt
    this.W = (this.widthMm / 25.4) * 72;
    this.H = (this.heightMm / 25.4) * 72;
    this.parts = [];
  }

  _t(style = {}) {
    // 注意：这里不能用 spread 直接合入 style，因为 style 可能不含
    // fontFamily 等字段而把 theme 的值覆盖为 undefined。逐字段择取。
    return {
      fontSize: style.fontSize ?? this.theme.fontSize,
      fontFamily: style.fontFamily ?? this.theme.fontFamily,
      ...style,
    };
  }

  text(x, y, str, opt = {}) {
    const s = this._t(opt);
    const anchor = opt.anchor ?? 'start';
    const baseline = opt.baseline ?? 'alphabetic';
    const rot = opt.rotate ? ` transform="rotate(${n(opt.rotate)} ${n(x)} ${n(y)})"` : '';
    this.parts.push(
      `<text x="${n(x)}" y="${n(y)}" font-family="${esc(s.fontFamily)}" font-size="${n(s.fontSize)}" ` +
      `font-weight="${s.weight ?? 'normal'}" font-style="${s.italic ? 'italic' : 'normal'}" ` +
      `fill="${s.fill ?? '#000000'}" text-anchor="${anchor}" dominant-baseline="${baseline}"` +
      `${rot}>${esc(str)}</text>`
    );
    return this;
  }

  line(x1, y1, x2, y2, opt = {}) {
    this.parts.push(
      `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ` +
      `stroke="${opt.stroke ?? '#000000'}" stroke-width="${n(opt.width ?? this.theme.lineWidth)}" ` +
      `${opt.cap ? `stroke-linecap="${opt.cap}"` : ''} ${opt.dash ? `stroke-dasharray="${opt.dash}"` : ''}/>`
    );
    return this;
  }

  rect(x, y, w, h, opt = {}) {
    this.parts.push(
      `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ` +
      `fill="${opt.fill ?? 'none'}"${opt.fillOpacity !== undefined ? ` fill-opacity="${n(opt.fillOpacity)}"` : ''} ` +
      `stroke="${opt.stroke ?? 'none'}" stroke-width="${n(opt.width ?? this.theme.lineWidth)}"/>`
    );
    return this;
  }

  path(d, opt = {}) {
    this.parts.push(
      `<path d="${d}" fill="${opt.fill ?? 'none'}" stroke="${opt.stroke ?? 'none'}" ` +
      `stroke-width="${n(opt.width ?? this.theme.lineWidth)}" stroke-linejoin="round" stroke-linecap="round"/>`
    );
    return this;
  }

  circle(cx, cy, r, opt = {}) {
    this.parts.push(
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${opt.fill ?? 'none'}"` +
      `${opt.fillOpacity !== undefined ? ` fill-opacity="${n(opt.fillOpacity)}"` : ''} ` +
      `stroke="${opt.stroke ?? 'none'}" stroke-width="${n(opt.width ?? this.theme.lineWidth)}"/>`
    );
    return this;
  }

  polyline(pts, opt = {}) {
    const d = 'M' + pts.map((p) => `${n(p[0])},${n(p[1])}`).join('L');
    return this.path(d, { ...opt, fill: 'none' });
  }

  group(inner) { this.parts.push(inner); return this; }

  /** 生成完整 SVG 字符串 */
  toString() {
    const bg = this.theme.background;
    const bgRect = bg && bg !== 'transparent'
      ? `<rect x="0" y="0" width="${n(this.W)}" height="${n(this.H)}" fill="${bg}"/>`
      : '';
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
      `width="${n(this.widthMm)}mm" height="${n(this.heightMm)}mm" ` +
      `viewBox="0 0 ${n(this.W)} ${n(this.H)}">` +
      bgRect + this.parts.join('') + `</svg>`
    );
  }
}

/* ------------------------------------------------------- 坐标轴系统 */

export class Axes {
  /**
   * @param {SvgCanvas} cv
   * @param {object} o {left,right,top,bottom,xLabel,yLabel,xRange,yRange,logY}
   */
  constructor(cv, o) {
    this.cv = cv;
    this.o = {
      left: 46, right: 12, top: 10, bottom: 34, ...o,
    };
    this.x0 = this.o.left;
    this.x1 = cv.W - this.o.right;
    this.y0 = cv.H - this.o.bottom;
    this.y1 = this.o.top;
    this.xRange = this.o.xRange ?? [0, 1];
    this.yRange = this.o.yRange ?? [0, 1];
  }

  px(v) {
    const [a, b] = this.xRange;
    return this.x0 + ((v - a) / (b - a || 1)) * (this.x1 - this.x0);
  }

  py(v) {
    const [a, b] = this.yRange;
    return this.y0 - ((v - a) / (b - a || 1)) * (this.y0 - this.y1);
  }

  /** 绘制坐标框 + 刻度 + 标签 */
  render(opt = {}) {
    const cv = this.cv, th = cv.theme;
    const xt = niceTicks(...this.xRange, opt.xTickCount ?? 6);
    const yt = niceTicks(...this.yRange, opt.yTickCount ?? 6);
    const gridY = opt.gridY ?? false;

    // 网格（先画，处于底层）
    if (gridY) {
      for (const t of yt.ticks) {
        const y = this.py(t);
        if (y < this.y1 - 0.01 || y > this.y0 + 0.01) continue;
        cv.line(this.x0, y, this.x1, y, { stroke: '#E3E3E3', width: 0.4 });
      }
    }
    // 轴线
    cv.line(this.x0, this.y0, this.x1, this.y0, { stroke: '#000', width: th.axisLineWidth });
    cv.line(this.x0, this.y1, this.x0, this.y0, { stroke: '#000', width: th.axisLineWidth });

    // 刻度
    for (const t of xt.ticks) {
      const x = this.px(t);
      if (x < this.x0 - 0.01 || x > this.x1 + 0.01) continue;
      cv.line(x, this.y0, x, this.y0 - th.tickLength, { stroke: '#000', width: th.axisLineWidth });
      cv.text(x, this.y0 + th.tickLength + 4.2, opt.xFmt ? opt.xFmt(t) : tickLabel(t, xt.step),
        { anchor: 'middle', fontSize: th.fontSize });
    }
    for (const t of yt.ticks) {
      const y = this.py(t);
      if (y < this.y1 - 0.01 || y > this.y0 + 0.01) continue;
      cv.line(this.x0, y, this.x0 - th.tickLength, y, { stroke: '#000', width: th.axisLineWidth });
      cv.text(this.x0 - th.tickLength - 3, y + 1.6, opt.yFmt ? opt.yFmt(t) : tickLabel(t, yt.step),
        { anchor: 'end', fontSize: th.fontSize });
    }
    if (opt.xLabel) cv.text((this.x0 + this.x1) / 2, this.y0 + 22, opt.xLabel, { anchor: 'middle', fontSize: th.fontSize + 0.5 });
    if (opt.yLabel) {
      cv.text(12, (this.y1 + this.y0) / 2, opt.yLabel, { anchor: 'middle', fontSize: th.fontSize + 0.5, rotate: -90 });
    }
    this.xt = xt; this.yt = yt;
    return this;
  }
}

/* ------------------------------------------------------ 统计图类型 */

/** 带误差棒与显著性字母的柱状图 */
export function barChart(cv, data, opt = {}) {
  // data: [{label, mean, se, n, letters, color?}]
  const th = cv.theme;
  const values = data.map((d) => d.mean);
  const errs = data.map((d) => (d.se ?? d.sd ?? 0) * (opt.errType === 'sd' ? 1 : 1));
  const yMax = Math.max(...data.map((d) => d.mean + (d.se ?? 0)), 0) || 1;
  const yt = niceTicks(0, yMax * 1.25, 6);
  const ax = new Axes(cv, { yRange: [0, yt.max], ...opt });
  ax.render({ xLabel: opt.xLabel, yLabel: opt.yLabel, yTickCount: 6, gridY: opt.gridY ?? true });

  const inner = ax.x1 - ax.x0;
  const step = inner / data.length;
  const bw = Math.min(step * 0.55, opt.maxBarWidth ?? 26);
  data.forEach((d, i) => {
    const cx = ax.x0 + step * (i + 0.5);
    const yTop = ax.py(d.mean);
    const yBase = ax.py(0);
    const col = d.color ?? th.colors[i % th.colors.length];
    if (opt.barFillOpacity ?? 1) cv.rect(cx - bw / 2, yTop, bw, yBase - yTop, { fill: col, fillOpacity: opt.barFillOpacity });
    // 误差棒
    const e = (d.se ?? 0) * (opt.errFactor ?? 1);
    if (e > 0) {
      const yT = ax.py(d.mean + e), yB = ax.py(d.mean - e);
      cv.line(cx, yT, cx, yB, { stroke: '#000', width: th.lineWidth * 0.9 });
      const cap = bw * 0.28;
      cv.line(cx - cap, yT, cx + cap, yT, { stroke: '#000', width: th.lineWidth * 0.9 });
      cv.line(cx - cap, yB, cx + cap, yB, { stroke: '#000', width: th.lineWidth * 0.9 });
    }
    // 散点叠加
    if (opt.showPoints && d.values) {
      for (let k = 0; k < d.values.length; k++) {
        const jx = cx + (jitter(k, d.values.length) * bw * 0.42);
        cv.circle(jx, ax.py(d.values[k]), opt.pointR ?? 1.5,
          { fill: '#000', fillOpacity: opt.pointAlpha ?? 0.55 });
      }
    }
    // 显著性字母（置于误差棒之上）
    if (d.letters) {
      const yL = (d.se ?? 0) > 0 ? ax.py(d.mean + d.se) : yTop;
      cv.text(cx, yL - 3, d.letters, { anchor: 'middle', fontSize: th.fontSize + 0.5 });
    }
    cv.text(cx, ax.y0 + th.tickLength + 4.2, d.label, { anchor: 'middle', fontSize: th.fontSize });
  });
  if (opt.note) cv.text(ax.x1, cv.H - 3, opt.note, { anchor: 'end', fontSize: th.fontSize - 0.5, fill: '#444' });
  return { ax, yt };
}

/** 箱线图（可叠加散点与显著性括号） */
export function boxPlot(cv, data, opt = {}) {
  // data: [{label, values, letters}]
  const th = cv.theme;
  const all = data.flatMap((d) => d.values);
  const lo = opt.yMin ?? Math.min(...all);
  const hi = Math.max(...all);
  const yt = niceTicks(lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.15, 6);
  const ax = new Axes(cv, { yRange: [yt.min, yt.max], ...opt });
  ax.render({ xLabel: opt.xLabel, yLabel: opt.yLabel, gridY: opt.gridY ?? true });

  const inner = ax.x1 - ax.x0;
  const step = inner / data.length;
  const bw = Math.min(step * 0.5, 22);
  data.forEach((d, i) => {
    const cx = ax.x0 + step * (i + 0.5);
    const v = d.values.slice().sort((a, b) => a - b);
    const q1 = q(v, 0.25), med = q(v, 0.5), q3 = q(v, 0.75);
    const iqr = q3 - q1;
    const loW = Math.max(v[0], q1 - 1.5 * iqr), hiW = Math.min(v[v.length - 1], q3 + 1.5 * iqr);
    const col = d.color ?? th.colors[i % th.colors.length];
    const yq1 = ax.py(q1), yq3 = ax.py(q3);
    cv.rect(cx - bw / 2, yq3, bw, yq1 - yq3, { fill: 'none', stroke: '#000', width: th.lineWidth });
    cv.line(cx, ax.py(hiW), cx, yq3, { stroke: '#000', width: th.lineWidth });
    cv.line(cx, ax.py(loW), cx, yq1, { stroke: '#000', width: th.lineWidth });
    cv.line(cx - bw * 0.28, ax.py(hiW), cx + bw * 0.28, ax.py(hiW), { stroke: '#000', width: th.lineWidth });
    cv.line(cx - bw * 0.28, ax.py(loW), cx + bw * 0.28, ax.py(loW), { stroke: '#000', width: th.lineWidth });
    cv.line(cx - bw / 2, ax.py(med), cx + bw / 2, ax.py(med), { stroke: '#000', width: th.lineWidth * 1.3 });
    // 均值标记
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    cv.line(cx - bw * 0.22, ax.py(m), cx + bw * 0.22, ax.py(m), { stroke: col, width: th.lineWidth * 1.6 });
    // 散点
    if (opt.showPoints !== false) {
      for (let k = 0; k < v.length; k++) {
        cv.circle(cx + jitter(k, v.length) * bw * 0.34, ax.py(v[k]), opt.pointR ?? 1.4,
          { fill: '#000', fillOpacity: opt.pointAlpha ?? 0.4 });
      }
    }
    if (d.letters) cv.text(cx, ax.py(hiW) - 3, d.letters, { anchor: 'middle', fontSize: th.fontSize + 0.5 });
    cv.text(cx, ax.y0 + th.tickLength + 4.2, d.label, { anchor: 'middle', fontSize: th.fontSize });
  });
  if (opt.brackets) drawBrackets(cv, ax, opt.brackets, data.length, step, ax.x0);
  return { ax, yt };
}

function drawBrackets(cv, ax, brackets, nGroups, step, x0) {
  const th = cv.theme;
  for (const b of brackets) {
    const xa = x0 + step * (b.i + 0.5), xb = x0 + step * (b.j + 0.5);
    const y = ax.py(b.y ?? Math.max(ax.yt.max * 0.8, 0));
    const h = 3;
    cv.line(xa, y, xb, y, { stroke: '#000', width: th.lineWidth * 0.9 });
    cv.line(xa, y + h, xa, y - h * 0.4, { stroke: '#000', width: th.lineWidth * 0.9 });
    cv.line(xb, y + h, xb, y - h * 0.4, { stroke: '#000', width: th.lineWidth * 0.9 });
    cv.text((xa + xb) / 2, y - 2, b.label ?? '*', { anchor: 'middle', fontSize: th.fontSize + 0.5 });
  }
}

/** 小提琴图 */
export function violinPlot(cv, data, opt = {}) {
  const th = cv.theme;
  const all = data.flatMap((d) => d.values);
  const yt = niceTicks(Math.min(...all), Math.max(...all), 6);
  const ax = new Axes(cv, { yRange: [yt.min, yt.max], ...opt });
  ax.render({ xLabel: opt.xLabel, yLabel: opt.yLabel, gridY: true });
  const step = (ax.x1 - ax.x0) / data.length;
  const bw = Math.min(step * 0.5, 26);
  const bandwidth = opt.bandwidth ?? (Math.max(...all) - Math.min(...all)) / 40;

  data.forEach((d, i) => {
    const cx = ax.x0 + step * (i + 0.5);
    const col = d.color ?? th.colors[i % th.colors.length];
    const grid = [];
    const y0 = yt.min, y1 = yt.max;
    const M = 80;
    for (let g = 0; g <= M; g++) {
      const yv = y0 + ((y1 - y0) * g) / M;
      let dens = 0;
      for (const v of d.values) dens += Math.exp(-((v - yv) ** 2) / (2 * bandwidth ** 2));
      dens /= d.values.length;
      grid.push([yv, dens]);
    }
    const maxD = Math.max(...grid.map((g) => g[1])) || 1;
    // 上半边（右半）自下而上，再接左半边自上而下，形成闭合轮廓
    const right = grid.map(([yv, dens]) => [cx + (dens / maxD) * (bw / 2), ax.py(yv)]);
    const left = grid.map(([yv, dens]) => [cx - (dens / maxD) * (bw / 2), ax.py(yv)]).reverse();
    const dpath = 'M' + [...right, ...left]
      .map(([x, y]) => `${n(x)},${n(y)}`).join('L') + 'Z';
    cv.path(dpath, { fill: col, fillOpacity: opt.fillOpacity ?? 0.45, stroke: '#000', width: th.lineWidth * 0.8 });
    // 中位数与四分位
    const v = d.values.slice().sort((a, b) => a - b);
    cv.line(cx - bw * 0.18, ax.py(q(v, 0.5)), cx + bw * 0.18, ax.py(q(v, 0.5)), { stroke: '#000', width: th.lineWidth * 1.4 });
    if (d.letters) cv.text(cx, ax.py(Math.max(...d.values)) - 4, d.letters, { anchor: 'middle', fontSize: th.fontSize + 0.5 });
    cv.text(cx, ax.y0 + th.tickLength + 4.2, d.label, { anchor: 'middle', fontSize: th.fontSize });
  });
  return { ax, yt };
}

/** 散点 + 线性/二次拟合 + R² */
export function scatterFit(cv, points, opt = {}) {
  const th = cv.theme;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const yt = niceTicks(Math.min(...ys), Math.max(...ys), 6);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs), 6);
  const ax = new Axes(cv, { yRange: [yt.min, yt.max], xRange: [xt.min, xt.max], ...opt });
  ax.render({ xLabel: opt.xLabel, yLabel: opt.yLabel, gridY: opt.gridY ?? true });
  const col = opt.color ?? th.colors[0];
  for (const p of points) {
    cv.circle(ax.px(p.x), ax.py(p.y), opt.pointR ?? 2.2,
      { fill: col, fillOpacity: opt.pointAlpha ?? 0.7, stroke: '#fff', width: 0.3 });
  }
  if (opt.fit !== false && points.length > 1) {
    const n = points.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    const sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0);
    const sxy = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0);
    const syy = ys.reduce((s, v) => s + (v - my) ** 2, 0);
    const r = sxy / Math.sqrt(sxx * syy);
    let f;
    if (opt.model === 'quadratic') {
      // 最小二乘二次拟合
      let S = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], B = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const X = [1, xs[i], xs[i] ** 2], Y = ys[i];
        for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) S[a][b] += X[a] * X[b]; B[a] += X[a] * Y; }
      }
      const sol = solve3(S, B);
      if (sol) {
        const [a, b, c] = sol;
        f = (x) => a + b * x + c * x * x;
        opt._eq = `y = ${sig3(a)} ${a < 0 ? '-' : '+'} ${sig3(Math.abs(b))}x ${c < 0 ? '-' : '+'} ${sig3(Math.abs(c))}x²`;
      }
    }
    if (!f) {
      const b = sxy / sxx, a = my - b * mx;
      f = (x) => a + b * x;
      opt._eq = `y = ${sig3(a)} ${b < 0 ? '-' : '+'} ${sig3(Math.abs(b))}x`;
    }
    const xa = xt.min, xb = xt.max;
    cv.line(ax.px(xa), ax.py(f(xa)), ax.px(xb), ax.py(f(xb)),
      { stroke: opt.fitColor ?? '#000', width: th.lineWidth * 1.4 });
    opt._r2 = r * r;
  }
  // R² 角标
  if (opt._r2 !== undefined && opt.showR2 !== false) {
    cv.text(ax.x1 - 2, ax.y1 + 6, `${opt.rLabel ?? 'R'}² = ${opt._r2.toFixed(3)}`,
      { anchor: 'end', fontSize: th.fontSize, italic: true });
  }
  if (opt.eqLabel && opt._eq) cv.text(ax.x1 - 2, ax.y1 + 6, opt.eqLabel, { anchor: 'end', fontSize: th.fontSize });
  return { ax, yt };
}

function solve3(A0, b) {
  const M = A0.map((r, i) => [...r, b[i]]);
  const n = 3;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const fq = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= fq * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

const sig3 = (v) => {
  const a = Math.abs(v);
  const d = a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return Number(v.toFixed(d)).toString();
};

/** 直方图 + 正态/对数正态核密度 */
export function histDensity(cv, values, opt = {}) {
  const th = cv.theme;
  const nBins = opt.bins ?? 18;
  const min = opt.min ?? Math.min(...values);
  const max = opt.max ?? Math.max(...values);
  const binW = (max - min) / nBins || 1;
  const counts = new Array(nBins).fill(0);
  for (const v of values) {
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((v - min) / binW)));
    counts[i]++;
  }
  const yt = niceTicks(0, Math.max(...counts) * 1.2, 5);
  const ax = new Axes(cv, { yRange: [0, yt.max], xRange: [min, max], ...opt });
  ax.render({ xLabel: opt.xLabel, yLabel: opt.yLabel || 'Frequency', gridY: true });
  const col = opt.color ?? th.colors[0];
  for (let i = 0; i < nBins; i++) {
    const x0 = ax.px(min + i * binW), x1 = ax.px(min + (i + 1) * binW);
    const y = ax.py(counts[i]);
    cv.rect(x0, y, x1 - x0, ax.y0 - y, { fill: col, fillOpacity: opt.fillOpacity ?? 0.75 });
  }
  // 核密度（归一化到直方图量纲）
  const bwK = (binW * 1.2);
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(values.length - 1, 1)) || 1;
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const x = min + ((max - min) * i) / 200;
    let d = 0;
    for (const v of values) d += Math.exp(-((v - x) ** 2) / (2 * bwK * bwK));
    d /= values.length * bwK * Math.sqrt(2 * Math.PI);
    pts.push([ax.px(x), ax.py(d * values.length * binW)]);
  }
  cv.polyline(pts, { stroke: opt.densityColor ?? '#C0504D', width: th.lineWidth * 1.3 });
  return { ax, yt, counts, binW };
}

/** 散点矩阵式相关热图 */
export function corrHeatmap(cv, labels, R, opt = {}) {
  const th = cv.theme;
  const k = labels.length;
  const cell = opt.cell ?? 16;
  const left = 30, top = 26;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const r = R[i][j];
      const x = left + j * cell, y = top + i * cell;
      const fill = r >= 0 ? mix('#FFFFFF', th.colors[0], Math.abs(r))
        : mix('#FFFFFF', th.colors[1], Math.abs(r));
      cv.rect(x, y, cell, cell, { fill, stroke: '#fff', width: 0.4 });
      if (opt.showValue !== false) {
        cv.text(x + cell / 2, y + cell / 2 + 1.4, r.toFixed(2),
          { anchor: 'middle', fontSize: th.fontSize - 1.5, fill: Math.abs(r) > 0.6 ? '#fff' : '#000' });
      }
    }
  }
  for (let i = 0; i < k; i++) {
    cv.text(left + (k - 0.5) * cell + 2, top + (i + 0.5) * cell, labels[i], { anchor: 'start', fontSize: th.fontSize - 1 });
    cv.text(left + (i + 0.5) * cell, top - 3, labels[i], { anchor: 'middle', fontSize: th.fontSize - 1 });
  }
  return { left, top, cell };
}

function mix(a, b, t) {
  const pa = hex2rgb(a), pb = hex2rgb(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function hex2rgb(h) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

/* ----------------------------------------------------------- 工具 */

function q(sorted, p) {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 确定性抖动（避免随机导致图不可复现） */
function jitter(i, n) {
  if (n <= 1) return 0;
  return (((i * 2654435761) % 1000) / 1000 - 0.5) * 1.6;
}

/** 多面板拼图 */
export function composePanels(panels, opts = {}) {
  // panels: [{svg, widthMm, heightMm}]，返回合并 SVG
  const gap = opts.gapMm ?? 2;
  const cols = opts.cols ?? panels.length;
  const rows = Math.ceil(panels.length / cols);
  const cw = Math.max(...panels.map((p) => p.widthMm));
  const chh = Math.max(...panels.map((p) => p.heightMm));
  const totalW = cols * cw + (cols - 1) * gap;
  const totalH = rows * chh + (rows - 1) * gap;
  const out = [];
  panels.forEach((p, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const x = c * (cw + gap), y = r * (chh + gap);
    const inner = p.svg.replace(/<\?xml[^>]*\?>\s*/, '').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    out.push(`<g transform="translate(${n(x)},${n(y)}) scale(${n(cw / p.widthMm)})">${inner}</g>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(totalW)}mm" height="${n(totalH)}mm" viewBox="0 0 ${n(totalW)} ${n(totalH)}">${out.join('')}</svg>`;
}

/** 加比例尺标尺条（显微/籽粒图必备） */
export function scaleBar(cv, x, y, mmPerPx, lengthMm, label) {
  const th = cv.theme;
  const len = lengthMm / mmPerPx * (72 / 25.4);
  cv.rect(x, y, len, 2.2, { fill: '#000' });
  cv.text(x + len / 2, y - 2, label ?? `${lengthMm} mm`, { anchor: 'middle', fontSize: th.fontSize });
}