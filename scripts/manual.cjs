#!/usr/bin/env node
'use strict';
/*
 * 共享新闻池 · 使用手册 → PDF
 *
 * 把 docs/使用手册.html 用本机自带的 Edge / Chrome 无头模式打印成 PDF。
 * 不需要联网、不需要额外依赖（Windows 一定有 Edge）。
 *
 * 用法：npm run manual
 * 产物：dist/使用手册.pdf
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', '使用手册.html');
const OUT_DIR = path.join(ROOT, 'dist');
const TMP = path.join(OUT_DIR, 'manual.pdf');          // 先用 ASCII 名，避免中文路径问题
const OUT = path.join(OUT_DIR, '使用手册.pdf');

if (!fs.existsSync(SRC)) { console.error('✗ 找不到 docs/使用手册.html'); process.exit(1); }

const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const local = process.env['LOCALAPPDATA'] || '';
const candidates = [
  path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

const browser = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!browser) {
  console.error('✗ 没找到 Edge 或 Chrome。');
  console.error('  也可以直接双击 docs/使用手册.html，用浏览器「打印 → 另存为 PDF」。');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(TMP, { force: true });

const fileUrl = 'file:///' + SRC.replace(/\\/g, '/');
console.log('  浏览器 : ' + browser);
console.log('  源文件 : docs/使用手册.html');
console.log('  正在生成 PDF…');

execFileSync(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-pdf-header-footer',
  '--virtual-time-budget=4000',
  '--print-to-pdf=' + TMP,
  fileUrl
], { stdio: ['ignore', 'ignore', 'ignore'] });

if (!fs.existsSync(TMP) || fs.statSync(TMP).size === 0) {
  console.error('✗ 生成失败（浏览器没有输出文件）。可改用：双击 docs/使用手册.html → 打印 → 另存为 PDF');
  process.exit(1);
}
fs.rmSync(OUT, { force: true });
fs.renameSync(TMP, OUT);
console.log('✓ 已生成：' + path.relative(ROOT, OUT) + '  (' + fs.statSync(OUT).size + ' 字节)');
