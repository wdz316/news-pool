'use strict';

// 共享新闻池 - 后端服务（本地 MVP）
// HTTP + 静态资源 + REST API + WebSocket 实时广播
// 契约：CONTRACT v1

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const dbm = require('./db');
const dedup = require('./dedup');
const search = require('./search');
const social = require('./social');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3210;
const HOST = process.env.HOST || '0.0.0.0';
// 品牌名（可自定义：给关注的博主用时可换成自己的频道名）
const BRAND = (process.env.NEWS_POOL_BRAND || '共享新闻池').trim() || '共享新闻池';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** 生效的品牌名：池注册表里的优先，其次环境变量，最后默认 */
function effectiveBrand(pool) {
  const b = (pool && pool.brand) || '';
  return String(b).trim() || BRAND;
}

const VALID_STATUS = ['pending', 'done', 'skipped'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

// ---------------- 工具 ----------------

function respond(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve({});
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/**
 * 从链接推导标题：社交链接（X 等）取正文 → 否则抓网页标题 → 最后用 URL slug 兜底。
 * 返回 null 表示取不到有意义的内容。
 */
async function deriveTitle(url) {
  if (!url) return null;
  let t = null;
  if (social.isSocial(url)) {
    const un = await social.unfurl(url);
    if (un && un.text) t = social.cleanText(un.text);
  }
  if (!t && process.env.NEWS_POOL_DISABLE_FETCH !== '1') {
    t = await dedup.fetchTitle(url);
  }
  if (!t || dedup.isJunkTitle(t, url)) {
    const fromSlug = dedup.titleFromUrl(url);
    if (fromSlug) t = fromSlug;
  }
  return t || null;
}

// ---------------- WebSocket 广播中心 ----------------

const wss = new WebSocketServer({ noServer: true });
const hub = new Map(); // poolId -> Map<ws, {userId, display_name}>

function broadcast(poolId, msg) {
  const set = hub.get(poolId);
  if (!set || !set.size) return;
  const data = JSON.stringify(msg);
  for (const ws of set.keys()) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

function broadcastPresence(poolId) {
  const set = hub.get(poolId);
  const online = set ? [...new Set([...set.values()].map((v) => v.userId))] : [];
  broadcast(poolId, { type: 'presence', online });
}

wss.on('connection', (ws, ctx) => {
  const { poolId, user } = ctx;
  const db = dbm.openPool(poolId);

  if (!hub.has(poolId)) hub.set(poolId, new Map());
  hub.get(poolId).set(ws, { userId: user.id, display_name: user.display_name });

  try {
    ws.send(JSON.stringify({ type: 'snapshot', items: dbm.listItems(db) }));
  } catch { /* ignore */ }
  broadcastPresence(poolId);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg && msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
    }
  });

  ws.on('close', () => {
    const set = hub.get(poolId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) hub.delete(poolId);
    }
    broadcastPresence(poolId);
  });

  ws.on('error', () => { /* ignore */ });
});

// ---------------- REST API ----------------

async function handleApi(req, res, pathname) {
  const segs = pathname.split('/').filter(Boolean); // ['api','pool','<id>', ...]
  if (segs[0] !== 'api' || segs[1] !== 'pool') return respond(res, 404, { error: 'not found' });

  const poolId = segs[2];
  const pool = dbm.getPool(poolId);
  if (!pool) return respond(res, 404, { error: '池不存在' });

  const db = dbm.openPool(poolId);
  const action = segs[3] || '';
  const rest = segs.slice(4);
  const method = req.method.toUpperCase();
  const qs = (() => {
    try { return new URL(req.url, 'http://localhost').searchParams; } catch { return new URLSearchParams(); }
  })();

  function auth() {
    const token = bearerToken(req);
    const session = dbm.getSession(db, token);
    if (!session) return null;
    const user = dbm.userById(db, session.user_id);
    if (!user) return null;
    return { session, user, token };
  }

  // ---- 登录（无需鉴权）----
  if (action === 'login' && method === 'POST') {
    const body = await readJson(req);
    const user = dbm.userByUsername(db, body.username);
    if (!user || !dbm.verifyPassword(body.password, user.password_hash)) {
      return respond(res, 401, { error: '账号或密码错误' });
    }
    const token = dbm.insertSession(db, user.id);
    return respond(res, 200, { token, user: dbm.publicUser(user) });
  }

  // ---- 公开配置（无需鉴权）：品牌名 + 池名，供登录页/顶栏展示 ----
  if (action === 'config' && method === 'GET') {
    return respond(res, 200, { brand: effectiveBrand(pool), pool: { id: poolId, name: pool.name } });
  }

  // ---- 以下均需鉴权 ----
  const ctx = auth();
  if (!ctx) return respond(res, 401, { error: '未登录或登录已失效' });

  if (action === 'logout' && method === 'POST') {
    dbm.deleteSession(db, ctx.token);
    return respond(res, 200, { ok: true });
  }

  if (action === 'me' && method === 'GET') {
    return respond(res, 200, {
      user: dbm.publicUser(ctx.user),
      brand: effectiveBrand(pool),
      pool: { id: poolId, name: pool.name }
    });
  }

  if (action === 'unlock' && method === 'POST') {
    const body = await readJson(req);
    const hash = (dbm.getPool(poolId) || {}).admin_password_hash;
    if (!hash || !dbm.verifyPassword(body.password, hash)) {
      return respond(res, 401, { error: '管理密码错误' });
    }
    dbm.setSessionUnlocked(db, ctx.token, true);
    return respond(res, 200, { ok: true });
  }

  // ---- 自定义界面名称：大标题(品牌) / 副标题(池名)（需进入成员模式）----
  if (action === 'name' && method === 'POST') {
    if (ctx.session.unlocked !== 1) return respond(res, 403, { error: '请先输入管理密码进入成员模式' });
    const body = await readJson(req);
    const patch = {};
    if ('name' in body) {
      const n = String(body.name || '').trim().slice(0, 40);
      if (!n) return respond(res, 400, { error: '副标题名称不能为空' });
      patch.name = n;
    }
    if ('brand' in body) {
      const b = String(body.brand || '').trim().slice(0, 40);
      if (!b) return respond(res, 400, { error: '大标题名称不能为空' });
      patch.brand = b;
    }
    if (!Object.keys(patch).length) return respond(res, 400, { error: '没有要修改的内容' });

    const meta = dbm.setPoolMeta(poolId, patch);
    const brand = effectiveBrand(meta);
    const poolMeta = { id: poolId, name: meta.name };
    broadcast(poolId, { type: 'pool_changed', pool: poolMeta, brand });
    return respond(res, 200, { pool: poolMeta, brand });
  }

  // ---- 联网搜索（核查：把一条消息拿到其他来源找同题报道）----
  if (action === 'search' && method === 'GET') {
    const q = (qs.get('q') || '').trim();
    if (!q) return respond(res, 400, { error: '缺少查询词 q' });
    const r = await search.webSearch(q.slice(0, 200));
    return respond(res, 200, r);
  }

  // ---- 新闻条目 ----
  if (action === 'items') {
    if (method === 'GET' && rest.length === 0) {
      return respond(res, 200, { items: dbm.listItems(db) });
    }

    if (method === 'POST' && rest.length === 0) {
      const body = await readJson(req);
      let url = typeof body.url === 'string' ? body.url.trim() : '';
      let title = typeof body.title === 'string' ? body.title.trim() : '';
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

      if (!url && !title && !note) {
        return respond(res, 400, { error: '请提供链接或标题' });
      }

      // 标题：社交链接（X 等）取正文；否则抓网页标题；都不行就用 URL 路径 slug 兜底
      if (!title && url) {
        const t = await deriveTitle(url);
        if (t) title = t;
      }
      if (!title && url) title = url; // 最终兜底

      const urlNorm = url ? dedup.normalizeUrl(url) : null;
      const titleNorm = dedup.normalizeTitle(title);

      const duplicates = dedup.findDuplicates(db, { urlNorm, titleNorm, title, excludeId: null });

      const row = dbm.insertItem(db, {
        title,
        url: url || null,
        url_norm: urlNorm,
        title_norm: titleNorm,
        source: url ? dedup.deriveSource(url) : null,
        note,
        planned_date: typeof body.planned_date === 'string' && body.planned_date ? body.planned_date : dbm.todayLocal(),
        added_by: ctx.user.id,
        added_by_name: ctx.user.display_name
      });

      const item = dbm.itemRowToJson(row);
      broadcast(poolId, { type: 'item_added', item, duplicates });
      return respond(res, 201, { item, duplicates });
    }

    // 核查：联网搜索其他来源的同题报道，结果保存到条目并广播（全员可见）
    if (method === 'POST' && rest.length === 2 && rest[1] === 'verify') {
      const id = rest[0];
      let row = dbm.getItem(db, id);
      if (!row) return respond(res, 404, { error: '条目不存在' });

      // 标题若仍是链接（例如 X 链接，正文没抓到），先尝试重新取回正文再核查
      let title = String(row.title || '').trim();
      let retitled = false;
      if (row.url && (!title || /^https?:\/\//i.test(title))) {
        const t = await deriveTitle(row.url);
        if (t) {
          db.prepare('UPDATE news_items SET title = ?, title_norm = ?, updated_at = ? WHERE id = ?')
            .run(t, dedup.normalizeTitle(t), dbm.nowIso(), id);
          row = dbm.getItem(db, id);
          title = t;
          retitled = true;
        }
      }

      const q = search.cleanQuery(title);
      if (!q) {
        return respond(res, 400, { error: '这条没有可核查的文字内容，请先用「改标题」写上消息内容' });
      }

      const r = await search.webSearch(q);
      const verify = { at: dbm.nowIso(), query: r.query, engine: r.engine, results: r.results, error: r.error || null };
      dbm.setItemVerify(db, id, verify);
      const updated = dbm.itemRowToJson(dbm.getItem(db, id));
      broadcast(poolId, { type: 'item_updated', item: updated });
      return respond(res, 200, { item: updated, retitled });
    }

    // 清空本池全部条目（测试/重置用，需先进入成员模式）
    if (method === 'DELETE' && rest.length === 0) {
      if (ctx.session.unlocked !== 1) return respond(res, 403, { error: '请先输入管理密码进入成员模式' });
      const cleared = dbm.clearItems(db);
      broadcast(poolId, { type: 'items_cleared' });
      return respond(res, 200, { ok: true, cleared });
    }

    if ((method === 'PATCH' || method === 'DELETE') && rest.length === 1) {
      const id = rest[0];
      const row = dbm.getItem(db, id);
      if (!row) return respond(res, 404, { error: '条目不存在' });

      if (method === 'DELETE') {
        if (row.added_by !== ctx.user.id && ctx.user.role !== 'admin') {
          return respond(res, 403, { error: '无权删除他人添加的条目' });
        }
        db.prepare('DELETE FROM news_items WHERE id = ?').run(id);
        broadcast(poolId, { type: 'item_deleted', id });
        return respond(res, 200, { ok: true });
      }

      // PATCH
      const body = await readJson(req);
      const fields = {};
      if ('title' in body) {
        fields.title = String(body.title || '');
        fields.title_norm = dedup.normalizeTitle(fields.title);
      }
      if ('note' in body) fields.note = body.note;
      if ('planned_date' in body && body.planned_date) fields.planned_date = String(body.planned_date);
      if ('status' in body) {
        const s = String(body.status);
        if (!VALID_STATUS.includes(s)) return respond(res, 400, { error: '非法状态' });
        fields.status = s;
        if (s === 'done') {
          fields.done_at = dbm.nowIso();
          fields.done_by = ctx.user.id;
          fields.done_by_name = ctx.user.display_name;
        } else {
          fields.done_at = null;
          fields.done_by = null;
          fields.done_by_name = null;
        }
      }
      if ('flagged' in body) fields.flagged = body.flagged ? 1 : 0;
      if (Object.keys(fields).length === 0) return respond(res, 400, { error: '没有可更新的字段' });
      fields.updated_at = dbm.nowIso();

      const setSql = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE news_items SET ${setSql} WHERE id = @__id`).run({ ...fields, __id: id });

      const updated = dbm.itemRowToJson(dbm.getItem(db, id));
      broadcast(poolId, { type: 'item_updated', item: updated });
      if (fields.flagged === 1) {
        broadcast(poolId, {
          type: 'notice',
          text: '🔔 「' + ctx.user.display_name + '」把一条新闻标为重点关注：' + (updated.title || '')
        });
      }
      return respond(res, 200, { item: updated });
    }
  }

  // ---- 成员 ----
  if (action === 'members') {
    if (method === 'GET' && rest.length === 0) {
      return respond(res, 200, { members: dbm.listUsers(db).map(dbm.publicUser) });
    }

    const unlocked = ctx.session.unlocked === 1;
    if (method === 'POST' && rest.length === 0) {
      if (!unlocked) return respond(res, 403, { error: '请先输入管理密码进入成员模式' });
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const displayName = String(body.display_name || '').trim() || username;
      const password = String(body.password || '');
      if (!username || !password) return respond(res, 400, { error: '账号和密码必填' });
      if (dbm.userByUsername(db, username)) return respond(res, 409, { error: '该账号已存在' });
      const created = dbm.insertUser(db, {
        username,
        display_name: displayName,
        password,
        role: body.role === 'admin' ? 'admin' : 'member'
      });
      const members = dbm.listUsers(db).map(dbm.publicUser);
      broadcast(poolId, { type: 'members_changed', members });
      return respond(res, 201, { member: dbm.publicUser(created) });
    }

    if (method === 'PATCH' && rest.length === 1) {
      if (!unlocked) return respond(res, 403, { error: '请先输入管理密码进入成员模式' });
      const id = rest[0];
      if (!dbm.userById(db, id)) return respond(res, 404, { error: '成员不存在' });
      const body = await readJson(req);
      const name = String(body.display_name || '').trim().slice(0, 20);
      if (!name) return respond(res, 400, { error: '显示名不能为空' });
      dbm.renameUser(db, id, name);
      const members = dbm.listUsers(db).map(dbm.publicUser);
      broadcast(poolId, { type: 'members_changed', members });
      // 条目上冗余的添加人/播出人名字已同步，广播最新快照让所有人刷新
      broadcast(poolId, { type: 'snapshot', items: dbm.listItems(db) });
      return respond(res, 200, { member: dbm.publicUser(dbm.userById(db, id)) });
    }

    if (method === 'DELETE' && rest.length === 1) {
      if (!unlocked) return respond(res, 403, { error: '请先输入管理密码进入成员模式' });
      const id = rest[0];
      if (id === ctx.user.id) return respond(res, 400, { error: '不能删除自己' });
      const target = dbm.userById(db, id);
      if (!target) return respond(res, 404, { error: '成员不存在' });
      dbm.deleteUser(db, id);
      const members = dbm.listUsers(db).map(dbm.publicUser);
      broadcast(poolId, { type: 'members_changed', members });
      return respond(res, 200, { ok: true });
    }
  }

  return respond(res, 404, { error: 'not found' });
}

// ---------------- 静态资源 ----------------

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA 兜底：未知路径返回 index.html
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (e2, buf) => {
        if (e2) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          return res.end('<h1>共享新闻池</h1><p>前端文件尚未就绪（public/index.html 缺失）。</p>');
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (e2, buf) => {
      if (e2) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('read error');
      }
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

// ---------------- 启动 ----------------

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try {
      return decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return '/';
    }
  })();

  if (pathname.startsWith('/api/')) {
    Promise.resolve(handleApi(req, res, pathname)).catch(() => {
      if (!res.headersSent) respond(res, 500, { error: '服务器内部错误' });
    });
    return;
  }
  if (pathname.startsWith('/ws/')) {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Upgrade Required');
    return;
  }
  serveStatic(req, res, pathname);
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  const m = /^\/ws\/pool\/([^/]+)$/.exec(url.pathname);
  if (!m) { socket.destroy(); return; }
  const poolId = m[1];
  if (!dbm.getPool(poolId)) { socket.destroy(); return; }

  const db = dbm.openPool(poolId);
  const session = dbm.getSession(db, url.searchParams.get('token'));
  const user = session && dbm.userById(db, session.user_id);
  if (!user) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, { poolId, user });
  });
});

function seedIfNeeded() {
  const reg = dbm.readRegistry();
  if (!reg.demo) {
    reg.demo = {
      name: '默认池',
      created_at: dbm.nowIso(),
      admin_password_hash: dbm.hashPassword('admin888')
    };
    dbm.writeRegistry(reg);
  } else if (!reg.demo.admin_password_hash) {
    reg.demo.admin_password_hash = dbm.hashPassword('admin888');
    dbm.writeRegistry(reg);
  }

  const db = dbm.openPool('demo');
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const seeds = [
      { username: 'alice', display_name: '成员A', password: '123456', role: 'admin' },
      { username: 'bob', display_name: '成员B', password: '123456', role: 'member' },
      { username: 'carol', display_name: '成员C', password: '123456', role: 'member' }
    ];
    for (const s of seeds) dbm.insertUser(db, s);
    console.log('[seed] 已创建测试账号。');
  }
}

function start() {
  dbm.ensureDirs();
  seedIfNeeded();

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('========================================');
    console.log('  ' + effectiveBrand(dbm.getPool('demo')) + ' 已启动');
    console.log('  打开浏览器访问:  http://localhost:' + PORT);
    console.log('----------------------------------------');
    console.log('  测试账号 (密码均为 123456):');
    console.log('    alice / 123456   (成员A, 管理员)');
    console.log('    bob   / 123456   (成员B)');
    console.log('    carol / 123456   (成员C)');
    console.log('  成员模式管理密码: admin888');
    console.log('----------------------------------------');
    console.log('  用 3 个浏览器窗口分别登录 3 个账号即可测试实时协作');
    console.log('========================================');
    console.log('');
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});

start();
