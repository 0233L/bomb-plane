// ============================================
// test/props-items-test.js —— 道具版 5 个道具测试（阶段B）
// 用法：先启动服务器（RECYCLE_SECONDS=3 node server.js）再运行本测试
// 每个道具用独立房间 + 已知布局（测试脚本掌握 B 的飞机坐标），精准断言：
//   声呐数字 / Pro 机身优先 / 双发 2 格+steps+2 / 吞噬摧毁+机头命中 /
//   无所遁形整机揭示 / 金币不足拒绝 / 步数门控 / 经典房间无道具
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const WS_URL = 'ws://localhost:3000/ws';
const SPEC = 'M'; // 道具版默认 12×12 / 4 架

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

// 建一个道具版房间并开战，返回 {a, b, knownB, roomId}
async function makePropsRoom() {
  const a = new WSClient(WS_URL);
  await waitFor(a, 'connect');
  a.emit('createRoom', { name: 'A', mode: 'props', boardSize: SPEC });
  const created = await waitFor(a, 'roomCreated');

  const b = new WSClient(WS_URL);
  await waitFor(b, 'connect');
  b.emit('joinRoom', { roomId: created.roomId, name: 'B' });
  await waitFor(b, 'joinedRoom');

  const knownB = randomDeployment(SPEC); // 测试脚本掌握 B 的布局，用于精准断言
  // 两个 battleStart 监听都要在 emit 前注册：广播只发一次，监听注册晚就永远收不到
  const pA = waitFor(a, 'battleStart');
  const pB = waitFor(b, 'battleStart');
  a.emit('deployConfirm', { planes: randomDeployment(SPEC) });
  b.emit('deployConfirm', { planes: knownB });
  await pA;
  await pB;
  return { a: a, b: b, knownB: knownB, roomId: created.roomId };
}

// 先注册监听再发送，避免「广播先到、监听后注册」的竞态（测试里统一用这两个）
function aReveal(a, r, c) {
  const p = waitForMatch(a, 'revealResult', function (d) { return d.attacker === 0; });
  a.emit('reveal', { row: r, col: c });
  return p;
}
function bReveal(b, r, c) {
  const p = waitForMatch(b, 'revealResult', function (d) { return d.attacker === 1; });
  b.emit('reveal', { row: r, col: c });
  return p;
}
function aUse(a, itemId, data, predicate) {
  const p = waitForMatch(a, 'itemResult', function (d) { return predicate(d); });
  a.emit('useItem', Object.assign({ itemId: itemId }, data));
  return p;
}

// 找一个 3x3 区域（左上角），保证包含指定格子且完整落在棋盘内
function regionAround(r, c, size) {
  return { row: Math.max(0, Math.min(size - 3, r - 1)), col: Math.max(0, Math.min(size - 3, c - 1)) };
}

async function main() {
  // ========== 1. 声呐脉冲：区域内非空格数量 ==========
  console.log('1. 声呐脉冲');
  {
    const { a, knownB } = await makePropsRoom();
    const head = knownB[0];
    const reg = regionAround(head.headRow, head.headCol, 12);
    // 数一下区域内已知的非空格数量（从测试掌握的布局精确算）
    const inReg = knownB.filter(function (p) {
      return shared.getPlaneCells(p.headRow, p.headCol, p.dir).some(function (c) {
        return c[0] >= reg.row && c[0] < reg.row + 3 && c[1] >= reg.col && c[1] < reg.col + 3;
      });
    });
    const expect = inReg.reduce(function (n, p) {
      return n + shared.getPlaneCells(p.headRow, p.headCol, p.dir).filter(function (c) {
        return c[0] >= reg.row && c[0] < reg.row + 3 && c[1] >= reg.col && c[1] < reg.col + 3;
      }).length;
    }, 0);
    const res = await aUse(a, 'sonar', { row: reg.row, col: reg.col }, function (d) { return d.itemId === 'sonar' && d.attacker === 0; });
    check('声呐数字正确（期望 ' + expect + ' 个非空格）', res.count === expect);
    check('声呐后 A 金币 = 8 - 3', res.coins[0] === 5);
    check('声呐后步数 +1', res.steps[0] === 1);
  }

  // ========== 2. 探测者 Pro：机身优先揭示 ==========
  console.log('2. 探测者 Pro');
  {
    const { a, knownB } = await makePropsRoom();
    const plane = knownB[0];
    const bodyCell = shared.getPlaneCells(plane.headRow, plane.headCol, plane.dir)[1]; // 第一格机身
    const reg = regionAround(bodyCell[0], bodyCell[1], 12);
    // 注意：区域内即使有机头也是机身优先，所以揭示结果必是 body
    const p = waitForMatch(a, 'revealResult', function (d) { return d.attacker === 0; });
    a.emit('useItem', { itemId: 'pro', row: reg.row, col: reg.col });
    const res = await p;
    check('Pro 揭示结果必为机身', res.result === 'body');
    check('Pro 后金币 = 8 - 4 + 1', res.coins[0] === 5);
    check('Pro 后步数 +1', res.steps[0] === 1);
  }

  // ========== 3. 双发连射：2 格 + steps +2 ==========
  console.log('3. 双发连射');
  {
    const { a, knownB } = await makePropsRoom();
    const c1 = shared.getPlaneCells(knownB[0].headRow, knownB[0].headCol, knownB[0].dir)[2];
    const c2 = shared.getPlaneCells(knownB[1].headRow, knownB[1].headCol, knownB[1].dir)[2];
    // 两个监听先注册再 emit，避免「第二个广播先到」的竞态
    const seen = [];
    const p1 = waitForMatch(a, 'revealResult', function (d) {
      if (d.attacker !== 0) return false;
      seen.push([d.row, d.col]);
      return true;
    });
    const p2 = waitForMatch(a, 'revealResult', function (d) {
      if (d.attacker !== 0) return false;
      return !seen.some(function (s) { return s[0] === d.row && s[1] === d.col; });
    });
    a.emit('useItem', { itemId: 'burst', row: c1[0], col: c1[1], row2: c2[0], col2: c2[1] });
    const r1 = await p1;
    const r2 = await p2;
    check('双发两次揭示结果都是机身', r1.result === 'body' && r2.result === 'body');
    check('双发后步数 +2', r2.steps[0] === 2);
    check('双发后金币 = 8 - 5 + 2', r2.coins[0] === 5);
    check('双发是两条独立 revealResult（格子不同）', r1.row !== r2.row || r1.col !== r2.col);
  }

  // ========== 4. 吞噬者：摧毁 + 机头命中判发现 ==========
  console.log('4. 吞噬者');
  {
    const { a, knownB } = await makePropsRoom();
    const plane = knownB[0];
    const reg = regionAround(plane.headRow, plane.headCol, 12); // 区域包含机头
    const res = await aUse(a, 'devour', { row: reg.row, col: reg.col }, function (d) { return d.itemId === 'devour' && d.attacker === 0; });
    check('吞噬摧毁 9 格', Array.isArray(res.destroyed) && res.destroyed.length === 9);
    check('机头命中有明确反馈', Array.isArray(res.headHit) && res.headHit[0] === plane.headRow && res.headHit[1] === plane.headCol);
    check('吞噬命中机头 → 对方机头数 -1', res.headsLeft[1] === 3);
    check('吞噬不给金币', res.coins[0] === 2); // 8 - 6 = 2，没有 +5
    check('吞噬后步数 +1', res.steps[0] === 1);
    // 被摧毁的机身不能再被揭示：reveal 那架飞机的第二个机身格 → 应该拒绝
    const bodyCell = shared.getPlaneCells(plane.headRow, plane.headCol, plane.dir)[2];
    if (bodyCell[0] >= reg.row && bodyCell[0] < reg.row + 3 && bodyCell[1] >= reg.col && bodyCell[1] < reg.col + 3) {
      const ep = waitForMatch(a, 'error', function (d) { return true; });
      a.emit('reveal', { row: bodyCell[0], col: bodyCell[1] });
      const err = await ep;
      check('被摧毁格不能再揭示（被拒）', err.message.indexOf('已经揭示') !== -1 || err.message.indexOf('摧毁') !== -1);
    }
  }

  // ========== 5. 无所遁形：整架飞机揭示 ==========
  console.log('5. 无所遁形');
  {
    const { a, b, knownB } = await makePropsRoom();
    const plane = knownB[0];
    // 先正常揭示机头（+5 金币，steps 1:0 领先）
    const hit = await aReveal(a, plane.headRow, plane.headCol);
    check('先揭示机头成功', hit.result === 'head' && hit.coins[0] === 13);
    // B 走一步把步数拉平（1:1），A 才能用道具
    await bReveal(b, 0, 0);
    // 无所遁形：整架 10 格全揭示
    const res = await aUse(a, 'expose', { row: plane.headRow, col: plane.headCol }, function (d) { return d.itemId === 'expose' && d.attacker === 0; });
    check('无所遁形揭示 10 格', Array.isArray(res.cells) && res.cells.length === 10);
    check('金币 = 13 - 5 = 8', res.coins[0] === 8);
    // 那架飞机的任意一格现在都已揭示：reveal 机身格应被拒
    const bodyCell = shared.getPlaneCells(plane.headRow, plane.headCol, plane.dir)[5];
    const ep = waitForMatch(a, 'error', function (d) { return true; });
    a.emit('reveal', { row: bodyCell[0], col: bodyCell[1] });
    const err = await ep;
    check('已揭示机身不能再打', err.message.indexOf('已经揭示') !== -1);
  }

  // ========== 6. 规则边界 ==========
  console.log('6. 规则边界');
  {
    // 金币不足：吞噬者 6 用一次 → 剩 2。B 走一步拉平步数，再买就被金币不足拒绝
    const { a, b } = await makePropsRoom();
    const reg = { row: 0, col: 0 };
    await aUse(a, 'devour', { row: reg.row, col: reg.col }, function (d) { return d.itemId === 'devour' && d.attacker === 0; }); // 剩 2 金币，steps 1:0
    await bReveal(b, 0, 0); // steps 1:1
    const e1p = waitForMatch(a, 'error', function (d) { return true; });
    a.emit('useItem', { itemId: 'devour', row: reg.row, col: reg.col });
    const err1 = await e1p;
    check('金币不足被拒', err1.message.indexOf('金币') !== -1);

    // 步数门控：A 用道具 + 揭示共 2 步，B 只走 1 步 → A 领先 → 再用道具被拒
    const { a: a2, b: b2, knownB: k2 } = await makePropsRoom();
    const reg2 = { row: 1, col: 1 };
    await aUse(a2, 'sonar', { row: reg2.row, col: reg2.col }, function (d) { return d.itemId === 'sonar' && d.attacker === 0; }); // steps 1:0
    await bReveal(b2, 0, 0); // steps 1:1
    const body = shared.getPlaneCells(k2[0].headRow, k2[0].headCol, k2[0].dir)[3];
    const r = await aReveal(a2, body[0], body[1]); // steps 2:1，A 领先
    check('A 连走两步领先', r.steps[0] === 2 && r.steps[1] === 1);
    const e2p = waitForMatch(a2, 'error', function (d) { return true; });
    a2.emit('useItem', { itemId: 'sonar', row: reg2.row, col: reg2.col });
    const err2 = await e2p;
    check('领先者不能用道具', err2.message.indexOf('领先') !== -1);

    // 经典房间没有道具
    const a3 = new WSClient(WS_URL);
    await waitFor(a3, 'connect');
    a3.emit('createRoom', { name: 'A3', mode: 'classic' });
    const c3 = await waitFor(a3, 'roomCreated');
    const b3 = new WSClient(WS_URL);
    await waitFor(b3, 'connect');
    b3.emit('joinRoom', { roomId: c3.roomId, name: 'B3' });
    await waitFor(b3, 'joinedRoom');
    const c3A = waitFor(a3, 'battleStart');
    const c3B = waitFor(b3, 'battleStart');
    a3.emit('deployConfirm', { planes: randomDeployment('S') });
    b3.emit('deployConfirm', { planes: randomDeployment('S') });
    await c3A;
    await c3B;
    const e3p = waitForMatch(a3, 'error', function () { return true; });
    a3.emit('useItem', { itemId: 'sonar', row: 0, col: 0 });
    const err3 = await e3p;
    check('经典房间没有道具（被拒）', err3.message.indexOf('经典') !== -1);
  }

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exitCode = failed ? 1 : 0;
  process.exit(process.exitCode); // WSClient 保持连接会挂住进程，测试脚本直接退出
}

main().catch(function (e) {
  console.error('测试异常:', e.message);
  process.exitCode = 1;
  process.exit(1);
});
