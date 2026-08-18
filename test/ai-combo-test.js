// ============================================
// test/ai-combo-test.js —— 人机对战 6 种组合冒烟测试
// 玩法（classic/props）× 规格（S/M/L）= 6 种组合全部能开局、
// AI 部署合法（能被服务器接受）、真人走一步后 AI 会行动（揭示或道具）。
// 用法：先启动服务器（RECYCLE_SECONDS=3 AI_THINK_MIN_MS=80 AI_THINK_MAX_MS=200 node server.js）
// 再运行本测试。
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const WS_URL = 'ws://localhost:3000/ws';
const COMBOS = [
  { mode: 'classic', boardSize: 'S' },
  { mode: 'classic', boardSize: 'M' },
  { mode: 'classic', boardSize: 'L' },
  { mode: 'props', boardSize: 'S' },
  { mode: 'props', boardSize: 'M' },
  { mode: 'props', boardSize: 'L' }
];

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
// 等真人视角收到的「AI 行动」：揭示结果或道具结果，attacker=1
function waitAiMove(socket, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () {
      socket.off('revealResult', h1); socket.off('itemResult', h2);
      reject(new Error('等待 AI 行动超时'));
    }, timeoutMs || 8000);
    function h1(d) { if (d.attacker === 1) { clearTimeout(t); socket.off('revealResult', h1); socket.off('itemResult', h2); resolve(d); } }
    function h2(d) { if (d.attacker === 1) { clearTimeout(t); socket.off('revealResult', h1); socket.off('itemResult', h2); resolve(d); } }
    socket.on('revealResult', h1);
    socket.on('itemResult', h2);
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
  for (let i = 0; i < COMBOS.length; i++) {
    const combo = COMBOS[i];
    const sp = shared.getBoardSpec(combo.boardSize);
    console.log((i + 1) + '. 人机 ' + combo.mode + ' × ' + combo.boardSize + '（' + sp.size + '×' + sp.size + ' / ' + sp.planeCount + ' 架）');
    const a = new WSClient(WS_URL);
    await waitFor(a, 'connect');
    a.emit('createRoomAI', { name: 'P' + (i + 1), mode: combo.mode, boardSize: combo.boardSize });
    const created = await waitFor(a, 'roomCreated');
    check('roomCreated 回显 ' + combo.mode + '/' + combo.boardSize,
      created.mode === combo.mode && created.boardSize === combo.boardSize);

    // battleStart 广播只发一次：开战前就要挂好监听（AI 房间 battleStart 在部署完成后由服务器触发）
    const battleP = waitFor(a, 'battleStart');
    a.emit('deployConfirm', { planes: randomDeployment(combo.boardSize) });
    const battle = await battleP;
    check('battleStart 带 ' + combo.mode + '/' + combo.boardSize,
      battle.mode === combo.mode && battle.boardSize === combo.boardSize);
    check('开局金币 = ' + (combo.mode === 'props' ? 8 : 0),
      combo.mode === 'props' ? (battle.coins && battle.coins[0] === 8) : true);

    // 真人先走一步（必被接受），然后等 AI 行动（AI_THINK 80~200ms，8s 超时足够）
    const aiMoveP = waitAiMove(a);
    a.emit('reveal', { row: 0, col: 0 });
    const move = await aiMoveP;
    check('AI 已行动（' + (move.itemId ? '道具 ' + move.itemId : '揭示') + '）', true);
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
