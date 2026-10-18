'use strict';

// 去重核心：URL 规范化 + 标题规范化 + 标题相似度(Jaccard)
// 标题提取：og:title / twitter:title / JSON-LD headline / <title>，并做站点名清洗；
//           抓不到或抓到的是站点名时，用 URL 路径 slug 兜底。
// 契约见 CONTRACT v1。

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid',
  'ref', 'ref_src', 'spm', 'scm', 'mc_cid', 'mc_eid', '_ga',
  'wt_mc', 'share_token', 'from', 'share_source', 'ocid', 'cvid', 'ei', 'pc'
]);

const SIMILAR_THRESHOLD = 0.6;

/**
 * 规范化 URL：统一 https、小写主机、去 fragment、去跟踪参数、排序参数、去尾斜杠
 * 返回 null 表示不是合法 http(s) URL。
 */
function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(s)) s = 'https://' + s;
    else return null;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase();
  const port = u.port ? ':' + u.port : '';
  const params = [];
  for (const [k, v] of u.searchParams.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk)) continue;
    params.push([lk, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  let path = u.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');

  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return `https://${host}${port}${path}${query ? '?' + query : ''}`;
}

/** 标题规范化：NFKC + 小写 + 去掉所有空白与标点 */
function normalizeTitle(input) {
  if (!input || typeof input !== 'string') return '';
  let s = input.normalize('NFKC').toLowerCase();
  s = s.replace(/\s+/gu, '');
  s = s.replace(/[\p{P}\p{S}]/gu, '');
  return s;
}

/** 标题分词：按非字母数字切分 */
function tokenizeTitle(input) {
  if (!input || typeof input !== 'string') return [];
  const s = input.normalize('NFKC').toLowerCase();
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Jaccard 相似度 0..1 */
function jaccard(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const uni = sa.size + sb.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/** 字符二元组（中文无空格，按字符切 bigram 才能比较相似度） */
function charBigrams(input) {
  const t = normalizeTitle(input);
  const out = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * 标题相似度 0..1：分词 Jaccard 与 字符二元组 Jaccard 取较大者。
 * 这样既适配英文分词，也能处理中文（中文没有空格，分词会退化成整段）。
 */
function similarity(a, b) {
  const tj = jaccard(tokenizeTitle(a), tokenizeTitle(b));
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  let bj = 0;
  if (na.length >= 4 && nb.length >= 4) bj = jaccard(charBigrams(a), charBigrams(b));
  return Math.max(tj, bj);
}

const REASON_RANK = { verify: 4, url: 3, title: 2, similar: 1 };

/** 条目的核查结果里是否出现了这个（规范化后的）链接 */
function verifyMentionsUrl(json, urlNorm) {
  if (!json || !urlNorm) return false;
  let v;
  try { v = JSON.parse(json); } catch { return false; }
  const results = (v && v.results) || [];
  for (const r of results) {
    if (r && r.url && normalizeUrl(r.url) === urlNorm) return true;
  }
  return false;
}

/** 在池内查找重复项。 */
function findDuplicates(db, opts) {
  const urlNorm = opts.urlNorm || null;
  const titleNorm = opts.titleNorm || '';
  const excludeId = opts.excludeId || null;

  const rows = db
    .prepare('SELECT id, title, url_norm, title_norm, added_by_name, status, verify_json FROM news_items')
    .all();

  const matches = [];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    let best = null;

    if (urlNorm && row.url_norm && row.url_norm === urlNorm) {
      best = { reason: 'url', score: 1 };
    } else if (urlNorm && verifyMentionsUrl(row.verify_json, urlNorm)) {
      // 候选链接出现在该条目的"核查结果"里 → 很可能是同一件事
      best = { reason: 'verify', score: 1 };
    } else if (titleNorm && row.title_norm && row.title_norm === titleNorm) {
      best = { reason: 'title', score: 1 };
    } else {
      const score = similarity(opts.title || '', row.title);
      if (score >= SIMILAR_THRESHOLD) best = { reason: 'similar', score };
    }

    if (best) {
      matches.push({
        id: row.id,
        title: row.title,
        added_by_name: row.added_by_name,
        status: row.status,
        reason: best.reason,
        score: Math.round(best.score * 100) / 100
      });
    }
  }

  matches.sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return -1;
    if (b.status === 'done' && a.status !== 'done') return 1;
    return (REASON_RANK[b.reason] || 0) - (REASON_RANK[a.reason] || 0);
  });
  return matches;
}

// ---------------- 标题提取 ----------------

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    });
}

/** 取 <meta property/name="key" content="...">，不依赖属性顺序 */
function metaContent(html, key) {
  const re = new RegExp('<meta[^>]*?(?:property|name)\\s*=\\s*["\']' + key + '["\'][^>]*>', 'i');
  const m = html.match(re);
  if (!m) return null;
  const c = m[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return c ? decodeHtmlEntities(c[1].replace(/\s+/g, ' ').trim()) : null;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function brandOf(host) {
  return String(host || '').split('.')[0].toLowerCase();
}

/** 清洗标题：去空白/实体，并去掉尾部「 - 站点名」 */
function cleanTitle(raw, opts = {}) {
  let t = decodeHtmlEntities(String(raw || '').replace(/\s+/g, ' ').trim());
  if (!t) return '';
  const siteName = (opts.siteName || '').toLowerCase();
  const brand = brandOf(opts.host || '');
  const seps = [' - ', ' | ', ' – ', ' — ', ' _ ', ' » ', ' · ', ' :: '];
  for (const sep of seps) {
    const idx = t.lastIndexOf(sep);
    if (idx <= 0) continue;
    const tail = t.slice(idx + sep.length).trim().toLowerCase();
    const isBrand = (brand && (tail === brand || tail === brand + '.com')) ||
      (siteName && tail === siteName);
    if (isBrand) t = t.slice(0, idx).trim();
    break;
  }
  return t;
}

/** 判断抓到的标题是否为无效/站点名 */
function isJunkTitle(title, url) {
  const t = String(title || '').trim();
  if (t.length < 4) return true;
  const host = hostOf(url);
  const brand = brandOf(host);
  const tl = t.toLowerCase();
  if (brand && (tl === brand || tl === brand + '.com' || tl === host || tl === 'www.' + host)) return true;
  return false;
}

/** 单个路径段 -> 标题（无法判断时返回 null） */
function slugToTitle(seg) {
  let s = String(seg || '');
  try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
  s = s.replace(/\.(html?|php|aspx?|jsp|htm)$/i, '');
  let spaced = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return null;
  if (spaced.length > 300) spaced = spaced.slice(0, 300);
  const hasCJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(spaced);
  if (hasCJK) return spaced.length >= 4 ? spaced : null;
  const words = spaced.split(' ').filter(Boolean);
  if (words.length >= 3) return spaced; // 英文 slug 至少 3 个词
  return null;
}

/** 从 URL 路径兜底提取标题（从后往前找第一个有意义的路径段） */
function titleFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = slugToTitle(segs[i]);
    if (s) return s;
  }
  return null;
}

/** 抓取网页标题；失败返回 null，绝不抛错 */
async function fetchTitle(url, timeoutMs = 6000, maxBytes = 1024 * 1024) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    if (!res.ok) return null;

    let html = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        html += decoder.decode(value, { stream: true });
        if (received >= maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        if (html.indexOf('</head>') !== -1) break;
      }
    } else {
      html = (await res.text()).slice(0, maxBytes);
    }

    const host = hostOf(url);
    const ogTitle = metaContent(html, 'og:title');
    const twTitle = metaContent(html, 'twitter:title');
    const ldMatch = html.match(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const siteName = metaContent(html, 'og:site_name') || metaContent(html, 'application-name');

    const raw = ogTitle || twTitle || (ldMatch && ldMatch[1]) || (titleTag && titleTag[1]) || '';
    const cleaned = cleanTitle(raw, { siteName, host });
    return cleaned ? cleaned.slice(0, 300) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 URL 推断来源站名 */
function deriveSource(url) {
  return hostOf(url) || null;
}

module.exports = {
  normalizeUrl,
  normalizeTitle,
  tokenizeTitle,
  jaccard,
  charBigrams,
  similarity,
  findDuplicates,
  decodeHtmlEntities,
  metaContent,
  cleanTitle,
  isJunkTitle,
  slugToTitle,
  titleFromUrl,
  fetchTitle,
  deriveSource,
  SIMILAR_THRESHOLD
};
