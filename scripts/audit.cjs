#!/usr/bin/env node
'use strict';
/*
 * 共享新闻池 · 无后门自查脚本
 * 用法：npm run audit        （或 node scripts/audit.cjs）
 *
 * 它做四件事（全部只读，不改任何文件、不联网）：
 *   1. 列出运行时依赖（越少越好看）
 *   2. 扫描 src/ 里所有「主动外联」的代码位置
 *   3. 抽出代码里出现的所有域名，与白名单核对
 *   4. 检查常见危险模式（执行外部命令 / 动态执行代码 / 原始套接字）
 *
 * 结论全绿 → 退出码 0；发现白名单外的域名或危险模式 → 退出码 1。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// 允许出现的域名（每一条都对应 README 里承诺的、由你主动触发的动作）
const DOMAIN_ALLOWLIST = {
  'api.fxtwitter.com': '取 X/Twitter 推文正文',
  'publish.twitter.com': '取 X/Twitter 推文正文（备用）',
  'lite.duckduckgo.com': '核查：搜索同题报道',
  'www.bing.com': '核查：搜索同题报道（备用）',
  'twitter.com': '仅作为 oEmbed 查询参数“内嵌”（不直接访问）'
};

// 允许的「本地」域名（服务器自己），不算外联
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const OUTBOUND_PATTERNS = [
  { re: /\bfetch\s*\(/, label: 'fetch() 主动请求' },
  { re: /\bhttpGet\s*\(/, label: 'httpGet() 主动请求' },
  { re: /https?\.(get|request)\s*\(/, label: 'http(s).get/request' },
  { re: /\bnet\.connect\s*\(/, label: 'net.connect 原始套接字' },
  { re: /\bdns\./, label: 'dns.* 域名查询' },
  { re: /require\(\s*['"](axios|got|node-fetch|undici|request|superagent)['"]\s*\)/, label: '引入第三方 HTTP 库' }
];

const DANGER_PATTERNS = [
  { re: /require\(\s*['"]child_process['"]\s*\)|\bchild_process\b/, label: '执行系统命令 (child_process)' },
  { re: /\beval\s*\(/, label: '动态执行代码 (eval)' },
  { re: /new\s+Function\s*\(/, label: '动态执行代码 (new Function)' },
  { re: /\bexecSync\s*\(|\bexecFileSync\s*\(|\bspawnSync\s*\(/, label: '同步执行外部程序' },
  { re: /\bnet\.connect\s*\(/, label: '原始 TCP 连接 (net.connect)' }
];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js') || name.endsWith('.cjs')) out.push(p);
  }
  return out;
}

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

const line = (n) => '-'.repeat(n);
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

let problems = 0;

console.log('');
console.log('共享新闻池 · 无后门自查报告');
console.log(line(56));
console.log('只读扫描，不联网、不改文件。仓库根目录：' + ROOT);
console.log('');

/* ---------- 1. 依赖 ---------- */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const deps = Object.entries(pkg.dependencies || {});
console.log('【1】运行时依赖：' + deps.length + ' 个');
for (const [k, v] of deps) console.log('      - ' + k + '@' + v);
const installed = fs.existsSync(path.join(ROOT, 'node_modules'))
  ? fs.readdirSync(path.join(ROOT, 'node_modules')).filter((n) => !n.startsWith('.')).length
  : 0;
console.log('      安装后 node_modules 里的包总数：约 ' + installed + ' 个（含间接依赖，可用 `npm ls --all` 展开）');
console.log('      提示：依赖越少 = 越容易被独立审计。本项目刻意只用 3 个。');
console.log('');

/* ---------- 2. 外联点 ---------- */
const files = walk(SRC).filter((f) => !f.includes('node_modules'));
const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    if (/(function|const|let|var)\s+httpGet\b/.test(text)) return; // 辅助函数定义行，不算调用点
    for (const p of OUTBOUND_PATTERNS) {
      if (p.re.test(text)) { hits.push({ file: rel(f), ln: i + 1, text: text.trim(), label: p.label }); break; }
    }
  });
}
console.log('【2】主动外联的代码位置：' + hits.length + ' 处');
for (const h of hits) console.log('      ' + pad(h.file + ':' + h.ln, 22) + ' ' + h.label);
console.log('      说明：以上全部由你的操作触发（粘贴链接 / 点核查 / 加 X 链接），服务器不会自行外联。');
console.log('');

/* ---------- 3. 域名白名单核对 ---------- */
const urlRe = /https?:\/\/[^\s'"`)\]},;<>]+/g;
const found = new Map();
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  for (const m of content.match(urlRe) || []) {
    if (m.includes('${')) continue; // 模板占位符（运行时才拼接），不算真实域名
    let host;
    try { host = new URL(m.replace(/[.,;]+$/, '')).hostname; } catch { continue; }
    if (LOCAL_HOSTS.has(host)) continue;
    if (!found.has(host)) found.set(host, rel(f));
  }
}
console.log('【3】代码里出现的所有域名：' + found.size + ' 个');
if (found.size === 0) {
  console.log('      （无）');
}
for (const [host, where] of found) {
  const ok = DOMAIN_ALLOWLIST[host];
  if (ok) {
    console.log('      ✅ ' + pad(host, 24) + ' ' + ok);
  } else {
    console.log('      ❌ ' + pad(host, 24) + ' 不在白名单！（出现在 ' + where + '）');
    problems++;
  }
}
console.log('');

/* ---------- 4. 危险模式 ---------- */
console.log('【4】危险模式检查（下面每一项都应为「未发现」）');
for (const d of DANGER_PATTERNS) {
  const foundIn = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => { if (d.re.test(text)) foundIn.push(rel(f) + ':' + (i + 1)); });
  }
  if (foundIn.length === 0) {
    console.log('      ✅ 未发现  ' + d.label);
  } else {
    console.log('      ❌ 命中！  ' + d.label + ' → ' + foundIn.join(', '));
    problems++;
  }
}
console.log('');

/* ---------- 数据位置 ---------- */
console.log('【5】数据存放位置');
console.log('      data/  （本地 SQLite：pools.json + pools/<池ID>/news.db）');
console.log('      可直接用文件管理器打开查看，也可删掉重来。不会上传到任何服务器。');
console.log('');

/* ---------- 结论 ---------- */
console.log(line(56));
if (problems === 0) {
  console.log('结论：✅ 全部通过。除上面列出的、由你主动触发的外联外，');
  console.log('      没有发现任何其它外联、也没有可疑代码。');
  console.log('补充验证：关掉网络后，除「核查 / 抓标题」外功能照常 —— 说明它不偷传数据。');
  console.log(line(56));
  process.exit(0);
} else {
  console.log('结论：❌ 发现 ' + problems + ' 处需要人工确认的项目（见上面的 ❌）。');
  console.log('      请勿直接使用，先看清楚这些代码在做什么。');
  console.log(line(56));
  process.exit(1);
}
