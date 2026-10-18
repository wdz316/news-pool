'use strict';

// 端到端冒烟测试：启动真实服务（独立数据目录 + 关闭外网抓取），
// 覆盖登录 / 鉴权 / 添加 / 去重(URL+标题相似) / 状态流转 / 成员模式 / WebSocket 实时广播。
// 运行：node verify/smoke.cjs

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const dedup = require('../src/dedup');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newspool-test-'));

// 搜索桩：让核查功能在测试中不依赖外网
const SEARCH_STUB = JSON.stringify([
  { title: '其他来源报道 A', url: 'https://news-a.example/story', source: 'news-a.example', snippet: '摘要 A' },
  { title: '其他来源报道 B', url: 'https://news-b.example/story', source: 'news-b.example', snippet: '摘要 B' }
]);

// 社交展开桩：X 链接取回正文（测试不联网）
const SOCIAL_STUB = JSON.stringify({ text: 'X 推文正文测试内容', author: '某博主' });

let failures = 0;
let checks = 0;

function check(cond, msg) {
  checks++;
  if (cond) console.log('  PASS  ' + msg);
  else { failures++; console.log('  FAIL  ' + msg); }
}

async function req(p, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error('等待超时: ' + label);
    await sleep(150);
  }
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NEWS_POOL_DATA_DIR: DATA_DIR,
      NEWS_POOL_DISABLE_FETCH: '1',
      NEWS_POOL_SEARCH_STUB: SEARCH_STUB,
      NEWS_POOL_SOCIAL_STUB: SOCIAL_STUB
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitFor(async () => (await fetch(BASE + '/')).ok, 10000, '服务启动');

    console.log('\n[0] 去重/标题 单元检查');
    check(dedup.normalizeUrl('https://news.example.com/a?utm_source=x&fbclid=y') === 'https://news.example.com/a', 'normalizeUrl 去跟踪参数');
    check(dedup.isJunkTitle('MSN', 'https://www.msn.com/x') === true, 'isJunkTitle 识别站点名 MSN 为无效标题');
    check(dedup.titleFromUrl('https://a.com/world/us-election-results-2026') === 'us election results 2026', 'titleFromUrl 英文 slug 提取');
    check(dedup.similarity('泽连斯基称星链运行改善但未完全恢复', '星链运行改善但未完全恢复') >= 0.6, '中文标题相似度(无空格)达标');
    check(dedup.similarity('芝加哥枪战', '美联储加息决议') < 0.3, '不相关中文标题相似度低');

    console.log('\n[1] 登录与鉴权');
    const alice = await req('/api/pool/demo/login', { method: 'POST', body: { username: 'alice', password: '123456' } });
    check(alice.status === 200 && alice.data.token, 'alice 登录成功并返回 token');
    check(alice.data.user && alice.data.user.display_name === '成员A', '返回用户信息正确 (成员A)');

    const bad = await req('/api/pool/demo/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
    check(bad.status === 401, '错误密码被拒绝 (401)');

    const bob = await req('/api/pool/demo/login', { method: 'POST', body: { username: 'bob', password: '123456' } });
    const carol = await req('/api/pool/demo/login', { method: 'POST', body: { username: 'carol', password: '123456' } });
    check(bob.status === 200 && carol.status === 200, 'bob / carol 登录成功');

    const noAuth = await req('/api/pool/demo/items');
    check(noAuth.status === 401, '未登录访问条目被拒绝 (401)');

    console.log('\n[2] 添加新闻 + URL 去重');
    const a1 = await req('/api/pool/demo/items', {
      method: 'POST',
      token: alice.data.token,
      body: { url: 'https://news.example.com/story?id=42&utm_source=wechat' }
    });
    check(a1.status === 201 && a1.data.item, 'alice 添加新闻成功');
    check(Array.isArray(a1.data.duplicates) && a1.data.duplicates.length === 0, '首条无重复');

    const b1 = await req('/api/pool/demo/items', {
      method: 'POST',
      token: bob.data.token,
      body: { url: 'https://news.example.com/story?id=42&utm_source=twitter&fbclid=abc' }
    });
    check(b1.status === 201, 'bob 添加(同链接,不同跟踪参数)成功');
    check(b1.data.duplicates.length >= 1, '检测到重复');
    check(b1.data.duplicates[0].reason === 'url', '重复原因为相同链接 (url)');
    check(b1.data.duplicates[0].added_by_name === '成员A', '重复项指向 alice(成员A)');

    console.log('\n[3] 标题相似度去重');
    await req('/api/pool/demo/items', { method: 'POST', token: carol.data.token, body: { title: '特斯拉 上海 工厂 停产' } });
    const t2 = await req('/api/pool/demo/items', { method: 'POST', token: bob.data.token, body: { title: '特斯拉 上海 工厂 起火' } });
    const sim = (t2.data.duplicates || []).find((d) => d.reason === 'similar' || d.reason === 'title');
    check(!!sim, '标题相似被识别为重复 (similar/title)');

    console.log('\n[4] 状态流转 + 已播强提醒');
    const listed = await req('/api/pool/demo/items', { token: alice.data.token });
    check(listed.data.items.length === 4, '列表返回全部 4 条 (' + listed.data.items.length + ')');

    const done = await req('/api/pool/demo/items/' + a1.data.item.id, {
      method: 'PATCH',
      token: alice.data.token,
      body: { status: 'done' }
    });
    check(done.status === 200 && done.data.item.status === 'done', '标记为已播成功');
    check(done.data.item.done_by_name === '成员A', '记录播出人 (成员A)');

    const b2 = await req('/api/pool/demo/items', {
      method: 'POST',
      token: bob.data.token,
      body: { url: 'https://news.example.com/story?id=42' }
    });
    const doneDup = (b2.data.duplicates || []).find((d) => d.status === 'done');
    check(!!doneDup, '已播出的重复项仍被返回并标记状态为 done');

    console.log('\n[4b] 标题：URL slug 兜底 + 手动修改');
    const msnUrl = 'https://www.msn.com/zh-hk/news/other/%E7%BE%8E%E7%83%8F%E9%97%9C%E4%BF%82%E7%B7%8A%E5%BC%B5-%E6%BE%A4%E5%80%AB%E6%96%AF%E5%9F%BA%E7%A8%B1%E9%9B%99%E6%96%B9%E8%AB%87%E5%88%A4%E4%BB%A3%E8%A1%A8%E5%8F%AF%E8%83%BD%E6%9C%83%E9%9D%A2/ar-AA2enPox?ocid=msedgntp';
    const slugItem = await req('/api/pool/demo/items', { method: 'POST', token: carol.data.token, body: { url: msnUrl } });
    check(slugItem.status === 201, 'MSN 链接添加成功');
    check(!!slugItem.data.item.title && slugItem.data.item.title.indexOf('澤倫斯基') !== -1,
      '标题从 URL slug 兜底提取 (' + slugItem.data.item.title + ')');

    const edited = await req('/api/pool/demo/items/' + slugItem.data.item.id, {
      method: 'PATCH', token: carol.data.token, body: { title: '我手动改的标题' }
    });
    check(edited.status === 200 && edited.data.item.title === '我手动改的标题', 'PATCH 手动修改标题生效');

    console.log('\n[5] 成员模式');
    const badUnlock = await req('/api/pool/demo/unlock', { method: 'POST', token: bob.data.token, body: { password: 'nope' } });
    check(badUnlock.status === 401, '错误管理密码被拒绝 (401)');

    const noPerm = await req('/api/pool/demo/members', {
      method: 'POST',
      token: bob.data.token,
      body: { username: 'dave', display_name: '成员D', password: '123456', role: 'member' }
    });
    check(noPerm.status === 403, '未解锁时添加成员被拒绝 (403)');

    const unlock = await req('/api/pool/demo/unlock', { method: 'POST', token: bob.data.token, body: { password: 'admin888' } });
    check(unlock.status === 200, '正确管理密码解锁成功');

    const addMember = await req('/api/pool/demo/members', {
      method: 'POST',
      token: bob.data.token,
      body: { username: 'dave', display_name: '成员D', password: '123456', role: 'member' }
    });
    check(addMember.status === 201, '解锁后添加成员成功');

    const dupMember = await req('/api/pool/demo/members', {
      method: 'POST',
      token: bob.data.token,
      body: { username: 'dave', display_name: '成员D', password: '123456', role: 'member' }
    });
    check(dupMember.status === 409, '重复账号被拒绝 (409)');

    console.log('\n[5b] 自定义池名称 + 成员改名');
    const nameNoPerm = await req('/api/pool/demo/name', { method: 'POST', token: carol.data.token, body: { name: '偷偷改池名' } });
    check(nameNoPerm.status === 403, '未解锁改池名被拒绝 (403)');

    const nameOk = await req('/api/pool/demo/name', { method: 'POST', token: bob.data.token, body: { name: '我的新闻台' } });
    check(nameOk.status === 200 && nameOk.data.pool.name === '我的新闻台', '解锁后改池名成功');

    const cfg = await req('/api/pool/demo/config');
    check(cfg.status === 200 && cfg.data.pool.name === '我的新闻台', 'GET /config 反映新池名（公开，无需登录）');
    check(!!cfg.data.brand, 'GET /config 返回品牌名');

    const brandOk = await req('/api/pool/demo/name', { method: 'POST', token: bob.data.token, body: { brand: '我的新闻台' } });
    check(brandOk.status === 200 && brandOk.data.brand === '我的新闻台', '解锁后改品牌名(大标题)成功');

    const cfgBrand = await req('/api/pool/demo/config');
    check(cfgBrand.data.brand === '我的新闻台', '/config 反映新品牌名 (持久化)');

    const brandNoPerm = await req('/api/pool/demo/name', { method: 'POST', token: carol.data.token, body: { brand: '偷偷改' } });
    check(brandNoPerm.status === 403, '未解锁改品牌名被拒绝 (403)');

    const meAfter = await req('/api/pool/demo/me', { token: bob.data.token });
    check(meAfter.data.pool && meAfter.data.pool.name === '我的新闻台', '/me 返回池名称');

    const renNoPerm = await req('/api/pool/demo/members/' + carol.data.user.id, {
      method: 'PATCH', token: carol.data.token, body: { display_name: 'X' }
    });
    check(renNoPerm.status === 403, '未解锁改成员名被拒绝 (403)');

    const ren = await req('/api/pool/demo/members/' + carol.data.user.id, {
      method: 'PATCH', token: bob.data.token, body: { display_name: '小李' }
    });
    check(ren.status === 200 && ren.data.member.display_name === '小李', '解锁后改成员显示名成功');

    const renEmpty = await req('/api/pool/demo/members/' + carol.data.user.id, {
      method: 'PATCH', token: bob.data.token, body: { display_name: '   ' }
    });
    check(renEmpty.status === 400, '空显示名被拒绝 (400)');

    console.log('\n[5c] 删除条目：自己可删，管理员可删他人，普通成员不可删他人');
    const mineItem = await req('/api/pool/demo/items', { method: 'POST', token: carol.data.token, body: { title: '待删除测试条条目 QQ' } });
    const delOthers = await req('/api/pool/demo/items/' + mineItem.data.item.id, { method: 'DELETE', token: bob.data.token });
    check(delOthers.status === 403, '普通成员删除他人条目被拒绝 (403)');

    const delMine = await req('/api/pool/demo/items/' + mineItem.data.item.id, { method: 'DELETE', token: carol.data.token });
    check(delMine.status === 200, '删除自己添加的条目成功');

    const goneList = await req('/api/pool/demo/items', { token: alice.data.token });
    check(!(goneList.data.items || []).some((x) => x.id === mineItem.data.item.id), '删除后条目不在列表中');

    const adminTarget = await req('/api/pool/demo/items', { method: 'POST', token: carol.data.token, body: { title: '管理员删除测试 条目 ZZ' } });
    const delAdmin = await req('/api/pool/demo/items/' + adminTarget.data.item.id, { method: 'DELETE', token: alice.data.token });
    check(delAdmin.status === 200, '管理员可删除他人条目');

    console.log('\n[6] WebSocket 实时广播');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/pool/demo?token=${carol.data.token}`);
    const events = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS 连接超时')), 5000);
      ws.on('message', (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        events.push(m);
        if (m.type === 'snapshot') { clearTimeout(timer); resolve(); }
      });
      ws.on('error', reject);
    });
    check(events.some((e) => e.type === 'snapshot'), '连接后收到 snapshot');

    const addedWaiter = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 4000);
      ws.on('message', (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        if (m.type === 'item_added') { clearTimeout(t); resolve(m); }
      });
    });
    await req('/api/pool/demo/items', { method: 'POST', token: alice.data.token, body: { title: '实时广播测试条目 XYZ' } });
    const evt = await addedWaiter;
    check(evt && evt.item && evt.item.title === '实时广播测试条目 XYZ', '他人添加时实时收到 item_added');

    console.log('\n[7] 重点关注标记 + 全池提醒');
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws/pool/demo?token=${bob.data.token}`);
    const got = { updated: null, notice: null };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS2 连接超时')), 5000);
      ws2.on('open', () => { clearTimeout(t); resolve(); });
      ws2.on('error', reject);
      ws2.on('message', (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        if (m.type === 'item_updated' && m.item && m.item.flagged) got.updated = m.item;
        if (m.type === 'notice') got.notice = m.text;
      });
    });
    const fitem = await req('/api/pool/demo/items', { method: 'POST', token: alice.data.token, body: { title: '重点关注测试条目' } });
    await sleep(200);
    await req('/api/pool/demo/items/' + fitem.data.item.id, { method: 'PATCH', token: alice.data.token, body: { flagged: true } });
    await sleep(400);
    check(got.updated && got.updated.flagged === true, 'flagged 标记广播 item_updated');
    check(!!got.notice, '提交后广播 notice 全池提醒 (' + got.notice + ')');
    ws2.close();

    console.log('\n[7b] 移动日期（PATCH planned_date）+ 取消重点关注');
    const moved = await req('/api/pool/demo/items/' + fitem.data.item.id, {
      method: 'PATCH', token: bob.data.token, body: { planned_date: '2030-01-02' }
    });
    check(moved.status === 200 && moved.data.item.planned_date === '2030-01-02', 'PATCH planned_date 移动成功');
    check(moved.data.item.status === 'pending', '移动后状态仍为待播');
    check(moved.data.item.flagged === true, '移动不影响重点关注标记');

    const relistMoved = await req('/api/pool/demo/items', { token: alice.data.token });
    const stillThere = (relistMoved.data.items || []).find((x) => x.id === fitem.data.item.id && x.planned_date === '2030-01-02');
    check(!!stillThere, '移动后日期已持久化（重新拉取在 2030-01-02）');

    const noopDate = await req('/api/pool/demo/items/' + fitem.data.item.id, {
      method: 'PATCH', token: bob.data.token, body: { planned_date: '' }
    });
    check(noopDate.status === 400, '空日期不生效（400，不误改）');

    const unflagged = await req('/api/pool/demo/items/' + fitem.data.item.id, {
      method: 'PATCH', token: bob.data.token, body: { flagged: false }
    });
    check(unflagged.status === 200 && unflagged.data.item.flagged === false, '取消重点关注成功 (flagged=false)');

    console.log('\n[7c] 备注：添加时写入 / 之后修改 / 可清空');
    const noteText = '背景：某某人是谁\n评价：值得一看';
    const nAdd = await req('/api/pool/demo/items', {
      method: 'POST', token: alice.data.token, body: { title: '带备注的新闻条目', note: noteText }
    });
    check(nAdd.status === 201 && nAdd.data.item.note === noteText, '添加时写入备注（含换行）');

    const nEdit = await req('/api/pool/demo/items/' + nAdd.data.item.id, {
      method: 'PATCH', token: alice.data.token, body: { note: '改过的备注' }
    });
    check(nEdit.status === 200 && nEdit.data.item.note === '改过的备注', 'PATCH 修改备注生效');

    const nClear = await req('/api/pool/demo/items/' + nAdd.data.item.id, {
      method: 'PATCH', token: alice.data.token, body: { note: '' }
    });
    check(nClear.status === 200 && !nClear.data.item.note, '备注可清空');

    console.log('\n[8] 联网核查：搜索接口');
    const s1 = await req('/api/pool/demo/search?q=' + encodeURIComponent('测试查询'), { token: alice.data.token });
    check(s1.status === 200, 'GET /search 返回 200');
    check(s1.data.engine === 'stub', '使用注入的搜索桩 (stub)');
    check(Array.isArray(s1.data.results) && s1.data.results.length === 2, '返回 2 条结果');

    const noQ = await req('/api/pool/demo/search', { token: alice.data.token });
    check(noQ.status === 400, '缺少 q 参数返回 400');

    const noAuthSearch = await req('/api/pool/demo/search?q=x');
    check(noAuthSearch.status === 401, '未登录搜索被拒绝 (401)');

    console.log('\n[9] 条目核查：结果持久化 + 广播');
    const vItem = await req('/api/pool/demo/items', { method: 'POST', token: alice.data.token, body: { title: '需要核查的消息内容 ABCDEF' } });
    check(vItem.status === 201, '创建待核查条目');

    const ws3 = new WebSocket(`ws://127.0.0.1:${PORT}/ws/pool/demo?token=${carol.data.token}`);
    let verifyEvt = null;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS3 连接超时')), 5000);
      ws3.on('open', () => { clearTimeout(t); resolve(); });
      ws3.on('error', reject);
      ws3.on('message', (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch { return; }
        if (m.type === 'item_updated' && m.item && m.item.id === vItem.data.item.id && m.item.verify) verifyEvt = m.item;
      });
    });

    const vr = await req('/api/pool/demo/items/' + vItem.data.item.id + '/verify', { method: 'POST', token: alice.data.token });
    check(vr.status === 200, 'POST /items/:id/verify 返回 200');
    check(!!(vr.data.item.verify && vr.data.item.verify.results.length === 2), '核查结果保存到条目 (2 条)');

    const relist = await req('/api/pool/demo/items', { token: alice.data.token });
    const persisted = (relist.data.items || []).find((x) => x.id === vItem.data.item.id);
    check(!!(persisted && persisted.verify && persisted.verify.results.length === 2), '核查结果持久化（重新拉取仍在）');
    await sleep(400);
    check(!!verifyEvt, '核查完成广播 item_updated（含 verify）');

    const urlItem = await req('/api/pool/demo/items', { method: 'POST', token: alice.data.token, body: { url: 'https://example.com/only-url' } });
    const vr2 = await req('/api/pool/demo/items/' + urlItem.data.item.id + '/verify', { method: 'POST', token: alice.data.token });
    check(vr2.status === 400, '纯链接条目核查返回 400（无可核查文本）');
    ws3.close();

    console.log('\n[9b] X/Twitter 链接：自动取回推文正文作为标题');
    const xAdd = await req('/api/pool/demo/items', {
      method: 'POST', token: alice.data.token,
      body: { url: 'https://x.com/someone/status/1234567890' }
    });
    check(xAdd.status === 201, 'X 链接添加成功');
    check(xAdd.data.item.title === 'X 推文正文测试内容', 'X 链接标题取自推文正文 (' + xAdd.data.item.title + ')');

    // 模拟旧数据：标题仍是 URL，点核查时应自动重取正文
    const legacy = await req('/api/pool/demo/items', {
      method: 'POST', token: alice.data.token,
      body: { title: 'https://x.com/someone/status/999', url: 'https://x.com/someone/status/999' }
    });
    check(legacy.data.item.title === 'https://x.com/someone/status/999', '旧数据：标题为纯链接');
    const legacyVerify = await req('/api/pool/demo/items/' + legacy.data.item.id + '/verify', { method: 'POST', token: alice.data.token });
    check(legacyVerify.status === 200 && legacyVerify.data.retitled === true, '核查时自动重取正文(retitled)');
    check(legacyVerify.data.item.title === 'X 推文正文测试内容', '旧数据标题被自动修复为推文正文');
    check(legacyVerify.data.item.verify.results.length === 2, '用推文正文做关键字核查成功');

    console.log('\n[9c] 核查来源交叉命中：加入核查结果里的链接应报重复');
    const crossAdd = await req('/api/pool/demo/items', {
      method: 'POST', token: bob.data.token,
      body: { url: 'https://news-a.example/story?utm_source=share' }
    });
    const crossDup = (crossAdd.data.duplicates || []).find((d) => d.reason === 'verify');
    check(!!crossDup, '加入核查结果中的链接被识别为重复 (reason=verify)');

    console.log('\n[10] 清空本池记录（需成员模式）');
    const clearNoPerm = await req('/api/pool/demo/items', { method: 'DELETE', token: carol.data.token });
    check(clearNoPerm.status === 403, '未解锁清空被拒绝 (403)');

    const cleared = await req('/api/pool/demo/items', { method: 'DELETE', token: bob.data.token });
    check(cleared.status === 200 && cleared.data.cleared >= 1, '解锁后清空成功 (cleared=' + (cleared.data && cleared.data.cleared) + ')');

    const afterClear = await req('/api/pool/demo/items', { token: alice.data.token });
    check((afterClear.data.items || []).length === 0, '清空后条目为 0');

    console.log('\n[11] 前端静态产物检查');
    const jsRes = await fetch(BASE + '/app.js');
    const js = await jsRes.text();
    check(jsRes.status === 200, 'GET /app.js 返回 200');
    check(js.includes('function statusToggle'), 'app.js 含合并后的状态胶囊 statusToggle');
    check(!/actionBtn\('标记已播'/.test(js), 'app.js 已移除单独的「标记已播」按钮');
    check(js.includes('function jumpToDate'), 'app.js 含统计→列表跳转 jumpToDate');
    check(js.includes('function linkifyInto'), 'app.js 含备注网址链接化 linkifyInto');
    check(js.includes('⏭️ 略过这条') && js.includes('📅 移动日期') && js.includes('📋 复制标题+备注+链接'),
      '⋯ 菜单项统一带图标');

    const cssRes = await fetch(BASE + '/style.css');
    const css = await cssRes.text();
    check(cssRes.status === 200, 'GET /style.css 返回 200');
    check(css.includes('.item-badge:hover'), 'style.css 含状态胶囊悬停效果');
    check(css.includes('.day-flash'), 'style.css 含跳转高亮 .day-flash');
    check(css.includes('.note-link'), 'style.css 含备注链接样式');
    check(css.includes('.stats-cell.has-items'), 'style.css 含统计格可点样式');

    const htmlRes = await fetch(BASE + '/');
    const html = await htmlRes.text();
    check(html.includes('id="note-modal"') && html.includes('id="stats-modal"'), 'index.html 含备注与统计弹窗');

    console.log('\n[12] 外观主题（10 套）检查');
    const themeKeys = ['warm', 'oled', 'print', 'crt', 'soft', 'luxury', 'blueprint', 'riso', 'zaxis', 'neon'];
    const missingCss = themeKeys.filter((k) => !css.includes('[data-theme="' + k + '"]'));
    check(missingCss.length === 0, 'style.css 含全部 10 个主题块' + (missingCss.length ? '（缺:' + missingCss.join(',') + '）' : ''));
    check(css.includes('.theme-swatch') && css.includes('.theme-grid'), 'style.css 含外观设置面板样式');
    check(css.includes('--font:') && css.includes('--font-display:'), 'style.css 主题含字体位变量');

    check(js.includes('function applyTheme'), 'app.js 含 applyTheme');
    check(js.includes('const THEMES') && js.includes("'classic'") && js.includes("'neon'"), 'app.js 含 THEMES 清单（经典…霓虹）');
    check(js.includes("localStorage.setItem('np_theme'"), 'app.js 主题写入 localStorage(np_theme)');
    check(js.includes("setAttribute('data-theme'"), 'app.js 切换 <html data-theme>');

    check(html.includes('id="btn-theme"'), 'index.html 含顶栏「外观」按钮');
    check(html.includes('id="theme-modal"') && html.includes('id="theme-grid"'), 'index.html 含外观弹窗与网格容器');

    console.log('\n[12b] 状态色条 × 悬停 不打架（回归）');
    check(css.includes(':not(.status-done):not(.status-skipped)'), '待播左侧色条常驻（琥珀）');
    check(!/\.item:hover\s*\{[^}]*border-left-color/.test(css), '悬停规则不再覆盖状态色条 border-left-color');
    check(css.includes('[data-theme="blueprint"] .item:hover'), '工程图纸主题有独立悬停反馈（发光描边）');
    check(css.includes('.theme-swatch.active'), '外观面板有选中态样式');
    check(!css.includes('repeating-linear-gradient'), '战术终端已去掉扫描线细线（不铺满屏）');

    console.log('\n[12c] ⋯ 菜单遮挡回归：展开时抬高整张卡');
    check(css.includes('.item.menu-open'), 'style.css 含 .item.menu-open 抬高层');
    check(/\.item\.menu-open\s*\{[^}]*z-index/.test(css), '抬高层明确设置了 z-index');
    check(js.includes("classList.add('menu-open')"), 'app.js 展开菜单时给卡片加 menu-open');
    check(js.includes("remove('menu-open')"), 'app.js closeMenu 会移除 menu-open（放下卡片）');
    check(js.includes("closest('.item')"), 'app.js 用 closest(.item) 定位并抬高卡片');
    check(/\[data-theme="neon"\]\s*\.item\.menu-open\s*\{[^}]*clip-path:\s*none/.test(css), '赛博霓虹：菜单展开时取消切角 clip-path（否则菜单被裁）');
    check(css.includes('.menu-pop.up'), 'style.css 含 .menu-pop.up（空间不足向上弹）');
    check(js.includes("classList.add('up')"), 'app.js 空间不足时给菜单加 up');

    console.log('\n[13] 傻瓜安装 / 无后门自证 交付物检查');
    const readRoot = (rel) => { try { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); } catch { return ''; } };
    const auditSrc = readRoot('scripts/audit.cjs');
    check(auditSrc.length > 0, 'scripts/audit.cjs 存在（无后门自查脚本）');
    check(auditSrc.includes('DOMAIN_ALLOWLIST') && auditSrc.includes('api.fxtwitter.com'), 'audit.cjs 含外联域名白名单');
    check(auditSrc.includes('child_process') && auditSrc.includes('未发现'), 'audit.cjs 含危险模式检查');
    const pkgJson = JSON.parse(readRoot('package.json') || '{}');
    check(pkgJson.scripts && pkgJson.scripts.audit === 'node scripts/audit.cjs', 'package.json 含 audit 脚本');
    const secDoc = readRoot('SECURITY.md');
    check(secDoc.includes('npm run audit') && secDoc.includes('F12'), 'SECURITY.md 含自验方法（脚本 + F12）');
    const deployDoc = readRoot('部署指南.md');
    check(deployDoc.includes('局域网') && deployDoc.includes('隧道') && deployDoc.includes('VPS'), '部署指南.md 含三种部署方式');
    check(readRoot('给访客的一页纸.md').includes('你只要做 3 步'), '给访客的一页纸.md 存在');
    check(readRoot('README.md').includes('npm run audit'), 'README 提到 npm run audit');
    check(readRoot('start.bat').includes('winget'), 'start.bat 支持 winget 一键装 Node');

    console.log('\n[14] 发布工具 / 使用手册 交付物检查');
    const publishSrc = readRoot('scripts/publish.cjs');
    check(publishSrc.includes('gh') && publishSrc.includes("'release'"), 'scripts/publish.cjs 存在（一键发布）');
    check(publishSrc.includes("'archive'") && publishSrc.includes('--format=zip') && (publishSrc.includes('sha256') || publishSrc.includes('SHA256')), 'publish.cjs 生成 zip 并计算 SHA256');
    check(readRoot('scripts/manual.cjs').includes('print-to-pdf'), 'scripts/manual.cjs 存在（无头浏览器生成 PDF）');
    const manualHtml = readRoot('docs/使用手册.html');
    check(manualHtml.includes('使用手册') && manualHtml.includes('@page'), 'docs/使用手册.html 存在且为打印优化');
    check(pkgJson.scripts.release === 'node scripts/publish.cjs', 'package.json 含 release 脚本');
    check(pkgJson.scripts.manual === 'node scripts/manual.cjs', 'package.json 含 manual 脚本');
    check(!!(pkgJson.repository && String(pkgJson.repository.url || '').includes('github.com')), 'package.json 含 repository（发布工具据此定位仓库）');
    check(readRoot('README.md').includes('您可以使用 AI 代理进行修改'), 'README 含「可用 AI 代理修改」说明');

    console.log('\n[15] 开源合规 / 许可与免责');
    const notices = readRoot('THIRD-PARTY-NOTICES.md');
    check(notices.includes('bcryptjs') && notices.includes('better-sqlite3') && notices.includes('ws'), 'THIRD-PARTY-NOTICES.md 列出全部直接依赖');
    check(notices.includes('MIT') && /不含 GPL|无 GPL/.test(notices), 'THIRD-PARTY-NOTICES.md 含许可证汇总与无 copyleft 结论');
    check(notices.includes('OFL') && notices.includes('未分发'), 'THIRD-PARTY-NOTICES.md 说明字体许可（OFL）且未分发字体文件');
    check(readRoot('LICENSE').includes('MIT'), 'LICENSE 为 MIT');
    const readmeFinal = readRoot('README.md');
    check(readmeFinal.includes('免责声明'), 'README 含免责声明');
    check(readmeFinal.includes('THIRD-PARTY-NOTICES.md'), 'README 链到第三方许可清单');

    ws.close();
  } finally {
    server.kill();
    await sleep(300);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n========================================');
  console.log(`  结果: ${checks - failures}/${checks} 通过`);
  console.log('========================================');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n[测试异常]', e);
  process.exit(1);
});
