// ============================================
// tools/selfplay-props.js —— 道具模式 AI 自对弈（双 AI 客户端走真实服务器）
//
// 用途：① 收集道具使用率（哪些道具被用、每局几次）
//      ② 两个「略有差异」的 AI 对战（infoWeight / 采样数 / 道具阈值不同）
//      供 tools/tune-ai.js 迭代调参，也支持命令行直接跑统计。
//
// 原理：创建普通双人房间（isAI=false，服务器不做 AI 调度），脚本扮演两个
//       AI 客户端，各自用 ai.js 的同一套决策逻辑（概率场选格 + decideItem
//       道具决策），交替走棋。金币/冻结/步数/道具结算全部走真实服务器规则，
//       因此统计到的道具使用率就是线上行为。
//
// 用法：先启动服务器，再：
//   node tools/selfplay-props.js            # 默认 20 局 M
//   node tools/selfplay-props.js 40 L        # 40 局 L（14×14）
// 环境变量：SELFPLAY_WS（默认 ws://localhost:3000/ws）、SELFPLAY_SAMPLES（默认 120）
// 模块导出：runBattle(url, spec, cfgA, cfgB) → 单局结果（tune-ai.js 用）
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const ai = require('../ai.js');
const shared = require('../public/shared.js');

const WS_URL = process.env.SELFPLAY_WS || 'ws://localhost:3000/ws';
const SAMPLES = parseInt(process.env.SELFPLAY_SAMPLES || '120', 10);
const MAX_MOVES = 600; // 防挂死：超过视为异常局

// ---------- 工具 ----------
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 20000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
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

// 给一个客户端挂上「状态维护」监听：从广播更新自己视角的棋盘揭示记录 /
// 金币 / 步数 / 冻结格 / 声呐历史，并按成功口径累计道具使用次数
function attach(state, usage) {
  state.ws.on('revealResult', function (d) {
    state.steps = d.steps[state.seat];
    state.coins = d.coins[state.seat];
    if (d.attacker === state.seat) {
      state.shots.push({ row: d.row, col: d.col, result: d.result });
      if (state.pendingItem) { usage[state.pendingItem] = (usage[state.pendingItem] || 0) + 1; state.pendingItem = null; } // pro/burst 的确认
    }
  });
  state.ws.on('itemResult', function (d) {
    if (d.attacker !== state.seat) return;
    state.steps = d.steps[state.seat];
    state.coins = d.coins[state.seat];
    usage[state.pendingItem || d.itemId] = (usage[state.pendingItem || d.itemId] || 0) + 1;
    state.pendingItem = null;
    if (d.itemId === 'sonar') {
      state.sonars.push({ row: d.row, col: d.col, count: d.count });
    } else if (d.itemId === 'expose') {
      // 广播只给坐标不给结果：与真人对局中看到的一致，整机其余格都按机身近似
      d.cells.forEach(function (c) { state.shots.push({ row: c[0], col: c[1], result: 'body' }); });
    } else if (d.itemId === 'devour') {
      d.destroyed.forEach(function (c) { state.shots.push({ row: c[0], col: c[1], result: 'destroyed' }); });
      if (d.headHit) state.shots.push({ row: d.headHit[0], col: d.headHit[1], result: 'head' });
    } else if (d.itemId === 'doom') {
      d.cells.forEach(function (c) { state.shots.push({ row: c.row, col: c.col, result: c.result }); });
      d.frozen.forEach(function (f) {
        if (f.owner === state.seat) state.frozen.push({ row: f.row, col: f.col, expiry: f.expiry });
      });
    }
  });
}

// 等「自己这一步」的回复：revealResult / itemResult（自己发动）/ error / gameOver。
// emitFn 先注册监听再发送（避免竞态）。返回 'over' | 'ok' | 'error'。
// 注意：ws.js 解包后回调收到的是 data（如 {winner,...}），不是 {type,data} 包装
function stepWait(state, emitFn, timeoutMs) {
  return new Promise(function (resolve) {
    const t = setTimeout(function () {
      cleanup();
      resolve('stall');
    }, timeoutMs || 10000);
    function any(d) {
      cleanup();
      if (d && typeof d.winner === 'number') { resolve('over'); return; }
      if (d && typeof d.message === 'string') { resolve('error'); return; }
      resolve('ok');
    }
    function cleanup() {
      clearTimeout(t);
      state.ws.off('revealResult', any);
      state.ws.off('itemResult', any);
      state.ws.off('error', any);
      state.ws.off('gameOver', any);
    }
    state.ws.on('revealResult', any);
    state.ws.on('itemResult', any);
    state.ws.on('error', any);
    state.ws.on('gameOver', any);
    emitFn();
  });
}

// 一个 AI 走一步：道具（成功即止）→ 否则普通揭示
async function act(state, cfg, spec) {
  const size = shared.getBoardSpec(spec).size;
  // 过期冻结解除（与服务器 isFrozenCell 同口径：steps >= expiry 可再碰）
  state.frozen = state.frozen.filter(function (f) { return state.steps < f.expiry; });
  let pf = null;
  try {
    pf = ai.buildProbField(state.shots, size, { samples: cfg.samples, sonarCounts: state.sonars });
  } catch (e) { pf = null; }
  const target = (pf && pf.head
    ? ai.chooseTargetProbField(state.shots, size, state.frozen, { probField: pf, infoWeight: cfg.infoWeight })
    : null) || ai.chooseTargetSimple(state.shots, size, state.frozen);

  // 道具决策（阈值 cfg.decide 覆盖默认；被服务器拒绝自动转普通揭示）
  if (pf && pf.head) {
    const item = ai.decideItem(state.coins, state.shots, size, state.frozen, pf, cfg.decide);
    if (item) {
      state.pendingItem = item.itemId;
      const res = await stepWait(state, function () {
        state.ws.emit('useItem', Object.assign({ itemId: item.itemId }, item.data));
      });
      if (res === 'over') return 'over';
      if (res === 'ok') return 'ok'; // 道具成功（计数已在 attach 完成）
      state.pendingItem = null;      // 被拒：退回普通揭示
    }
  }
  if (!target) return 'ok';
  const r2 = await stepWait(state, function () {
    state.ws.emit('reveal', { row: target.row, col: target.col });
  });
  if (r2 === 'over') return 'over';
  return 'ok';
}

// 单局对弈。cfg = {infoWeight, samples, decide}（decide 为 ai.decideItem 的 opts）
// 返回 {winner, stepsA, stepsB, moves, usage: {0:{itemId:n}, 1:{...}}, aborted}
async function runBattle(url, spec, cfgA, cfgB) {
  const a = new WSClient(url);
  await waitFor(a, 'connect');
  a.emit('createRoom', { name: '自对弈A', mode: 'props', boardSize: spec });
  const created = await waitFor(a, 'roomCreated');

  const b = new WSClient(url);
  await waitFor(b, 'connect');
  b.emit('joinRoom', { roomId: created.roomId, name: '自对弈B' });
  await waitFor(b, 'joinedRoom');

  const pA = waitFor(a, 'battleStart');
  const pB = waitFor(b, 'battleStart');
  // 兜底：pA 失败时 pB 可能是「没人 await 的孤儿 rejection」，Node 默认
  // unhandledRejection 直接崩进程——no-op catch 消费掉，主链 await 仍会拿到错误
  pA.catch(function () { /* 主链处理 */ });
  pB.catch(function () { /* 主链处理 */ });
  a.emit('deployConfirm', { planes: randomDeployment(spec) });
  b.emit('deployConfirm', { planes: randomDeployment(spec) });
  const bat = await pA;
  await pB;

  const stateA = { ws: a, seat: 0, shots: [], coins: bat.coins[0], steps: 0, frozen: [], sonars: [], pendingItem: null };
  const stateB = { ws: b, seat: 1, shots: [], coins: bat.coins[1], steps: 0, frozen: [], sonars: [], pendingItem: null };
  const usage = [{}, {}];
  attach(stateA, usage[0]);
  attach(stateB, usage[1]);

  const overP = new Promise(function (resolve) {
    function onOver(d) { cleanup(); resolve(d); }
    function cleanup() { a.off('gameOver', onOver); b.off('gameOver', onOver); }
    a.on('gameOver', onOver);
    b.on('gameOver', onOver);
  });

  // overFlag：gameOver 广播与 revealResult 可能是同一手先后两条消息，
  // stepWait 常被先到的 revealResult 消费而错过 gameOver，所以用常驻
  // 监听兜底，主循环每轮检查
  let overFlag = false;
  overP.then(function () { overFlag = true; });
  let moves = 0;
  let aborted = false;
  while (moves < MAX_MOVES && !overFlag) {
    const r1 = await act(stateA, cfgA, spec);
    moves++;
    if (r1 === 'over' || overFlag) break;
    const r2 = await act(stateB, cfgB, spec);
    moves++;
    if (r2 === 'over' || overFlag) break;
  }
  if (moves >= MAX_MOVES) aborted = true;

  const over = await Promise.race([
    overP,
    new Promise(function (resolve) { setTimeout(function () { resolve({ winner: -1 }); }, 3000); })
  ]);
  // 每局结束都断开连接（不占服务器资源）
  try { a.disconnect(); } catch (e) { /* 忽略 */ }
  try { b.disconnect(); } catch (e) { /* 忽略 */ }
  return {
    winner: over.winner === 0 ? 0 : over.winner === 1 ? 1 : -1,
    stepsA: stateA.steps, stepsB: stateB.steps, moves: moves,
    usage: usage, aborted: aborted
  };
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------- 命令行：跑 N 局打印胜率 + 道具使用率 ----------
async function main() {
  const games = parseInt(process.argv[2] || '20', 10);
  const spec = process.argv[3] || 'M';
  console.log('自对弈：' + games + ' 局 ' + (spec === 'L' ? '14×14' : '12×12') + ' 道具模式（' + WS_URL + '）');
  // 命令行统计默认用生产参数；可用 SELFPLAY_INFOWEIGHT 覆盖（如统计「采纳参数」下的使用率）
  const cfg = { infoWeight: parseFloat(process.env.SELFPLAY_INFOWEIGHT || '1.3'), samples: SAMPLES, decide: {} };
  let wins = { A: 0, B: 0, draw: 0 };
  const usageAgg = [{}, {}];
  const stepsAgg = { A: 0, B: 0 };
  const t0 = Date.now();
  for (let i = 1; i <= games; i++) {
    const r = await runBattle(WS_URL, spec, cfg, cfg);
    if (r.winner === 0) wins.A++;
    else if (r.winner === 1) wins.B++;
    else wins.draw++;
    stepsAgg.A += r.stepsA; stepsAgg.B += r.stepsB;
    ['sonar', 'pro', 'expose', 'burst', 'devour', 'doom'].forEach(function (id) {
      usageAgg[0][id] = (usageAgg[0][id] || 0) + (r.usage[0][id] || 0);
      usageAgg[1][id] = (usageAgg[1][id] || 0) + (r.usage[1][id] || 0);
    });
    if (i % 5 === 0 || i === games) {
      console.log('  第 ' + i + ' 局：' + (r.winner === 0 ? 'A 胜' : r.winner === 1 ? 'B 胜' : '平/异常') +
        '（' + r.stepsA + ':' + r.stepsB + ' 步，' + r.moves + ' 手）');
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('—— 结果（' + secs + 's）——');
  console.log('胜率：A ' + wins.A + ' / B ' + wins.B + ' / 平 ' + wins.draw);
  console.log('平均步数：A ' + (stepsAgg.A / games).toFixed(1) + ' / B ' + (stepsAgg.B / games).toFixed(1));
  console.log('道具使用率（每局平均，双方合计）：');
  ['sonar', 'pro', 'expose', 'burst', 'devour', 'doom'].forEach(function (id) {
    const total = (usageAgg[0][id] || 0) + (usageAgg[1][id] || 0);
    console.log('  ' + id + ': ' + (total / games).toFixed(2) + ' 次/局（A ' + (usageAgg[0][id] || 0) + ' / B ' + (usageAgg[1][id] || 0) + '）');
  });
  process.exit(0);
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('自对弈异常:', e.message);
    process.exit(1);
  });
}

module.exports = { runBattle: runBattle, WS_URL: WS_URL };
