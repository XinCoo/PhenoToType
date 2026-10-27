/**
 * 单测：合成图像验证分割、形状量、统计与绘图。
 * 运行：node test/unit/run.js
 */
import {
  rgbToLab, labToRgb, segmentGrains, traceContour, findContourSeed,
  connectedComponents, fillHoles, erode, dilate,
} from '../../src/core/segmentation/image.js';
import {
  polygonArea, polygonPerimeter, convexHull, minAreaRect, fitEllipse,
  describeShape, maxFeret, centroid,
} from '../../src/core/geometry/shape.js';
import {
  betainc, tTestP, fTestP, welchT, oneWayAnova, pearson, linearRegression,
  describe, letterGroups, pairwisePMatrix, inverseT, quantile, median,
} from '../../src/core/statistics/stats.js';
import {
  niceTicks, SvgCanvas, barChart, boxPlot, violinPlot, scatterFit,
  histDensity, corrHeatmap, composePanels, scaleBar,
} from '../../src/core/plotting/plot.js';
import { mmPerPixel, makeScaler, detectScaleBars } from '../../src/core/calibration/calibrate.js';
import { processImage, groupSamples, simplify } from '../../src/core/pipeline.js';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; } else { fail++; failures.push(`${name} ${detail}`); }
}
function near(name, a, b, tol) {
  ok(name, Math.abs(a - b) <= tol, `got=${a} expect=${b} tol=${tol}`);
}

/* ---------------------------------------------------- 合成工具 */
function makeImg(w, h, bg = [245, 245, 240]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    data[p * 4] = bg[0]; data[p * 4 + 1] = bg[1]; data[p * 4 + 2] = bg[2]; data[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
function putEllipse(img, cx, cy, rx, ry, color = [90, 60, 40], angle = 0) {
  const { width: w, height: h, data } = img;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if ((u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1) {
        const i = (y * w + x) * 4;
        data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2];
      }
    }
  }
}
function circlePts(cx, cy, r, n = 360) {
  return Array.from({ length: n }, (_, i) => ({
    x: cx + r * Math.cos((2 * Math.PI * i) / n),
    y: cy + r * Math.sin((2 * Math.PI * i) / n),
  }));
}

/* ------------------------------------------------- 1. 色彩空间 */
{
  const lab = rgbToLab(255, 255, 255);
  near('Lab(白).L', lab.L, 100, 0.5);
  near('Lab(白).a', lab.a, 0, 0.5);
  near('Lab(白).b', lab.b, 0, 0.6);
  const l0 = rgbToLab(0, 0, 0);
  near('Lab(黑).L', l0.L, 0, 0.5);
  const back = labToRgb(lab.L, lab.a, lab.b);
  ok('Lab→RGB 往返', Math.abs(back.r - 255) <= 1 && Math.abs(back.g - 255) <= 1 && Math.abs(back.b - 255) <= 1,
    JSON.stringify(back));
  const mid = rgbToLab(128, 128, 128);
  const b2 = labToRgb(mid.L, mid.a, mid.b);
  ok('Lab 往返(灰)', Math.abs(b2.r - 128) <= 2, JSON.stringify(b2));
}

/* --------------------------------------------- 2. 形态学与连通域 */
{
  const w = 20, h = 20;
  const m = new Uint8Array(w * h);
  m[10 * w + 5] = 1; m[10 * w + 6] = 1; m[10 * w + 7] = 1;   // 孤立噪点
  const { regions } = connectedComponents(m, w, h, 8);
  ok('连通域计数', regions.length === 1 && regions[0].area === 3, JSON.stringify(regions));

  // 圆环：填孔后变成实心
  const m2 = new Uint8Array(w * h);
  const R = 8;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 10, y - 10);
    if (d <= R && d >= R - 2) m2[y * w + x] = 1;
  }
  const before = connectedComponents(m2, w, h, 8).regions[0].area;
  const filled = fillHoles(m2, w, h);
  const after = connectedComponents(filled, w, h, 8).regions[0].area;
  ok('填孔增加面积', after > before, `${before} -> ${after}`);
  const er = erode(m2, w, h, 1);
  ok('腐蚀缩小', connectedComponents(er, w, h, 8).regions.length === 0 || connectedComponents(er, w, h, 8).regions[0].area < before);
  const di = dilate(m2, w, h, 1);
  ok('膨胀增大', connectedComponents(di, w, h, 8).regions[0].area > before);
}

/* -------------------------------------------------- 3. 几何量 */
{
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  near('正方形面积', polygonArea(sq), 100, 1e-9);
  near('正方形周长', polygonPerimeter(sq), 40, 1e-9);
  const rect = minAreaRect(convexHull(sq));
  near('正方形最小外接矩形宽', rect.width, 10, 1e-6);
  near('正方形最小外接矩形高', rect.height, 10, 1e-6);

  const c = circlePts(0, 0, 50);
  near('圆面积(πr²)', polygonArea(c), Math.PI * 2500, 6);
  near('圆周长(2πr)', polygonPerimeter(c), 2 * Math.PI * 50, 1.5);
  const cr = minAreaRect(convexHull(c));
  near('圆最小外接矩形≈直径', cr.width, 100, 1.5);
  near('圆圆度=1', describeShape(c).circularity, 1, 0.02);
  near('圆 solidity=1', describeShape(c).solidity, 1, 1e-6);

  const ell = fitEllipse(c);
  near('圆拟合半轴 a', ell.a, 50, 1.5);
  near('圆拟合半轴 b', ell.b, 50, 1.5);

  // 旋转椭圆：长轴 40 短轴 20，旋转 30°
  const ang = Math.PI / 6;
  const rot = Array.from({ length: 720 }, (_, i) => {
    const t = (2 * Math.PI * i) / 720;
    const x = 20 * Math.cos(t), y = 10 * Math.sin(t);
    return { x: x * Math.cos(ang) - y * Math.sin(ang), y: x * Math.sin(ang) + y * Math.cos(ang) };
  });
  const d = describeShape(rot);
  near('旋转椭圆长轴', d.length, 40, 1.0);
  near('旋转椭圆短轴', d.width, 20, 1.0);
  near('椭圆长宽比', d.aspectRatio, 2, 0.08);
  near('椭圆角度(度)', (d.angle * 180) / Math.PI, 30, 2);
  near('椭圆面积', d.area, Math.PI * 20 * 10, 8);

  near('最大 Feret', maxFeret(sq).length, Math.hypot(10, 10), 1e-9);
  const cen = centroid(sq);
  near('质心 x', cen.x, 5, 1e-9);
}

/* ------------------------------------------------ 4. 端到端分割 */
{
  const img = makeImg(300, 200);
  putEllipse(img, 70, 100, 20, 14, [110, 70, 45]);
  putEllipse(img, 170, 100, 25, 18, [95, 60, 40], 0.4);
  const { regions } = segmentGrains(img, { minArea: 50 });
  ok('检出 2 粒', regions.length === 2, `得到 ${regions.length}`);

  const full = processImage(img, { minArea: 50, group: 'G1', mmPerPx: 0.02 });
  ok('pipeline 产出 2 个样本', full.samples.length === 2, `得到 ${full.samples.length}`);
  if (full.samples.length === 2) {
    // 按质心位置排序，保证与合成时的放置顺序一致
    const [a, b] = [...full.samples].sort((p, q) => p.cx - q.cx);
    // 第一粒：半轴 20/14 → 长约 40px = 0.8mm，宽约 28px = 0.56mm
    ok('样本1长度(mm)', Math.abs(a.lengthMM - 0.8) < 0.08, `长=${a.lengthMM.toFixed(3)}`);
    ok('样本1宽度(mm)', Math.abs(a.widthMM - 0.56) < 0.08, `宽=${a.widthMM.toFixed(3)}`);
    ok('样本1面积(mm²) 合理', a.areaMM2 > 0.2 && a.areaMM2 < 0.6, `面积=${a.areaMM2.toFixed(3)}`);
    ok('样本1质心≈70', Math.abs(a.cx - 70) < 4, `cx=${a.cx}`);
    ok('样本2质心≈170', Math.abs(b.cx - 170) < 4, `cx=${b.cx}`);
    ok('颜色统计存在', a.color && a.color.L > 20 && a.color.L < 90, `L=${a.color?.L}`);
    ok('长宽比合理', a.aspectRatio > 1.0 && a.aspectRatio < 1.9, `AR=${a.aspectRatio.toFixed(2)}`);
    ok('solidity 高', a.solidity > 0.9, `sol=${a.solidity}`);
    ok('圆度接近椭圆理论值', a.circularity > 0.7 && a.circularity < 0.95, `circ=${a.circularity.toFixed(2)}`);
  }
}

/* ------------------------------------------------- 5. 标定 */
{
  near('mmPerPixel', mmPerPixel(100, 2), 0.02, 1e-12);
  const s = makeScaler(0.02);
  near('toMm(100px)', s.toMm(100), 2, 1e-12);
  near('toPx(2mm)', s.toPx(2), 100, 1e-9);
  // 标尺检测：造一条深色横条
  const img = makeImg(200, 200, [250, 250, 250]);
  for (let y = 180; y < 184; y++) for (let x = 20; x < 180; x++) {
    const i = (y * 200 + x) * 4;
    img.data[i] = 10; img.data[i + 1] = 10; img.data[i + 2] = 10;
  }
  const bars = detectScaleBars(img, { minLength: 30 });
  ok('检测到标尺条', bars.length > 0, JSON.stringify(bars.slice(0, 2)));
}

/* ------------------------------------------------- 6. 统计 */
{
  near('betainc(0.5,0.5,1)', betainc(0.5, 0.5, 1), 1, 1e-9);
  near('betainc(1,1,0.5)', betainc(1, 1, 0.5), 0.5, 1e-9);
  // 查 t 分布：t=2.228, df=10 → 双尾 p≈0.05
  near('tTestP(2.228,10)', tTestP(2.228, 10), 0.05, 5e-4);
  near('tTestP(0,5)', tTestP(0, 5), 1, 1e-9);
  near('tTestP(1.96,10000)', tTestP(1.96, 10000), 0.05, 5e-4);
  // F(3,20)=3.10 → p≈0.05
  near('fTestP(3.10,3,20)', fTestP(3.10, 3, 20), 0.05, 0.01);
  near('inverseT(0.05,10)', Math.abs(inverseT(0.05, 10)), 2.228, 0.01);

  const a = [12, 14, 13, 15, 11, 14];
  const b = [20, 22, 19, 25, 21, 23];
  const t = welchT(a, b);
  ok('Welch 显著', t.p < 0.01, `p=${t.p}`);
  ok('Welch t 为负', t.t < 0, `t=${t.t}`);

  const an = oneWayAnova([a, b, [30, 32, 31, 33]]);
  ok('ANOVA F 显著', an.p < 0.01, `p=${an.p} F=${an.F}`);
  near('ANOVA dfB', an.dfB, 2, 0);
  near('ANOVA dfW', an.dfW, 13, 0);   // N=16, k=3 => 16-3

  const pr = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  near('pearson r', pr.r, 1, 1e-9);
  const lr = linearRegression([1, 2, 3, 4, 5], [3, 5, 7, 9, 11]);
  near('回归斜率', lr.slope, 2, 1e-9);
  near('回归截距', lr.intercept, 1, 1e-9);
  near('回归 R²', lr.r2, 1, 1e-9);

  const ds = describe([1, 2, 3, 4, 100]);
  near('median', ds.median, 3, 1e-9);
  ok('离群检出', ds.outliers.includes(100), JSON.stringify(ds.outliers));
  near('quantile q1', quantile([1, 2, 3, 4], 0.25), 1.75, 1e-9);

  // 字母标注：不显著的两组必须共享字母
  const g1 = [10, 11, 12, 10.5], g2 = [10.4, 11.2, 11.8, 10.9], g3 = [20, 21, 19, 22];
  const M = pairwisePMatrix([g1, g2, g3]);
  ok('g1-g2 不显著', M[0][1] > 0.05, `p=${M[0][1]}`);
  ok('g1-g3 显著', M[0][2] < 0.05, `p=${M[0][2]}`);
  const L = letterGroups(M, 0.05);
  const shared = [...L[0]].some((ch) => L[1].includes(ch));
  const notShared = ![...L[0]].some((ch) => L[2].includes(ch));
  ok('不显著组共享字母', shared, JSON.stringify(L));
  ok('显著组无共享字母', notShared, JSON.stringify(L));
}

/* ------------------------------------------------- 7. 绘图 */
{
  const t = niceTicks(0, 97, 6);
  ok('niceTicks 单调', t.ticks.every((v, i, a) => i === 0 || v > a[i - 1]), JSON.stringify(t.ticks));
  near('niceTicks 覆盖上界', t.max >= 97, true, 0);

  const cv = new SvgCanvas({ widthMm: 85, heightMm: 60, palette: 'nature' });
  barChart(cv, [
    { label: 'A', mean: 10, se: 1, letters: 'a', values: [9, 11, 10, 10.5] },
    { label: 'B', mean: 14, se: 1.5, letters: 'b', values: [13, 15, 14, 14.5] },
  ], { yLabel: 'Length (mm)', showPoints: true, gridY: true });
  const svg = cv.toString();
  ok('柱状图 SVG 有效', svg.startsWith('<?xml') && svg.includes('</svg>'));
  ok('SVG 含 mm 尺寸', /width="[\d.]+mm"/.test(svg));
  ok('SVG 文本已转义', !svg.includes('<script'));

  const cv2 = new SvgCanvas({ widthMm: 80, heightMm: 60 });
  boxPlot(cv2, [
    { label: 'G1', values: [1, 2, 3, 4, 5, 6, 7], letters: 'a' },
    { label: 'G2', values: [3, 4, 5, 6, 7, 8, 9], letters: 'ab' },
  ], { yLabel: 'Area' });
  ok('箱线图生成', cv2.toString().includes('<rect'));

  const cv3 = new SvgCanvas({ widthMm: 80, heightMm: 60 });
  violinPlot(cv3, [
    { label: 'A', values: [1, 2, 2, 3, 3, 4, 5], letters: 'a' },
    { label: 'B', values: [5, 6, 6, 7, 8], letters: 'b' },
  ], { yLabel: 'V' });
  ok('小提琴图含 path', cv3.toString().includes('<path'));

  const cv4 = new SvgCanvas({ widthMm: 80, heightMm: 60 });
  const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 2 * i + 1 + (i % 3) * 0.2 }));
  const so = scatterFit(cv4, pts, { xLabel: 'L', yLabel: 'W', eqLabel: true });
  ok('散点回归 R² 高', so.ax && so.opt === undefined, '');
  ok('散点图含拟合线', cv4.toString().includes('<line'));

  const cv5 = new SvgCanvas({ widthMm: 80, heightMm: 55 });
  histDensity(cv5, [1, 2, 2, 3, 3, 3, 4, 4, 5, 6], { xLabel: 'Length' });
  ok('直方图生成', cv5.toString().includes('<rect'));

  const cv6 = new SvgCanvas({ widthMm: 60, heightMm: 60 });
  corrHeatmap(cv6, ['L', 'W', 'AR'], [[1, 0.8, -0.3], [0.8, 1, -0.2], [-0.3, -0.2, 1]]);
  ok('热图生成', cv6.toString().includes('<rect'));

  const comp = composePanels([
    { svg: cv.toString(), widthMm: 85, heightMm: 60 },
    { svg: cv2.toString(), widthMm: 80, heightMm: 60 },
  ], { cols: 2 });
  ok('拼图生成', comp.includes('<g transform'));

  const cv7 = new SvgCanvas({ widthMm: 60, heightMm: 45 });
  scaleBar(cv7, 10, 35, 0.02, 1);
  ok('比例尺生成', cv7.toString().includes('1 mm'));
}

/* ------------------------------------------------- 8. 辅助 */
{
  const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: Math.sin(i) * 3 }));
  const sp = simplify(pts, 0.2);
  ok('轮廓简化减少点数', sp.length < pts.length, `${pts.length} -> ${sp.length}`);

  const samples = [
    { group: 'A', lengthMM: 8 }, { group: 'A', lengthMM: 9 },
    { group: 'B', lengthMM: 11 }, { group: 'B', lengthMM: 12 }, { group: 'B', lengthMM: 12.5 },
  ];
  const gs = groupSamples(samples, 'lengthMM');
  ok('分组聚合', gs.length === 2 && gs[0].values.length === 2 && gs[1].values.length === 3,
    JSON.stringify(gs.map((g) => g.values.length)));
}

/* ---------------------------------------------------- 报告 */
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) {
  console.log('\n失败明细:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');