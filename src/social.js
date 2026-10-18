'use strict';

// X / Twitter 等需登录站点：正文直接抓不到（X 链接里只有 作者 + 状态ID）。
// 这里通过公开镜像/接口取回推文正文，供"标题"与"核查关键字"使用。
// 主：fxtwitter API；备：Twitter oEmbed。
// 测试：环境变量 NEWS_POOL_SOCIAL_STUB 注入固定正文。

const dedup = require('./dedup');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SOCIAL_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com']);

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function isSocial(url) {
  return SOCIAL_HOSTS.has(hostOf(url));
}

/** 从 status 链接里解析 用户名 + 状态ID */
function parseStatus(url) {
  try {
    const u = new URL(url);
    const m = /\/([A-Za-z0-9_]+)\/status(?:es)?\/(\d+)/.exec(u.pathname);
    return m ? { user: m[1], id: m[2] } : null;
  } catch {
    return null;
  }
}

async function getJson(url, timeoutMs = 7000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: c.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 清洗正文：去标签/实体/链接，压空白，限长 */
function cleanText(t) {
  return dedup
    .decodeHtmlEntities(String(t || '').replace(/https?:\/\/\S+/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

async function viaFxtwitter(user, id) {
  const j = await getJson('https://api.fxtwitter.com/' + user + '/status/' + id);
  const tw = j && j.tweet;
  if (tw && tw.text) {
    return { text: tw.text, author: (tw.author && (tw.author.name || tw.author.screen_name)) || null, via: 'fxtwitter' };
  }
  return null;
}

async function viaOembed(user, id) {
  const j = await getJson(
    'https://publish.twitter.com/oembed?url=' + encodeURIComponent('https://twitter.com/' + user + '/status/' + id)
  );
  if (j && j.html) {
    const m = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(j.html);
    const text = m ? m[1].replace(/<[^>]+>/g, ' ').trim() : '';
    if (text) return { text, author: j.author_name || null, via: 'oembed' };
  }
  return null;
}

/**
 * 展开社交链接，取回 { text, author, via }；取不到返回 null，绝不抛错。
 */
async function unfurl(url) {
  const st = parseStatus(url);
  if (!st) return null;

  if (process.env.NEWS_POOL_SOCIAL_STUB) {
    try {
      const s = JSON.parse(process.env.NEWS_POOL_SOCIAL_STUB);
      if (s && s.text) return { text: s.text, author: s.author || null, via: 'stub' };
    } catch { /* 忽略 */ }
  }
  if (process.env.NEWS_POOL_DISABLE_FETCH === '1') return null;

  let r = null;
  try { r = await viaFxtwitter(st.user, st.id); } catch { /* 下一个 */ }
  if (!r) { try { r = await viaOembed(st.user, st.id); } catch { /* 忽略 */ } }
  return r;
}

module.exports = { isSocial, parseStatus, unfurl, cleanText, hostOf };
