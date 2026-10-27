/**
 * UI冒烟测试包装器
 * 宿主环境可能预设 ELECTRON_RUN_AS_NODE=1（会让 Electron 以纯 Node 模式运行，
 * 导致 BrowserWindow 不可用），这里在拉起前剔除该变量，并把 [冒烟] JSON 解析成可读报告。
 * 用法：node test/smoke/smoke.electron.cjs
 */
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[k];

const r = spawnSync(electron, [path.join(__dirname, 'smoke.cjs')], {
  encoding: 'utf8', env, timeout: 180000,
});

const out = `${r.stdout || ''}${r.stderr || ''}`;
const line = out.split(/\r?\n/).find((l) => l.includes('[冒烟]{'));
if (!line) {
  console.error(out.slice(-3000) || '(无输出)');
  console.error('\n[smoke] 未能解析冒烟报告，Electron 退出码 ' + r.status);
  process.exit(1);
}

let rep;
try {
  rep = JSON.parse(line.slice(line.indexOf('[冒烟]') + '[冒烟]'.length));
} catch (e) {
  console.error('报告 JSON 解析失败：' + e.message);
  process.exit(1);
}

rep.checks.forEach((c) => {
  console.log((c.pass ? '  ✓ ' : '  ✗ ') + c.name + (c.pass ? '' : '   [' + c.detail + ']'));
});
console.log(`\n[smoke] 通过 ${rep.ok} 项，失败 ${rep.fail} 项`);

// 渲染进程报错也算失败
if (/渲染进程有错误|Fatal|Error: /.test(out) && rep.fail === 0 && rep.ok === 0) process.exit(1);
process.exit(rep.fail === 0 ? 0 : 1);