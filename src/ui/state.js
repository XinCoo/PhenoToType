/**
 * state.js — 全局状态与项目持久化
 */
export const state = {
  batches: [],          // {id, name, path, url, image(HTMLImageElement), imageData, samples[], calib}
  activeBatchId: null,
  samples: [],          // 汇总所有批次的样本（含 group/imageName）
  settings: {
    palette: 'nature', widthMm: 85, heightMm: 65, fontSize: 8, dpi: 600,
    errType: 'se', alpha: 0.05, postHoc: 'tukey', minArea: 40, denoise: 1, thrOffset: 0,
  },
  calib: { mode: 'none', mmPerPx: null, px: 100, mm: 10 },
  stats: null,
  lastFigure: null,
};

let seq = 0;
export function nextId() { return `b${++seq}`; }

export function activeBatch() {
  return state.batches.find((b) => b.id === state.activeBatchId) || null;
}

/** 把所有批次样本汇总为扁平列表（附来源信息） */
export function collectSamples() {
  const out = [];
  for (const b of state.batches) {
    const g = b.group || b.name;
    for (const s of b.samples) {
      out.push({ ...s, group: g, imageName: b.name, batchId: b.id });
    }
  }
  return out;
}

export function rebuildSamples() {
  state.samples = collectSamples();
}

/** 项目序列化（不含原始像素，仅保留数据与设置，可重复分析） */
export function serializeProject() {
  return {
    version: '0.1.0',
    createdAt: new Date().toISOString(),
    settings: state.settings,
    calib: state.calib,
    batches: state.batches.map((b) => ({
      name: b.name, path: b.path, group: b.group,
      calib: b.calib,
      samples: b.samples.map(stripHeavy),
    })),
  };
}

function stripHeavy(s) {
  const { contour, ...rest } = s;
  return rest;
}

export function loadProject(data) {
  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.calib = { ...state.calib, ...(data.calib || {}) };
  state.batches = (data.batches || []).map((b, i) => ({
    id: `loaded${i}`,
    name: b.name,
    path: b.path || null,
    url: null,
    image: null,
    imageData: null,
    group: b.group || b.name,
    calib: b.calib || null,
    samples: (b.samples || []).map((s) => ({ ...s })),
  }));
  state.activeBatchId = state.batches[0]?.id || null;
  rebuildSamples();
}

export function toCSV() {
  const rows = state.samples;
  if (!rows.length) return '';
  const cols = [
    ['group', '分组'], ['imageName', '图像'], ['index', '编号'],
    ['lengthMM', '长度_mm'], ['widthMM', '宽度_mm'], ['feretMM', 'Feret_mm'],
    ['areaMM2', '面积_mm2'], ['eqDiameterMM', '等效直径_mm'],
    ['thicknessMM', '厚度_mm'], ['volumeMM3', '体积_mm3'],
    ['aspectRatio', '长宽比'], ['circularity', '圆度'], ['solidity', '凸实度'],
    ['roundness', '圆度比'], ['angleRad', '长轴角度_rad'],
    ['colorL', '明度L'], ['colora', '色度a'], ['colorb', '色度b'],
    ['colorChroma', '彩度C'], ['colorHue', '色相H'], ['colorSat', '饱和度'],
  ];
  const lines = [cols.map((c) => c[1]).join(',')];
  rows.forEach((s, i) => {
    const v = [
      s.group, `"${(s.imageName || '').replace(/"/g, '""')}"`, i + 1,
      s.lengthMM, s.widthMM, s.feretMM, s.areaMM2, s.eqDiameterMM,
      s.thicknessMM, s.volumeMM3, s.aspectRatio, s.circularity, s.solidity,
      s.roundness, s.angleRad,
      s.color?.L, s.color?.a, s.color?.b, s.color?.chroma, s.color?.hue, s.color?.sat,
    ].map((x) => {
      if (x === undefined || x === null) return '';
      if (typeof x === 'number') return Number.isFinite(x) ? Number(x.toFixed(5)) : '';
      return `"${String(x).replace(/"/g, '""')}"`;
    });
    lines.push(v.join(','));
  });
  // BOM 保证 Excel 正确识别 UTF-8
  return '﻿' + lines.join('\n');
}