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
// Linux CI 容器（GitHub Actions runner）里 Electron 自带 chrome-sandbox 需要
// root 且 mode 4755，实际不具备，否则进程直接 FATAL 退出：
//   "The SUID sandbox helper binary was found, but is not configured correctly."
// 这里连同环境变量与命令行开关一起禁用 sandbox，双保险。
if (process.platform === 'linux') env.ELECTRON_DISABLE_SANDBOX = '1';

// 同上：Linux 下必须显式 --no-sandbox，否则 xvfb 也救不了，进程会以 FATAL 直接退出，
// stdout 里拿不到 [冒烟] 报告，表现为“未能解析冒烟报告，Electron 退出码 null”。
const args = [];
if (process.platform === 'linux') {
  args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
}
args.push(path.join(__dirname, 'smoke.cjs'));

const r = spawnSync(electron, args, {
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