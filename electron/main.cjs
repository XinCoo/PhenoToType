'use strict';
// 某些宿主环境（如 IDE 内置终端、部分 CI）会预设 ELECTRON_RUN_AS_NODE=1，
// 那会让 Electron 以纯 Node 模式运行，导致 require('electron') 拿不到 app/BrowserWindow。
// 必须在加载 electron 之前清除，否则窗口无法创建。
if (process.env.ELECTRON_RUN_AS_NODE) delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#12161c',
    title: 'SeedPhenotype Studio — 植物籽粒表型测定',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../src/index.html'));
  // 自检：加载完成后回报渲染进程状态，便于无头环境验证
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      return JSON.stringify({
        title: document.title,
        tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim()),
        buttons: [...document.querySelectorAll('.topbar-actions .btn')].map(b => b.textContent.trim()),
        hasCanvas: !!q('#view-canvas'),
        batchesEmpty: !!q('#batch-list .empty-hint'),
        status: q('#img-status')?.textContent,
        jsError: window.__err || null,
      });
    })()`).then((r) => {
      console.log('[自检] ' + r);
    }).catch((e) => console.log('[自检失败] ' + e.message));
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[渲染进程${level >= 3 ? '严重' : '警告'}] ${message}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开图像…', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.send('menu', 'open') },
        { label: '导出数据 CSV…', click: () => win?.webContents.send('menu', 'export-csv') },
        { label: '导出图片…', click: () => win?.webContents.send('menu', 'export-figure') },
        { type: 'separator' },
        { label: '保存项目…', click: () => win?.webContents.send('menu', 'save-project') },
        { label: '载入项目…', click: () => win?.webContents.send('menu', 'load-project') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '使用说明', click: () => win?.webContents.send('menu', 'help') },
        { label: '关于', click: () => {
          dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: 'SeedPhenotype Studio',
            detail: '植物籽粒表型测定与科研级论文图片生成工具\n版本 0.1.0\n\n算法全部本地运行，图像数据不离开本机。',
          });
        } },
      ],
    },
  ]);
}

/* --------------------------------------------------------------- IPC */

ipcMain.handle('dialog:openImages', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择籽粒图像',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图像', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({
    path: p,
    name: path.basename(p),
    url: `file://${p.replace(/\\/g, '/')}`,
  }));
});

ipcMain.handle('dialog:save', async (_e, { defaultName, filters, dataBase64 }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(dataBase64, 'base64'));
  return r.filePath;
});

ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '载入项目',
    properties: ['openFile'],
    filters: [{ name: '项目文件', extensions: ['sps.json'] }, { name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled) return null;
  return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
});

ipcMain.handle('fs:readImage', async (_e, filePath) => {
  const buf = fs.readFileSync(filePath);
  return buf.toString('base64');
});

ipcMain.handle('shell:showItem', async (_e, p) => shell.showItemInFolder(p));