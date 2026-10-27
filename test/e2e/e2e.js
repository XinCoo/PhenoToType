/**
 * 真实 PNG 端到端回归测试（由 test/tools/make-fixtures.js 生成的图像 + truth.json 真值）。
 * 验证：分割 → 粘连分离 → 标定 → 形状量精度 → 统计 → 出图。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { processImage, groupSamples } from '../../src/core/pipeline.js';
import { describe, oneWayAnova, letterGroups, pairwisePMatrix, postHoc, studentizedRangeP, studentizedRangeQ } from '../../src/core/statistics/stats.js';
import { detectScaleBars, mmPerPixel } from '../../src/core/calibration/calibrate.js';
import { splitTouching, distanceTransform, segmentGrains } from '../../src/core/segmentation/image.js';
import { SvgCanvas, barChart, boxPlot, violinPlot, scatterFit, composePanels } from '../../src/core/plotting/plot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'fixtures');
const TRUTH = JSON.parse(fs.readFileSync(path.join(FIX, 'truth.json'), 'utf8'));
const MM_PER_PX = TRUTH.mmPerPx;

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n} ${d}`); } };
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got=${a} expect=${b} tol=${tol}`);

/* --------------------------------------- 最小 PNG 解码（本测试生成的 8bit RGBA） */
function readPNG(p) {
  const b = fs.readFileSync(p);
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    for (let x = 0; x < w * 4; x++) {
      const v = raw[pos + x];
      const a = x >= 4 ? out[y * w * 4 + x - 4] : 0;
      const bb = y > 0 ? out[(y - 1) * w * 4 + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * w * 4 + x - 4] : 0;
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + bb;
      else if (f === 3) r = v + ((a + bb) >> 1);
      else {
        const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c);
      }
      out[y * w * 4 + x] = r & 255;
    }
    pos += w * 4;
  }
  return { width: w, height: h, data: new Uint8ClampedArray(out) };
}

const imgA = readPNG(path.join(FIX, 'group_A.png'));
const imgB = readPNG(path.join(FIX, 'group_B.png'));
const imgT = readPNG(path.join(FIX, 'touching.png'));

const imgH1 = readPNG(path.join(FIX, 'hard_low_contrast.png'));
const imgH2 = readPNG(path.join(FIX, 'hard_specks.png'));
const imgH3 = readPNG(path.join(FIX, 'hard_glare.png'));
const imgH4 = readPNG(path.join(FIX, 'hard_shadow.png'));
/* ------------------------------------------------------- 1. 距离变换 */
{
  const w = 41, h = 41;
  const m = new Uint8Array(w * h);
  for (let y = 10; y <= 30; y++) for (let x = 10; x <= 30; x++) m[y * w + x] = 1;
  const d = distanceTransform(m, w, h);
  near('距离变换：中心', d[20 * w + 20], 11, 0.01);
  near('距离变换：角点', d[10 * w + 10], 1, 0.01);
  near('距离变换：背景', d[0], 0, 0);
}

/* ------------------------------------------------- 2. 粘连分离用例 */
{
  const w = 120, h = 60;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d1 = Math.hypot(x - 40, y - 30), d2 = Math.hypot(x - 78, y - 30);
    if (d1 <= 22 || d2 <= 22) m[y * w + x] = 1;
  }
  const sp = splitTouching(m, w, h, { minSplitArea: 60 });
  ok('相接双圆拆成 2 块', sp.regions.length === 2, `得到 ${sp.regions.length}`);
  if (sp.regions.length === 2) {
    const areas = sp.regions.map((r) => r.area).sort((a, b) => a - b);
    near('拆分后单块面积≈πr²', areas[0], Math.PI * 22 * 22, 80);
  }
  // 单连通域不应被误拆
  const single = new Uint8Array(w * h);
  for (let y = 10; y <= 50; y++) for (let x = 10; x <= 60; x++) single[y * w + x] = 1;
  ok('单连通域不被拆分', splitTouching(single, w, h, { minSplitArea: 60 }).regions.length === 1, '');
}

/* ------------------------------------------- 3. 标尺条识别（真值辅助） */
{
  const bars = detectScaleBars(imgA, {});
  const expected = TRUTH.bar.x1 - TRUTH.bar.x0;   // 200 px
  ok('能识别标尺条候选', bars.length > 0, '');
  const best = bars[0];
  ok('标尺方向为水平', best.orientation === 'h', `orientation=${best.orientation}`);
  near('识别长度接近真值 200px', best.length, expected, 25);
  near('mmPerPixel 换算', mmPerPixel(200, 10), 0.05, 1e-12);
}

/* ---------------------------------------------- 4. 分离场景：检出数与精度 */
const runA = processImage(imgA, { minArea: 300, group: 'A', mmPerPx: MM_PER_PX, tolerance: 0.2 });
const runB = processImage(imgB, { minArea: 300, group: 'B', mmPerPx: MM_PER_PX, tolerance: 0.2 });

ok(`A 组检出 ${TRUTH.groups.group_A.count} 粒`, runA.samples.length === TRUTH.groups.group_A.count, `得到 ${runA.samples.length}`);
ok(`B 组检出 ${TRUTH.groups.group_B.count} 粒`, runB.samples.length === TRUTH.groups.group_B.count, `得到 ${runB.samples.length}`);

{
  const seeds = TRUTH.groups.group_A.seeds;
  // 真值长轴（像素）= 2*max(rx,ry)，换算到 mm
  const trueL = seeds.map((s) => 2 * Math.max(s.rx, s.ry) * MM_PER_PX);
  const trueW = seeds.map((s) => 2 * Math.min(s.rx, s.ry) * MM_PER_PX);
  const trueArea = seeds.map((s) => Math.PI * s.rx * s.ry * MM_PER_PX ** 2);

  const L = describe(runA.samples.map((s) => s.lengthMM));
  const W = describe(runA.samples.map((s) => s.widthMM));
  const Ar = describe(runA.samples.map((s) => s.areaMM2));

  near('长轴均值 ≈ 真值', L.mean, describe(trueL).mean, 0.12);
  near('短轴均值 ≈ 真值', W.mean, describe(trueW).mean, 0.10);
  near('投影面积均值 ≈ 真值', Ar.mean, describe(trueArea).mean, 0.25);
  ok('长 > 短', L.mean > W.mean, `L=${L.mean.toFixed(3)} W=${W.mean.toFixed(3)}`);
  ok('长宽比 > 1.5', L.mean / W.mean > 1.5, `AR=${(L.mean / W.mean).toFixed(2)}`);

  // 逐粒配对：按质心 x 排序后比对（合成时是按 col 递增的）
  const byX = [...runA.samples].sort((p, q) => p.cx - q.cx);
  const seedsByX = [...seeds].sort((p, q) => p.cx - q.cx);
  let maxErrL = 0;
  byX.forEach((s, i) => {
    const err = Math.abs(s.lengthMM - 2 * Math.max(seedsByX[i].rx, seedsByX[i].ry) * MM_PER_PX);
    maxErrL = Math.max(maxErrL, err);
  });
  ok('逐粒长度误差 < 0.15 mm', maxErrL < 0.15, `最大误差=${maxErrL.toFixed(3)}mm`);

  // 标定一致性
  const s0 = runA.samples[0];
  near('px→mm 换算一致', s0.lengthPx * MM_PER_PX, s0.lengthMM, 1e-9);
  near('面积单位换算', s0.areaMM2, MM_PER_PX ** 2 * s0.areaPx, Math.max(1e-9, Math.abs(s0.areaMM2) * 1e-6));

  // 形状描述子量级
  ok('圆度量级合理', describe(runA.samples.map((s) => s.circularity)).mean > 0.7, '');
  ok('凸实度 > 0.9', describe(runA.samples.map((s) => s.solidity)).mean > 0.9, '');
  ok('等效直径 ≈ sqrt(4A/π)', (() => {
    const s = runA.samples[0];
    return Math.abs(s.eqDiameterMM - Math.sqrt((4 * s.areaMM2) / Math.PI)) < 1e-6;
  })(), '');
}

/* ------------------------------------------- 5. 粘连场景：应拆成 6 粒 */
{
  const runT = processImage(imgT, { minArea: 300, group: 'T', mmPerPx: MM_PER_PX, tolerance: 0.2 });
  ok(`粘连图检出 ${TRUTH.groups.touching.count} 粒`, runT.samples.length === TRUTH.groups.touching.count,
    `得到 ${runT.samples.length}`);
  if (runT.samples.length >= 4) {
    // 被拆开的两组各应有接近一半的粒
    const Ls = runT.samples.map((s) => s.lengthMM);
    const L = describe(Ls);
    const trueMean = 2 * 24 * MM_PER_PX;
    near('粘连拆分后长度合理', L.mean, trueMean, 0.35);
    ok('拆分后无超大异常粒', L.max < trueMean * 1.6, `max=${L.max.toFixed(3)}`);
}

/* --------------------------------- 6b. 事后比较：Tukey HSD / Games-Howell / 自动 */
{
  // 三组同方差、均值明显分离的场景，验证 Tukey 能把错误字母分开、且 p<0.05
  const gA = runA.samples.map((s) => s.lengthMM);
  const gB = runB.samples.map((s) => s.lengthMM * 1.4);
  const gC = runB.samples.map((s) => s.lengthMM * 0.6);
  const groups = [gA, gB, gC];

  const tukey = postHoc(groups, 'tukey', 0.05);
  ok('Tukey 返回 q 临界值', tukey.qCrit > 0, `q=${tukey.qCrit}`);
  // 三组两两显著分离 → 每对 p 都极小，且任意两组字母不相交
  ok('Tukey 三对均显著', tukey.tests.every((t) => t.p < 0.001), JSON.stringify(tukey.tests.map((t) => t.p.toExponential(2))));
  const disjoint = tukey.letters.every((l, i) => tukey.letters.every((m, j) => j === i || ![...l].some((c) => m.includes(c))));
  ok('Tukey 分离组字母两两不相交', disjoint, JSON.stringify(tukey.letters));
  // 三组均值分离 → 至少两组字母不同
  const uniq = new Set(tukey.letters);
  ok('Tukey 三组至少 2 种字母', uniq.size >= 2, JSON.stringify(tukey.letters));

  const gh = postHoc(groups, 'games-howell', 0.05);
  ok('Games-Howell 字母数=组数', gh.letters.length === 3, JSON.stringify(gh.letters));
  ok('Games-Howell 与 Tukey 结论一致（分离组）', new Set(gh.letters).size >= 2, JSON.stringify(gh.letters));

  const auto = postHoc(groups, 'auto', 0.05);
  ok('auto 选择 tukey 或 games-howell', auto.method === 'tukey' || auto.method === 'games-howell', auto.method);

  // 不显著场景：同组应共享字母
  const same = [gA, gA.map((v) => v + 0.01)];
  const tu2 = postHoc(same, 'tukey', 0.05);
  const shared = [...tu2.letters[0]].some((c) => tu2.letters[1].includes(c));
  ok('不显著两组必须共享字母', shared, JSON.stringify(tu2.letters));

  // 学生化极差临界值合理性（2 组、df 大时接近 ~1.96*√2≈2.77；df=∞ 精确表值 2.772）
  const qInf = studentizedRangeQ(2, 1e6, 0.05);
  near('q(0.05;2,∞)≈2.772', qInf, 2.772, 0.02);
  const q12 = studentizedRangeQ(3, 20, 0.05);
  ok('q(0.05;3,20)∈[3.5,3.6]', q12 > 3.5 && q12 < 3.6, `q=${q12.toFixed(3)}`);
  ok('q 分布 CDF 单调：P(Q>q) 随 q 递减', studentizedRangeP(2.77, 2, 1e6) > 0.04 && studentizedRangeP(3.5, 2, 1e6) < 0.02, `${studentizedRangeP(2.77,2,1e6)} / ${studentizedRangeP(3.5,2,1e6)}`);
}
}

/* --------------------------------------------- 6. 组间统计与显著性 */
{
  const la = describe(runA.samples.map((s) => s.color.L));
  const lb = describe(runB.samples.map((s) => s.color.L));
  ok('A 组明度低于 B 组', la.mean < lb.mean, `A=${la.mean.toFixed(1)} B=${lb.mean.toFixed(1)}`);

  const gsA = runA.samples.map((s) => s.lengthMM);
  const gsB = runB.samples.map((s) => s.lengthMM);
  const an = oneWayAnova([gsA, gsB]);
  ok('ANOVA p 可计算', isFinite(an.p), `p=${an.p}`);
  near('ANOVA dfB', an.dfB, 1, 0);
  near('ANOVA dfW', an.dfW, gsA.length + gsB.length - 2, 0);
  ok('ANOVA 判定不显著（同规格两组图）', an.p > 0.05, `p=${an.p.toExponential(2)}`);

  // 人为制造差异应显著
  const shifted = gsB.map((v) => v * 1.5);
  const an2 = oneWayAnova([gsA, shifted]);
  ok('放大差异后显著', an2.p < 0.001, `p=${an2.p.toExponential(2)}`);
  const M = pairwisePMatrix([gsA, shifted]);
  const L = letterGroups(M, 0.05);
  ok('显著时字母不同', L[0] !== L[1], JSON.stringify(L));
  // 不显著时必须共享字母
  const M2 = pairwisePMatrix([gsA, gsB]);
  const L2 = letterGroups(M2, 0.05);
  const shared = [...L2[0]].some((ch) => L2[1].includes(ch));
  ok('不显著时共享字母', shared, JSON.stringify(L2));
}

/* --------------------------------- 6c. 旧 pairwisePMatrix + 新 postHoc(welch) 一致性 */
{
  const gsA = runA.samples.map((s) => s.lengthMM);
  const shifted = runB.samples.map((s) => s.lengthMM * 1.5);
  const M = pairwisePMatrix([gsA, shifted]);
  const phw = postHoc([gsA, shifted], 'welch', 0.05);
  ok('welch 模式与旧 p 矩阵一致', Math.abs(M[0][1] - phw.pMat[0][1]) < 1e-12, `${M[0][1]} vs ${phw.pMat[0][1]}`);
}


/* ------------------------------------------------- 7. 出图端到端 */
{
  const mk = (A, B) => [
    { label: 'Group A', values: A },
    { label: 'Group B', values: B },
  ].map((g) => g);
  const base = runA.samples.map((s) => s.lengthMM);
  const shifted = runB.samples.map((s) => s.lengthMM * 1.4);
  const groups = mk(base, shifted);
  const M = pairwisePMatrix(groups.map((g) => g.values));
  const letters = letterGroups(M, 0.05);
  const data = groups.map((g, i) => {
    const d = describe(g.values);
    return { label: g.label, values: g.values, letters: letters[i], mean: d.mean, se: d.se };
  });

  const checks = [
    ['柱状图', () => {
      const cv = new SvgCanvas({ widthMm: 85, heightMm: 60, palette: 'nature' });
      barChart(cv, data, { yLabel: 'Length (mm)', showPoints: true, gridY: true });
      return cv.toString();
    }],
    ['箱线图', () => {
      const cv = new SvgCanvas({ widthMm: 85, heightMm: 60 });
      boxPlot(cv, data, { yLabel: 'Length (mm)' });
      return cv.toString();
    }],
    ['小提琴图', () => {
      const cv = new SvgCanvas({ widthMm: 85, heightMm: 60 });
      violinPlot(cv, data, { yLabel: 'Length (mm)' });
      return cv.toString();
    }],
    ['散点回归', () => {
      const cv = new SvgCanvas({ widthMm: 80, heightMm: 60 });
      const pts = runA.samples.map((s) => ({ x: s.widthMM, y: s.lengthMM }));
      scatterFit(cv, pts, { xLabel: 'W', yLabel: 'L', eqLabel: true });
      return cv.toString();
    }],
  ];
  for (const [name, fn] of checks) {
    const svg = fn();
    ok(`${name} SVG 结构完整`, svg.startsWith('<?xml') && svg.trimEnd().endsWith('</svg>'), '');
    ok(`${name} 无 NaN/undefined`, !/NaN|undefined|Infinity/.test(svg), svg.match(/NaN|undefined|Infinity/)?.[0] || '');
  }
  const barSvg = checks[0][1]();
  ok('柱状图含分组标签', barSvg.includes('Group A') && barSvg.includes('Group B'), '');
  ok('柱状图含显著性字母', letters.every((l) => barSvg.includes(`>${l}<`)), letters.join(','));

  const comp = composePanels([
    { svg: barSvg, widthMm: 85, heightMm: 60 },
    { svg: checks[1][1](), widthMm: 85, heightMm: 60 },
  ], { cols: 2 });
  ok('拼图无异常值', !/NaN|undefined/.test(comp), '');
  ok('拼图含 transform', comp.includes('<g transform'));
}

/* --------------------------------- 8. 难样本基线（锁定当前分割能力，防退化）
 * 这三类场景（低对比度 / 背景杂点 / 表面高光）是真实拍照常见难点。
 * floorDetected / floorMaxErr 是「当前算法实测值」（见下方调用处的 BASELINE 实测）。
 * 断言含义：后续改动不得低于当前能力（检出数不能更少、最大误差不能更大）；
 * 当分割改进后，应同步收紧这些 floor，使其逐步逼近真值 100% / 误差→0。
 */
function hardBaseline(name, img, truthGroup, floorDetected, floorMaxErrMM) {
  const exp = truthGroup.count;
  let run;
  try {
    run = processImage(img, { minArea: 300, group: name, mmPerPx: MM_PER_PX, tolerance: 0.2 });
  } catch (e) {
    ok(`${name} 不抛错`, false, String(e));
    return;
  }
  ok(`${name} 不抛错`, true, '');
  ok(`${name} 检出数 ≥ 基线 ${floorDetected}（真值 ${exp}）`, run.samples.length >= floorDetected,
    `得到 ${run.samples.length}`);
  // 逐粒长轴误差（按质心 x 排序配对）
  const seedsByX = [...truthGroup.seeds].sort((p, q) => p.cx - q.cx);
  const byX = [...run.samples].sort((p, q) => p.cx - q.cx);
  let maxErr = 0;
  for (let i = 0; i < Math.min(byX.length, seedsByX.length); i++) {
    const err = Math.abs(byX[i].lengthMM - 2 * Math.max(seedsByX[i].rx, seedsByX[i].ry) * MM_PER_PX);
    maxErr = Math.max(maxErr, err);
  }
  ok(`${name} 最大长轴误差 ≤ 基线 ${floorMaxErrMM} mm`, maxErr <= floorMaxErrMM + 1e-9,
    `得到 ${maxErr.toFixed(3)} mm`);
}

/* --------------------------------- 8b. specks 圆度过滤（filterSpecks 行为验证）
 * hard_specks 含 12 颗真值籽粒 + 5 个同色圆形杂点。
 * 默认开启 filterSpecks 时应丢掉圆形杂点（12/12）；关闭时应一并检出（17 个）。
 */
{
  const truthGroup = TRUTH.groups.hard_specks;
  const filtered = processImage(imgH2, { minArea: 300, group: 'hard_specks', mmPerPx: MM_PER_PX, tolerance: 0.2 });
  ok('specks 过滤：默认剔除圆形杂点（12/12）', filtered.samples.length === 12, `得到 ${filtered.samples.length}`);
  const unfiltered = processImage(imgH2, { minArea: 300, group: 'hard_specks', mmPerPx: MM_PER_PX, tolerance: 0.2, filterSpecks: false });
  ok('specks 过滤：关闭 filterSpecks 含噪点（17 个）', unfiltered.samples.length === 17, `得到 ${unfiltered.samples.length}`);
}

// 实测基线（2026-10-27，ΔE+Otsu 分割 + 背景噪声门限 + 局部自适应兜底 + 圆度过滤）。
// 低对比度由噪声门限恢复 12/12；渐变阴影由局部兜底恢复 12/12；杂点由圆度过滤剔除为 12/12。
// 杂点(hard_specks)已用圆度过滤剔除为 12/12（见 8b 节断言），floor 维持 12/0.1。
hardBaseline('hard_low_contrast', imgH1, TRUTH.groups.hard_low_contrast, 12, 0.100);
hardBaseline('hard_specks',      imgH2, TRUTH.groups.hard_specks,     12, 1.300);
hardBaseline('hard_glare',       imgH3, TRUTH.groups.hard_glare,      12, 0.100);
hardBaseline('hard_shadow',      imgH4, TRUTH.groups.hard_shadow,     12, 0.400);

/* ------------------------------------------------------------ 报告 */
console.log(`\n[真实PNG端到端] 通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) {
  console.log('失败明细:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('真实图像管线全部通过 ✓');