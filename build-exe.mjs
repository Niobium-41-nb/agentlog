#!/usr/bin/env node
/**
 * build-exe.mjs —— 把 agentlog 打包成 Windows 单文件可执行程序 agentlog.exe
 *
 * 用的是 Node.js 自带的 SEA（Single Executable Application）能力：
 * 把脚本打成 blob，再注入到 node.exe 的副本里。产物自带 Node 运行时，
 * 目标机器上不需要装 Node.js，也不需要任何第三方库。
 *
 * 用法：
 *   node build-exe.mjs                 # 产出 dist/agentlog.exe
 *   node build-exe.mjs --out <目录>     # 指定输出目录
 *   node build-exe.mjs --keep           # 保留中间产物，便于排查
 *
 * 前提：
 *   - Node.js >= 22.5（用到 --experimental-sea-config）
 *   - 构建时需要 postject（会自动安装到 .build 目录，不污染项目依赖）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(ROOT, '.build');
const IS_WIN = process.platform === 'win32';

// ─────────────────────────── 参数 ───────────────────────────

const args = process.argv.slice(2);
let outDir = path.join(ROOT, 'dist');
let keep = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = path.resolve(args[++i]);
  else if (args[i] === '--keep') keep = true;
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('用法：node build-exe.mjs [--out <目录>] [--keep]');
    process.exit(0);
  }
}

// ─────────────────────────── 环境检查 ───────────────────────────

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`需要 Node.js >= 22.5，当前 ${process.version}`);
  process.exit(1);
}

const ENGINE = path.join(ROOT, 'agentlog.mjs');
const GUI = path.join(ROOT, 'agentlog-gui.ps1');
for (const f of [ENGINE, GUI]) {
  if (!fs.existsSync(f)) {
    console.error(`缺少文件：${f}`);
    process.exit(1);
  }
}

// ─────────────────────────── 1. ESM → CommonJS ───────────────────────────
// SEA 的入口只能是 CommonJS（实测 .mjs 会以普通脚本方式加载并报语法错），
// 而 agentlog.mjs 只用了 5 条静态 import、没有 export / 顶层 await，
// 因此可以机械地等价改写。

function toCommonJs(src) {
  // CJS 里 shebang 不是合法语法（Node 只在直接执行主模块时才剥掉），必须先去掉
  let out = src.replace(/^#!.*\r?\n/, '');
  out = out.replace(/^import\s+(\w+)\s+from\s+'([^']+)';\s*$/gm, "const $1 = require('$2');");
  out = out.replace(/^import\s+\{([^}]+)\}\s+from\s+'([^']+)';\s*$/gm, "const {$1} = require('$2');");
  out = out.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)';\s*$/gm, "const $1 = require('$2');");

  const leftover = out.match(/^\s*import\s+[\w{*]/m);
  if (leftover) {
    console.error('无法自动转换为 CommonJS，仍存在静态 import：', leftover[0].trim());
    console.error('请改写 agentlog.mjs 后重试。');
    process.exit(1);
  }
  return out;
}

// ─────────────────────────── 2. 启动引导（图形界面） ───────────────────────────
// 双击 exe（不带参数）或显式 --gui 时，把内嵌的 PowerShell 界面释放到临时目录并启动，
// 同时把自身路径作为采集引擎传给界面——这样 exe 单文件即可完成全部工作。

const BOOTSTRAP = String.raw`'use strict';
/* agentlog.exe 启动引导：无参数 / --gui 时唤起 Windows 原生界面 */
(function bootstrap() {
  var fs = require('node:fs');
  var os = require('node:os');
  var path = require('node:path');
  var spawnSync = require('node:child_process').spawnSync;

  // 单文件模式下没法用 --no-warnings，这里在进程内滤掉实验特性提示，
  // 避免用户看到的输出里混进 "ExperimentalWarning: SQLite..." 之类的噪音
  var rawEmit = process.emit;
  process.emit = function (name) {
    if (name === 'warning' && arguments[1] && arguments[1].name === 'ExperimentalWarning') return false;
    return rawEmit.apply(this, arguments);
  };

  var argv = process.argv.slice(2);
  var selfPath = process.execPath;
  var guiIdx = -1;
  for (var gi = 0; gi < argv.length; gi++) {
    if (argv[gi] === '--gui' || argv[gi] === 'gui' || argv[gi] === '/gui') { guiIdx = gi; break; }
  }
  var isGuiCmd = guiIdx >= 0;
  // 不带任何参数（典型场景：双击）或显式要求界面 —— 走图形界面
  if (!isGuiCmd && argv.length !== 0) return;

  if (process.platform !== 'win32') {
    console.error('图形界面仅在 Windows 上可用。命令行用法：agentlog <工作区目录> [选项]');
    process.exit(1);
  }

  // 优先取打进 exe 里的界面脚本，取不到再退回同目录的 .ps1
  var ps1 = null;
  try {
    ps1 = Buffer.from(require('node:sea').getAsset('gui.ps1')).toString('utf8');
  } catch (e) {
    ps1 = null;
  }
  if (!ps1) {
    var sibling = path.join(path.dirname(selfPath), 'agentlog-gui.ps1');
    if (fs.existsSync(sibling)) ps1 = fs.readFileSync(sibling, 'utf8');
  }
  if (!ps1) {
    console.error('未找到图形界面脚本 agentlog-gui.ps1');
    process.exit(1);
  }
  // 源脚本自带 BOM，这里先剥掉，写入时统一补一个（两个 BOM 会让 PowerShell 认不出 param 块）
  ps1 = ps1.replace(/^\uFEFF/, '');

  var dir = path.join(os.tmpdir(), 'agentlog-gui');
  fs.mkdirSync(dir, { recursive: true });
  var target = path.join(dir, 'agentlog-gui.ps1');
  // PowerShell 5.1 靠 BOM 判断 UTF-8，否则中文全部乱码
  fs.writeFileSync(target, '\uFEFF' + ps1, 'utf8');

  var rest = isGuiCmd ? argv.slice(0, guiIdx).concat(argv.slice(guiIdx + 1)) : argv;
  var psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', target, '-EngineExe', selfPath];
  var ws = null;
  for (var i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('-')) { ws = rest[i]; break; }
  }
  if (ws) psArgs.push('-Workspace', ws);

  var r = spawnSync('powershell.exe', psArgs, { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
})();

`;

// ─────────────────────────── 3. 生成 SEA 入口 ───────────────────────────

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

const seaMain = path.join(BUILD_DIR, 'sea-main.cjs');
fs.writeFileSync(seaMain, BOOTSTRAP + toCommonJs(fs.readFileSync(ENGINE, 'utf8')), 'utf8');
console.log(`[1/5] 生成 CommonJS 入口：${path.relative(ROOT, seaMain)}`);

// ─────────────────────────── 4. 生成 blob ───────────────────────────

const seaConfig = path.join(BUILD_DIR, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: seaMain,
      output: path.join(BUILD_DIR, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: { 'gui.ps1': GUI },
    },
    null,
    2,
  ),
  'utf8',
);

const blob = path.join(BUILD_DIR, 'sea-prep.blob');
console.log('[2/5] 生成 SEA blob…');
const gen = spawnSync(process.execPath, ['--experimental-sea-config', seaConfig], { encoding: 'utf8' });
if (gen.status !== 0 || !fs.existsSync(blob)) {
  console.error(gen.stdout || '');
  console.error(gen.stderr || '');
  console.error('生成 blob 失败');
  process.exit(1);
}

// ─────────────────────────── 5. 注入到 node.exe 副本 ───────────────────────────

const exeName = IS_WIN ? 'agentlog.exe' : 'agentlog';
fs.mkdirSync(outDir, { recursive: true });
const outExe = path.join(outDir, exeName);
fs.copyFileSync(process.execPath, outExe);
console.log(`[3/5] 复制运行时：${path.relative(ROOT, outExe)}`);

const postject = resolvePostject();
if (!postject) {
  console.error('未能获取 postject（需要联网执行一次 npm install postject）');
  process.exit(1);
}
console.log('[4/5] 注入 blob…');
const inject = spawnSync(
  process.execPath,
  [postject, outExe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  { encoding: 'utf8' },
);
if (inject.status !== 0) {
  console.error(inject.stdout || '');
  console.error(inject.stderr || '');
  console.error('注入失败');
  process.exit(1);
}
if (inject.stderr) process.stderr.write(inject.stderr);

// ─────────────────────────── 6. 冒烟测试 ───────────────────────────

console.log('[5/5] 冒烟测试…');
const smoke = spawnSync(outExe, ['--version'], { encoding: 'utf8' });
const ver = (smoke.stdout || '').trim() || (smoke.stderr || '').trim();
if (smoke.status !== 0) {
  console.error('exe 运行失败：', ver);
  process.exit(1);
}
console.log(`      ${ver}`);

const sizeMb = (fs.statSync(outExe).size / 1024 / 1024).toFixed(1);
console.log('');
console.log(`完成：${outExe}（${sizeMb} MB）`);
console.log('不带参数运行或加 --gui 会启动 Windows 原生图形界面。');

if (!keep) fs.rmSync(BUILD_DIR, { recursive: true, force: true });

// ─────────────────────────── 工具：定位 postject ───────────────────────────

function resolvePostject() {
  if (process.env.POSTJECT_CLI && fs.existsSync(process.env.POSTJECT_CLI)) return process.env.POSTJECT_CLI;

  const require_ = createRequire(import.meta.url);
  const roots = [ROOT, process.cwd(), path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace')];
  for (const r of roots) {
    try {
      const p = require_.resolve('postject/dist/cli.js', { paths: [r] });
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* 继续找下一个候选 */
    }
  }

  // 都没有就临时装一个，装在项目内的 .build 目录里，不写进 package.json
  console.log('      未找到 postject，正在安装到 .build/ …');
  const ins = spawnSync(
    process.execPath,
    [
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      'install',
      '--prefix',
      BUILD_DIR,
      '--no-save',
      '--no-audit',
      '--no-fund',
      'postject',
    ],
    { encoding: 'utf8' },
  );
  if (ins.status !== 0) return null;
  const p = path.join(BUILD_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
  return fs.existsSync(p) ? p : null;
}
