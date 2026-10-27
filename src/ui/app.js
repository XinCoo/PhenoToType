/**
 * app.js — UI 主控制器
 */
import { processImage, groupSamples, colorStats } from '../core/pipeline.js';
import { segmentGrains, regionMask } from '../core/segmentation/image.js';
import { detectScaleBars, mmPerPixel, makeScaler } from '../core/calibration/calibrate.js';
import {
  describe, oneWayAnova, pairwisePMatrix, letterGroups, welchT, pStars,
  pearson, linearRegression, fmtNum, postHoc, meanCI95,
} from '../core/statistics/stats.js';
import {
  SvgCanvas, barChart, boxPlot, violinPlot, scatterFit, histDensity,
  corrHeatmap, composePanels, scaleBar as drawScaleBarSvg, niceTicks, esc,
} from '../core/plotting/plot.js';
import {
  state, nextId, activeBatch, collectSamples, rebuildSamples,
  serializeProject, loadProject, toCSV,
} from './state.js';
import { drawImageView } from './viewer.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------------------------------------------------- 工具 */
let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function getMetric(s, path) {
  if (path.includes('.')) return path.split('.').reduce((o, k) => (o ? o[k] : undefined), s);
  return s[path];
}

function metricLabel(path) {
  return {
    lengthMM: 'Length (mm)', widthMM: 'Width (mm)', lengthPx: 'Length (px)',
    widthPx: 'Width (px)', feretMM: 'Feret diameter (mm)', areaMM2: 'Projected area (mm²)',
    eqDiameterMM: 'Equivalent diameter (mm)', thicknessMM: 'Thickness (mm)',
    volumeMM3: 'Volume (mm³)', aspectRatio: 'Aspect ratio', circularity: 'Circularity',
    solidity: 'Solidity', roundness: 'Roundness',
    feretPx: 'Feret diameter (px)', areaPx: 'Projected area (px²)',
    eqDiameterPx: 'Equivalent diameter (px)', thicknessPx: 'Thickness (px)', 'color.L': 'Lightness L*',
    'color.chroma': 'Chroma C*', 'color.hue': 'Hue H*', 'color.sat': 'Saturation',
  }[path] || path;
}

const METRIC_PATHS = [
  'lengthMM', 'widthMM', 'feretMM', 'areaMM2', 'eqDiameterMM', 'thicknessMM',
  'volumeMM3', 'aspectRatio', 'circularity', 'solidity', 'roundness',
  'lengthPx', 'widthPx', 'feretPx', 'areaPx', 'eqDiameterPx', 'thicknessPx',
  'color.L', 'color.chroma', 'color.hue', 'color.sat',
];

/* ------------------------------------------------------- 图像导入 */
async function openImages() {
  const files = await window.api.openImages();
  if (!files.length) return;
  for (const f of files) await loadImageFile(f);
  renderBatches();
  if (state.batches.length) {
    state.activeBatchId = state.batches[state.batches.length - 1].id;
    reanalyzeAll();
  }
  toast(`已导入 ${files.length} 张图像`, 'success');
}

function loadImageFile(f, group) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, c.width, c.height);
      const id = nextId();
      const defaultName = f.name.replace(/\.[^.]+$/, '');
      state.batches.push({
        id, name: defaultName, path: f.path, url: f.url,
        image: img, imageData, samples: [], mask: null,
        // 优先用调用方指定的分组；否则退回输入框当前值；再否则用文件名
        group: group ?? ($('#batch-group').value?.trim() || defaultName),
        calib: null,
      });
      resolve();
    };
    img.onerror = () => reject(new Error(`无法加载 ${f.name}`));
    img.src = f.url;
  });
}

/* -------------------------------------------------- 批次重新分析 */
/** 分析单个批次（不做 UI 刷新） */
function analyzeBatch(b) {
  if (!b?.imageData) return 0;
  const t0 = performance.now();
  let mmPerPx = null;
  if (state.calib.mode === 'manual' && state.calib.mmPerPx) mmPerPx = state.calib.mmPerPx;
  if (b.calib?.mmPerPx) mmPerPx = b.calib.mmPerPx;

  const segOpts = {
    minArea: state.settings.minArea,
    erode: state.settings.denoise,
    dilate: state.settings.denoise,
  };
  if (state.settings.thrOffset !== 0) segOpts.thresholdShift = state.settings.thrOffset;
  const seg = segmentGrains(b.imageData, segOpts);
  b.mask = seg.mask;

  const { samples } = processImage(b.imageData, {
    ...segOpts,
    group: b.group,
    mmPerPx,
  });
  // 补上颜色别名字段（CSV 用）
  samples.forEach((s, i) => {
    s.index = i + 1;
    s.colorL = s.color?.L; s.colora = s.color?.a; s.colorb = s.color?.b;
    s.colorChroma = s.color?.chroma; s.colorHue = s.color?.hue; s.colorSat = s.color?.sat;
  });
  b.samples = samples;
  b.lastMs = Math.round(performance.now() - t0);
  b.lastMmPerPx = mmPerPx;
  b.lastSize = `${imgW(b)}×${imgH(b)}`;
  return samples.length;
}

/** 重跑所有批次（标定/分割参数变化时必须全部重来，否则不同批次单位不一致） */
function reanalyzeAll() {
  for (const b of state.batches) analyzeBatch(b);
  const b = activeBatch();
  if (b) {
    $('#img-status').textContent =
      `${b.name} · ${b.lastSize}px · 检出 ${b.samples.length} 粒 · ${b.lastMs}ms · ` +
      `${b.lastMmPerPx ? (1 / b.lastMmPerPx).toFixed(1) + ' px/mm' : '像素单位'}` +
      (state.batches.length > 1 ? `（共 ${state.batches.length} 批次）` : '');
  }
  rebuildSamples();
  renderBatches(); renderTable(); renderStats(); refreshAxisOptions();
  drawCurrent();
}

function reanalyzeActive() {
  const b = activeBatch();
  if (!b?.imageData) { rebuildSamples(); renderStats(); return; }
  analyzeBatch(b);
  $('#img-status').textContent =
    `${b.name} · ${b.lastSize}px · 检出 ${b.samples.length} 粒 · ${b.lastMs}ms · ` +
    `${b.lastMmPerPx ? (1 / b.lastMmPerPx).toFixed(1) + ' px/mm' : '像素单位'}`;
  rebuildSamples();
  renderBatches(); renderTable(); renderStats(); refreshAxisOptions();
  drawCurrent();
}
const imgW = (b) => b.imageData?.width ?? 0;
const imgH = (b) => b.imageData?.height ?? 0;

function drawCurrent() {
  const b = activeBatch();
  $('#drop-hint').classList.toggle('hidden', !!b);
  if (!b) return;
  drawImageView($('#view-canvas'), b, {
    showMask: $('#show-mask').checked,
    showContour: $('#show-contour').checked,
    showIndex: $('#show-index').checked,
    showScale: $('#show-scale').checked,
  });
}

/* -------------------------------------------------------- 批次列表 */
function renderBatches() {
  const el = $('#batch-list');
  if (!state.batches.length) {
    el.innerHTML = '<p class="empty-hint">尚未导入图像。点击「打开图像」批量导入单粒散落照。</p>';
    return;
  }
  el.innerHTML = state.batches.map((b) => `
    <div class="batch-item ${b.id === state.activeBatchId ? 'active' : ''}" data-id="${b.id}">
      <span class="bi-remove" data-rm="${b.id}" title="移除">×</span>
      <div class="bi-name">${esc(b.name)}</div>
      <div class="bi-meta">${b.samples.length} 粒 · ${imgW(b)}×${imgH(b)}px</div>
    </div>`).join('');
  el.querySelectorAll('.batch-item').forEach((it) => {
    it.addEventListener('click', (e) => {
      if (e.target.dataset.rm) return;
      state.activeBatchId = it.dataset.id;
      renderBatches(); drawCurrent();
      const b = activeBatch();
      if (b) {
        $('#img-status').textContent = `${b.name} · ${imgW(b)}×${imgH(b)}px · 检出 ${b.samples.length} 粒`;
        $('#batch-group').value = b.group || '';
      }
    });
  });
  el.querySelectorAll('[data-rm]').forEach((x) => {
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = x.dataset.rm;
      state.batches = state.batches.filter((b) => b.id !== id);
      if (state.activeBatchId === id) state.activeBatchId = state.batches[0]?.id || null;
      rebuildSamples(); renderBatches(); renderTable(); renderStats(); refreshAxisOptions(); drawCurrent();
    });
  });
}

/* -------------------------------------------------------- 数据表格 */
function renderTable() {
  const q = $('#table-search').value.trim().toLowerCase();
  const cols = [
    ['分组', 'group', (s) => s.group, 'lbl'],
    ['图像', 'imageName', (s) => s.imageName, 'lbl'],
    ['#', 'index', (s) => s.index],
    ['L(mm)', 'lengthMM', (s) => f(s.lengthMM)],
    ['W(mm)', 'widthMM', (s) => f(s.widthMM)],
    ['Area(mm²)', 'areaMM2', (s) => f(s.areaMM2)],
    ['L/W', 'aspectRatio', (s) => f(s.aspectRatio)],
    ['Circ.', 'circularity', (s) => f(s.circularity)],
    ['Solid.', 'solidity', (s) => f(s.solidity)],
    ['Thick(mm)', 'thicknessMM', (s) => f(s.thicknessMM)],
    ['L*', 'colorL', (s) => f(s.colorL)],
    ['C*', 'colorChroma', (s) => f(s.colorChroma)],
    ['H*', 'colorHue', (s) => f(s.colorHue)],
  ];
  const rows = state.samples.filter((s) =>
    !q || s.group.toLowerCase().includes(q) || (s.imageName || '').toLowerCase().includes(q));
  const f = (v) => (v === undefined || v === null || !isFinite(v) ? '—' : Number(v.toFixed(3)));

  $('#data-table thead').innerHTML = '<tr>' +
    cols.map((c) => `<th>${c[0]}</th>`).join('') + '</tr>';
  $('#data-table tbody').innerHTML = rows.map((s) =>
    '<tr>' + cols.map((c) => `<td class="${c[3] || ''}">${c[2](s)}</td>`).join('') + '</tr>'
  ).join('') || '<tr><td colspan="13" style="text-align:center;color:var(--text-faint)">无数据</td></tr>';
  $('#table-status').textContent = `${rows.length} / ${state.samples.length} 粒`;
}
const f = (v) => (v === undefined || v === null || !isFinite(v) ? '—' : Number(v.toFixed(3)));

/* ---------------------------------------------------------- 统计 */
function renderStats() {
  const metric = $('#stat-metric').value;
  const groups = groupSamples(state.samples, metric).filter((g) => g.values.length >= 2);
  const dt = $('#desc-table');
  const at = $('#anova-table');

  if (groups.length === 0) {
    dt.querySelector('thead').innerHTML = '';
    dt.querySelector('tbody').innerHTML = `<tr><td class="lbl">${state.samples.length < 2 ? '样本不足，请先导入并标定图像' : '所选指标无有效数据（是否未做尺度标定？）'}</td></tr>`;
    at.querySelector('thead').innerHTML = '';
    at.querySelector('tbody').innerHTML = '';
    state.stats = null;
    return;
  }

  const stats = groups.map((g) => ({ label: g.label, ...describe(g.values), values: g.values }));
  const anova = oneWayAnova(groups.map((g) => g.values));
  const ph = postHoc(groups.map((g) => g.values), state.settings.postHoc || 'tukey', state.settings.alpha);
  const pMat = ph.pMat;
  const letters = ph.letters;

  dt.querySelector('thead').innerHTML =
    '<tr><th>分组</th><th>n</th><th>均值</th><th>SD</th><th>SE</th><th>CV%</th><th>最小</th><th>最大</th><th>中位</th><th>字母</th></tr>';
  dt.querySelector('tbody').innerHTML = stats.map((s, i) => `
    <tr><td class="lbl">${esc(s.label)}</td><td>${s.n}</td><td>${fmtNum(s.mean, 3)}</td>
    <td>${fmtNum(s.sd, 3)}</td><td>${fmtNum(s.se, 3)}</td><td>${fmtNum(s.cv, 1)}</td>
    <td>${fmtNum(s.min, 2)}</td><td>${fmtNum(s.max, 2)}</td><td>${fmtNum(s.median, 3)}</td>
    <td style="text-align:center;font-weight:600">${letters[i] || ''}</td></tr>`).join('');

  let html = `<tr><td colspan="4" style="background:var(--bg-elev);color:var(--text-dim)">
    单因素 ANOVA：F(${anova.dfB}, ${anova.dfW}) = ${fmtNum(anova.F, 3)},
    p = ${anova.p < 0.001 ? '<0.001' : fmtNum(anova.p, 4)},
    ${anova.p < state.settings.alpha ? '组间差异显著' : '组间差异不显著'}
    （${pStars(anova.p)}）</td></tr>`;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const p = pMat[i][j];
      const sig = p < state.settings.alpha;
      html += `<tr><td class="lbl">${esc(groups[i].label)} vs ${esc(groups[j].label)}</td>
        <td class="p-val ${sig ? 'p-sig' : 'p-ns'}">${p < 0.001 ? '<0.001' : fmtNum(p, 4)}</td>
        <td class="${sig ? 'p-sig' : 'p-ns'}">${pStars(p)}</td></tr>`;
  }
  const phName = { tukey: 'Tukey HSD', 'games-howell': 'Games-Howell', welch: 'Welch t', auto: 'Tukey/Games-Howell(自动)' }[ph.method] || ph.method;
  const autoNote = ph.bartlett ? `（方差齐性 Bartlett p=${ph.bartlett.p < 0.001 ? '<0.001' : fmtNum(ph.bartlett.p, 3)}，采用 ${phName}）` : `（${phName}，p < ${state.settings.alpha}）`;
  html += `<tr><td colspan="4" style="background:var(--bg-elev);color:var(--text-dim)">两两事后比较：${autoNote}${ph.qCrit ? `；q(0.05, ${groups.length}, ${anova.dfW})=${fmtNum(ph.qCrit, 2)}` : ''}</td></tr>`;
    }
  at.querySelector('thead').innerHTML = '<tr><th>比较</th><th>t</th><th>p</th><th>显著性</th></tr>';
  at.querySelector('tbody').innerHTML = html;

  state.stats = { metric, groups, stats, anova, pMat, letters };
}

/* ---------------------------------------------------------- 图表 */
function refreshAxisOptions() {
  // 只提供当前数据里实际存在的指标，避免选到空列
  const available = METRIC_PATHS.filter((m) =>
    state.samples.some((s) => isFinite(getMetric(s, m))));
  for (const sel of ['#fig-x', '#fig-y']) {
    const el = $(sel);
    const cur = el.value;
    el.innerHTML = available.map((m) => `<option value="${m}">${metricLabel(m)}</option>`).join('');
    if (cur && available.includes(cur)) el.value = cur;
  }
  const sm = $('#stat-metric');
  const curStat = sm.value;
  sm.innerHTML = (available.length ? available : ['lengthPx'])
    .map((m) => `<option value="${m}">${metricLabel(m)}</option>`).join('');
  if (curStat && available.includes(curStat)) sm.value = curStat;

  if (!$('#fig-y').value && available.length) {
    $('#fig-y').value = available.includes('areaMM2') ? 'areaMM2' : available[0];
  }
  if (!$('#fig-x').value && available.length) {
    $('#fig-x').value = available.includes('lengthMM') ? 'lengthMM' : available[0];
  }
}

function figureTheme() {
  return { fontSize: state.settings.fontSize };
}

function buildFigure() {
  const type = $('#fig-type').value;
  const groups = groupSamples(state.samples, $('#fig-y').value).filter((g) => g.values.length);
  const alpha = state.settings.alpha;
  const theme = figureTheme();
  const cfg = {
    widthMm: state.settings.widthMm, heightMm: state.settings.heightMm,
    palette: state.settings.palette, theme,
  };
  let cv = new SvgCanvas(cfg);
  let caption = '';
  const yLabel = metricLabel($('#fig-y').value);
  const xLabel = $('#fig-type').value === 'scatter' ? metricLabel($('#fig-x').value) : '';
  const showPts = $('#fig-points').checked;
  const grid = $('#fig-grid').checked;

  if (groups.length < 1 || state.samples.length < 2) {
    return { cv, caption: '样本不足，无法生成图表。请先导入图像。', empty: true };
  }

  if (type === 'bar' || type === 'box' || type === 'violin') {
    const ph = postHoc(groups.map((g) => g.values), state.settings.postHoc || 'tukey', alpha);
    const pMat = ph.pMat;
    const letters = ph.letters;
    const data = groups.map((g, i) => {
      const d = describe(g.values);
      const ci = meanCI95(g.values);
      const useCI = state.settings.errType === 'ci';
      return {
        label: g.label, values: g.values, letters: letters[i],
        mean: d.mean,
        se: useCI ? ci.half : (state.settings.errType === 'sd' ? d.sd : d.se),
        sd: d.sd,
        ciLo: ci.lo, ciHi: ci.hi,
      };
    });
    const errName = state.settings.errType === 'ci' ? '95% 置信区间' : (state.settings.errType === 'sd' ? 'SD' : 'SE');
    if (type === 'bar') {
      barChart(cv, data, { yLabel, showPoints: showPts, gridY: grid });
      caption = `图：各组${yLabel}的均值 ± ${errName}（n = ${groups.map((g) => g.values.length).join(', ')}）。`
      + `误差棒表示${errName}；柱上不同字母表示组间差异显著（${ph.method === 'games-howell' ? 'Games-Howell' : ph.method === 'welch' ? 'Welch t' : 'Tukey HSD'}，p < ${alpha}）。`;
    } else if (type === 'box') {
      boxPlot(cv, data, { yLabel, showPoints: showPts, gridY: grid });
      caption = `图：各组${yLabel}的分布。箱体表示四分位距，中线为中位数，空心散点为单个样本。`
      + `不同字母表示组间差异显著（${ph.method === 'games-howell' ? 'Games-Howell' : ph.method === 'welch' ? 'Welch t' : 'Tukey HSD'}，p < ${alpha}）。`;
    } else {
      violinPlot(cv, data, { yLabel });
      caption = `图：各组${yLabel}的核密度分布（小提琴宽度表示该取值区间的相对频率）。`
      + `不同字母表示组间差异显著（${ph.method === 'games-howell' ? 'Games-Howell' : ph.method === 'welch' ? 'Welch t' : 'Tukey HSD'}，p < ${alpha}）。`;
    }
  } else if (type === 'scatter') {
    const pts = state.samples
      .map((s) => ({ x: getMetric(s, $('#fig-x').value), y: getMetric(s, $('#fig-y').value) }))
      .filter((p) => isFinite(p.x) && isFinite(p.y));
    if (pts.length < 3) return { cv, caption: '散点拟合需 ≥3 个有效样本点。', empty: true };
    scatterFit(cv, pts, { xLabel, yLabel, eqLabel: true });
    const lr = linearRegression(pts.map((p) => p.x), pts.map((p) => p.y));
    const pr = pearson(pts.map((p) => p.x), pts.map((p) => p.y));
    caption = `图：${metricLabel($('#fig-x').value)}与${yLabel}的相关性。`
      + `回归方程：${lr.equation}；R² = ${fmtNum(lr.r2, 3)}；Pearson r = ${fmtNum(pr.r, 3)}，p = ${pr.p < 0.001 ? '<0.001' : fmtNum(pr.p, 4)}（n = ${pts.length}）。`;
  } else if (type === 'hist') {
    const vals = state.samples.map((s) => getMetric(s, $('#fig-x').value)).filter(isFinite);
    if (vals.length < 5) return { cv, caption: '直方图需 ≥5 个有效样本。', empty: true };
    histDensity(cv, vals, { xLabel: metricLabel($('#fig-x').value), gridY: true });
    const d = describe(vals);
    caption = `图：${metricLabel($('#fig-x').value)}的频数分布与核密度估计。`
      + `均值 = ${fmtNum(d.mean, 3)}，SD = ${fmtNum(d.sd, 3)}，CV = ${fmtNum(d.cv, 1)}%（n = ${d.n}）。`;
  } else if (type === 'corr') {
    const paths = ['lengthMM', 'widthMM', 'areaMM2', 'aspectRatio', 'circularity', 'thicknessMM', 'color.L', 'color.chroma'];
    const valid = paths.filter((p) => state.samples.some((s) => isFinite(getMetric(s, p))));
    const labels = valid.map((p) => metricLabel(p).replace(/\s*\(.*\)/, ''));
    const R = valid.map((a) => valid.map((b) => {
      const xs = state.samples.map((s) => getMetric(s, a)).filter(isFinite);
      const ys = state.samples.map((s) => getMetric(s, b)).filter(isFinite);
      const m = Math.min(xs.length, ys.length);
      return pearson(xs.slice(0, m), ys.slice(0, m)).r;
    }));
    cv = new SvgCanvas({ widthMm: 70, heightMm: 70, palette: state.settings.palette, theme });
    corrHeatmap(cv, labels, R);
    caption = `图：籽粒性状间的 Pearson 相关系数矩阵。颜色深浅表示相关强度（蓝：正相关；红：负相关），数值为相关系数 r（n = ${state.samples.length}）。`;
  } else if (type === 'composite') {
    const ph = postHoc(groups.map((g) => g.values), state.settings.postHoc || 'tukey', alpha);
    const pMat = ph.pMat;
    const letters = ph.letters;
    const barData = groups.map((g, i) => {
      const d = describe(g.values);
      return { label: g.label, mean: d.mean, se: state.settings.errType === 'sd' ? d.sd : d.se, letters: letters[i], values: g.values };
    });
    const boxData = groups.map((g, i) => ({ label: g.label, values: g.values, letters: letters[i] }));
    const vals = state.samples.map((s) => getMetric(s, $('#fig-x').value)).filter(isFinite);
    const cvA = new SvgCanvas(cfg); barChart(cvA, barData, { yLabel, showPoints: false, gridY: true });
    const cvB = new SvgCanvas(cfg); boxPlot(cvB, boxData, { yLabel: 'Distribution', showPoints: true, gridY: true });
    let panels = [
      { svg: cvA.toString(), widthMm: cfg.widthMm, heightMm: cfg.heightMm },
      { svg: cvB.toString(), widthMm: cfg.widthMm, heightMm: cfg.heightMm },
    ];
    if (vals.length >= 5) {
      const cvC = new SvgCanvas({ widthMm: cfg.widthMm, heightMm: cfg.heightMm * 0.62, palette: state.settings.palette, theme });
      histDensity(cvC, vals, { xLabel: metricLabel($('#fig-x').value), gridY: true });
      panels.push({ svg: cvC.toString(), widthMm: cfg.widthMm, heightMm: cfg.heightMm * 0.62 });
    }
    cv = new SvgCanvas({ widthMm: cfg.widthMm, heightMm: cfg.heightMm * (panels.length === 3 ? 2.35 : 1.7), palette: state.settings.palette, theme });
    const merged = composePanels(panels, { cols: 1, gapMm: 2 });
    cv.parts = [merged.replace(/<\?xml[^>]*\?>\s*<svg[^>]*>/, '').replace(/<\/svg>$/, '')];
    caption = `图：${yLabel}的多面板表征。(a) 均值 ± ${state.settings.errType === 'sd' ? 'SD' : 'SE'}；`
      + `(b) 箱线图叠加单个样本；(c) 频数分布与核密度。不同字母表示组间差异显著（${ph.method === 'games-howell' ? 'Games-Howell' : ph.method === 'welch' ? 'Welch t' : 'Tukey HSD'}，p < ${alpha}）。`;
  } else if (type === 'contours') {
    const items = state.batches.map((b) => ({ label: b.name, samples: b.samples })).filter((b) => b.samples.length);
    if (!items.length) return { cv, caption: '无轮廓数据。', empty: true };
    const cols = Math.min(items.length, Math.ceil(Math.sqrt(items.length)));
    const cellW = 26, cellH = 22;
    cv = new SvgCanvas({ widthMm: cols * cellW, heightMm: Math.ceil(items.length / cols) * cellH + 8, palette: state.settings.palette, theme });
    items.forEach((b, bi) => {
      const cx0 = (bi % cols) * cellW + 2;
      const cy0 = Math.floor(bi / cols) * cellH + 10;
      cv.text(cx0 + cellW / 2 - 2, cy0 - 3, b.label.length > 14 ? b.label.slice(0, 13) + '…' : b.label,
        { anchor: 'middle', fontSize: 6 });
      const first = b.samples[0];
      const scale = first ? Math.min((cellW - 8) / (first.feretPx || 1), (cellH - 6) / (first.feretPx || 1)) : 1;
      b.samples.forEach((s) => {
        if (!s.contour) return;
        const bx = first ? first.cx : 0, by = first ? first.cy : 0;
        const d = 'M' + s.contour.map((p) => `${(cx0 + (p.x - bx) * scale).toFixed(2)},${(cy0 + (p.y - by) * scale).toFixed(2)}`).join('L') + 'Z';
        cv.path(d, { fill: '#4d9fff', fillOpacity: 0.25, stroke: '#1a3a5c', width: 0.4 });
      });
      // 统一标尺：按最长粒
      const longest = Math.max(...b.samples.map((s) => s.feretPx || 0));
      if (longest > 0 && b.calib?.mmPerPx) {
        drawScaleBarSvg(cv, cx0, cy0 + cellH - 4, b.calib.mmPerPx, niceScaleMm(longest * b.calib.mmPerPx));
      }
    });
    caption = `图：各样本的籽粒轮廓拼图（统一比例尺，蓝色填充表示籽粒外轮廓）。`
      + `每格内的籽粒按各自最长的一个对齐并使用相同缩放倍率。`;
  }

  return { cv, caption };
}

function niceScaleMm(mm) {
  const cands = [1, 2, 5, 10, 20, 50];
  for (const c of cands) if (mm <= c * 1.15) return c;
  return 50;
}

/** SVG → Canvas 位图渲染（用于屏幕预览与 PNG 导出） */
function renderSvgToCanvas(svgString, dpi, canvas) {
  return new Promise((resolve, reject) => {
    const svg = svgString.replace(/<\?xml[^>]*\?>\s*/, '');
    const m = svg.match(/width="([\d.]+)mm"[^>]*height="([\d.]+)mm"/);
    const wmm = m ? parseFloat(m[1]) : 85;
    const hmm = m ? parseFloat(m[2]) : 65;
    const pxW = Math.round((wmm / 25.4) * dpi);
    const pxH = Math.round((hmm / 25.4) * dpi);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      canvas.width = pxW; canvas.height = pxH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pxW, pxH);
      ctx.drawImage(img, 0, 0, pxW, pxH);
      URL.revokeObjectURL(url);
      resolve({ pxW, pxH, wmm, hmm });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 渲染失败')); };
    img.src = url;
  });
}

async function renderFigure() {
  const { cv, caption, empty } = buildFigure();
  state.lastFigure = { svg: cv.toString(), caption };
  $('#fig-caption').textContent = caption;
  const target = $('#fig-canvas');
  try {
    // 屏幕预览用 300dpi，导出时按设定 DPI 重新渲染
    await renderSvgToCanvas(cv.toString(), 300, target);
  } catch (e) {
    toast('图表渲染失败：' + e.message, 'error');
  }
  renderSpecCheck();
}

function renderSpecCheck() {
  const s = state.settings;
  const checks = [
    { ok: s.dpi >= 300, msg: `导出分辨率 ${s.dpi} DPI` + (s.dpi >= 600 ? '（满足多数期刊要求）' : '（多数期刊要求 ≥300，建议 600）') },
    { ok: s.fontSize >= 5 && s.fontSize <= 9, msg: `字号 ${s.fontSize} pt（正文图通常 6–9 pt）` },
    { ok: s.widthMm >= 40, msg: `图宽 ${s.widthMm} mm（单栏 85 mm / 双栏 180 mm）` },
    { ok: s.palette !== 'grayscale' || s.dpi >= 600, msg: `配色：${$('#palette').selectedOptions[0].textContent}` },
    { ok: state.calib.mode !== 'none' || $('#fig-y').value.includes('Px'), msg: state.calib.mode === 'none' ? '注意：未做尺度标定，图中数值为像素单位' : '已做尺度标定，输出物理单位 (mm)' },
    { ok: state.samples.length >= 3, msg: `样本量 n = ${state.samples.length}` },
  ];
  $('#fig-check').innerHTML = checks.map((c) =>
    `<li class="${c.ok ? 'ok' : 'warn'}"><span class="mk">${c.ok ? '✓' : '!'}</span><span>${c.msg}</span></li>`
  ).join('');
}

/* ---------------------------------------------------------- 导出 */
async function exportCSV() {
  if (!state.samples.length) return toast('没有数据可导出', 'error');
  const b64 = btoa(unescape(encodeURIComponent(toCSV())));
  const p = await window.api.saveFile({
    defaultName: `籽粒表型数据_${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    dataBase64: b64,
  });
  if (p) toast('数据已导出：' + p, 'success');
}

async function exportSVG() {
  if (!state.lastFigure) return toast('请先生成图表', 'error');
  const b64 = btoa(unescape(encodeURIComponent(state.lastFigure.svg)));
  const p = await window.api.saveFile({
    defaultName: `figure_${Date.now()}.svg`,
    filters: [{ name: 'SVG（矢量，推荐投稿）', extensions: ['svg'] }],
    dataBase64: b64,
  });
  if (p) toast('矢量图已导出（可直接排版，不失真）：' + p, 'success');
}

async function exportPNG() {
  if (!state.lastFigure) return toast('请先生成图表', 'error');
  try {
    const dpi = state.settings.dpi;
    const tmp = document.createElement('canvas');
    const info = await renderSvgToCanvas(state.lastFigure.svg, dpi, tmp);
    const blob = await new Promise((res) => tmp.toBlob(res, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const p = await window.api.saveFile({
      defaultName: `figure_${info.pxW}x${info.pxH}_${dpi}dpi.png`,
      filters: [{ name: `PNG (${dpi} DPI, ${info.pxW}×${info.pxH} px)`, extensions: ['png'] }],
      dataBase64: btoa(bin),
    });
    if (p) toast(`位图已导出：${info.pxW}×${info.pxH} px @ ${dpi} DPI（${info.wmm}×${info.hmm} mm）`, 'success');
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

async function saveProject() {
  const data = serializeProject();
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const p = await window.api.saveFile({
    defaultName: `籽粒表型项目_${new Date().toISOString().slice(0, 10)}.sps.json`,
    filters: [{ name: '项目文件', extensions: ['json'] }],
    dataBase64: b64,
  });
  if (p) toast('项目已保存（含数据与设置，可重新分析）：' + p, 'success');
}

async function doLoadProject() {
  const data = await window.api.openProject();
  if (!data) return;
  loadProject(data);
  state.batches.forEach((b) => { b.samples.forEach((s, i) => { s.index = i + 1; }); });
  applySettingsToUI();
  renderBatches(); renderTable(); renderStats(); refreshAxisOptions(); drawCurrent();
  toast(`已载入项目：${state.batches.length} 个批次，${state.samples.length} 粒`, 'success');
}

/* ------------------------------------------------- 标尺自动识别 */
function autoDetectBar() {
  const b = activeBatch();
  if (!b) return toast('请先选择图像', 'error');
  const bars = detectScaleBars(b.imageData, {});
  const el = $('#calib-bars');
  if (!bars.length) {
    el.innerHTML = '<p class="hint">未自动识别到标尺条。可改用手动输入，或在图像中直接标注。</p>';
    return;
  }
  el.innerHTML = bars.slice(0, 5).map((bar, i) =>
    `<div class="bar-item" data-i="${i}">${bar.orientation === 'h' ? '水平' : '垂直'} · 长度 ${bar.length} px · 对比度 ${(bar.contrast * 100).toFixed(0)}%</div>`
  ).join('');
  el.querySelectorAll('.bar-item').forEach((it) => {
    it.addEventListener('click', () => {
      const bar = bars[+it.dataset.i];
      $('#calib-px').value = Math.round(bar.length);
      $('#calib-mode').value = 'manual';
      syncCalibUI();
      updateCalibPreview();
    });
  });
}

function updateCalibPreview() {
  const px = +$('#calib-px').value, mm = +$('#calib-mm').value;
  const k = mmPerPixel(px, mm);
  if (isFinite(k) && k > 0) {
    state.calib.px = px; state.calib.mm = mm; state.calib.mmPerPx = k;
    // 手动填入标定值即视为 manual 模式，否则分析时不会采用该标定
    if (state.calib.mode === 'none') {
      state.calib.mode = 'manual';
      $('#calib-mode').value = 'manual';
      $('#calib-manual').classList.remove('hidden');
      $('#calib-auto').classList.add('hidden');
    }
    $('#calib-preview').textContent = `1 mm = ${(1 / k).toFixed(2)} px；1 px = ${k.toFixed(5)} mm`;
  }
  reanalyzeAll();
}

function syncCalibUI() {
  const m = $('#calib-mode').value;
  $('#calib-manual').classList.toggle('hidden', m !== 'manual');
  $('#calib-auto').classList.toggle('hidden', m !== 'auto');
  if (m === 'none') {
    state.calib.mmPerPx = null;
    reanalyzeAll();
  } else if (m === 'manual') {
    updateCalibPreview();
  }
}

function applySettingsToUI() {
  const s = state.settings;
  $('#palette').value = s.palette;
  $('#fig-w').value = s.widthMm; $('#fig-h').value = s.heightMm;
  $('#font-size').value = s.fontSize; $('#v-fs').textContent = s.fontSize;
  $('#dpi').value = s.dpi; $('#v-dpi').textContent = s.dpi;
  $('#min-area').value = s.minArea; $('#v-minarea').textContent = s.minArea;
  $('#denoise').value = s.denoise; $('#v-denoise').textContent = s.denoise;
  $('#thr-offset').value = s.thrOffset; $('#v-thr').textContent = s.thrOffset;
  $('#err-type').value = s.errType;
  $('#sig-alpha').value = String(s.alpha);
  $('#posthoc').value = s.postHoc || 'tukey';
  $('#calib-mode').value = state.calib.mode;
  if (state.calib.px) $('#calib-px').value = state.calib.px;
  if (state.calib.mm) $('#calib-mm').value = state.calib.mm;
  syncCalibUI();
}

/* --------------------------------------------------------- 事件 */
function bind() {
  $('#btn-open').addEventListener('click', openImages);
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#btn-export-fig').addEventListener('click', exportPNG);
  $('#btn-save-proj').addEventListener('click', saveProject);
  $('#btn-load-proj').addEventListener('click', doLoadProject);
  $('#btn-svg').addEventListener('click', exportSVG);
  $('#btn-png').addEventListener('click', exportPNG);
  $('#btn-render-fig').addEventListener('click', renderFigure);
  $('#btn-run-stats').addEventListener('click', renderStats);
  $('#btn-detect-bar').addEventListener('click', autoDetectBar);

  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.ws-panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`#tab-${t.dataset.tab}`).classList.add('active');
    if (t.dataset.tab === 'figures' && !state.lastFigure) renderFigure();
  }));

  $('#show-mask').addEventListener('change', drawCurrent);
  $('#show-contour').addEventListener('change', drawCurrent);
  $('#show-index').addEventListener('change', drawCurrent);
  $('#show-scale').addEventListener('change', drawCurrent);

  $('#calib-mode').addEventListener('change', syncCalibUI);
  $('#calib-px').addEventListener('input', updateCalibPreview);
  $('#calib-mm').addEventListener('input', updateCalibPreview);

  const bindRange = (id, label, key, after) => {
    const el = $(id);
    el.addEventListener('input', () => {
      const v = +el.value;
      if (label) $(label).textContent = v;
      state.settings[key] = v;
      if (after) after();
    });
  };
  bindRange('#min-area', '#v-minarea', 'minArea', reanalyzeAll);
  bindRange('#denoise', '#v-denoise', 'denoise', reanalyzeAll);
  bindRange('#thr-offset', '#v-thr', 'thrOffset', reanalyzeAll);
  bindRange('#font-size', '#v-fs', 'fontSize');
  bindRange('#dpi', '#v-dpi', 'dpi');

  $('#palette').addEventListener('change', (e) => { state.settings.palette = e.target.value; renderFigure(); });
  $('#fig-w').addEventListener('change', (e) => { state.settings.widthMm = +e.target.value; renderFigure(); });
  $('#fig-h').addEventListener('change', (e) => { state.settings.heightMm = +e.target.value; renderFigure(); });
  $('#err-type').addEventListener('change', (e) => { state.settings.errType = e.target.value; renderFigure(); });
  $('#sig-alpha').addEventListener('change', (e) => { state.settings.alpha = +e.target.value; renderStats(); renderFigure(); });
  $('#posthoc').addEventListener('change', (e) => { state.settings.postHoc = e.target.value; renderStats(); renderFigure(); });
  $('#stat-metric').addEventListener('change', renderStats);
  $('#fig-type').addEventListener('change', renderFigure);
  $('#fig-x').addEventListener('change', renderFigure);
  $('#fig-y').addEventListener('change', renderFigure);
  $('#fig-points').addEventListener('change', renderFigure);
  $('#fig-grid').addEventListener('change', renderFigure);
  $('#table-search').addEventListener('input', renderTable);

  // 拖拽导入
  const wrap = $('.canvas-wrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.style.outline = '2px dashed var(--accent)'; });
  wrap.addEventListener('dragleave', () => { wrap.style.outline = 'none'; });
  wrap.addEventListener('drop', async (e) => {
    e.preventDefault(); wrap.style.outline = 'none';
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    for (const f of files) await loadImageFile({ name: f.name, path: f.path, url: URL.createObjectURL(f) });
    renderBatches();
    if (state.batches.length) { state.activeBatchId = state.batches[state.batches.length - 1].id; reanalyzeAll(); }
    toast(`已导入 ${files.length} 张图像`, 'success');
  });

  window.addEventListener('resize', () => { drawCurrent(); });
  window.api.onMenu((action) => {
    ({ open: openImages, 'export-csv': exportCSV, 'export-figure': exportPNG,
      'save-project': saveProject, 'load-project': doLoadProject,
      help: () => toast('见 README.md：导入 → 标定 → 轮廓核对 → 统计 → 出图') })[action]?.();
  });
}

/* ---------------------------------------------------------- 启动 */
bind();
applySettingsToUI();
renderBatches();
refreshAxisOptions();
drawCurrent();
window.addEventListener('error', (e) => toast('运行错误：' + e.message, 'error'));

// 供自动化冒烟测试驱动内部流程（正常交互请走界面）
window.__sps = {
  state,
  async importFile(filePath, name, group) {
    const before = state.batches.length;
    await loadImageFile({ name, path: filePath, url: `file:///${filePath.replace(/\\/g, '/')}` }, group);
    const batch = state.batches[before];
    state.activeBatchId = batch.id;
    renderBatches();
    reanalyzeAll();
    return batch.samples.length;
  },
  setCalib(px, mm) {
    $('#calib-mode').value = 'manual';
    $('#calib-px').value = String(px);
    $('#calib-mm').value = String(mm);
    updateCalibPreview();   // 内部已调用 reanalyzeAll，所有批次统一单位
    return state.calib.mmPerPx;
  },
  renderFigure: () => renderFigure(),
  lastFigureSvg: () => state.lastFigure?.svg || '',
  tableRows: () => document.querySelectorAll('#data-table tbody tr').length,
  statRows: () => document.querySelectorAll('#desc-table tbody tr').length,
  csv: () => toCSV(),
};