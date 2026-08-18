// ============================================
// test/props-smoke-test.js —— 道具版协议冒烟测试（阶段A临时）
// 验证：创建道具房间（props + M 规格）→ 加入 → 部署 4 架 → 开战金币 8
//       → 经典房间规格不随加入者覆盖 → 非法规格回退经典 → 人机强制经典
// 用法：先启动服务器（RECYCLE_SECONDS=3 node server.js）再运行本测试
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';

let passed = 0, failed = 0;
const errors = []; // 服务器拒绝原因收集
function watchErrors(socket, who) {
  socket.on('error', function (d) { errors.push(who + ': ' + d.message); });
}
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 4000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}

// 随机生成一份合法部署（可指定规格，如 M = 4 架 / 12×12）
function randomDeployment(spec) {
  const sp = shared.getBoardSpec(spec);
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < sp.planeCount; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * sp.size);
    const headCol = Math.floor(Math.random() * sp.size);
    const occupied = [];
    planes.forEach(function (p) {
      shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (c) { occupied.push(c); });
    });
    if (shared.canPlacePlane(occupied, headRow, headCol, dir, spec)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes;
}

async function main() {
  // ---- 1. 道具房间：创建带 mode/boardSize，加入者带别的规格不覆盖 ----
  console.log('1. 道具房间创建/加入/开战');
  const a = new WSClient(WS_URL);
  await waitFor(a, 'connect');
  watchErrors(a, 'A');
  a.emit('createRoom', { name: 'A', mode: 'props', boardSize: 'M' });
  const created = await waitFor(a, 'roomCreated');
  check('roomCreated 回显 mode=props', created.mode === 'props');
  check('roomCreated 回显 boardSize=M', created.boardSize === 'M');

  const b = new WSClient(WS_URL);
  await waitFor(b, 'connect');
  watchErrors(b, 'B');
  b.emit('joinRoom', { roomId: created.roomId, name: 'B', mode: 'classic', boardSize: 'S' });
  const joined = await waitFor(b, 'joinedRoom');
  check('加入者传经典规格不覆盖房间（仍 props/M）', joined.mode === 'props' && joined.boardSize === 'M');

  const deployA = randomDeployment('M');
  const deployB = randomDeployment('M');
  // 广播竞态：battleStart 服务器只发一次，A/B 的监听都必须在 deployConfirm 前先挂好
  const battleA = waitFor(a, 'battleStart');
  const battleB = waitFor(b, 'battleStart');
  a.emit('deployConfirm', { planes: deployA });
  b.emit('deployConfirm', { planes: deployB });
  const battle = await battleA;
  await battleB;
  check('battleStart 带 mode=props', battle.mode === 'props');
  check('battleStart 带 boardSize=M', battle.boardSize === 'M');
  check('battleStart 金币 = [8,8]', battle.coins && battle.coins[0] === 8 && battle.coins[1] === 8);

  // ---- 2. 道具房间揭示：金币按 空0/身1/头5 结算 ----
  console.log('2. 道具版揭示金币结算');
  // B 的 battleStart 已在第一节 await battleB 时消费，这里不再等待
  // 开局双方步数都是 0：A 直接揭示一格（先到先得，必被接受）
  a.emit('reveal', { row: 0, col: 0 });
  const first = await waitFor(a, 'revealResult');
  check('revealResult 带 coins 字段', Array.isArray(first.coins));
  check('revealResult 带 coinGain（空=0 身=1 头=3）', [0, 1, 3].indexOf(first.coinGain) !== -1);
  const coinsAfter = first.coins[0];
  check('A 的金币 = 8 + coinGain', coinsAfter === 8 + first.coinGain);

  // ---- 3. 非法规格/玩法回退经典；人机房间强制经典 S ----
  console.log('3. 回退规则与人机房间');
  const c = new WSClient(WS_URL);
  await waitFor(c, 'connect');
  watchErrors(c, 'C');
  c.emit('createRoom', { name: 'C', mode: 'hack', boardSize: 'XX' });
  const createdC = await waitFor(c, 'roomCreated');
  check('非法 mode/boardSize 回退 classic/S', createdC.mode === 'classic' && createdC.boardSize === 'S');

  const d = new WSClient(WS_URL);
  await waitFor(d, 'connect');
  watchErrors(d, 'D');
  d.emit('createRoomAI', { name: 'D', mode: 'props', boardSize: 'L' });
  const createdD = await waitFor(d, 'roomCreated');
  check('人机房间支持道具/L（不再强制经典）', createdD.mode === 'props' && createdD.boardSize === 'L');

  if (errors.length) console.log('服务器拒绝: ' + errors.join(' | '));
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exitCode = failed ? 1 : 0;
  process.exit(process.exitCode); // WSClient 保持连接会挂住进程，测试脚本直接退出
}

main().catch(function (e) {
  console.error('测试异常:', e.message);
  if (errors.length) console.log('服务器拒绝: ' + errors.join(' | '));
  process.exitCode = 1;
  process.exit(1); // 测试脚本允许直接退出：WSClient 保持连接会挂住进程
});
