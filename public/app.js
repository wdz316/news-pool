'use strict';

// 共享新闻池 - 前端（无构建，原生 JS）
// 契约：CONTRACT v1

const POOL = 'demo';
const DEFAULT_BRAND = '共享新闻池';

const state = {
  token: null,
  user: null,
  brand: DEFAULT_BRAND,
  poolName: '',
  items: [],
  members: [],
  online: [],
  unlocked: false,
  filter: 'all',        // 顶部筛选：all / pending / done / flagged / skipped
  statsMonth: null,     // 统计月历当前月份 'YYYY-MM'
  moveCtx: null,        // 移动弹窗上下文 { mode:'single'|'bulk', item?, date? }
  noteCtx: null,        // 备注弹窗正在编辑的条目
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  theme: 'classic'      // 外观主题 key（见 THEMES）；只存本机 localStorage('np_theme')
};

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { pending: '待播', done: '已播', skipped: '略过' };

// 外观主题清单（第一个「经典」＝原来的暖灰外观，CSS 里没有 data-theme 块）
const THEMES = [
  { key: 'classic',   name: '经典 · 暖灰', note: '默认',        bg: '#9d9b95', a: '#8a5305', b: '#4f6b4c' },
  { key: 'warm',      name: '暖调编辑',   note: '衬线 · 浅色',  bg: '#f7f6f3', a: '#956400', b: '#346538' },
  { key: 'oled',      name: '暗夜玻璃',   note: 'OLED · 深色',  bg: '#050505', a: '#f2b45c', b: '#6fd39a' },
  { key: 'print',     name: '工业蓝图',   note: '瑞士印刷',     bg: '#f4f4f0', a: '#e61919', b: '#050505' },
  { key: 'crt',       name: '战术终端',   note: 'CRT · 深色',   bg: '#0a0a0a', a: '#4af626', b: '#ff2a2a' },
  { key: 'soft',      name: '软结构',     note: 'Bento · 浅色', bg: '#f5f5f7', a: '#b06f1a', b: '#2f7d4f' },
  { key: 'luxury',    name: '暖金奢品',   note: '衬线 · 奢华',  bg: '#fdfbf7', a: '#b08a4a', b: '#5f6f52' },
  { key: 'blueprint', name: '氰版蓝图',   note: '工程图纸',     bg: '#0b2947', a: '#8fd6f0', b: '#c6ecff' },
  { key: 'riso',      name: '双色丝网',   note: '油墨 · 印刷',  bg: '#f4f1ea', a: '#1b3a6b', b: '#ff4d6d' },
  { key: 'zaxis',     name: '层叠卡片',   note: '立体 · 触感',  bg: '#e6e1d7', a: '#c9761d', b: '#3d7a55' },
  { key: 'neon',      name: '赛博霓虹',   note: '霓虹 · 深色',  bg: '#05060a', a: '#00f0ff', b: '#ff2fb9' }
];
const verifying = new Set(); // 正在核查的条目 id（用于按钮/面板的加载态）
const expandedVerify = new Set(); // 已展开核查明细的条目 id（默认收起）

// ---------------- 权限 / 筛选 ----------------

function isAdmin() { return !!(state.user && state.user.role === 'admin'); }
function isMine(it) { return it.added_by === (state.user && state.user.id); }

function matchesFilter(it, f) {
  if (f === 'pending') return it.status === 'pending';
  if (f === 'done') return it.status === 'done';
  if (f === 'skipped') return it.status === 'skipped';
  if (f === 'flagged') return !!it.flagged;
  return true;
}

function setFilter(f) { state.filter = f; render(); }

/** 刷新顶部筛选标签的选中态与计数 */
function updateFilterTabs() {
  const c = { all: state.items.length, pending: 0, done: 0, skipped: 0, flagged: 0 };
  for (const it of state.items) {
    if (c[it.status] !== undefined) c[it.status]++;
    if (it.flagged) c.flagged++;
  }
  for (const b of document.querySelectorAll('#filters .filter')) {
    const f = b.dataset.filter;
    b.classList.toggle('active', f === state.filter);
    const s = b.querySelector('.fcount');
    if (s) s.textContent = c[f] ? '(' + c[f] + ')' : '';
  }
}

// ---------------- 小工具 ----------------

function isUrlText(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^www\./i.test(t)) return true;
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(t);
}

function firstLine(t) {
  return String(t || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))[0] || '';
}

function unescapeAttr(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function urlFromHtml(html) {
  const m = /href\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  return m ? unescapeAttr(m[1]) : '';
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** 把一段文字里的网址渲染成可点链接（纯 DOM 构造，不用 innerHTML，防 XSS） */
function linkifyInto(container, text) {
  const s = String(text == null ? '' : text);
  let last = 0;
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s)) !== null) {
    let url = m[0];
    let trail = '';
    // 去掉被正则顺带吞进来的收尾标点（。，、）】」』… 等）
    while (url && /[)\]}>，。、；;：:！!？?】」』）…]$/.test(url)) {
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    if (m.index > last) container.appendChild(document.createTextNode(s.slice(last, m.index)));
    if (url) {
      const a = document.createElement('a');
      a.className = 'note-link';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = url;
      container.appendChild(a);
    }
    if (trail) container.appendChild(document.createTextNode(trail));
    last = m.index + m[0].length;
  }
  if (last < s.length) container.appendChild(document.createTextNode(s.slice(last)));
}

// ---------------- HTTP ----------------

async function api(path, method = 'GET', body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers['authorization'] = 'Bearer ' + state.token;

  let res;
  try {
    res = await fetch('/api/pool/' + POOL + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error('网络错误，无法连接服务器');
  }

  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }

  if (res.status === 401 && state.user) {
    doLogout();
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok) throw new Error((data && data.error) || ('请求失败（' + res.status + '）'));
  return data;
}

// ---------------- 品牌 / 池名 ----------------

function setBrand(brand) {
  state.brand = (brand || DEFAULT_BRAND);
  const a = $('brand-name'); if (a) a.textContent = state.brand;
  const b = $('login-brand'); if (b) b.textContent = state.brand;
  document.title = state.brand + (state.poolName ? ' · ' + state.poolName : '');
}

function setPoolName(name) {
  state.poolName = (name || '').trim();
  const el = $('pool-name');
  if (el) el.textContent = state.poolName ? '· ' + state.poolName : '';
  document.title = state.brand + (state.poolName ? ' · ' + state.poolName : '');
}

async function loadConfig() {
  try {
    const d = await api('/config');
    setBrand(d.brand);
    if (d.pool) setPoolName(d.pool.name);
  } catch {
    setBrand(DEFAULT_BRAND);
  }
}

// ---------------- 登录 / 登出 ----------------

async function doLogin(username, password) {
  const data = await api('/login', 'POST', { username, password });
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('np_token', data.token);
  localStorage.setItem('np_user', JSON.stringify(data.user));
  enterApp();
}

function enterApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('me').textContent = '👤 ' + (state.user ? state.user.display_name : '');
  setBrand(state.brand);
  setPoolName(state.poolName);
  connectWS();
  refresh();
}

function doLogout() {
  fetch('/api/pool/' + POOL + '/logout', {
    method: 'POST',
    headers: state.token ? { authorization: 'Bearer ' + state.token } : {}
  }).catch(() => {});
  state.token = null;
  state.user = null;
  state.items = [];
  state.members = [];
  state.unlocked = false;
  verifying.clear();
  expandedVerify.clear();
  localStorage.removeItem('np_token');
  localStorage.removeItem('np_user');
  if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('login-password').value = '';
}

async function refresh() {
  const d = await api('/items');
  state.items = d.items || [];
  render();
  try {
    const m = await api('/members');
    state.members = m.members || [];
  } catch { /* 忽略 */ }
  renderOnline();
}

// ---------------- WebSocket ----------------

function setConn(kind) {
  const el = $('conn');
  el.className = 'conn conn-' + kind;
  $('conn-text').textContent = kind === 'online' ? '已连接' : kind === 'connecting' ? '连接中' : '已断开';
}

function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/ws/pool/' + POOL + '?token=' + encodeURIComponent(state.token);
  const ws = new WebSocket(url);
  state.ws = ws;
  setConn('connecting');

  ws.onopen = () => { state.reconnectDelay = 1000; setConn('online'); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWs(msg);
  };
  ws.onclose = () => { setConn('offline'); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  if (!state.token) return;
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.token) connectWS();
  }, state.reconnectDelay);
  state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 10000);
}

function handleWs(msg) {
  switch (msg.type) {
    case 'snapshot':
      state.items = msg.items || [];
      render();
      break;
    case 'item_added': {
      upsert(msg.item);
      render();
      if (msg.duplicates && msg.duplicates.length && msg.item.added_by !== (state.user && state.user.id)) {
        const mine = msg.duplicates.some((d) => d.added_by_name === (state.user && state.user.display_name));
        if (mine) showDup(msg.duplicates, '⚠️ 别人加了和你重复的新闻', msg.item.id);
        else toast('「' + msg.item.added_by_name + '」添加了与池中重复的新闻');
      }
      break;
    }
    case 'item_updated':
      upsert(msg.item);
      render();
      break;
    case 'item_deleted':
      state.items = state.items.filter((x) => x.id !== msg.id);
      render();
      break;
    case 'items_cleared':
      state.items = [];
      render();
      toast('🗑 池已被清空');
      break;
    case 'members_changed':
      state.members = msg.members || [];
      if (state.unlocked) renderMembers();
      renderOnline();
      break;
    case 'pool_changed':
      if (msg.brand) setBrand(msg.brand);
      if (msg.pool) setPoolName(msg.pool.name);
      break;
    case 'presence':
      state.online = msg.online || [];
      renderOnline();
      break;
    case 'notice':
      toast(msg.text || '');
      break;
    default:
      break;
  }
}

// 心跳（保活 + 检测断线）
setInterval(() => {
  if (state.ws && state.ws.readyState === 1) {
    try { state.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
  }
}, 25000);

// ---------------- 数据操作 ----------------

function upsert(item) {
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item;
  else state.items.push(item);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function addItem() {
  const url = $('add-url').value.trim();
  const title = $('add-title').value.trim();
  const note = $('add-note').value.trim();
  const planned = $('add-date').value || undefined;
  if (!url && !title) { toast('请输入链接或标题'); return; }

  try {
    const data = await api('/items', 'POST', {
      url: url || undefined,
      title: title || undefined,
      note: note || undefined,
      planned_date: planned
    });
    upsert(data.item);
    render();
    $('add-url').value = '';
    $('add-title').value = '';
    $('add-note').value = '';
    if (data.duplicates && data.duplicates.length) {
      showDup(data.duplicates, '⚠️ 你添加的新闻与池中已有重复', data.item.id);
    } else {
      toast('✅ 已加入新闻池');
    }
    // 有文字内容时，自动核查其他来源
    if (shouldAutoVerify(data.item)) verifyItem(data.item);
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

function shouldAutoVerify(it) {
  const t = ((it && it.title) || '').trim();
  return t.length >= 6 && !isUrlText(t);
}

// 展开/收起某条的核查明细
function toggleVerify(it) {
  if (expandedVerify.has(it.id)) expandedVerify.delete(it.id);
  else expandedVerify.add(it.id);
  render();
}

// 核查：联网搜索其他来源的同题报道，帮助判断真伪
async function verifyItem(it, expand) {
  const q = (it.title || '').trim();
  if (!q || isUrlText(q)) {
    toast('这条没有可核查的文字内容，先点「改标题」写上消息内容，再核查');
    return;
  }
  verifying.add(it.id);
  render();
  try {
    const data = await api('/items/' + it.id + '/verify', 'POST');
    upsert(data.item);
    if (expand) expandedVerify.add(it.id);
    render();
    if (data.retitled) toast('已自动取回正文并更新标题');
    const n = data.item.verify && data.item.verify.results ? data.item.verify.results.length : 0;
    toast(n ? ('🔍 找到 ' + n + ' 条其他来源') : '🔍 未找到其他来源');
  } catch (e) {
    toast('❌ 核查失败：' + e.message);
  } finally {
    verifying.delete(it.id);
    render();
  }
}

async function setStatus(item, status) {
  try {
    const data = await api('/items/' + item.id, 'PATCH', { status });
    upsert(data.item);
    render();
  } catch (e) {
    toast('❌ ' + e.message);
  }
}
async function editTitle(item) {
  const t = window.prompt('修改标题：', item.title || '');
  if (t === null) return;
  const v = t.trim();
  if (!v) { toast('标题不能为空'); return; }
  try {
    const data = await api('/items/' + item.id, 'PATCH', { title: v });
    upsert(data.item);
    render();
    toast('✅ 标题已更新');
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

// 删除条目（自己添加的；管理员可删任意）
async function deleteItem(item) {
  if (!confirm('确定删除这条新闻？此操作不可撤销。')) return;
  try {
    await api('/items/' + item.id, 'DELETE');
    state.items = state.items.filter((x) => x.id !== item.id);
    render();
    toast('🗑 已删除');
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

// ---------------- 重点关注（★） ----------------

async function toggleFlag(it) {
  try {
    const data = await api('/items/' + it.id, 'PATCH', { flagged: !it.flagged });
    upsert(data.item);
    render();
    toast(data.item.flagged ? '★ 已标为重点关注' : '已取消重点关注');
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

// ---------------- 复制 ----------------

async function copyText(text, okMsg) {
  const s = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
    } else {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(okMsg || '已复制');
    return true;
  } catch {
    toast('❌ 复制失败，请手动选中');
    return false;
  }
}

// 一键复制「标题」+「备注」+「链接」（有哪个复制哪个）
function copyItem(it) {
  const parts = [it.title || '(无标题)'];
  if (it.note) parts.push('备注：' + it.note);
  if (it.url) parts.push(it.url);
  return copyText(parts.join('\n'), '已复制');
}

// ---------------- 备注 ----------------

function openNote(it) {
  state.noteCtx = it;
  $('note-error').textContent = '';
  $('note-desc').textContent = '「' + (it.title || '(无标题)').slice(0, 60) + '」';
  $('note-text').value = it.note || '';
  $('note-modal').classList.remove('hidden');
  $('note-text').focus();
}

async function saveNote() {
  const ctx = state.noteCtx;
  if (!ctx) return;
  const note = $('note-text').value.trim();
  $('note-save').disabled = true;
  try {
    const d = await api('/items/' + ctx.id, 'PATCH', { note });
    upsert(d.item);
    $('note-modal').classList.add('hidden');
    state.noteCtx = null;
    render();
    toast(note ? '✅ 备注已保存' : '已清空备注');
  } catch (e) {
    $('note-error').textContent = e.message;
  } finally {
    $('note-save').disabled = false;
  }
}

// ---------------- 移动到其他天 ----------------

/** 某天「可被一键移动」的条目：待播中，自己加的（管理员＝全部） */
function bulkTargets(date) {
  return state.items.filter((x) =>
    x.planned_date === date && x.status === 'pending' && (isMine(x) || isAdmin()));
}

function openMove(ctx) {
  state.moveCtx = ctx;
  $('move-error').textContent = '';
  if (ctx.mode === 'bulk') {
    const n = bulkTargets(ctx.date).length;
    $('move-title').textContent = '把未播出的移动到…';
    $('move-desc').textContent = '将移动 ' + n + ' 条（' + ctx.date + ' 的待播条目中，你添加的' + (isAdmin() ? '；管理员含全部' : '') + '）。';
    $('move-date').value = todayStr();
  } else {
    const it = ctx.item;
    $('move-title').textContent = '移动到其他日期';
    $('move-desc').textContent = '当前：' + it.planned_date + ' ｜ ' + String(it.title || '(无标题)').slice(0, 60);
    $('move-date').value = it.planned_date || todayStr();
  }
  $('move-modal').classList.remove('hidden');
  $('move-date').focus();
}

async function confirmMove() {
  const date = $('move-date').value;
  if (!date) { $('move-error').textContent = '请选择日期'; return; }
  const ctx = state.moveCtx;
  if (!ctx) return;
  $('move-confirm').disabled = true;
  try {
    if (ctx.mode === 'bulk') {
      const targets = bulkTargets(ctx.date);
      for (const it of targets) {
        const d = await api('/items/' + it.id, 'PATCH', { planned_date: date });
        upsert(d.item);
      }
      toast('已移动 ' + targets.length + ' 条到 ' + date);
    } else {
      const d = await api('/items/' + ctx.item.id, 'PATCH', { planned_date: date });
      upsert(d.item);
      toast('已移动到 ' + date);
    }
    $('move-modal').classList.add('hidden');
    state.moveCtx = null;
    render();
  } catch (e) {
    $('move-error').textContent = e.message;
  } finally {
    $('move-confirm').disabled = false;
  }
}

// ---------------- 导出当天清单 ----------------

function buildDayText(date) {
  const items = state.items.filter((x) => x.planned_date === date);
  const lines = [fmtDate(date) + '（' + date + '）共 ' + items.length + ' 条', ''];
  const sorted = items.slice().sort((a, b) =>
    a.added_by_name.localeCompare(b.added_by_name, 'zh') || String(a.created_at).localeCompare(String(b.created_at)));
  const byPerson = new Map();
  for (const it of sorted) {
    if (!byPerson.has(it.added_by_name)) byPerson.set(it.added_by_name, []);
    byPerson.get(it.added_by_name).push(it);
  }
  for (const [person, arr] of byPerson) {
    lines.push('【' + person + '】');
    for (const it of arr) {
      const mark = it.status === 'done' ? '✔' : it.status === 'skipped' ? '✖' : '☐';
      lines.push('  ' + mark + ' ' + (it.title || '(无标题)') + (it.flagged ? '  ★重点' : ''));
      if (it.note) {
        String(it.note).split(/\r?\n/).forEach((ln, i) => lines.push('     ' + (i === 0 ? '📝 ' : '   ') + ln));
      }
      if (it.url) lines.push('     ' + it.url);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function exportDay(date) {
  $('export-title').textContent = '导出 ' + fmtDate(date) + ' 清单';
  const ta = $('export-text');
  ta.value = buildDayText(date);
  ta.dataset.date = date;
  $('export-modal').classList.remove('hidden');
}

function downloadExport() {
  const ta = $('export-text');
  const blob = new Blob([ta.value], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '新闻清单-' + (ta.dataset.date || todayStr()) + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------- 播出统计（月历） ----------------

function openStats() {
  if (!state.statsMonth) state.statsMonth = todayStr().slice(0, 7);
  $('stats-modal').classList.remove('hidden');
  renderStats();
}

function statsShift(delta) {
  const parts = state.statsMonth.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1 + delta, 1);
  state.statsMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  renderStats();
}

/** 统计月历：点击某天 → 关掉弹窗并滚动到列表里当天的分组 */
function jumpToDate(ds) {
  $('stats-modal').classList.add('hidden');
  if (!state.items.some((x) => x.planned_date === ds)) { toast('这一天没有新闻'); return; }
  if (state.filter !== 'all') state.filter = 'all';
  render();
  const sec = document.querySelector('.day[data-date="' + ds + '"]');
  if (!sec) { toast('这一天没有可显示的新闻'); return; }
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sec.classList.add('day-flash');
  setTimeout(() => sec.classList.remove('day-flash'), 1600);
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function renderStats() {
  const [y, m] = state.statsMonth.split('-').map(Number);
  $('stats-month').textContent = y + ' 年 ' + m + ' 月';
  const grid = $('stats-grid');
  grid.innerHTML = '';

  for (const w of WEEKDAYS) {
    const h = document.createElement('div');
    h.className = 'stats-wd';
    h.textContent = w;
    grid.appendChild(h);
  }

  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // 以周一为一周起点
  for (let i = 0; i < lead; i++) {
    const c = document.createElement('div');
    c.className = 'stats-cell empty-cell';
    grid.appendChild(c);
  }

  const daysInMonth = new Date(y, m, 0).getDate();
  const todayS = todayStr();
  let totalPrep = 0;
  let totalAired = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const cell = document.createElement('div');
    cell.className = 'stats-cell' + (ds === todayS ? ' is-today' : '');

    const num = document.createElement('div');
    num.className = 'stats-day';
    num.textContent = day;
    cell.appendChild(num);

    // 每人：准备＝他添加的（按添加人）；已播＝他标记播出的（按播出人）
    const per = new Map();
    const bump = (p, key) => {
      if (!per.has(p)) per.set(p, { prep: 0, aired: 0 });
      per.get(p)[key]++;
    };
    for (const it of state.items) {
      if (it.planned_date !== ds) continue;
      bump(it.added_by_name || '?', 'prep');
    }
    for (const it of state.items) {
      if (it.planned_date !== ds) continue;
      if (it.status === 'done' && it.done_by_name) bump(it.done_by_name, 'aired');
    }

    for (const [p, v] of per) {
      const row = document.createElement('div');
      row.className = 'stats-row';
      row.textContent = p + ' ' + v.prep + '/' + v.aired;
      cell.appendChild(row);
      totalPrep += v.prep;
      totalAired += v.aired;
    }

    // 当天有新闻 → 可点击，跳到列表里那天
    if (per.size) {
      cell.classList.add('has-items');
      cell.title = '点击跳到当天新闻';
      cell.addEventListener('click', () => jumpToDate(ds));
    }

    grid.appendChild(cell);
  }

  $('stats-summary').textContent = '本月合计：准备 ' + totalPrep + ' 条 · 已播 ' + totalAired + ' 条';
}

// ---------------- 渲染 ----------------

function fmtDate(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return dateStr;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dt - today) / 86400000);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
  const prefix = diff === 0 ? '今天 · ' : diff === 1 ? '明天 · ' : diff === -1 ? '昨天 · ' : '';
  return prefix + (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + wd;
}

function statusLabel(s) { return STATUS_LABEL[s] || s; }

function render() {
  updateFilterTabs();
  const list = $('list');
  list.innerHTML = '';

  const items = state.items.filter((it) => matchesFilter(it, state.filter));

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.items.length ? '这一类暂时没有条目' : '还没有新闻，粘贴一个链接试试 👆';
    list.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.planned_date)) groups.set(it.planned_date, []);
    groups.get(it.planned_date).push(it);
  }
  const dates = [...groups.keys()].sort().reverse();

  for (const date of dates) {
    const sec = document.createElement('section');
    sec.className = 'day';
    sec.dataset.date = date;

    const head = document.createElement('div');
    head.className = 'day-head';
    const dLabel = document.createElement('span');
    dLabel.className = 'day-date';
    dLabel.textContent = fmtDate(date);
    const dCount = document.createElement('span');
    dCount.className = 'day-count';
    dCount.textContent = groups.get(date).length + ' 条';
    head.appendChild(dLabel);
    head.appendChild(dCount);

    // 当天操作：导出清单 / 把该天未播出的全部移动到其他天
    const dayActions = document.createElement('div');
    dayActions.className = 'day-actions';
    dayActions.appendChild(actionBtn('导出当天', 'edit', () => exportDay(date)));
    const movable = bulkTargets(date);
    if (movable.length) {
      dayActions.appendChild(actionBtn('未播全部移动…', 'edit', () => openMove({ mode: 'bulk', date })));
    }
    head.appendChild(dayActions);

    sec.appendChild(head);

    // 按添加人分组（组内再按时间）
    const byPerson = new Map();
    const sorted = groups.get(date).slice().sort((a, b) => {
      if (a.added_by_name !== b.added_by_name) return a.added_by_name.localeCompare(b.added_by_name, 'zh');
      return a.created_at.localeCompare(b.created_at);
    });
    for (const it of sorted) {
      if (!byPerson.has(it.added_by_name)) byPerson.set(it.added_by_name, []);
      byPerson.get(it.added_by_name).push(it);
    }

    for (const [person, arr] of byPerson) {
      const pg = document.createElement('div');
      pg.className = 'person-group';
      const ph = document.createElement('div');
      ph.className = 'person-head';
      ph.textContent = (person === (state.user && state.user.display_name) ? '我（' + person + '）' : person) + ' · ' + arr.length;
      pg.appendChild(ph);
      for (const it of arr) pg.appendChild(renderItem(it));
      sec.appendChild(pg);
    }

    list.appendChild(sec);
  }
}

function actionBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'mini ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** 状态胶囊：把「状态显示」和「标记已播/待播」合并成一个可点按钮
 *  待播 → 点击变已播；已播 → 点击变回待播；略过 → 点击恢复待播 */
function statusToggle(it) {
  const next = it.status === 'pending' ? 'done' : 'pending';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'item-badge';
  b.textContent = statusLabel(it.status);
  b.title = it.status === 'pending' ? '点击标记为已播'
    : it.status === 'done' ? '点击改回待播'
    : '点击恢复待播';
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', (e) => { e.stopPropagation(); setStatus(it, next); });
  return b;
}

/** 关掉所有已展开的「⋯」菜单 */
function closeMenu() {
  for (const p of document.querySelectorAll('.item-menu .menu-pop')) {
    p.classList.add('hidden');
    const b = p.parentElement && p.parentElement.querySelector('button.more');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
}

/** 条目次要操作收进「⋯」菜单：改标题 / 核查 / 略过 / 恢复待播 / 移动 / 复制 / 删除 */
function buildItemMenu(it) {
  const wrap = document.createElement('div');
  wrap.className = 'item-menu';

  const btn = document.createElement('button');
  btn.className = 'mini more';
  btn.type = 'button';
  btn.textContent = '⋯';
  btn.title = '更多操作';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');

  const pop = document.createElement('div');
  pop.className = 'menu-pop hidden';
  pop.addEventListener('click', (e) => e.stopPropagation());

  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      fn();
    });
    pop.appendChild(b);
  };

  add('✏️ 改标题', '', () => editTitle(it));
  add('📝 ' + (it.note ? '改备注' : '加备注'), '', () => openNote(it));
  add(verifying.has(it.id) ? '🔍 核查中…' : '🔍 核查真伪', '', () => verifyItem(it, true));
  if (it.status !== 'skipped') add('⏭️ 略过这条', 'skip', () => setStatus(it, 'skipped'));
  if (it.status === 'skipped') add('↩️ 恢复待播', 'pend', () => setStatus(it, 'pending'));
  add('📅 移动日期', '', () => openMove({ mode: 'single', item: it }));
  add('📋 复制标题+备注+链接', '', () => copyItem(it));
  if (isMine(it) || isAdmin()) add('🗑️ 删除', 'danger', () => deleteItem(it));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = pop.classList.contains('hidden');
    closeMenu();
    if (willOpen) {
      pop.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
  });

  wrap.appendChild(btn);
  wrap.appendChild(pop);
  return wrap;
}

function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'item status-' + it.status;

  const main = document.createElement('div');
  main.className = 'item-main';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = it.title || '(无标题)';
  main.appendChild(title);

  // 备注：主播自己的话（背景 / 评价 / 播出时想说的）
  if (it.note) {
    const note = document.createElement('div');
    note.className = 'item-note';
    linkifyInto(note, it.note);
    main.appendChild(note);
  }

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  if (it.flagged) {
    const f = document.createElement('span');
    f.className = 'chip flag';
    f.textContent = '★ 重点关注';
    meta.appendChild(f);
  }
  if (it.source) {
    const s = document.createElement('span');
    s.className = 'chip';
    s.textContent = it.source;
    meta.appendChild(s);
  }
  if (it.url) {
    const a = document.createElement('a');
    a.className = 'item-link';
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '打开链接 ↗';
    meta.appendChild(a);
  }
  if (it.status === 'done' && it.done_by_name) {
    const d = document.createElement('span');
    d.className = 'item-done';
    d.textContent = '✅ ' + it.done_by_name + ' 已播出';
    meta.appendChild(d);
  }
  main.appendChild(meta);

  const row = document.createElement('div');
  row.className = 'item-row';
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  actions.appendChild(statusToggle(it));
  actions.appendChild(actionBtn(it.flagged ? '★ 已标重点' : '☆ 标重点', 'star' + (it.flagged ? ' on' : ''), () => toggleFlag(it)));
  actions.appendChild(buildItemMenu(it));
  row.appendChild(actions);
  el.appendChild(row);

  if (it.verify || verifying.has(it.id)) {
    el.appendChild(renderVerify(it));
    // 整条新闻点一下就收起/展开核查明细（按钮、链接除外）
    el.classList.add('clickable');
    el.title = expandedVerify.has(it.id) ? '点击收起核查明细' : '点击展开核查明细';
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, textarea, .item-menu')) return;
      toggleVerify(it);
    });
  }

  return el;
}

function renderVerify(it) {
  const panel = document.createElement('div');
  panel.className = 'verify-panel';

  if (verifying.has(it.id)) {
    panel.classList.add('loading');
    panel.textContent = '🔍 正在搜索其他来源…';
    return panel;
  }

  const v = it.verify || {};
  const results = v.results || [];
  const open = expandedVerify.has(it.id);

  const summary = results.length
    ? '其他来源 ' + results.length + ' 条' + (v.engine ? ' · ' + v.engine : '')
    : '未找到其他来源' + (v.error ? '（' + v.error + '）' : '');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'verify-head';
  head.textContent = (open ? '▾ ' : '▸ ') + '🔍 ' + summary;
  head.title = open ? '点击收起明细' : '点击展开明细';
  head.addEventListener('click', () => toggleVerify(it));
  panel.appendChild(head);

  if (open) {
    for (const r of results) {
      const a = document.createElement('a');
      a.className = 'verify-row';
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      const t = document.createElement('div');
      t.className = 'verify-title';
      t.textContent = r.title || r.url;
      a.appendChild(t);

      const s = document.createElement('div');
      s.className = 'verify-src';
      s.textContent = (r.source ? r.source + ' · ' : '') + (r.snippet || '');
      a.appendChild(s);

      panel.appendChild(a);
    }
    panel.appendChild(actionBtn('↻ 重新核查', 'verify', () => verifyItem(it, true)));
  }

  return panel;
}

function renderOnline() {
  const n = state.online.length;
  $('online').textContent = n ? '在线 ' + n + ' 人' : '';
}

// ---------------- 重复警告 ----------------

let dupItemId = null;

async function submitDup() {
  $('dup-modal').classList.add('hidden');
  if (!dupItemId) return;
  try {
    const data = await api('/items/' + dupItemId, 'PATCH', { flagged: true });
    upsert(data.item);
    render();
    toast('✅ 已标为重点关注，其他成员会收到提醒');
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

function showDup(duplicates, heading, itemId) {
  dupItemId = itemId || null;
  $('dup-heading').textContent = heading || '⚠️ 发现疑似重复';
  const ul = $('dup-list');
  ul.innerHTML = '';
  for (const d of duplicates) {
    const li = document.createElement('li');
    li.className = 'dup-item' + (d.status === 'done' ? ' dup-done' : '');

    const t = document.createElement('div');
    t.className = 'dup-title';
    t.textContent = d.title || '(无标题)';
    li.appendChild(t);

    const m = document.createElement('div');
    m.className = 'dup-meta';
    const reason = d.reason === 'url' ? '相同链接'
      : d.reason === 'verify' ? '出现在该条的核查结果中（疑似同一件事）'
      : d.reason === 'title' ? '相同标题' : '标题相似';
    const scoreTxt = d.reason === 'similar' ? '（相似度 ' + Math.round((d.score || 0) * 100) + '%）' : '';
    if (d.status === 'done') {
      m.textContent = '⚠️ 已被「' + d.added_by_name + '」标记播出 · ' + reason + scoreTxt;
    } else {
      m.textContent = '「' + d.added_by_name + '」已添加 · ' + statusLabel(d.status) + ' · ' + reason + scoreTxt;
    }
    li.appendChild(m);

    ul.appendChild(li);
  }
  $('dup-modal').classList.remove('hidden');
  beep();
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.18);
  } catch { /* 忽略 */ }
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---------------- 成员模式 ----------------

function openMembers() {
  $('members-modal').classList.remove('hidden');
  $('unlock-error').textContent = '';
  if (state.unlocked) {
    $('unlock-box').classList.add('hidden');
    $('members-box').classList.remove('hidden');
    renderMembers();
  } else {
    $('unlock-box').classList.remove('hidden');
    $('members-box').classList.add('hidden');
    $('unlock-pw').value = '';
    $('unlock-pw').focus();
  }
}

async function unlock() {
  const pw = $('unlock-pw').value;
  if (!pw) return;
  try {
    await api('/unlock', 'POST', { password: pw });
    state.unlocked = true;
    $('unlock-box').classList.add('hidden');
    $('members-box').classList.remove('hidden');
    await refresh();
    renderMembers();
  } catch (e) {
    $('unlock-error').textContent = e.message;
  }
}

function renderMembers() {
  const input = $('pool-name-input');
  if (input) input.value = state.poolName || '';
  const brandInput = $('brand-input');
  if (brandInput) brandInput.value = state.brand || '';

  const ul = $('member-list');
  ul.innerHTML = '';
  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = 'member-item';
    const info = document.createElement('div');
    info.className = 'member-info';
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.display_name;
    const meta = document.createElement('span');
    meta.className = 'member-meta';
    meta.textContent = ' @' + m.username + (m.role === 'admin' ? ' · 管理员' : '');
    info.appendChild(name);
    info.appendChild(meta);
    li.appendChild(info);

    const tools = document.createElement('div');
    tools.className = 'member-tools';
    tools.appendChild(actionBtn('改名', 'edit', () => renameMember(m)));
    if (m.id !== (state.user && state.user.id)) {
      tools.appendChild(actionBtn('删除', 'danger', () => removeMember(m.id)));
    } else {
      const self = document.createElement('span');
      self.className = 'member-self';
      self.textContent = '（我）';
      tools.appendChild(self);
    }
    li.appendChild(tools);
    ul.appendChild(li);
  }
}

// 修改成员显示名（含自己）
async function renameMember(m) {
  $('member-error').textContent = '';
  const name = window.prompt('修改「' + m.display_name + '」的显示名：', m.display_name);
  if (name === null) return;
  const v = name.trim();
  if (!v) { $('member-error').textContent = '显示名不能为空'; return; }
  try {
    await api('/members/' + m.id, 'PATCH', { display_name: v });
    if (m.id === (state.user && state.user.id)) {
      state.user.display_name = v;
      $('me').textContent = '👤 ' + v;
    }
    await refresh();
    renderMembers();
    toast('✅ 已改名');
  } catch (e) {
    $('member-error').textContent = e.message;
  }
}

// 修改界面名称（大标题 + 副标题）
async function savePoolMeta() {
  $('member-error').textContent = '';
  const brand = $('brand-input').value.trim();
  const name = $('pool-name-input').value.trim();
  if (!brand) { $('member-error').textContent = '大标题不能为空'; return; }
  if (!name) { $('member-error').textContent = '副标题不能为空'; return; }
  try {
    const d = await api('/name', 'POST', { brand, name });
    if (d.brand) setBrand(d.brand);
    if (d.pool) setPoolName(d.pool.name);
    toast('✅ 名称已更新');
  } catch (e) {
    $('member-error').textContent = e.message;
  }
}

async function addMember() {
  $('member-error').textContent = '';
  const username = $('m-user').value.trim();
  const display_name = $('m-name').value.trim();
  const password = $('m-pw').value;
  const role = $('m-role').value;
  if (!username || !password) { $('member-error').textContent = '账号和密码必填'; return; }
  try {
    await api('/members', 'POST', { username, display_name, password, role });
    $('m-user').value = '';
    $('m-name').value = '';
    $('m-pw').value = '';
    await refresh();
    renderMembers();
    toast('✅ 成员已添加');
  } catch (e) {
    $('member-error').textContent = e.message;
  }
}

async function removeMember(id) {
  if (!confirm('确定删除该成员？')) return;
  try {
    await api('/members/' + id, 'DELETE');
    await refresh();
    renderMembers();
    toast('已删除成员');
  } catch (e) {
    $('member-error').textContent = e.message;
  }
}

async function clearAllItems() {
  if (!confirm('确定清空本池的所有新闻记录？此操作不可撤销。')) return;
  try {
    await api('/items', 'DELETE');
    state.items = [];
    render();
    toast('🗑 已清空本池记录');
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

// ---------------- 拖拽 ----------------

let dragDepth = 0;
function showDrag(on) { $('drag-overlay').classList.toggle('hidden', !on); }

// 把一段文本放进合适的输入框（URL→链接框；其余→标题/内容框）
function fillAddFields(text) {
  const t = String(text || '').trim();
  if (isUrlText(t)) {
    $('add-url').value = t;
    $('add-title').value = '';
    $('add-url').focus();
  } else {
    $('add-title').value = t;
    $('add-url').value = '';
    $('add-title').focus();
  }
}

function submitDroppedText(text) {
  const t = String(text || '').trim();
  if (!t) return;
  fillAddFields(t);
  addItem();
}

function setupDragDrop() {
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!state.user) return;
    dragDepth++;
    showDrag(true);
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDrag(false);
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    showDrag(false);
    if (!state.user) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    // 兼容多种拖拽来源：浏览器链接 / 社交 App（多为 html 或 moz-url）/ 纯文本
    let text = firstLine(dt.getData('text/uri-list'));
    if (!text) text = firstLine(dt.getData('text/plain'));
    if (!text) text = urlFromHtml(dt.getData('text/html'));
    if (!text) text = firstLine(dt.getData('text/x-moz-url'));
    if (text) submitDroppedText(text);
  });

  // 页面空白处 Ctrl+V 粘贴（输入框内正常粘贴，不拦截）
  document.addEventListener('paste', (e) => {
    if (!state.user) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const line = firstLine((e.clipboardData && e.clipboardData.getData('text/plain')) || '');
    if (!line) return;
    e.preventDefault();
    fillAddFields(line);
    toast('已粘贴，按回车加入（或点「加入池」）');
  });
}

// ---------------- 初始化 ----------------

// ---------------- 外观主题 ----------------

// 应用主题：classic 用「无 data-theme」表示（走 :root 默认），其余写到 <html data-theme>
function applyTheme(key) {
  const found = THEMES.find((t) => t.key === key);
  const k = found ? found.key : 'classic';
  if (k === 'classic') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', k);
  state.theme = k;
  try { localStorage.setItem('np_theme', k); } catch { /* 隐私模式等：忽略 */ }
  return k;
}

function renderThemeGrid() {
  const grid = $('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const t of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-swatch' + (t.key === state.theme ? ' active' : '');
    btn.dataset.theme = t.key;
    btn.innerHTML =
      '<div class="sw-preview" style="background:' + t.bg + '">' +
        '<span class="sw-dot" style="background:' + t.a + '"></span>' +
        '<span class="sw-bar" style="background:' + t.b + '"></span>' +
      '</div>' +
      '<div class="sw-name">' + t.name + '<small>' + t.note + '</small></div>';
    btn.addEventListener('click', () => {
      applyTheme(t.key);
      for (const el of grid.querySelectorAll('.theme-swatch')) {
        el.classList.toggle('active', el.dataset.theme === t.key);
      }
      const nameEl = $('theme-current-name');
      if (nameEl) nameEl.textContent = t.name;
    });
    grid.appendChild(btn);
  }
  const cur = THEMES.find((x) => x.key === state.theme);
  const nameEl = $('theme-current-name');
  if (nameEl) nameEl.textContent = cur ? cur.name : '经典 · 暖灰';
}

function openTheme() {
  renderThemeGrid();
  $('theme-modal').classList.remove('hidden');
}

function init() {
  $('add-date').value = todayStr();
  setupDragDrop();

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      await doLogin($('login-username').value.trim(), $('login-password').value);
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  $('btn-logout').addEventListener('click', doLogout);
  $('btn-add').addEventListener('click', addItem);
  $('add-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
  $('add-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });

  $('dup-ignore').addEventListener('click', () => $('dup-modal').classList.add('hidden'));
  $('dup-submit').addEventListener('click', submitDup);
  $('btn-members').addEventListener('click', openMembers);
  $('members-close').addEventListener('click', () => $('members-modal').classList.add('hidden'));
  $('btn-unlock').addEventListener('click', unlock);
  $('unlock-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('btn-add-member').addEventListener('click', addMember);
  $('btn-save-poolname').addEventListener('click', savePoolMeta);
  $('btn-clear-items').addEventListener('click', clearAllItems);

  // 顶部筛选标签
  for (const b of document.querySelectorAll('#filters .filter')) {
    b.addEventListener('click', () => setFilter(b.dataset.filter));
  }

  // 点空白处 / Esc 关闭「⋯」菜单
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // 统计
  $('btn-stats').addEventListener('click', openStats);
  $('stats-close').addEventListener('click', () => $('stats-modal').classList.add('hidden'));
  $('stats-prev').addEventListener('click', () => statsShift(-1));
  $('stats-next').addEventListener('click', () => statsShift(1));
  $('stats-today').addEventListener('click', () => { state.statsMonth = todayStr().slice(0, 7); renderStats(); });

  // 移动
  $('move-cancel').addEventListener('click', () => { $('move-modal').classList.add('hidden'); state.moveCtx = null; });
  $('move-confirm').addEventListener('click', confirmMove);
  $('move-date').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmMove(); });

  // 导出
  $('export-close').addEventListener('click', () => $('export-modal').classList.add('hidden'));
  $('export-copy').addEventListener('click', () => copyText($('export-text').value, '已复制清单'));
  $('export-download').addEventListener('click', downloadExport);

  // 备注
  $('note-cancel').addEventListener('click', () => { $('note-modal').classList.add('hidden'); state.noteCtx = null; });
  $('note-save').addEventListener('click', saveNote);
  $('note-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
  });

  // 外观主题（先应用，保证登录页也是所选风格）
  applyTheme(localStorage.getItem('np_theme') || 'classic');
  $('btn-theme').addEventListener('click', openTheme);
  $('theme-close').addEventListener('click', () => $('theme-modal').classList.add('hidden'));

  loadConfig();

  // 恢复会话
  const token = localStorage.getItem('np_token');
  if (token) {
    state.token = token;
    try { state.user = JSON.parse(localStorage.getItem('np_user') || 'null'); } catch { state.user = null; }
    api('/me')
      .then((d) => { state.user = d.user; if (d.brand) setBrand(d.brand); if (d.pool) setPoolName(d.pool.name); enterApp(); })
      .catch(() => doLogout());
  }
}

window.addEventListener('DOMContentLoaded', init);
