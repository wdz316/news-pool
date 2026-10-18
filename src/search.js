'use strict';

// 交叉核查：把一条消息的标题拿到其他来源搜索，列出同题报道，辅助判断真伪。
// 引擎：DuckDuckGo Lite（主）→ Bing（备，html 抓取）。
// 测试：设置环境变量 NEWS_POOL_SEARCH_STUB 为 JSON 数组，可注入固定结果（不联网）。

const dedup = require('./dedup');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = Number(process.env.NEWS_POOL_SEARCH_TIMEOUT || 8000);
const MAX_RESULTS = 8;

function decode(s) {
  return dedup.decodeHtmlEntities(String(s || '')).replace(/\s+/g, ' ').trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

async function httpGet(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** DDG 跳转链接（//duckduckgo.com/l/?uddg=...）-> 真实 URL */
function realDdgUrl(href) {
  let h = String(href || '').trim();
  if (!h) return '';
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    return uddg || u.href;
  } catch {
    return '';
  }
}

/** 解析 DuckDuckGo Lite 结果页 */
function parseDdgLite(html) {
  const out = [];
  const links = [...html.matchAll(/<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
  const snips = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)];
  for (let i = 0; i < links.length && out.length < MAX_RESULTS; i++) {
    const anchor = links[i][0];
    const hm = /href=['"]([^'"]+)['"]/i.exec(anchor);
    const url = hm ? realDdgUrl(hm[1]) : '';
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      title: decode(links[i][1].replace(/<[^>]+>/g, '')) || url,
      url,
      source: hostOf(url),
      snippet: snips[i] ? decode(snips[i][1].replace(/<[^>]+>/g, '')) : ''
    });
  }
  return out;
}

/** 解析 Bing 结果页 */
function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const b of blocks) {
    if (out.length >= MAX_RESULTS) break;
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = decode(a[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const sp = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b);
    out.push({
      title: decode(a[2].replace(/<[^>]+>/g, '')) || url,
      url,
      source: hostOf(url),
      snippet: sp ? decode(sp[1].replace(/<[^>]+>/g, '')) : ''
    });
  }
  return out;
}

async function searchDdg(query) {
  const html = await httpGet('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query));
  return html ? parseDdgLite(html) : null;
}

async function searchBing(query) {
  const html = await httpGet('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-hans');
  return html ? parseBing(html) : null;
}

/** 把一段文字整理成搜索关键字：去链接、压空白、限长 */
function cleanQuery(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/**
 * 联网搜索同题报道。
 * @returns {Promise<{engine:string|null, query:string, results:Array, error:string|null}>}
 */
async function webSearch(query) {
  const q = String(query || '').trim();
  if (!q) return { engine: null, query: q, results: [], error: '缺少查询词' };

  // 测试注入
  if (process.env.NEWS_POOL_SEARCH_STUB) {
    try {
      return { engine: 'stub', query: q, results: JSON.parse(process.env.NEWS_POOL_SEARCH_STUB), error: null };
    } catch {
      return { engine: 'stub', query: q, results: [], error: 'stub 解析失败' };
    }
  }

  try {
    const ddg = await searchDdg(q);
    if (ddg && ddg.length) return { engine: 'duckduckgo', query: q, results: ddg, error: null };
  } catch { /* 尝试下一个引擎 */ }

  try {
    const bing = await searchBing(q);
    if (bing && bing.length) return { engine: 'bing', query: q, results: bing, error: null };
  } catch { /* 忽略 */ }

  return { engine: null, query: q, results: [], error: '未找到其他来源或搜索引擎暂不可用' };
}

module.exports = { webSearch, cleanQuery, parseDdgLite, parseBing, realDdgUrl, hostOf };
