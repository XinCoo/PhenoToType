/**
 * shape.js — 籽粒形状几何量计算
 * 纯函数，输入轮廓点集，输出形状描述子。
 */

/** 鞋带公式求多边形面积（返回正值） */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** 折线周长（闭合） */
export function polygonPerimeter(pts) {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

export function centroid(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  return { x: cx / pts.length, y: cy / pts.length };
}

/** Andrew monotone chain 凸包 */
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** 两点距离 */
function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

/** 所有点对中最远距离（Feret 最大直径） */
export function maxFeret(pts) {
  let best = 0, bp = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = dist(pts[i], pts[j]);
      if (d > best) { best = d; bp = [pts[i], pts[j]]; }
    }
  }
  return { length: best, a: bp?.[0], b: bp?.[1] };
}

/**
 * 最小面积外接矩形（旋转卡壳，Hershberger & Snoeyink 简化版：遍历凸包边）
 * 返回 {width, height, angle}，angle 为长边与 x 轴夹角（弧度）
 */
export function minAreaRect(hull) {
  if (hull.length < 3) {
    const xs = hull.map((p) => p.x), ys = hull.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return { width: Math.max(w, h), height: Math.min(w, h), angle: 0 };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of hull) {
      const x = p.x * c - p.y * s, y = p.x * s + p.y * c;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const w = maxX - minX, h = maxY - minY, area = w * h;
    if (!best || area < best.area) best = { area, w, h, ang };
  }
  const width = Math.max(best.w, best.h), height = Math.min(best.w, best.h);
  const angle = best.w >= best.h ? best.ang : best.ang + Math.PI / 2;
  return { width, height, angle };
}

/**
 * 等效椭圆拟合（基于二阶中心矩）
 * 对真实椭圆精确；对任意形状给出"等效椭圆"，作为粒径、粒形的稳健描述。
 * 返回 {a, b, angle, cx, cy}，a>=b 为半轴长度
 */
export function fitEllipse(pts) {
  const n = pts.length;
  if (n < 5) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;

  // 多边形面积与二阶矩（解析式，优于采样求和）
  let A = 0, Cxx = 0, Cyy = 0, Cxy = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    A += cross;
    Cxx += (p.x * p.x + p.x * q.x + q.x * q.x) * cross;
    Cyy += (p.y * p.y + p.y * q.y + q.y * q.y) * cross;
    Cxy += (p.x * p.y + 0.5 * (p.x * q.y + q.x * p.y) + q.x * q.y) * cross;
  }
  A = Math.abs(A) / 2;
  Cxx = Math.abs(Cxx) / 12;
  Cyy = Math.abs(Cyy) / 12;
  Cxy = Math.abs(Cxy) / 12;
  if (A < 1e-9) return null;

  // 归一化二阶矩；椭圆半轴满足 m20=a²/4, m02=b²/4
  const m20 = Cxx / A, m02 = Cyy / A, m11 = Cxy / A;
  const common = Math.sqrt(Math.max((m20 - m02) ** 2 + 4 * m11 * m11, 0));
  const l1 = (m20 + m02 + common) / 2;
  const l2 = (m20 + m02 - common) / 2;
  // 椭圆半轴 a,b 满足 m20=a²/4, m02=b²/4 （无旋转时）
  let major = 2 * Math.sqrt(Math.max(l1, 0));
  let minor = 2 * Math.sqrt(Math.max(l2, 0));
  if (!isFinite(major) || major <= 0) major = 0;
  if (!isFinite(minor) || minor <= 0) minor = 0;
  if (minor > major) { const t = major; major = minor; minor = t; }
  // 主轴方向
  const angle = 0.5 * Math.atan2(2 * m11, m20 - m02);
  return { a: major, b: minor, angle, cx: mx, cy: my };
}

/** 周长法 / 面积法 估算厚度（用于顶视图：假定三轴椭球） */
export function estimateThickness(contour) {
  const area = polygonArea(contour);
  const per = polygonPerimeter(contour);
  const flat = 2 * area / per;           // 面积/周长 ≈ 平均宽度
  const boxArea = (maxFeret(contour).length) * flat;
  const k = area / boxArea;
  return { flatWidth: flat, thickness: flat * k };
}

/**
 * 汇总一个籽粒的全部形状描述子（像素单位）
 * @param {Array<{x,y}>} contour 外轮廓（像素坐标）
 */
export function describeShape(contour) {
  const area = polygonArea(contour);
  const perimeter = polygonPerimeter(contour);
  const hull = convexHull(contour);
  const hullArea = polygonArea(hull);
  const rect = minAreaRect(hull);
  const feret = maxFeret(contour);
  const ell = fitEllipse(contour);
  const c = centroid(contour);
  const circ = (4 * Math.PI * area) / (perimeter * perimeter);
  const solidity = area / hullArea;
  const eqDiameter = 2 * Math.sqrt(area / Math.PI);
  const aspect = rect.height > 0 ? rect.width / rect.height : 0;
  const roundness = rect.height > 0 ? rect.height / rect.width : 0;
  const { flatWidth, thickness } = estimateThickness(contour);
  const volEllipse = ell ? (4 / 3) * Math.PI * ell.a * ell.b * Math.max(thickness, 0) : 0;
  return {
    area, perimeter, hullArea, solidity, circularity: circ,
    length: rect.width, width: rect.height, angle: rect.angle,
    aspectRatio: aspect, roundness,
    feretMax: feret.length,
    equivalentDiameter: eqDiameter,
    ellipse: ell,
    flatWidth, thickness, volumeEllipsoid: volEllipse,
    centroid: c,
  };
}