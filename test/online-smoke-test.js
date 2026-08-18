// ============================================
// test/online-smoke-test.js —— 线上部署手测
// 连真实线上服务（bomb-plane.onrender.com），验证：
//   props 房间开局 / 金币 / 毁灭菇十字揭示 + 冻结生成 + 冻结拒绝
// 用法：node test/online-smoke-test.js
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const WS_URL = process.env.WS_URL || 'wss://bomb-plane.onrender.com/ws';
const SPEC = 'M';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 15000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}
function waitForMatch(socket, event, predicate, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { socket.off(event, handler); reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 15000);
    function handler(d) {
      if (!predicate(d)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(d);
    }
    socket.on(event, handler);
  });
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
  console.log('线上地址: ' + WS_URL);
  const a = new WSClient(WS_URL);
  await waitFor(a, 'connect');
  check('WebSocket 连接成功', true);
  a.emit('createRoom', { name: '线上A', mode: 'props', boardSize: SPEC });
  const created = await waitFor(a, 'roomCreated');
  check('roomCreated 回显 props/' + SPEC, created.mode === 'props' && created.boardSize === SPEC);

  const b = new WSClient(WS_URL);
  await waitFor(b, 'connect');
  b.emit('joinRoom', { roomId: created.roomId, name: '线上B' });
  await waitFor(b, 'joinedRoom');

  const pA = waitFor(a, 'battleStart');
  const pB = waitFor(b, 'battleStart');
  a.emit('deployConfirm', { planes: randomDeployment(SPEC) });
  b.emit('deployConfirm', { planes: randomDeployment(SPEC) });
  const battle = await pA;
  await pB;
  check('开战成功，金币 = 8', battle.coins && battle.coins[0] === 8);

  // 攒 10 金币：逐格揭示直到 coins >= 10（空格 +0 也合法），B 每轮拉平
  const reveal = function (s, r, c) {
    const p = waitForMatch(s, 'revealResult', function (d) { return true; }, 15000);
    s.emit('reveal', { row: r, col: c });
    return p;
  };
  const size = shared.getBoardSpec(SPEC).size;
  let coins = 8, tries = 0;
  while (coins < 10 && tries < 12) {
    const r = await reveal(a, Math.floor(tries / size), tries % size);
    coins = r.coins[0];
    await reveal(b, size - 1 - Math.floor(tries / size), tries % size); // B 拉平
    tries++;
  }
  check('攒够 10 金币（最终 ' + coins + '）', coins >= 10);

  // 毁灭菇：选 1..size-2 内的中心
  const centerRow = 1 + Math.floor(Math.random() * (shared.getBoardSpec(SPEC).size - 2));
  const centerCol = 1 + Math.floor(Math.random() * (shared.getBoardSpec(SPEC).size - 2));
  const doomP = waitForMatch(a, 'itemResult', function (d) { return d.itemId === 'doom' && d.attacker === 0; }, 15000);
  a.emit('useItem', { itemId: 'doom', row: centerRow, col: centerCol });
  const doom = await doomP;
  check('毁灭菇揭示 5 格', Array.isArray(doom.cells) && doom.cells.length === 5);
  check('冻结格带 owner/expiry', Array.isArray(doom.frozen) && doom.frozen.length > 0 &&
    doom.frozen.every(function (f) { return typeof f.row === 'number' && typeof f.col === 'number' && f.owner === 0; }));

  // 冻结拒绝：A 揭示冻结格 → error
  const f = doom.frozen[0];
  const errP = waitForMatch(a, 'error', function () { return true; }, 15000);
  a.emit('reveal', { row: f.row, col: f.col });
  const err = await errP;
  check('冻结格揭示被拒：' + err.message, err.message.indexOf('冻结') !== -1);

  // 对手不受限：B 揭示同一格成功
  const rb = await reveal(b, f.row, f.col);
  check('对手揭示冻结格成功', typeof rb.result === 'string');

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exitCode = failed ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch(function (e) {
  console.error('测试异常:', e.message);
  process.exitCode = 1;
  process.exit(1);
});
