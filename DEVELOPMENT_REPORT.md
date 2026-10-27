# SeedPhenotype Studio — 开发交接与后续扩展参考

> 本文档面向**代码交接**与**后续功能开发**两类读者。前半部分说明当前工程的架构、模块边界与运行方式；后半部分给出可扩展点（新增图型 / 指标 / 配色 / 标定方式）的具体落点，便于二次开发直接动手。

---

## 1. 项目定位

桌面端科研工具（Electron v33），用于**植物籽粒表型测定**并一键生成**科研级论文配图**。全部算法本地运行，图像不离开本机。核心链路：

```
导入图像 → 分割(Seg) → 粘连分离 → 尺度标定 → 形状量/颜色量 → 统计分析(ANOVA/显著性字母) → 论文配图(SVG, 600 DPI)
```

支持文件：单粒散落照（PNG/JPG/BMP/TIF/WebP）、项目文件 `*.sps.json`、批量 CSV 导出、SVG/PNG/TIFF 图表导出。

---

## 2. 目录结构（重排后）

重排原则：算法按**功能域**拆分子目录，UI 脚本集中到 `src/ui`，测试按**用途**拆分。相对 `D:\DSH\PhotoType`：

```
PhotoType/
├─ package.json            # 脚本/依赖/构建配置
├─ electron/
│  ├─ main.cjs             # 主进程：窗口、菜单、IPC(dialog/fs/shell)
│  └─ preload.cjs          # 上下文隔离桥：window.api
├─ src/
│  ├─ index.html           # 渲染进程入口（<script type="module" src="ui/app.js">）
│  ├─ styles.css           # 全部 UI 样式
│  ├─ core/                # 纯算法（无 DOM，可在 Node 单测直接 import）
│  │  ├─ pipeline.js       # 主编排：processImage / groupSamples / simplify（留在 core 根，串接各子域）
│  │  ├─ segmentation/
│  │  │  └─ image.js       # 色彩空间、分割、形态学、轮廓、连通域、距离变换、粘连分离
│  │  ├─ geometry/
│  │  │  └─ shape.js       # 多边形几何、凸包、最小外接矩形、椭圆拟合、形状描述子
│  │  ├─ calibration/
│  │  │  └─ calibrate.js   # 标尺识别、mm/px 换算、Scaler
│  │  ├─ statistics/
│  │  │  └─ stats.js       # 描述统计、t/F 检验、Welch、ANOVA、pearson、回归、显著性字母、postHoc(Tukey/Games-Howell/Welch/auto)、学生化极差、meanCI95(95% 置信区间)
│  │  └─ plotting/
│  │     └─ plot.js        # SvgCanvas、6 种图表、配色方案、niceTicks、比例尺
│  └─ ui/
│     ├─ app.js            # 渲染进程主逻辑：绑定 DOM、事件、图表渲染、导出、暴露 window.__sps
│     ├─ viewer.js         # Canvas 绘制（图像/掩膜/轮廓/编号/比例尺）
│     └─ state.js          # 全局状态、项目序列化、CSV、样本聚合
├─ test/
│  ├─ fixtures/            # e2e 真值图像与 truth.json（由 make-fixtures 生成，勿手改）
│  ├─ unit/run.js          # 合成图像单测（无需 Electron）
│  ├─ e2e/e2e.js           # 真实 PNG 端到端回归
│  ├─ smoke/smoke.cjs      # UI 冒烟（启动 Electron，驱动 window.__sps）
│  └─ tools/               # 测试辅助脚本：make-fixtures.js / make-icon.cjs
├─ dist/ release/          # 构建产物（dist 未打包，release 含已打包目录）
└─ README.md               # 用户向说明
```

> **关键约定**：`src/core/**` 为纯逻辑、无 DOM 依赖，可直接在 Node 中以 ESM 方式 `import`；`src/ui/**` 与 `index.html`/`styles.css` 仅在渲染进程运行。

---

## 3. 运行与构建

| 命令 | 作用 |
|------|------|
| `npm start` | 启动应用（走 `electron/launch.cjs`） |
| `npm test` | `node test/unit/run.js && node test/e2e/e2e.js && node test/smoke/smoke.electron.cjs` |
| `npm run test:unit` | 仅单测 + 端到端（不启 Electron，快） |
| `npm run smoke` | 仅 UI 冒烟 |
| `npm run icon` | 重新生成应用图标（Node 纯实现） |
| `npm run dist` | 打包（build-win.cjs / electron-builder 配置） |

**环境**：Node 须 ≥ 18 且 **≠ v22.0–22.3**（已知与 Electron 33 不兼容）；本机可用 `node v24.19.0`。

| **`npm run test:unit`** | 仅单测 + 端到端（不启 Electron，快） |
| **测试健康度（两步难样本基线 + Tukey HSD/CI + 修复 smoke 运行期错误后实测）**：unit **81/81**、e2e **72/72**、smoke **31/31**，合计 **184 项 0 失败**。
---

## 4. 模块边界与依赖图

```
pipeline.js
  ├─ segmentation/image.js  (segmentGrains, splitTouching, traceContour, distanceTransform, connectedComponents, fillHoles, erode/dilate, otsuThreshold, rgbToLab…)
  ├─ calibration/calibrate.js (detectScaleBars, mmPerPixel, makeScaler)
  ├─ geometry/shape.js      (describeShape, minAreaRect, fitEllipse, polygonArea, convexHull, maxFeret, centroid)
  └─ statistics/stats.js    (describe, oneWayAnova, letterGroups, pairwisePMatrix…)  ← 仅被 pipeline 的聚合用到

ui/app.js （渲染进程）
  ├─ core/pipeline.js
  ├─ core/segmentation/image.js
  ├─ core/calibration/calibrate.js
  ├─ core/statistics/stats.js
  ├─ core/plotting/plot.js
  ├─ ui/state.js            (state, activeBatch, collectSamples, rebuildSamples, serializeProject, toCSV)
  └─ ui/viewer.js           (drawImageView, drawScaleBar)

electron/main.cjs ↔ preload.cjs ↔ ui/app.js 经 IPC: dialog:openImages / fs:readImage / dialog:save / dialog:openProject / shell:showItem
```

**数据流**：`loadImageFile()` → 主进程 `fs:readImage` 读 base64 → `processImage()` 产出 `samples[]` → 存入 `state.batches` → `renderTable/renderStats/renderFigure` 消费。

---

## 5. 核心数据结构（二次开发必读）

`processImage(img, opts)` 返回的 **Sample**（一个籽粒）：

```
{ id, cx, cy, areaPx, areaMM2, lengthPx, lengthMM, widthPx, widthMM,
  aspectRatio, circularity, solidity, angle, eqDiameterMM,
  perimeterPx, convexAreaPx, color:{L,a,b,r,g,b}, contour:[{x,y}], group }
```

`state.batches[]` 中每个 Batch：`{ id, name, group, images:[{id,name,path,url,samples[]}] }`。

---

## 6. 可扩展点（直接落点）

### 6.1 新增图型（如散点矩阵 / 雷达图）
1. 在 `src/core/plotting/plot.js` 新增 `export function myChart(cv, data, opts)`，复用既有 `SvgCanvas` / `Axes` / `PALETTES`。
2. 在 `src/ui/app.js` 的 `renderFigure()` switch 增加 `case 'mychart'`，并同步 `index.html` 的 `#fig-type` 下拉项 + `#stat-metric` 等轴选项。
3. 在 `test/unit/run.js` 第 7 节补一条“SVG 结构完整 + 无 NaN/undefined”断言；`test/e2e/e2e.js` 第 7 节 `checks[]` 追加同名用例。

### 6.2 新增统计指标（如偏度 / 变异系数）
- 在 `src/core/statistics/stats.js` 扩展 `describe()` 或新增函数；`app.js` 的 `#stat-metric` 下拉 + `renderStats()` 表格列同步。
- `app.js` 中 `metricFns` / 描述统计表头映射需一并更新。

### 6.3 新增配色方案
- 在 `src/core/plotting/plot.js` 的 `PALETTES` 增加键；`index.html` `#palette` 下拉加 `<option>`。注意 6 套现有方案已覆盖 Nature/Lancet/Science/Wiley(色盲友好)/Okabe-Ito/灰度。

### 6.4 新增标定方式
- 现有：`none / manual / auto`。`src/core/calibration/calibrate.js` 的 `detectScaleBars`（auto 核心）。
- 扩展：在 `calibrate.js` 增加识别函数，`app.js` `#calib-mode` 增加选项，`state.setCalib()` 增加分支，`index.html` 对应面板 `#calib-*` 增块。

### 6.5 调整分割/粘连策略
- 分割阈值与形态学：`src/core/segmentation/image.js` 的 `segmentGrains` / `splitTouching / distanceTransform`。
- UI 参数滑块在 `index.html`（`#min-area` / `#denoise` / `#thr-offset`）与 `app.js` 的 `processImage` 调用 opts 对应。

---

## 7. 既有约定与踩坑

1. **`window.__sps` 是自动化测试契约**：`app.js` 末尾暴露 `{ state, importFile, setCalib, renderFigure, ... }`，smoke 测试据此驱动内部流程；改 `app.js` 时不要删除该对象，否则冒烟测试直接失败。
2. **预加载路径相对 `__dirname`**：`electron/main.cjs`、`test/smoke/smoke.cjs` 的 `preload` 必须指向 `../electron/preload.cjs`（smoke 在 `test/smoke/` 下故为 `../../electron/preload.cjs`）。移动测试脚本时务必同步修正，否则 `window.api` 缺失会导致 `app.js` 初始化抛错、`__sps` 不被赋值。
3. **fixtures 共享位置**：`test/tools/make-fixtures.js` 与 `test/e2e/e2e.js` 均读写 `test/fixtures/`（相对各自 `__dirname` 上溯两级），移动这两个文件时保持该相对关系，否则 e2e 找不到真值图。
4. **Node 版本**：见 §3，v22.0–22.3 与 Electron 33 不兼容。
5. **`ELECTRON_RUN_AS_NODE`**：`main.cjs` / smoke 启动前会清掉该环境变量，否则 `require('electron')` 拿不到 `app/BrowserWindow`。
6. **CSP**：`index.html` 设 `script-src 'self'`，渲染进程只允许 `type="module"` 引自身脚本；新增外部脚本会被拦截。

---

## 8. 已知限制

- 分割对**高反光 / 强阴影 / 背景与籽粒色差小**的图像仍偏脆弱（无 AI 分割）。已加三道常规兜底：① **背景噪声门限**（边框像素统计 + 4σ 噪声估计，干净低对比图可从 2/12 恢复到 12/12）；② **局部自适应背景兜底**（渐变阴影出现“主导大块”时切换，把 `hard_shadow` 从漏检恢复到 12/12）；③ **圆度/离心率二次过滤**（剔除近圆形同色背景杂点 `hard_specks`：默认开启时 12/12，关闭时一并检出 17 个并靠形状过滤）。仍存弱项：极端弱对比（前景 ΔE 低于阈值下限仍会丢）。量化基线见 e2e 第 8 节 BASELINE / 第 8b 节 specks 断言（防退化护栏）。
- 标定 `auto` 仅支持规则横/竖深色标尺条，斜标尺、刻度尺未支持。
- 统计学量基于单粒投影几何，未做三维重建；**多重比较与区间估计均已支持**——`stats.js` 暴露 `postHoc(groups, method, alpha)`：默认 `tukey`（方差齐、学生化极差 q 统计量、按族系错误率校正），另有 `games-howell`（方差不齐）、`welch`（兼容旧两两 t 检验）、`auto`（先 Bartlett 方差齐性检验择一）；以及 `meanCI95(a)`（正态近似 95% 置信区间）。设置面板「事后检验」可切换方法、误差棒「95% 置信区间(CI)」选项会改为画 mean±1.96·SE 区间（柱/箱/小提琴均同步，`barChart` 经 `plot.js` 的 se 字段自动生效）。
- `dist/` 目录为空（仅配置，未实际打包产物）；`release/` 含若干历史打包版本。

---

## 9. 建议后续路线
1. **分割鲁棒性**：上轮已加「背景噪声门限」与「局部自适应背景兜底」两道常规兜底（详见 §8），把 `hard_low_contrast`、`hard_shadow` 从漏检恢复到 12/12；再加「圆度/离心率二次过滤」，把 `hard_specks` 同色圆形杂点从误检 17/12 收敛到 12/12（默认开启）。下一步：① 探索轻量 U-Net 兜底应对极端弱对比；② 每次改进后同步收紧 `test/e2e/e2e.js` 第 8 节 `hardBaseline` 的 `floorDetected / floorMaxErrMM`，逼近真值 100% / 误差→0。
2. **标定增强**：支持斜标尺、双端拖拽选点（`index.html` 已有 `#btn-detect-bar` 与 `#calib-bars` 骨架）。
3. ~~**统计严谨化**：把两两比较升级为 Tukey HSD / Games-Howell，并在 `stats.js` 暴露。~~ ✅ 已完成（见 §5 统计管线、`src/core/statistics/stats.js` 的 `postHoc`/学生化极差实现、e2e 第 6b/6c 节）。
4. **图表增强**：按 §6.1 补齐散点矩阵、茎叶图等；导出 TIFF 走既有 `dialog:save` base64 通道。
5. **工程化**：把 `src/core` 抽成可单独发布的 npm 包，便于在 Web/CLI 复用；**CI 已加**（` .github/workflows/ci.yml`）：`unit-e2e` job 在 Ubuntu/Windows × Node 20/22 跑 `npm run test:unit`（无第三方运行依赖故跳 install）；`smoke` job 在矩阵上 `npm ci` 装 electron 后跑真实渲染进程冒烟（Linux 用 xvfb 虚拟显示，Windows 原生跑）。
6. **文档**：本文件与 README 已区分“开发”与“用户”视角，后续改动请同步更新两处对应段落。
