/**
 * stats.js — 描述统计、假设检验与显著性字母标注
 * 纯函数实现，无第三方依赖。
 */

/* --------------------------------------------------------- 分布函数 */

function logGamma(x) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 不完全 Beta 连分数 I_x(a,b) 的核心 betacf(a,b,x)，x ∈ (0,1) */
function betacf(a, b, x) {
  const TINY = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    // 偶数步
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // 奇数步
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/** 正则化不完全 Beta 函数 I_x(a,b)，x ∈ [0,1] */
export function betainc(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  const lbeta2 = logGamma(b) + logGamma(a) - logGamma(a + b); // 对称
  const back = Math.exp(b * Math.log(1 - x) + a * Math.log(x) - lbeta2) * betacf(b, a, 1 - x) / b;
  return 1 - back;
}

/** t 分布双尾 p 值 */
export function tTestP(t, df) {
  if (df <= 0) return NaN;
  const x = df / (df + t * t);
  return betainc(df / 2, 0.5, x);
}

/** F 分布 p 值 */
export function fTestP(f, df1, df2) {
  if (df1 <= 0 || df2 <= 0 || f < 0) return NaN;
  const x = df2 / (df2 + df1 * f);
  return betainc(df2 / 2, df1 / 2, x);
}

/* --------------------------------------------------------- 描述统计 */

export function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

export function variance(a, sample = true) {
  if (a.length < 2) return 0;
  const m = mean(a);
  const ss = a.reduce((s, v) => s + (v - m) ** 2, 0);
  return ss / (a.length - (sample ? 1 : 0));
}

export const sd = (a) => Math.sqrt(variance(a));

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(a) { return quantile(a.slice().sort((x, y) => x - y), 0.5); }

/** 完整描述统计 */
export function describe(a) {
  const n = a.length;
  const s = a.slice().sort((x, y) => x - y);
  const m = mean(a);
  const v = variance(a);
  const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  // Tukey 1.5 IQR 离群判定
  const outliers = a.filter((x) => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr);
  return {
    n, mean: m, sd: v === 0 ? 0 : Math.sqrt(v), se: n > 0 ? Math.sqrt(v / n) : 0,
    cv: m !== 0 ? (Math.sqrt(v) / Math.abs(m)) * 100 : 0,
    min: s[0], max: s[n - 1],
    q1, median: quantile(s, 0.5), q3, iqr,
    geomean: a.every((x) => x > 0) ? Math.exp(mean(a.map((x) => Math.log(x)))) : NaN,
    outliers,
  };
}

/** 均值的 95% 置信区间半宽（正态近似：mean ± 1.96·SE）。返回 {lo, hi, half}。 */
export function meanCI95(a) {
  const d = describe(a);
  if (d.n < 2) return { lo: d.mean, hi: d.mean, half: 0 };
  const half = 1.96 * d.se;
  return { lo: d.mean - half, hi: d.mean + half, half };
}

/* --------------------------------------------------------- 检验 */

/** 独立样本 t 检验（Welch） */
export function welchT(x, y) {
  const nx = x.length, ny = y.length;
  const mx = mean(x), my = mean(y);
  const vx = variance(x) / nx, vy = variance(y) / ny;
  const t = (mx - my) / Math.sqrt(vx + vy);
  const df = (vx + vy) ** 2 / (vx ** 2 / (nx - 1) + vy ** 2 / (ny - 1));
  return { t, df, p: tTestP(t, df), n1: nx, n2: ny, mean1: mx, mean2: my };
}

/** 单因素方差分析 */
export function oneWayAnova(groups) {
  const all = groups.flat();
  const N = all.length, k = groups.length;
  const gm = mean(all);
  let ssB = 0, ssW = 0;
  for (const g of groups) {
    const m = mean(g);
    ssB += g.length * (m - gm) ** 2;
    for (const x of g) ssW += (x - m) ** 2;
  }
  const dfB = k - 1, dfW = N - k;
  const msB = dfB > 0 ? ssB / dfB : 0, msW = dfW > 0 ? ssW / dfW : 0;
  const F = msW > 0 ? msB / msW : 0;
  return { F, p: fTestP(F, dfB, dfW), dfB, dfW, ssB, ssW, msB, msW, grandMean: gm, N };
}

/** Pearson 相关 */
export function pearson(x, y) {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const r = num / Math.sqrt(dx * dy);
  const df = n - 2;
  const t = r * Math.sqrt(df / Math.max(1 - r * r, 1e-15));
  return { r, r2: r * r, p: tTestP(t, df), n };
}

/** 线性回归 y = a + b x */
export function linearRegression(x, y) {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  const r = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  const r2 = r * r;
  const df = n - 2;
  const se = df > 0 ? Math.sqrt((syy - b * sxy) / df / sxx) : 0;
  return { slope: b, intercept: a, r, r2, se, df, n,
    equation: `y = ${fmtNum(b)}x ${a < 0 ? '-' : '+'} ${fmtNum(Math.abs(a))}` };
}

/** 卡方拟合优度（用于长宽比是否符合正态/对数正态） */
export function chiSquareGoodnessOfFit(observed, expected) {
  let chi = 0, df = 0;
  for (let i = 0; i < observed.length; i++) {
    const e = expected[i];
    if (e <= 0) continue;
    chi += (observed[i] - e) ** 2 / e;
    df++;
  }
  df = Math.max(df - 1, 1);
  return { chi2: chi, df, p: betainc(df / 2, 0.5, df / (df + chi)) };
}

/* ------------------------------------------------- 学生化极差与事后两两比较 */

/**
 * 学生化极差分布上尾 p 值 P(Q_{k,ν} > q)，Pearson 型式积分（k-1 项求和）数值计算。
 * 用于 Tukey HSD 的精确 p 值（相比查表更灵活，支持任意 k、df、q）。
 */
function erf(x) {
  // Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7)
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// k 个独立标准正态的极差 R_k 的 CDF：P(max-min <= r) = k ∫ φ(x)(Φ(x+r)-Φ(x))^{k-1} dx
function rangeNormalCdf(r, k) {
  if (k < 2) return 1;
  if (r <= 0) return 0;
  const A = 10, N = 96;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = -A + (2 * A) * (i + 0.5) / N;
    const phi = Math.exp(-x * x / 2) / Math.SQRT2 / Math.sqrt(Math.PI);
    const d = Math.max(0, normalCdf(x + r) - normalCdf(x));
    sum += phi * Math.pow(d, k - 1);
  }
  return Math.min(1, k * sum * (2 * A) / N);
}

// χ_ν 密度在对数尺度（避免大 ν 时的溢出），输入 s = 采样值
function chiPdfLog(s, nu) {
  if (s <= 0) return -Infinity;
  const lgammaNu2 = logGamma(nu / 2);
  return (nu - 1) * Math.log(s) - (s * s) / 2 - ((nu / 2 - 1) * Math.log(2) + lgammaNu2);
}

/**
 * 学生化极差分布上尾 p 值 P(Q_{k,ν} > q)。
 * 等价形式：Q = (k 个 N(0,1) 的极差) / (S/√ν)，其中 S² ~ χ²_ν 独立。
 * 用二重数值积分（外层对 χ 取期望，内层正态极差 CDF）稳健计算，对大 ν 也稳定。
 */
export function studentizedRangeP(q, k, df) {
  if (df <= 0 || k < 2) return NaN;
  if (q <= 0) return 1;
  // 极大自由度退化为“k 个标准正态的极差”，用精确闭式（避免网格在大 ν 下无法解析尖峰）
  if (df >= 1e5) return 1 - rangeNormalCdf(q, k);
  const nu = df;
  const Umax = 1 + 6 / Math.sqrt(nu);
  const N = 128;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const u = Umax * (i + 0.5) / N;
    const s = u * Math.sqrt(nu);
    const pdfU = Math.exp(chiPdfLog(s, nu) + 0.5 * Math.log(nu));
    sum += (Umax / N) * pdfU * rangeNormalCdf(q * u, k);
  }
  return Math.min(1, Math.max(0, 1 - sum));
}

/** 学生化极差临界值 q_{α}(k, ν)，由 CDF 反演二分 */
export function studentizedRangeQ(k, df, alpha = 0.05) {
  let lo = 0, hi = 300, qv = 0;
  for (let i = 0; i < 200; i++) {
    qv = (lo + hi) / 2;
    if (studentizedRangeP(qv, k, df) > alpha) lo = qv; else hi = qv;
  }
  return qv;
}

/**
 * 单因素方差分析后的两两事后比较（核心可扩展点：新增事后检验方法只需在此分支）。
 * @param {number[][]} groups 每组观测值数组
 * @param {'tukey'|'games-howell'|'welch'|'auto'} method
 *   - tukey：要求方差齐，用合并组内均方作标准误（q 统计量），对族系错误率做校正
 *   - games-howell：方差不齐时用 Welch 型标准误（t 统计量，Welch–Satterthwaite df）
 *   - welch：两两 Welch t 检验（不做多重比较校正，兼容旧行为）
 *   - auto：先 Bartlett 检验方差齐性，p>0.05 用 tukey，否则 games-howell
 * @param {number} [alpha=0.05] 族系错误率（用于 Tukey 临界值与字母分配）
 * @returns {{method:string, n:number[], means:number[], sds:number[], pMat:number[][],
 *            tests:Array, letters:string[], qCrit?:number, bartlett?:object}}
 */
export function postHoc(groups, method = 'tukey', alpha = 0.05) {
  const k = groups.length;
  const n = groups.map((g) => g.length);
  const means = groups.map(mean);
  const sds = groups.map((g) => Math.sqrt(variance(g)));
  const N = groups.flat().length;
  const dfW = N - k;
  const ssW = groups.reduce((s, g) => s + g.reduce((a, x) => a + (x - mean(g)) ** 2, 0), 0);
  const msW = dfW > 0 ? ssW / dfW : 0;
  const pMat = Array.from({ length: k }, () => new Array(k).fill(0));
  const tests = [];
  let chosen = method;
  let bartlett = null;
  if (method === 'auto') {
    let S = 0;
    for (let i = 0; i < k; i++) S += (n[i] - 1) * Math.log(sds[i] * sds[i] || 1e-12);
    const bStat = dfW * Math.log(msW || 1e-12) - S;
    const C = 1 + (1 / (3 * (k - 1))) *
      (n.reduce((a, ni) => a + 1 / Math.max(ni - 1, 1e-9), 0) - 1 / Math.max(dfW, 1e-9));
    const stat = C !== 0 ? bStat / C : 0;
    const p = dfW > 0 && k > 1
      ? betainc((k - 1) / 2, 0.5, (k - 1) / ((k - 1) + Math.max(stat, 0)))
      : 1;
    chosen = p > 0.05 ? 'tukey' : 'games-howell';
    bartlett = { stat, p, equalVar: p > 0.05 };
  }
  if (chosen === 'tukey') {
    const qCrit = studentizedRangeQ(k, dfW, alpha);
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const se = Math.sqrt(msW * (1 / n[i] + 1 / n[j]));
        const q = se > 0 ? Math.abs(means[i] - means[j]) / se : 0;
        const p = dfW > 0 ? studentizedRangeP(q, k, dfW) : 1;
        pMat[i][j] = pMat[j][i] = p;
        tests.push({ i, j, stat: q, statName: 'q', p });
      }
    }
    return { method: 'tukey', qCrit, n, means, sds, pMat, tests, letters: letterGroups(pMat, alpha), bartlett };
  }
  if (chosen === 'games-howell') {
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const se = Math.sqrt(sds[i] ** 2 / n[i] + sds[j] ** 2 / n[j]);
        const t = se > 0 ? Math.abs(means[i] - means[j]) / se : 0;
        const den = (sds[i] ** 2 / n[i]) ** 2 / Math.max(n[i] - 1, 1) +
          (sds[j] ** 2 / n[j]) ** 2 / Math.max(n[j] - 1, 1);
        const df = den > 0 ? se ** 4 / den : 0;
        const p = df > 0 ? tTestP(t, df) : 1;
        pMat[i][j] = pMat[j][i] = p;
        tests.push({ i, j, stat: t, statName: 't', df, p });
      }
    }
    return { method: 'games-howell', n, means, sds, pMat, tests, letters: letterGroups(pMat, alpha), bartlett };
  }
  // welch：兼容旧两两 t 检验（无多重比较校正）
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const r = welchT(groups[i], groups[j]);
      pMat[i][j] = pMat[j][i] = r.p;
      tests.push({ i, j, stat: r.t, statName: 't', df: r.df, p: r.p });
    }
  }
  return { method: 'welch', n, means, sds, pMat, tests, letters: letterGroups(pMat, alpha), bartlett };
}

/* ------------------------------------------------- 显著性字母标注 */

/** p 值转星号 */
export function pStars(p) {
  if (!isFinite(p)) return 'ns';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return 'ns';
}

const ALPHA_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 紧凑字母标注法（compact letter display）
 * 输入两两比较的 p 值矩阵（pMat[i][j] < alpha 表示 i、j 显著不同），
 * 输出每组字母串。实现保证：
 *   1) 不显著的两组必有共享字母；2) 显著的两组绝无共享字母。
 * 原理：对“显著关系图”（p<alpha 建边）做贪心图着色，同色节点互不相邻，
 *       即同色节点两两不显著，可共享同一字母；再把同色节点合并成一个字母块。
 * @param {number[][]} pMat 对称 p 值矩阵
 */
export function letterGroups(pMat, alpha = 0.05) {
  const k = pMat.length;
  if (k === 0) return [];
  if (k === 1) return ['a'];

  // 1) 显著关系图：p < alpha 表示"必须用不同字母"
  const sig = Array.from({ length: k }, () => new Set());
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      if (pMat[i][j] < alpha) { sig[i].add(j); sig[j].add(i); }
    }
  }
  // 2) 贪心着色：显著相连者颜色不同
  const colors = new Array(k).fill(-1);
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => sig[b].size - sig[a].size);
  for (const i of order) {
    const used = new Set();
    for (const j of sig[i]) if (colors[j] >= 0) used.add(colors[j]);
    let c = 0;
    while (used.has(c)) c++;
    colors[i] = c;
  }
  // 3) 同色节点构成字母块；校验块内两两不显著（贪心着色已保证，做防御性检查）
  const blocks = new Map();
  for (let i = 0; i < k; i++) {
    const c = colors[i];
    if (!blocks.has(c)) blocks.set(c, []);
    blocks.get(c).push(i);
  }
  for (const [, members] of blocks) {
    if (members.length < 2) continue;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        if (pMat[members[a]][members[b]] < alpha) {
          // 理论上不会发生；若发生则拆块（防御性）
          const moved = members.pop();
          const map = new Map(blocks);
          map.set(Math.max(...blocks.keys()) + 1, [moved]);
          blocks.clear();
          for (const [kk, vv] of map) blocks.set(kk, vv);
        }
      }
    }
  }
  // 4) 生成字母串：大写 26 个不够时续小写
  const sorted = [...blocks.keys()].sort((a, b) => a - b);
  const res = new Array(k).fill('');
  sorted.forEach((c, idx) => {
    const ch = idx < 26 ? ALPHA_UPPER[idx] : String.fromCharCode(97 + (idx - 26));
    for (const i of blocks.get(c)) res[i] += ch;
  });
  return res.map((s) => s.toUpperCase());
}

/** 由各组均值+标准差+样本量做两两 Welch t 检验，构造 p 矩阵 */
export function pairwisePMatrix(samples) {
  const k = samples.length;
  const M = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const p = welchT(samples[i], samples[j]).p;
      M[i][j] = M[j][i] = p;
    }
  }
  return M;
}

/** 两尾 t 检验的临界值（数值反演） */
export function inverseT(p, df) {
  let lo = -50, hi = 50, t = 0;
  for (let i = 0; i < 200; i++) {
    t = (lo + hi) / 2;
    const p2 = tTestP(t, df);
    if (p2 > p) lo = t; else hi = t;
  }
  return t;
}

export function fmtNum(v, d = 3) {
  if (!isFinite(v)) return 'NA';
  return Number(v.toFixed(d)).toString();
}