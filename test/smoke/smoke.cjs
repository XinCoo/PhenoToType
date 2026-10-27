'use strict';
/**
 * 渲染进程 UI 冒烟测试（由 test/smoke/smoke.electron.cjs 启动 Electron 后执行）。
 * 真实走一遍：加载测试图像 → 分割出样本 → 填充分组 → 手动标定 →
 * 数据表/统计表渲染 → 生成柱状图 SVG → 校验无异常值。
 * 结果通过 stdout 的 [冒烟] 标记输出，供 CI 断言。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const FIX = path.join(__dirname, '..', 'fixtures');
const report = { checks: [], ok: 0, fail: 0 };
const check = (name, cond, detail = '') => {
  report.checks.push({ name, pass: !!cond, detail });
  cond ? report.ok++ : report.fail++;
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600, height: 1000, show: false,
    webPreferences: {
      preload: path.join(__dirname, '../../electron/preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });

  const fixture = path.join(FIX, 'group_A.png');
  const fixtureB = path.join(FIX, 'group_B.png');
  check('测试图像存在', fs.existsSync(fixture) && fs.existsSync(fixtureB), fixture);

  await win.loadFile(path.join(__dirname, '../../src/index.html'));
  await new Promise((r) => setTimeout(r, 600));

  // 确认测试图像能被渲染进程解码（走的是与导入相同的 file:// 路径）
  const loaded = await win.webContents.executeJavaScript(`
    Promise.all([${JSON.stringify(fixture)}, ${JSON.stringify(fixtureB)}].map((f) =>
      new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im.naturalWidth);
        im.onerror = () => res(0);
        im.src = 'file:///' + f.replace(/\\\\/g, '/');
      })
    )).then((ws) => JSON.stringify(ws))
  `);
  check('测试图像可在渲染进程解码', JSON.parse(loaded).every((w) => w > 0), loaded);

  /* ---- 真实流程：导入两组图 → 标定 → 统计 → 出图 ---- */
  const imported = await win.webContents.executeJavaScript(`
    (async () => {
      const a = await window.__sps.importFile(${JSON.stringify(fixture)}, 'group_A', '品种A');
      const b = await window.__sps.importFile(${JSON.stringify(fixtureB)}, 'group_B', '品种B');
      return JSON.stringify({ a, b, total: window.__sps.state.samples.length });
    })()
  `);
  const im = JSON.parse(imported);
  check('A 组导入并检出 12 粒', im.a === 12, String(im.a));
  check('B 组导入并检出 12 粒', im.b === 12, String(im.b));
  check('汇总样本数 24', im.total === 24, String(im.total));

  const k = await win.webContents.executeJavaScript(`String(window.__sps.setCalib(200, 10))`);
  check('标定换算 0.05 mm/px', Math.abs(Number(k) - 0.05) < 1e-12, k);

  const stats = await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('.tab[data-tab="stats"]').click();
      const $ = (s) => document.querySelector(s);
      $('#stat-metric').value = 'lengthMM';
      $('#stat-metric').dispatchEvent(new Event('change'));
      return JSON.stringify({
        statRows: window.__sps.statRows(),
        tableRows: window.__sps.tableRows(),
        anovaRows: document.querySelectorAll('#anova-table tbody tr').length,
        descHead: [...document.querySelectorAll('#desc-table thead th')].map(t => t.textContent.trim()),
      });
    })()
  `);
  const st = JSON.parse(stats);
  check('描述统计表 2 行', st.statRows === 2, String(st.statRows));
  check('数据表 24 行', st.tableRows === 24, String(st.tableRows));
  check('ANOVA 表有内容', st.anovaRows >= 2, String(st.anovaRows));
  check('描述统计表头正确', st.descHead.includes('均值') && st.descHead.includes('SD'), st.descHead.join(','));

  const fig = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.tab[data-tab="figures"]').click();
      const $ = (s) => document.querySelector(s);
      $('#fig-type').value = 'bar';
      $('#fig-type').dispatchEvent(new Event('change'));
      $('#fig-y').value = 'lengthMM';
      $('#fig-y').dispatchEvent(new Event('change'));
      await window.__sps.renderFigure();
      const svg = window.__sps.lastFigureSvg();
      return JSON.stringify({
        len: svg.length,
        hasNaN: /NaN|undefined|Infinity/.test(svg),
        hasA: svg.includes('品种A'),
        hasB: svg.includes('品种B'),
        hasLetters: />[A-Z]+</.test(svg),
        caption: $('#fig-caption').textContent,
        canvasW: $('#fig-canvas').width,
        canvasH: $('#fig-canvas').height,
      });
    })()
  `);
  const fg = JSON.parse(fig);
  check('柱状图 SVG 已生成', fg.len > 500, String(fg.len));
  check('SVG 无 NaN/undefined', !fg.hasNaN, '');
  check('SVG 含两组分组名', fg.hasA && fg.hasB, '');
  check('SVG 含显著性字母', fg.hasLetters === true, '');
  check('图注已自动生成', fg.caption.length > 20, fg.caption.slice(0, 40));
  check('预览画布已渲染', fg.canvasW > 100 && fg.canvasH > 100, `${fg.canvasW}x${fg.canvasH}`);

  const csv = await win.webContents.executeJavaScript(`window.__sps.csv()`);
  check('CSV 含表头与数据', csv.includes('长度_mm') && csv.split('\n').length >= 25,
    `${csv.split('\n').length} 行`);

  const domCheck = await win.webContents.executeJavaScript(`
    (() => {
      const $ = (s) => document.querySelector(s);
      const r = {};
      r.tabs = document.querySelectorAll('.tab').length;
      r.canvases = !!$('#view-canvas') && !!$('#fig-canvas');
      // 切换到"图表输出"页签，触发无数据时的兜底渲染
      document.querySelector('.tab[data-tab="figures"]').click();
      r.figPanelVisible = $('#tab-figures').classList.contains('active');
      r.caption = $('#fig-caption').textContent.trim();
      r.checks = document.querySelectorAll('#fig-check li').length;
      // 切换到统计分析
      document.querySelector('.tab[data-tab="stats"]').click();
      r.statsPanelVisible = $('#tab-stats').classList.contains('active');
      // 切回图像页
      document.querySelector('.tab[data-tab="image"]').click();
      r.imagePanelVisible = $('#tab-image').classList.contains('active');
      r.dropHintVisible = !$('#drop-hint').classList.contains('hidden');
      return JSON.stringify(r);
    })()
  `);
  const d = JSON.parse(domCheck);
  check('4 个页签存在', d.tabs === 4, String(d.tabs));
  check('两个画布存在', d.canvases === true, '');
  check('图表页可切换', d.figPanelVisible === true, '');
  check('无数据时给出兜底提示', d.caption.length > 0, d.caption);
  check('投稿规范检查项已渲染', d.checks >= 5, String(d.checks));
  check('统计页可切换', d.statsPanelVisible === true, '');
  check('图像页可切换', d.imagePanelVisible === true, '');
  check('空态拖拽提示存在（导入后应隐藏）', d.dropHintVisible === false,
    '导入图像后应隐藏提示，当前=' + d.dropHintVisible);

  // 交互：切换图表类型 / 配色 / 字号，确认无异常
  const interact = await win.webContents.executeJavaScript(`
    (() => {
      const $ = (s) => document.querySelector(s);
      const errs = [];
      const types = [...document.querySelectorAll('#fig-type option')].map(o => o.value);
      for (const t of types) {
        $('#fig-type').value = t;
        try { $('#fig-type').dispatchEvent(new Event('change')); }
        catch (e) { errs.push(t + ': ' + e.message); }
      }
      const pal = $('#palette');
      pal.value = 'okabeIto';
      pal.dispatchEvent(new Event('change'));
      const fs_ = $('#font-size');
      fs_.value = '10';
      fs_.dispatchEvent(new Event('input'));
      // 切换标定模式（无标定 -> 手动）
      const cm = $('#calib-mode');
      cm.value = 'manual';
      cm.dispatchEvent(new Event('change'));
      const manualVisible = !$('#calib-manual').classList.contains('hidden');
      const px = $('#calib-px'); px.value = '200'; px.dispatchEvent(new Event('input'));
      const mm = $('#calib-mm'); mm.value = '10'; mm.dispatchEvent(new Event('input'));
      const preview = $('#calib-preview').textContent;
      cm.value = 'none'; cm.dispatchEvent(new Event('change'));
      return JSON.stringify({ errs, types, manualVisible, preview, fontSize: $('#v-fs').textContent });
    })()
  `);
  const it = JSON.parse(interact);
  check('8 种图表类型均可切换', it.types.length === 8, it.types.join(','));
  check('切换图表类型无异常', it.errs.length === 0, it.errs.join(' | '));
  check('手动标定面板可见', it.manualVisible === true, '');
  check('标定换算提示正确', /1 mm = 20\.00 px/.test(it.preview), it.preview);
  check('字号滑块联动', it.fontSize === '10', it.fontSize);
  check('渲染进程无严重报错', errors.length === 0, errors.join(' | '));

  console.log('[冒烟]' + JSON.stringify(report));
  app.exit(report.fail === 0 ? 0 : 1);
});
