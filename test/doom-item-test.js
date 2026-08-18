// ============================================
// test/doom-item-test.js —— 毁灭菇道具测试
// 用法：先启动服务器（RECYCLE_SECONDS=3 node server.js）再运行本测试
// 已知布局（测试脚本掌握 B 的飞机坐标）+ 多房间分工，精准断言：
//   十字 5 格揭示 / 冻结 8 邻域生成 / 金币 10 / 冻结拒绝与对手不受限 /
//   选区整体拒绝（声呐/双发/毁灭菇）/ 2 回合解除 / 越界拒绝 / 全揭示拒绝 / headsLeft
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const WS_URL = 'ws://localhost:3000/ws';
const SPEC = 'M'; // 道具版默认 12×12 / 4 架
const SIZE = shared.getBoardSpec(SPEC).size;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 8000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}
function waitForMatch(socket, event, predicate, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { socket.off(event, handler); reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 8000);
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

// 建一个道具版房间并开战，返回 {a, b, knownA, knownB, roomId}
// knownA = A 的布局（B 揭示的是 A 的棋盘，比对 B 的揭示结果要用它）
async function makePropsRoom() {
  const a = new WSClient(WS_URL);
  await waitFor(a, 'connect');
  a.emit('createRoom', { name: 'A', mode: 'props', boardSize: SPEC });
  const created = await waitFor(a, 'roomCreated');

  const b = new WSClient(WS_URL);
  await waitFor(b, 'connect');
  b.emit('joinRoom', { roomId: created.roomId, name: 'B' });
  await waitFor(b, 'joinedRoom');

  const knownA = randomDeployment(SPEC); // 测试脚本掌握双方布局，用于精准断言
  const knownB = randomDeployment(SPEC);
  const pA = waitFor(a, 'battleStart');
  const pB = waitFor(b, 'battleStart');
  a.emit('deployConfirm', { planes: knownA });
  b.emit('deployConfirm', { planes: knownB });
  await pA;
  await pB;
  return { a: a, b: b, knownA: knownA, knownB: knownB, roomId: created.roomId };
}

// 先注册监听再发送，避免「广播先到、监听后注册」的竞态。
// 注意：严格匹配 row/col——只按 attacker 匹配会错配同侧其他广播（比如双发的两条
// revealResult 会抢着匹配下一个 aReveal），导致流程静默乱序
function aReveal(a, r, c) {
  const p = waitForMatch(a, 'revealResult', function (d) { return d.attacker === 0 && d.row === r && d.col === c; });
  a.emit('reveal', { row: r, col: c });
  return p;
}
function bReveal(b, r, c) {
  const p = waitForMatch(b, 'revealResult', function (d) { return d.attacker === 1 && d.row === r && d.col === c; });
  b.emit('reveal', { row: r, col: c });
  return p;
}
function aUse(a, itemId, data, predicate) {
  const p = waitForMatch(a, 'itemResult', function (d) { return predicate(d); });
  a.emit('useItem', Object.assign({ itemId: itemId }, data));
  return p;
}
// 注册监听后发一个必然被拒的操作，取回 error 消息
function aError(a, emitFn) {
  const p = waitForMatch(a, 'error', function () { return true; });
  emitFn();
  return p;
}

// 已知布局的格子表：body 们 / head 们 / 任意格的期望内容
function planeCells(knownB) {
  const cells = [];
  knownB.forEach(function (p) {
    shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (c) { cells.push(c); });
  });
  return cells;
}
// 查一个格子的真实内容（head/body/empty）：先查机头（机头格也在机身格表里）
function contentOf(knownB, r, c) {
  for (let i = 0; i < knownB.length; i++) {
    if (knownB[i].headRow === r && knownB[i].headCol === c) return 'head';
  }
  const cells = planeCells(knownB);
  for (let i = 0; i < cells.length; i++) {
    if (cells[i][0] === r && cells[i][1] === c) return 'body';
  }
  return 'empty';
}

// 找一个十字中心：1..size-2，5 格都不在 exclude 里，可选：必须含某内容 / 不含已揭示格
function findCenter(knownB, exclude, wantContent, avoidContent) {
  const ex = {};
  (exclude || []).forEach(function (p) { ex[p[0] + ',' + p[1]] = true; });
  for (let attempt = 0; attempt < 3000; attempt++) {
    const row = 1 + Math.floor(Math.random() * (SIZE - 2));
    const col = 1 + Math.floor(Math.random() * (SIZE - 2));
    const cross = [[row, col], [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
    if (cross.some(function (c) { return ex[c[0] + ',' + c[1]]; })) continue;
    const contents = cross.map(function (c) { return contentOf(knownB, c[0], c[1]); });
    if (wantContent && contents.indexOf(wantContent) === -1) continue;
    if (avoidContent && contents.indexOf(avoidContent) !== -1) continue;
    return { row: row, col: col, cross: cross };
  }
  return null;
}

// 毁灭菇冻结范围的期望值：十字 5 格 8 邻域并集 - 十字 - 已揭示格（和服务器同规则）
function frozenExpect(cross, revealedSet) {
  const seen = {};
  cross.forEach(function (c) { seen[c[0] + ',' + c[1]] = true; });
  const out = [];
  cross.forEach(function (c) {
    for (let r = c[0] - 1; r <= c[0] + 1; r++) {
      for (let cc = c[1] - 1; cc <= c[1] + 1; cc++) {
        if (r < 0 || r >= SIZE || cc < 0 || cc >= SIZE) continue;
        if (r === c[0] && cc === c[1]) continue;
        const key = r + ',' + cc;
        if (seen[key]) continue;
        if (revealedSet[key]) continue;
        seen[key] = true;
        out.push([r, cc]);
      }
    }
  });
  return out;
}

async function main() {
  // ========== 1. 基础：十字揭示 + 冻结生成 + 金币结算 ==========
  console.log('1. 毁灭菇基础（十字揭示 / 冻结生成 / 金币）');
  let roomA;
  {
    const { a, b, knownA, knownB } = await makePropsRoom();
    roomA = { a: a, b: b, knownA: knownA, knownB: knownB };
    // 攒 10 金币：揭示 2 个机身（每轮 B 拉平步数）
    const bodies = planeCells(knownB).filter(function (c) { return contentOf(knownB, c[0], c[1]) === 'body'; });
    const b1 = bodies[0], b2 = bodies[1];
    let r = await aReveal(a, b1[0], b1[1]); // 1:0，coins 9
    check('第一个机身揭示 +1 金币', r.coins[0] === 9);
    await bReveal(b, 1, 1); // 1:1
    r = await aReveal(a, b2[0], b2[1]); // 2:1，coins 10
    check('第二个机身揭示后金币 = 10', r.coins[0] === 10);
    await bReveal(b, 2, 2); // 2:2
    // 找中心：5 格全未揭示（不含 b1/b2），且至少打中一架飞机（机身/机头都行）
    const center = findCenter(knownB, [b1, b2], null, null);
    // 要求十字含飞机格（更全面），找不到就再换一次部署——通常几轮内必找到
    let center2 = findCenter(knownB, [b1, b2], 'body', null) || center;
    if (!center2) { console.log('  !! 没找到合适的十字中心，跳过本房间核心断言'); }
    const res = await aUse(a, 'doom', { row: center2.row, col: center2.col },
      function (d) { return d.itemId === 'doom' && d.attacker === 0; });
    check('毁灭菇揭示 5 格（itemResult.cells）', Array.isArray(res.cells) && res.cells.length === 5);
    // 每格结果与已知布局一致
    const allRight = res.cells.every(function (c) {
      return contentOf(knownB, c.row, c.col) === c.result;
    });
    check('5 格揭示结果与真实布局一致', allRight);
    // 金币：10 - 10 + 十字内的收益（身 +1 / 头 +3 / 空 0）
    const gain = res.cells.reduce(function (n, c) {
      return n + (c.result === 'head' ? 3 : c.result === 'body' ? 1 : 0);
    }, 0);
    check('金币 = 10 - 10 + 十字收益（' + gain + '）', res.coins[0] === 0 + gain);
    check('毁灭菇步数 +1', res.steps[0] === 3 && res.steps[1] === 2);
    // 冻结集：与服务器同规则计算
    const revealedSet = {};
    [b1, b2].forEach(function (c) { revealedSet[c[0] + ',' + c[1]] = true; });
    const expectFrozen = frozenExpect(center2.cross, revealedSet);
    check('冻结格数量与 8 邻域期望一致（' + expectFrozen.length + '）',
      Array.isArray(res.frozen) && res.frozen.length === expectFrozen.length);
    // 冻结记录带 owner/expiry（客户端判断过期需要）
    const recOk = res.frozen.every(function (f) {
      return typeof f.row === 'number' && typeof f.col === 'number' &&
        f.owner === 0 && f.expiry === 3 + 2;
    });
    check('冻结记录带 owner=0 / expiry=5', recOk);
    // 冻结格都在期望集里
    const frozenKeys = {};
    expectFrozen.forEach(function (f) { frozenKeys[f[0] + ',' + f[1]] = true; });
    const allIn = res.frozen.every(function (f) { return !!frozenKeys[f.row + ',' + f.col]; });
    check('冻结格全部来自十字的 8 邻域', allIn);
    roomA.center = center2;
    roomA.frozen = res.frozen;
    roomA.b1 = b1; roomA.b2 = b2;
  }

  // ========== 2. 冻结拒绝（自己） + 对手不受影响 ==========
  console.log('2. 冻结只约束施放者自己');
  {
    const { a, b } = roomA;
    const f = roomA.frozen[0];
    await bReveal(b, 3, 3); // B 拉平步数 3:3，A 才能行动
    const e1 = await aError(a, function () { a.emit('reveal', { row: f.row, col: f.col }); });
    check('施放者揭示冻结格被拒（冻结）', e1.message.indexOf('冻结') !== -1);
    // B 揭示的是 A 的棋盘：用 A 的布局比对结果。
    // 注意 f 的坐标可能与第 1 节 B 已在 A 棋盘揭示过的 (1,1)/(2,2)/(3,3) 撞车
    // （doom 中心随机，(2,2)/(3,3) 时 frozen[0] 恰是这些格）→ 会被判重复揭示而挂起。
    // 换一个未揭示过的冻结格来证明「对手不受影响」。
    const revealedByB = { '1,1': true, '2,2': true, '3,3': true };
    const f2 = roomA.frozen.filter(function (x) { return !revealedByB[x.row + ',' + x.col]; })[0] || f;
    const rb = await bReveal(b, f2.row, f2.col); // B 不受任何限制
    check('对手揭示同一格成功（不受影响）', rb.result === contentOf(roomA.knownA, f2.row, f2.col));
  }

  // ========== 3. 2 回合解除 + 解除前仍拒绝 ==========
  console.log('3. 冻结 2 回合解除');
  {
    const { a, b, knownB } = roomA;
    // A 下一步时 steps=3（3:3）：冻结 expiry=5，steps<5 期间始终被拒
    const bodies = planeCells(knownB).filter(function (c) { return contentOf(knownB, c[0], c[1]) === 'body'; });
    // 找 2 个不在十字、不在冻结集、未揭示的机身格
    const frozenKeys = {};
    roomA.frozen.forEach(function (f) { frozenKeys[f.row + ',' + f.col] = true; });
    const crossKeys = {};
    roomA.center.cross.forEach(function (c) { crossKeys[c[0] + ',' + c[1]] = true; });
    const freeBodies = bodies.filter(function (c) {
      return !frozenKeys[c[0] + ',' + c[1]] && !crossKeys[c[0] + ',' + c[1]] &&
        !(c[0] === roomA.b1[0] && c[1] === roomA.b1[1]) && !(c[0] === roomA.b2[0] && c[1] === roomA.b2[1]);
    });
    const fb1 = freeBodies[0], fb2 = freeBodies[1];
    const f2 = roomA.frozen[1] || roomA.frozen[0];
    await aReveal(a, fb1[0], fb1[1]); // 4:4（把 B 的领先追平）
    await bReveal(b, 4, 4);           // 4:5（B 又领先——A 揭示不受限，B 之后不能再动）
    const e2 = await aError(a, function () { a.emit('reveal', { row: f2.row, col: f2.col }); });
    check('steps=4 仍被冻结（未到 expiry=5）', e2.message.indexOf('冻结') !== -1);
    await aReveal(a, fb2[0], fb2[1]); // 5:5（A 追上并反超）
    await bReveal(b, 5, 5);           // 5:6（B 又领先，但揭示只受 A 冻结限制，B 无冻结）
    const r3 = await aReveal(a, f2.row, f2.col); // steps[0]=5 ≥ expiry=5 → 解除
    check('steps=5 冻结解除，揭示成功', r3.result === contentOf(knownB, f2.row, f2.col));
  }

  // ========== 4. 选区整体拒绝（声呐/双发）+ 越界 + 中心含冻结 ==========
  console.log('4. 选区整体拒绝 / 越界 / 中心含冻结');
  {
    const { a, b, knownB } = await makePropsRoom();
    // 攒钱策略（金币检查先于选区校验，十字收益 0~15 随机——任何收益都必须买得起毁灭菇）：
    // body1 + 3 机头 = 18 → 再补 5 机身 = 23 → doom(-10) = 13+收益 → 双发 burst(-5+2) = 10+收益 ≥ 10 ✓
    // 补金币必须赶在 doom 之前：doom 施放后 A 每走一步都逼近冻结 expiry（=doom 时 steps+2），
    // 后面 e4/e5 还要依赖冻结生效（steps 11 < expiry 12）。
    const heads = knownB.map(function (p) { return [p.headRow, p.headCol]; });
    const body1 = shared.getPlaneCells(knownB[0].headRow, knownB[0].headCol, knownB[0].dir)[1];
    const spareBodies = [];
    knownB.forEach(function (p) {
      shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cc, i) {
        if (i > 0 && !heads.some(function (h) { return h[0] === cc[0] && h[1] === cc[1]; })) {
          spareBodies.push(cc);
        }
      });
    });
    const extraBodies = spareBodies.filter(function (cc) {
      return !(cc[0] === body1[0] && cc[1] === body1[1]);
    }).slice(0, 5);
    await aReveal(a, body1[0], body1[1]); // 1:0, 9
    await bReveal(b, 1, 1);
    await aReveal(a, heads[0][0], heads[0][1]); // 2:1, 12
    await bReveal(b, 2, 2);
    await aReveal(a, heads[1][0], heads[1][1]); // 3:2, 15
    await bReveal(b, 3, 3);
    await aReveal(a, heads[2][0], heads[2][1]); // 4:3, 18
    await bReveal(b, 4, 4);
    for (let i = 0; i < 5; i++) {
      await aReveal(a, extraBodies[i][0], extraBodies[i][1]); // 补金币 9:4 → 23
      await bReveal(b, 5 + i, 5 + i);                          // B 拉平（9:9）
    }
    // 中心避开全部已揭示格 + 第 4 个机头（十字若揭示它 → A 直接获胜，后续道具测试全废）
    const center = findCenter(knownB, heads.concat([body1], extraBodies, [heads[3]]));
    const res = await aUse(a, 'doom', { row: center.row, col: center.col },
      function (d) { return d.itemId === 'doom' && d.attacker === 0; }); // 10:9, coins 13+收益
    await bReveal(b, 10, 10); // 10:10（doom 施放时 steps=10 → 冻结 expiry=12）
    // 双发：一次行动揭示 2 个机身格（只占 1 步）。注意双发没有 itemResult 广播
    // （它只是两次普通揭示），要等两条 revealResult
    const freshBodies = spareBodies.filter(function (cc) {
      return !(cc[0] === body1[0] && cc[1] === body1[1]) && // body1 已被 A 揭示过
        !extraBodies.some(function (e) { return e[0] === cc[0] && e[1] === cc[1]; }) &&
        !res.cells.some(function (c) { return c.row === cc[0] && c.col === cc[1]; }) &&
        !res.frozen.some(function (f) { return f.row === cc[0] && f.col === cc[1]; });
    });
    const seenBurst = [];
    const bp1 = waitForMatch(a, 'revealResult', function (d) {
      if (d.attacker !== 0) return false;
      seenBurst.push([d.row, d.col]);
      return true;
    });
    const bp2 = waitForMatch(a, 'revealResult', function (d) {
      if (d.attacker !== 0) return false;
      return !seenBurst.some(function (s) { return s[0] === d.row && s[1] === d.col; });
    });
    a.emit('useItem', { itemId: 'burst', row: freshBodies[0][0], col: freshBodies[0][1], row2: freshBodies[1][0], col2: freshBodies[1][1] });
    await bp1;
    await bp2; // 11:10, coins 10+收益
    await bReveal(b, 11, 11); // 11:11（steps 11 < expiry 12，下面 e1~e5 的冻结断言仍生效）
    // 找一个 1..size-2 的冻结格（做选区拒绝和中心含冻结测试）
    const f = res.frozen.filter(function (x) { return x.row >= 1 && x.row <= SIZE - 2 && x.col >= 1 && x.col <= SIZE - 2; })[0];
    // 声呐：3x3 区域含冻结格 → 整体拒绝
    const reg = { row: Math.max(0, Math.min(SIZE - 3, f.row - 1)), col: Math.max(0, Math.min(SIZE - 3, f.col - 1)) };
    const e1 = await aError(a, function () { a.emit('useItem', { itemId: 'sonar', row: reg.row, col: reg.col }); });
    check('声呐选区含冻结格被拒', e1.message.indexOf('冻结') !== -1);
    // 双发：其中一格是冻结格 → 整体拒绝
    const e2 = await aError(a, function () {
      a.emit('useItem', { itemId: 'burst', row: f.row, col: f.col, row2: 0, col2: 0 });
    });
    check('双发含冻结格被拒', e2.message.indexOf('冻结') !== -1);
    // 越界：十字中心贴边
    const e3 = await aError(a, function () { a.emit('useItem', { itemId: 'doom', row: 0, col: 1 }); });
    check('十字中心贴边被拒', e3.message.indexOf('棋盘边') !== -1);
    // 中心本身是冻结格 → 十字里包含冻结 → 整体拒绝
    const e4 = await aError(a, function () { a.emit('useItem', { itemId: 'doom', row: f.row, col: f.col }); });
    check('毁灭菇十字含冻结格被拒', e4.message.indexOf('冻结') !== -1);
    // 冻结期间再揭示冻结格（steps=4 < expiry=6）→ 拒绝
    const e5 = await aError(a, function () { a.emit('reveal', { row: f.row, col: f.col }); });
    check('第二发毁灭菇后冻结期揭示也被拒', e5.message.indexOf('冻结') !== -1);
  }

  // ========== 5. 十字 5 格全已揭示 → 拒绝 ==========
  console.log('5. 十字 5 格全揭示后毁灭菇被拒');
  {
    const { a, b, knownB } = await makePropsRoom();
    // 找一个十字里含 ≥4 个机身的中心（先把 4 个揭示掉，第 5 格补一发）
    const bodies = planeCells(knownB).filter(function (c) { return contentOf(knownB, c[0], c[1]) === 'body'; });
    let center = null;
    for (let attempt = 0; attempt < 4000 && !center; attempt++) {
      const row = 1 + Math.floor(Math.random() * (SIZE - 2));
      const col = 1 + Math.floor(Math.random() * (SIZE - 2));
      const cross = [[row, col], [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
      const hit = cross.filter(function (c) {
        return bodies.some(function (b2) { return b2[0] === c[0] && b2[1] === c[1]; });
      });
      if (hit.length >= 4) center = { row: row, col: col, cross: cross };
    }
    if (!center) { console.log('  !! 没找到含 4 机身以上的十字，跳过'); failed++; }
    else {
      const used = [];
      const picked = center.cross.filter(function (c) {
        return bodies.some(function (b2) { return b2[0] === c[0] && b2[1] === c[1]; });
      }).slice(0, 4);
      for (let i = 0; i < 4; i++) {
        await aReveal(a, picked[i][0], picked[i][1]); // 每轮 B 拉平
        await bReveal(b, i + 1, i + 1);
        used.push(picked[i][0] + ',' + picked[i][1]);
      }
      // 第 5 格补一发（内容随机，只要把十字 5 格全揭示）
      const fifth = center.cross.filter(function (c) {
        return used.indexOf(c[0] + ',' + c[1]) === -1;
      })[0];
      await aReveal(a, fifth[0], fifth[1]); // 5:4
      await bReveal(b, 9, 9);               // 5:5
      const e = await aError(a, function () { a.emit('useItem', { itemId: 'doom', row: center.row, col: center.col }); });
      check('十字 5 格全揭示后毁灭菇被拒', e.message.indexOf('已经揭示') !== -1);
    }
  }

  // ========== 6. 毁灭菇揭示机头 → headsLeft 减一 ==========
  console.log('6. 毁灭菇揭示机头');
  {
    const { a, b, knownB } = await makePropsRoom();
    const heads = knownB.map(function (p) { return [p.headRow, p.headCol]; });
    await aReveal(a, heads[0][0], heads[0][1]); // 13
    await bReveal(b, 1, 1);
    await aReveal(a, heads[1][0], heads[1][1]); // 18
    await bReveal(b, 2, 2);
    // 找中心：十字含第 3 个（未揭示的）机头，且不含前两个已揭示的
    let center = null;
    for (let attempt = 0; attempt < 4000 && !center; attempt++) {
      const row = 1 + Math.floor(Math.random() * (SIZE - 2));
      const col = 1 + Math.floor(Math.random() * (SIZE - 2));
      const cross = [[row, col], [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
      const hasHead = cross.some(function (c) { return c[0] === heads[2][0] && c[1] === heads[2][1]; });
      const hasOld = cross.some(function (c) {
        return (c[0] === heads[0][0] && c[1] === heads[0][1]) || (c[0] === heads[1][0] && c[1] === heads[1][1]);
      });
      if (hasHead && !hasOld) center = { row: row, col: col, cross: cross };
    }
    if (!center) { console.log('  !! 没找到含机头的十字，跳过'); failed++; }
    else {
      const res = await aUse(a, 'doom', { row: center.row, col: center.col },
        function (d) { return d.itemId === 'doom' && d.attacker === 0; });
      const headInCells = res.cells.some(function (c) { return c.result === 'head'; });
      check('十字揭示了机头格', headInCells);
      check('headsLeft 减一（4 架 → 剩 1 个机头）', res.headsLeft[1] === 1);
    }
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
