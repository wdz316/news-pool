#!/usr/bin/env node
'use strict';
/*
 * 共享新闻池 · 一键发布
 *
 * 用法：
 *   npm run release                                 按 package.json 的 version 发布（会先让你确认）
 *   npm run release -- --yes                        跳过确认
 *   npm run release -- --notes 路径.md              自定义 Release 说明（Markdown）
 *   npm run release -- --attach dist/使用手册.pdf    额外附带文件（可重复；发布前先生成）
 *
 * 它只做「把你的代码同步到独立仓库并发布」，全部走 git / gh 官方命令：
 *   1. 读 package.json 的 version 与 repository
 *   2. 把远程仓库浅克隆到临时目录，用本地代码原样覆盖（排除 node_modules/data/dist/日志）
 *   3. 提交并推送到当前主分支
 *   4. 打 tag v<version> 并推送
 *   5. 生成 zip、算 SHA256
 *   6. 用 gh 创建 Release（附 zip + 你指定的额外文件）
 *
 * 不会动你主仓库（news-pool 所在的那个仓库）的任何东西。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = 'v' + VERSION;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, def) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const YES = has('--yes');
const NOTES = opt('--notes', '');
const ATTACH = argv.reduce((acc, a, i) => (a === '--attach' && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);

function fail(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }
function capture(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function run(cmd, args, cwd = ROOT) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/* ---------- 0. 前置检查 ---------- */
try { capture('git', ['--version']); } catch { fail('找不到 git，请先安装 Git。'); }
try { capture('gh', ['auth', 'status']); } catch { fail('gh 未登录。请先运行：gh auth login'); }

const repoUrl = String((typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || ''));
const clean = repoUrl.replace(/\.git$/, '');
const m = clean.match(/github\.com[/:]([^/]+)\/(.+)$/);
if (!m) fail('package.json 里没有可识别的 repository（形如 https://github.com/用户名/仓库）。');
const OWNER = m[1];
const REPO = m[2];

/* ---------- 1. 标签是否已存在 ---------- */
try {
  const existing = capture('git', ['ls-remote', '--tags', repoUrl, 'refs/tags/' + TAG]);
  if (existing) fail(`标签 ${TAG} 在远程已存在。请先提升 package.json 的 version 再发布。`);
} catch (e) {
  if (String(e.message || '').includes('已存在')) throw e;
  // 远程仓库可能还不存在 / 无网络读，留给后面 clone 步骤报错
}

/* ---------- 2. 确认 ---------- */
const attachedExisting = ATTACH.filter((f) => fs.existsSync(path.resolve(ROOT, f)));
function plan() {
  console.log('');
  console.log('  共享新闻池 · 一键发布');
  console.log('  ' + '-'.repeat(46));
  console.log('  仓库      : ' + OWNER + '/' + REPO);
  console.log('  版本      : ' + VERSION + '  (tag ' + TAG + ')');
  console.log('  说明文件  : ' + (NOTES ? path.resolve(ROOT, NOTES) : '（自动生成）'));
  console.log('  额外附件  : ' + (attachedExisting.length ? attachedExisting.join(', ') : '（无）'));
  console.log('  ' + '-'.repeat(46));
  console.log('  将执行：clone → 覆盖 → commit → push → tag → zip+SHA256 → gh release');
  console.log('');
}
plan();

async function confirm() {
  if (YES) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question('  确认发布？输入 y 回车继续：', res));
  rl.close();
  if (ans.trim().toLowerCase() !== 'y') { console.log('  已取消。'); process.exit(0); }
}

/* ---------- 主流程 ---------- */
async function main() {
  await confirm();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'np-publish-'));
  try {
    console.log('\n[1/6] 克隆远程仓库到临时目录…');
    try {
      run('git', ['clone', '--depth', '1', repoUrl, work]);
    } catch {
      console.log('  远程仓库不存在，正在用 gh 创建…');
      run('gh', ['repo', 'create', OWNER + '/' + REPO, '--public',
        '--description', String(pkg.description || '')], ROOT);
      run('git', ['clone', repoUrl, work]);
    }

    console.log('[2/6] 用本地代码覆盖（排除 node_modules / data / dist / 日志）…');
    // 临时克隆里可能没有提交身份（很多人只在本仓库配过 user.name/email）。
    // 从 gh 登录账号推导一个，只写进这个临时目录。
    let hasIdentity = true;
    try { capture('git', ['config', 'user.email'], work); } catch { hasIdentity = false; }
    if (!hasIdentity) {
      let login = '';
      try { login = capture('gh', ['api', 'user', '--jq', '.login']); } catch { /* ignore */ }
      const name = login || 'news-pool';
      const email = (login || 'news-pool') + '@users.noreply.github.com';
      run('git', ['config', 'user.name', name], work);
      run('git', ['config', 'user.email', email], work);
      console.log('  已为本次提交设置身份：' + name + ' <' + email + '>');
    }
    const EXCLUDE = new Set(['node_modules', 'data', '.git', 'dist']);
    for (const e of fs.readdirSync(work)) {
      if (e === '.git') continue;
      fs.rmSync(path.join(work, e), { recursive: true, force: true });
    }
    fs.cpSync(ROOT, work, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(ROOT, src);
        if (!rel) return true;
        const parts = rel.split(path.sep);
        if (parts.some((p) => EXCLUDE.has(p))) return false;
        if (/\.log$/i.test(rel)) return false;
        return true;
      }
    });

    console.log('[3/6] 提交并推送…');
    const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], work) || 'main';
    if (!capture('git', ['status', '--porcelain'], work)) fail('本地与远程一致，没有需要发布的新改动。');
    run('git', ['add', '-A'], work);
    run('git', ['commit', '-m', '共享新闻池 ' + TAG], work);
    run('git', ['push', 'origin', 'HEAD:' + branch], work);

    console.log('[4/6] 打标签并推送…');
    run('git', ['tag', '-a', TAG, '-m', '共享新闻池 ' + TAG], work);
    run('git', ['push', 'origin', TAG], work);

    console.log('[5/6] 生成 zip 并计算 SHA256…');
    const distDir = path.join(ROOT, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const zipName = 'news-pool-' + TAG + '.zip';
    const zipPath = path.join(distDir, zipName);
    fs.rmSync(zipPath, { force: true });
    run('git', ['archive', '--format=zip', '-o', zipPath, TAG], work);
    const sum = sha256(zipPath);
    console.log('  ' + zipName + '  ' + fs.statSync(zipPath).size + ' 字节');
    console.log('  SHA256: ' + sum);

    console.log('[6/6] 创建 GitHub Release…');
    // GitHub Release 的附件名要 ASCII：中文名会被存成 default.pdf，所以先换成 ASCII 文件名再传
    const isAscii = (s) => /^[\x20-\x7e]+$/.test(s);
    const attachFiles = [];
    attachedExisting.forEach((f) => {
      const abs = path.resolve(ROOT, f);
      const base = path.basename(abs);
      if (isAscii(base)) { attachFiles.push(abs); return; }
      const ext = path.extname(base);
      const stem = path.basename(base, ext).replace(/[^\x20-\x7e]/g, '').trim() || 'attachment';
      const safe = path.join(distDir, stem + ext);
      fs.copyFileSync(abs, safe);
      console.log('  附件中文名已改为 ASCII：' + base + ' → ' + path.basename(safe));
      attachFiles.push(safe);
    });
    const attachList = attachFiles.length
      ? '\n### 📎 附件\n' + attachFiles.map((f) => '- `' + path.basename(f) + '`').join('\n') + '\n'
      : '';
    const dlSection = [
      '### 📦 下载校验（防掉包）',
      '- 文件：`' + zipName + '`（' + fs.statSync(zipPath).size + ' 字节）',
      '- **SHA256**：`' + sum + '`',
      '',
      '核对方法：',
      '- Windows：`Get-FileHash .\\' + zipName + ' -Algorithm SHA256`',
      '- macOS / Linux：`shasum -a 256 ' + zipName + '`',
      attachList
    ].join('\n');
    const notesFile = path.join(distDir, 'RELEASE_NOTES-' + TAG + '.md');
    const head = NOTES
      ? fs.readFileSync(path.resolve(ROOT, NOTES), 'utf8').trimEnd() + '\n\n'
      : '## 共享新闻池 ' + TAG + '\n\n';
    const tail = NOTES ? '' : [
      '### 🚀 快速开始',
      '1. 解压 → 双击 `start.bat`（Windows）/ 运行 `./start.sh`（macOS / Linux）',
      '2. 浏览器打开 <http://localhost:3210>',
      '3. 默认账号 `alice` / `bob` / `carol`（密码 `123456`），成员模式密码 `admin888`',
      '   > ⚠️ 正式使用前请改掉全部默认密码。',
      '',
      '用法见仓库 `部署指南.md`；安全与自验见 `SECURITY.md`。',
      ''
    ].join('\n');
    fs.writeFileSync(notesFile, head + dlSection + '\n' + tail);

    const releaseArgs = ['release', 'create', TAG,
      '--title', TAG + ' · 共享新闻池',
      '--notes-file', notesFile,
      zipPath];
    for (const f of attachFiles) releaseArgs.push(f);
    run('gh', releaseArgs, work);

    console.log('\n✓ 发布完成');
    console.log('  仓库   : https://github.com/' + OWNER + '/' + REPO);
    console.log('  Release: https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + TAG);
    console.log('  SHA256 : ' + sum);
    console.log('');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('\n✗ 发布失败：' + (e && (e.stderr || e.message) || e));
  process.exit(1);
});
