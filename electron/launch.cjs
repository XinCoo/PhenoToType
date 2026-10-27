'use strict';
/**
 * 启动包装器：清除污染 Electron 的环境变量后再拉起主进程。
 *
 * 背景：部分宿主环境（IDE 内置终端、CI、部分 WSL/Git Bash 配置）会预设
 * ELECTRON_RUN_AS_NODE=1。该变量会让 Electron 二进制以纯 Node 模式运行，
 * 此时 require('electron') 只会返回二进制路径字符串，app / BrowserWindow 全为
 * undefined，窗口无法创建。由于该变量在 native 层于进程启动时读取，
 * 只能在拉起 Electron 之前从环境里删除。
 */
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');   // 未污染时返回 exe 路径

const env = { ...process.env };
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[k];

const child = spawn(electron, [path.join(__dirname, 'main.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('close', (code) => process.exit(code ?? 0));