'use strict';

// 数据层：全局池注册表 + 每池独立 SQLite 数据库。
// 每个池 = 一个独立 .db 文件（天然隔离，符合"每池独立数据库"）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
// 数据目录可通过环境变量覆盖（便于测试隔离）
const DATA_DIR = process.env.NEWS_POOL_DATA_DIR
  ? path.resolve(process.env.NEWS_POOL_DATA_DIR)
  : path.join(ROOT, 'data');
const POOLS_DIR = path.join(DATA_DIR, 'pools');
const REGISTRY_PATH = path.join(DATA_DIR, 'pools.json');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  unlocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  url_norm TEXT,
  title_norm TEXT,
  source TEXT,
  note TEXT,
  added_by TEXT NOT NULL,
  added_by_name TEXT NOT NULL,
  planned_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  flagged INTEGER NOT NULL DEFAULT 0,
  verify_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT,
  done_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_date ON news_items(planned_date);
`;

const openDbs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function newId() {
  return crypto.randomUUID();
}

// ---------- 池注册表 ----------

function ensureDirs() {
  fs.mkdirSync(POOLS_DIR, { recursive: true });
}

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeRegistry(reg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
}

function getPool(poolId) {
  return readRegistry()[poolId] || null;
}

function listPools() {
  const reg = readRegistry();
  return Object.entries(reg).map(([id, v]) => ({ id, name: v.name, created_at: v.created_at }));
}

// ---------- 打开/初始化池数据库 ----------

function openPool(poolId) {
  if (openDbs.has(poolId)) return openDbs.get(poolId);
  const dir = path.join(POOLS_DIR, poolId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'news.db'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  openDbs.set(poolId, db);
  return db;
}

/** 兼容旧数据库：补齐后加的列 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(news_items)').all().map((c) => c.name);
  if (!cols.includes('flagged')) {
    db.exec('ALTER TABLE news_items ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('verify_json')) {
    db.exec('ALTER TABLE news_items ADD COLUMN verify_json TEXT');
  }
}

function hashPassword(pw) {
  return bcrypt.hashSync(String(pw), 10);
}

function verifyPassword(pw, hash) {
  try {
    return bcrypt.compareSync(String(pw), hash);
  } catch {
    return false;
  }
}

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- 用户 ----------

function userByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
}

function userById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listUsers(db) {
  return db
    .prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at ASC')
    .all();
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
}

function insertUser(db, { username, display_name, password, role }) {
  const user = {
    id: newId(),
    username: String(username).trim(),
    display_name: String(display_name || username).trim(),
    password_hash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'member',
    created_at: nowIso()
  };
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (@id, @username, @display_name, @password_hash, @role, @created_at)'
  ).run(user);
  return user;
}

function deleteUser(db, id) {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return info.changes > 0;
}

/** 修改成员显示名；同时同步条目上的冗余显示名，保持一致 */
function renameUser(db, id, displayName) {
  const name = String(displayName || '').trim();
  if (!name) return null;
  const info = db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, id);
  if (!info.changes) return null;
  db.prepare('UPDATE news_items SET added_by_name = ? WHERE added_by = ?').run(name, id);
  db.prepare('UPDATE news_items SET done_by_name = ? WHERE done_by = ?').run(name, id);
  return name;
}

/** 修改池元信息（名称 / 品牌名），写入注册表 */
function setPoolMeta(poolId, patch) {
  const reg = readRegistry();
  if (!reg[poolId]) return null;
  const entry = reg[poolId];
  if (patch && typeof patch.name === 'string') entry.name = patch.name.trim();
  if (patch && typeof patch.brand === 'string') entry.brand = patch.brand.trim();
  writeRegistry(reg);
  return { id: poolId, name: entry.name, brand: entry.brand || null };
}

// ---------- 会话 ----------

function insertSession(db, userId) {
  const token = createToken();
  db.prepare('INSERT INTO sessions (token, user_id, unlocked, created_at) VALUES (?, ?, 0, ?)').run(
    token,
    userId,
    nowIso()
  );
  return token;
}

function getSession(db, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) || null;
}

function setSessionUnlocked(db, token, unlocked) {
  db.prepare('UPDATE sessions SET unlocked = ? WHERE token = ?').run(unlocked ? 1 : 0, token);
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---------- 新闻条目 ----------

function parseVerify(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function itemRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source,
    note: row.note,
    added_by: row.added_by,
    added_by_name: row.added_by_name,
    planned_date: row.planned_date,
    status: row.status,
    flagged: !!row.flagged,
    verify: parseVerify(row.verify_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    done_at: row.done_at,
    done_by_name: row.done_by_name
  };
}

function listItems(db) {
  return db
    .prepare(
      'SELECT * FROM news_items ORDER BY planned_date ASC, added_by_name ASC, created_at ASC'
    )
    .all()
    .map(itemRowToJson);
}

function getItem(db, id) {
  return db.prepare('SELECT * FROM news_items WHERE id = ?').get(id);
}

/** 清空本池全部条目（测试/重置用），返回删除条数 */
function clearItems(db) {
  return db.prepare('DELETE FROM news_items').run().changes;
}

/** 保存某条目的核查结果（JSON 字符串） */
function setItemVerify(db, id, verify) {
  db.prepare('UPDATE news_items SET verify_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(verify),
    nowIso(),
    id
  );
}

function insertItem(db, data) {
  const row = {
    id: newId(),
    title: data.title || '',
    url: data.url || null,
    url_norm: data.url_norm || null,
    title_norm: data.title_norm || '',
    source: data.source || null,
    note: data.note || null,
    added_by: data.added_by,
    added_by_name: data.added_by_name,
    planned_date: data.planned_date || todayLocal(),
    status: 'pending',
    created_at: nowIso(),
    updated_at: nowIso(),
    done_at: null,
    done_by: null,
    done_by_name: null
  };
  db.prepare(
    `INSERT INTO news_items (id, title, url, url_norm, title_norm, source, note, added_by, added_by_name, planned_date, status, created_at, updated_at, done_at, done_by, done_by_name)
     VALUES (@id, @title, @url, @url_norm, @title_norm, @source, @note, @added_by, @added_by_name, @planned_date, @status, @created_at, @updated_at, @done_at, @done_by, @done_by_name)`
  ).run(row);
  return row;
}

module.exports = {
  ROOT,
  DATA_DIR,
  POOLS_DIR,
  REGISTRY_PATH,
  ensureDirs,
  readRegistry,
  writeRegistry,
  getPool,
  listPools,
  openPool,
  hashPassword,
  verifyPassword,
  createToken,
  userByUsername,
  userById,
  listUsers,
  publicUser,
  insertUser,
  deleteUser,
  renameUser,
  setPoolMeta,
  insertSession,
  getSession,
  setSessionUnlocked,
  deleteSession,
  listItems,
  getItem,
  clearItems,
  setItemVerify,
  insertItem,
  itemRowToJson,
  newId,
  nowIso,
  todayLocal
};
