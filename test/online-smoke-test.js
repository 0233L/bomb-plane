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
  await waitFor(a, 'connect', 30000); // Render 冷启动较慢，放宽连接超时
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
  check('开战成功，金币 = 6', battle.coins && battle.coins[0] === 6);

  // 攒 6 金币（毁灭菇现价）：逐格揭示直到 coins >= 6（空格 +0 也合法），B 每轮拉平。
  // ⚠️ revealResult 是双方互发的广播——监听必须按 attacker 过滤，
  // 否则线上 RTT 下对方那次揭示的广播会抢先匹配，读到错位的 coins/steps。
  const reveal = function (s, r, c, attacker) {
    const p = waitForMatch(s, 'revealResult', function (d) { return d.attacker === attacker; }, 30000);
    s.emit('reveal', { row: r, col: c });
    return p;
  };
  const size = shared.getBoardSpec(SPEC).size;
  let coins = 6, tries = 0;
  const bRevealed = {}; // B 已揭示过的坐标（「对手不受限」环节要避开，防止重复揭示挂起）
  const aRevealed = {}; // A 已揭示过的坐标（毁灭菇十字中心要避开：十字 5 格若含已揭示格，revealed 会少于 5）
  while (coins < 6 && tries < 60) { // 上限 60 次：开局 6 金币即够，若首格是空格则需再揭 1 格机身
    const r = await reveal(a, Math.floor(tries / size), tries % size, 0);
    coins = r.coins[0];
    aRevealed[Math.floor(tries / size) + ',' + (tries % size)] = true;
    const bRow = size - 1 - Math.floor(tries / size), bCol = tries % size;
    bRevealed[bRow + ',' + bCol] = true;
    await reveal(b, bRow, bCol, 1); // B 拉平
    tries++;
  }
  check('攒够 6 金币（最终 ' + coins + '）', coins >= 6);

  // 毁灭菇：选 1..size-2 内、十字 5 格都未被 A 揭示过的中心（保证 revealed 恰好 5 格）
  let centerRow = 1, centerCol = 1, foundCenter = false;
  for (let r = 1; r <= size - 2 && !foundCenter; r++) {
    for (let c = 1; c <= size - 2; c++) {
      const crossOk = [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].every(function (p) {
        return !aRevealed[p[0] + ',' + p[1]];
      });
      if (crossOk) { centerRow = r; centerCol = c; foundCenter = true; break; }
    }
  }
  const doomP = waitForMatch(a, 'itemResult', function (d) { return d.itemId === 'doom' && d.attacker === 0; }, 15000);
  a.emit('useItem', { itemId: 'doom', row: centerRow, col: centerCol });
  const doom = await doomP;
  check('毁灭菇揭示 5 格', Array.isArray(doom.cells) && doom.cells.length === 5);
  check('冻结格带 owner/expiry', Array.isArray(doom.frozen) && doom.frozen.length > 0 &&
    doom.frozen.every(function (f) { return typeof f.row === 'number' && typeof f.col === 'number' && f.owner === 0; }));

  // 冻结拒绝：A 揭示冻结格 → error
  // f 避开 B 已揭示过的坐标（B 的揭示与 A 的冻结区可能撞车 → 重复揭示会挂起）
  const f = doom.frozen.filter(function (x) { return !bRevealed[x.row + ',' + x.col]; })[0] || doom.frozen[0];
  const errP = waitForMatch(a, 'error', function () { return true; }, 15000);
  a.emit('reveal', { row: f.row, col: f.col });
  const err = await errP;
  check('冻结格揭示被拒：' + err.message, err.message.indexOf('冻结') !== -1);

  // 对手不受限：B 揭示同一格成功
  const rb = await reveal(b, f.row, f.col, 1);
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
