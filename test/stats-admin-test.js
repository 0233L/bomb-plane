// ============================================
// test/stats-admin-test.js —— 后台（/stats）口令门禁 + 在线访客 + 昵称编辑测试
//
// 用法：
//   1. 先以短回收计时启动服务器：
//      RECYCLE_SECONDS=3 node server.js
//   2. 再运行本测试：
//      node test/stats-admin-test.js
// ============================================
'use strict';

// 原生 WebSocket 客户端：复用 public/ws.js（Node 里先提供一个全局 WebSocket）
global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');

const URL = process.env.TEST_URL || 'http://localhost:3000'; // 默认连本机 3000；回归测试可注入 TEST_URL 换端口
const KEY = process.env.ADMIN_KEY || process.env.STATS_KEY || '1233'; // 和 server.js 的钥匙解析一致

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 等待某个 socket 收到指定事件
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 4000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}

// 发 visit 并等回包（保证服务端已登记）
async function visitAndWait(socket, vid) {
  socket.emit('visit', { visitorId: vid, platform: 'web' });
  await waitFor(socket, 'visitResult');
}

async function main() {
  const A = new WSClient(URL);
  const B = new WSClient(URL);
  await Promise.all([waitFor(A, 'connect'), waitFor(B, 'connect')]);

  const vidA = 'admin-' + Date.now() + '-A';
  const vidB = 'admin-' + Date.now() + '-B';

  // 1. 口令门禁：无钥匙/错钥匙都不进列表，只显示口令输入页（不泄露任何访客数据）
  console.log('— 口令门禁 —');
  const noKey = await fetch(URL + '/stats');
  const noKeyHtml = await noKey.text();
  check('无钥匙打开 /stats 显示口令输入页', noKey.status === 200 && noKeyHtml.indexOf('请输入后台口令') !== -1);
  const badKey = await fetch(URL + '/stats?key=wrong');
  const badHtml = await badKey.text();
  check('错钥匙显示「口令错误」且不泄露数据', badKey.status === 200 &&
    badHtml.indexOf('口令错误') !== -1 && badHtml.indexOf(vidA) === -1);

  // 口令表单：对 → 302 到带钥匙的明细页；错 → 重显口令页
  const formOk = await fetch(URL + '/stats', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'key=' + encodeURIComponent(KEY)
  });
  check('口令表单提交正确 → 302 跳转明细页', formOk.status === 302 &&
    (formOk.headers.get('location') || '').indexOf('key=') !== -1);
  const formBad = await fetch(URL + '/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'key=wrong'
  });
  const formBadHtml = await formBad.text();
  check('口令表单提交错误 → 重显口令页', formBad.status === 200 && formBadHtml.indexOf('口令错误') !== -1);

  // 2. 在线访客：连接上报 visit 后在线，断开后离线
  console.log('— 在线访客 —');
  await visitAndWait(A, vidA);
  let data = await (await fetch(URL + '/stats.json?key=' + KEY)).json();
  let rec = data.visitors.find(function (v) { return v.id === vidA; });
  check('visit 后该访客在线', rec && rec.online === true);
  check('在线人数至少 1', data.onlineCount >= 1);

  await visitAndWait(B, vidB);
  data = await (await fetch(URL + '/stats.json?key=' + KEY)).json();
  rec = data.visitors.find(function (v) { return v.id === vidA; });
  const recB = data.visitors.find(function (v) { return v.id === vidB; });
  check('两个连接 → 两位访客都在线', rec && rec.online && recB && recB.online);

  A.disconnect();
  await sleep(400); // 等服务端 close 处理
  data = await (await fetch(URL + '/stats.json?key=' + KEY)).json();
  rec = data.visitors.find(function (v) { return v.id === vidA; });
  const recB2 = data.visitors.find(function (v) { return v.id === vidB; });
  check('断开 A → A 离线、B 仍在线', rec && rec.online === false && recB2 && recB2.online === true);

  B.disconnect();
  await sleep(400);
  data = await (await fetch(URL + '/stats.json?key=' + KEY)).json();
  rec = data.visitors.find(function (v) { return v.id === vidA; });
  check('全部断开 → 无人在线', data.onlineCount === 0 && rec && rec.online === false);

  // 3. 昵称编辑（后台备注）
  console.log('— 昵称编辑 —');
  const renameOk = await fetch(URL + '/stats/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, id: vidA, nickname: '我的手机' })
  });
  check('改名接口返回成功', renameOk.status === 200);
  data = await (await fetch(URL + '/stats.json?key=' + KEY)).json();
  check('/stats.json 返回昵称', data.visitors.some(function (v) { return v.id === vidA && v.nickname === '我的手机'; }));
  let pageHtml = await (await fetch(URL + '/stats?key=' + KEY)).text();
  check('/stats 页面显示昵称', pageHtml.indexOf('我的手机') !== -1);

  // 昵称转义：防 HTML 注入
  await fetch(URL + '/stats/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, id: vidA, nickname: '<b>x</b>' })
  });
  const escHtml = await (await fetch(URL + '/stats?key=' + KEY)).text();
  check('昵称里的 HTML 被转义', escHtml.indexOf('&lt;b&gt;x&lt;/b&gt;') !== -1 && escHtml.indexOf('<b>x</b>') === -1);

  // 校验：错口令 403 / 不存在 ID 404 / 超长昵称 400
  const noAuth = await fetch(URL + '/stats/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'wrong', id: vidA, nickname: 'x' })
  });
  check('错口令改名被拒', noAuth.status === 403);
  const noId = await fetch(URL + '/stats/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, id: 'no-such-id', nickname: 'x' })
  });
  check('不存在的访客返回 404', noId.status === 404);
  const longName = await fetch(URL + '/stats/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, id: vidA, nickname: '一二三四五六七八九十甲乙丙丁' })
  });
  check('超长昵称被拒', longName.status === 400);

  // 4. 昵称持久化（1 秒防抖落盘，重启后还在）
  console.log('— 昵称持久化 —');
  await fetch(URL + '/stats/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, id: vidA, nickname: '持久化昵称' })
  });
  await sleep(1500);
  const fs = require('fs');
  const path = require('path');
  const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'stats.json'), 'utf8'));
  check('昵称已写入 stats.json', saved.visitors[vidA] && saved.visitors[vidA].nickname === '持久化昵称');

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
  if (failed > 0) process.exit(1);
}

main().catch(function (e) { console.error('测试出错：', e); process.exit(1); });
