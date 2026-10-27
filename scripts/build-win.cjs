/**
 * Windows 打包脚本（不依赖 electron-builder）
 *
 * 为什么不用 electron-builder：其 winCodeSign 依赖解压含 macOS 符号链接的归档，
 * Windows 普通权限下会失败（需管理员/开发者模式）。@electron/packager 是纯 JS 打包，
 * 不依赖该环节；图标/版本信息通过 rcedit 写入。
 *
 * 用法：
 *   node scripts/build-win.cjs            # 生成未压缩目录
 *   node scripts/build-win.cjs --zip      # 额外生成 zip 便携包
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const WANT_ZIP = process.argv.includes('--zip');
// BUILD_TAG 用于区分多次打包产物：本机删除操作受安全策略限制，脚本不假设能覆盖旧产物
process.env.BUILD_TAG ||= String(Date.now()).slice(-6);
// 每次打包输出到独立目录，让多次结果可并存对比
const OUT = path.join(ROOT, 'release', 'v' + pkg.version + '-' + process.env.BUILD_TAG);

const NAME = 'SeedPhenotype Studio';
const EXE = 'SeedPhenotype Studio.exe';

// GitHub 直连不通时，走 npmmirror 的 Electron 镜像；已下载的 zip 会命中本地缓存
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';

/** 把应用源码按白名单拷到暂存目录，确保 asar 里只有运行必需内容 */
function stageApp() {
  const stage = path.join(OUT, '.stage-app');
  fs.mkdirSync(stage, { recursive: true });

  const copy = (rel) => {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) return;
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  };

  copy('src');
  copy('electron/main.cjs');
  copy('electron/preload.cjs');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
  // 打包入口必须是主进程本体；devDependencies 一并剥掉，避免被打进 asar
  const appPkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  appPkg.main = 'electron/main.cjs';
  appPkg.devDependencies = {};
  appPkg.scripts = {};
  delete appPkg.build;
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(appPkg, null, 2));
  return stage;
}

(async () => {
  const { packager } = require('@electron/packager');

  // BUILD_TAG 未提供时用时间戳，保证目录唯一
  const stage = stageApp();

  const paths = await packager({
    dir: stage,
    out: OUT,
    name: NAME,
    appVersion: pkg.version,
    buildVersion: '0.1.0.0',
    platform: 'win32',
    arch: 'x64',
    electronVersion: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
    prune: true,
    asar: true,
    icon: path.join(ROOT, 'build', 'icon.ico'),
    win32metadata: {
      CompanyName: 'SeedPhenotype Studio',
      FileDescription: '植物籽粒表型测定与科研级论文图片生成工具',
      ProductName: NAME,
      InternalName: NAME,
    },
  });

  // 打包器在目标目录已存在时会跳过并返回空数组，此时直接复用既有产物
  const appDir = paths[0] || path.join(OUT, `${NAME}-win32-x64`);
  const exePath = path.join(appDir, EXE);
  console.log('[build] 应用目录:', appDir);
  console.log('[build] 可执行文件:', exePath, fs.existsSync(exePath) ? '✓' : '✗ 缺失');

  if (!fs.existsSync(exePath)) {
    console.error('[build] 可执行文件不存在，打包失败');
    process.exit(1);
  }

  // 校验 asar 内确实含有运行所需文件
  const asarPath = path.join(appDir, 'resources', 'app.asar');
  if (fs.existsSync(asarPath)) {
    console.log('[build] asar 大小:', (fs.statSync(asarPath).size / 1048576).toFixed(1), 'MB');
  } else {
    console.error('[build] 未找到 app.asar，打包可能不完整');
    process.exit(1);
  }

  if (WANT_ZIP) {
    console.log('[build] 生成 zip 便携包…');
    // 用自带的 7-Zip（PowerShell 的 Compress-Archive 对含空格的长路径易抛权限错误）
    const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
    const zipPath = path.join(OUT, `${NAME}-${pkg.version}-portable.zip`);
    execFileSync(sevenZip, [
      'a', '-tzip', '-bd', '-y', '-mx=7',
      zipPath, path.join(appDir, '*'),
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    console.log('[build] zip:', zipPath, (fs.statSync(zipPath).size / 1048576).toFixed(1), 'MB');
  }

  console.log('[build] 完成');
})().catch((e) => {
  console.error('[build] 失败:', e && e.stack || e);
  process.exit(1);
});