// ============================================
// test/frozen-rejoin-test.js —— 回到菜单再重进，毁灭菇冻结标记不丢（回归）
// 流程：道具房开战 → A 攒金币用毁灭菇 → A leaveRoom → A rejoin →
//       检查 reconnected.frozenCells 完整恢复（服务器协议层）
// 用法：先启动服务器（RECYCLE_SECONDS=3 node server.js）再运行
// 背景：曾出 bug——网页端 goBattle() 无条件清空 frozenCells，
//       重连恢复现场后被清掉导致 ❄ 消失（客户端侧，见 home-ui-test 第 9 段）
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const WS_URL = 'ws://localhost:3000/ws';
const SPEC = 'M';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 4000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}
// 等满足条件的指定事件（attacker 过滤用）
function waitForMatch(socket, event, predicate, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { socket.off(event, handler); reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 4000);
    function handler(d) {
      if (!predicate(d)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(d);
    }
    socket.on(event, handler);
  });
}
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
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
  const a = new WSClient(WS_URL);
  await waitFor(a, 'connect');
  a.emit('createRoom', { name: 'A', mode: 'props', boardSize: SPEC });
  const created = await waitFor(a, 'roomCreated');

  const b = new WSClient(WS_URL);
  await waitFor(b, 'connect');
  b.emit('joinRoom', { roomId: created.roomId, name: 'B' });
  await waitFor(b, 'joinedRoom');

  const knownB = randomDeployment(SPEC);
  const pA = waitFor(a, 'battleStart');
  const pB = waitFor(b, 'battleStart');
  a.emit('deployConfirm', { planes: randomDeployment(SPEC) });
  b.emit('deployConfirm', { planes: knownB });
  await pA;
  await pB;
  console.log('— 已开战 —');

  // A 揭示直到金币 >= 10（毁灭菇价格），边攒边打；步数规则要求双方交替，B 也配合下棋
  const usedA = new Set();
  const usedB = new Set();
  let coin = 0;
  while (coin < 10) {
    const cell = pickUnknown(usedA);
    const p = waitForMatch(a, 'revealResult', function (d2) { return d2.attacker === 0; });
    a.emit('reveal', { row: cell[0], col: cell[1] });
    const d = await p;
    coin = d.coins[0];
    if (coin >= 10) break;
    const bCell = pickUnknown(usedB);
    b.emit('reveal', { row: bCell[0], col: bCell[1] });
    await waitForMatch(a, 'revealResult', function (d2) { return d2.attacker === 1; });
    // 节奏控制：本地循环极快（每轮几毫秒），1 秒内消息超过 20 条会被
    // 服务器当洪水关连接（server.js 的 msgTimes 限速）——小睡模拟真人手速
    await sleep(80);
  }
  console.log('— A 攒够金币 ' + coin + ' —');

  // A 刚下完最后一手（步数领先），让 B 下一手把行动权还给 A
  const bCell2 = pickUnknown(usedB);
  b.emit('reveal', { row: bCell2[0], col: bCell2[1] });
  await waitForMatch(a, 'revealResult', function (d2) { return d2.attacker === 1; });

  // A 用毁灭菇：找一个离边至少 1 格、十字 5 格都没被 A 揭示过的中心
  //（原来写死 (2,2)：攒金币手数多时 (2,2) 已被自己揭示 → 毁灭菇被拒 → 偶发超时）
  const center = pickDoomCenter(usedA);
  a.emit('useItem', { itemId: 'doom', row: center[0], col: center[1] });
  const itemRes = await waitForMatch(a, 'itemResult', function (d2) { return d2.attacker === 0 && d2.itemId === 'doom'; });
  console.log('— 毁灭菇已使用，冻结 ' + (itemRes.frozen || []).length + ' 格 —');
  check('毁灭菇有冻结记录', Array.isArray(itemRes.frozen) && itemRes.frozen.length > 0);

  // A 返回菜单
  a.emit('leaveRoom');
  await waitFor(a, 'leftRoom');
  console.log('— A 已返回菜单 —');

  // A 重进（凭 token 恢复现场）
  a.emit('rejoin', { token: created.token, roomId: created.roomId });
  const rec = await waitFor(a, 'reconnected');
  check('重连后 frozenCells 恢复（' + (rec.frozenCells || []).length + ' 格）',
    Array.isArray(rec.frozenCells) && rec.frozenCells.length > 0);
  // 恢复的冻结格与施放时完全一致（同一 owner + 同一 expiry）
  check('重连后冻结格与施放时一致',
    JSON.stringify(rec.frozenCells) === JSON.stringify(itemRes.frozen));

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exitCode = failed ? 1 : 0;
}

// 挑一个离边至少 1 格、十字 5 格都没被揭示过的中心（毁灭菇十字完整落盘）
function pickDoomCenter(used) {
  const size = shared.getBoardSpec(SPEC).size;
  for (let r = 1; r < size - 1; r++) {
    for (let c = 1; c < size - 1; c++) {
      const cross = [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
      const allFree = cross.every(function (p) { return !used.has(p[0] + ',' + p[1]); });
      if (allFree) {
        cross.forEach(function (p) { used.add(p[0] + ',' + p[1]); });
        return [r, c];
      }
    }
  }
  return [2, 2]; // 兜底：极端情况下退回固定点
}

// 挑一个还没打过的格子
function pickUnknown(used) {
  for (let r = 0; r < shared.getBoardSpec(SPEC).size; r++) {
    for (let c = 0; c < shared.getBoardSpec(SPEC).size; c++) {
      const key = r + ',' + c;
      if (!used.has(key)) { used.add(key); return [r, c]; }
    }
  }
  return [0, 0];
}

main().then(function () {
  setTimeout(function () { process.exit(process.exitCode); }, 500);
}).catch(function (e) {
  console.error('测试异常:', e.message);
  process.exit(1);
});
