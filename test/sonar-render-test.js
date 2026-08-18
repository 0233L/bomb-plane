// ============================================
// test/sonar-render-test.js —— 声呐结果渲染位置测试（jsdom 实测）
// 背景：声呐坐标相对「被探测方棋盘」记录，以前只渲染在对方棋盘上——
//       自己放（探测对方棋盘）刚好对，但对方放的声呐（探测我的棋盘）
//       数字却画在了对方棋盘上。修复后：谁放的声呐，结果就画在谁探测的棋盘上
//       （我放的 → 对方棋盘；对方放的 → 我的棋盘；观战者按被探测座位分）。
// 用法：先启动服务器（RECYCLE_SECONDS=3 node server.js）再运行
// 说明：client.js 是严格模式 + 顶层 init，state 在 eval 作用域内取不到，
//       所以被测源码和测试代码合并成一段脚本一次 eval（同一作用域）。
// ============================================
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const wsSrc = fs.readFileSync('public/ws.js', 'utf8');
const sharedSrc = fs.readFileSync('public/shared.js', 'utf8');
const clientSrc = fs.readFileSync('public/client.js', 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;
win.WebSocket = require('ws').WebSocket; // init 里 WSClient 会真实连接本地服务器
win.matchMedia = function () { // jsdom 不提供 matchMedia，给个最小实现
  return { matches: false, addEventListener: function () {}, removeEventListener: function () {} };
};

const testSrc = [
  'window.__sonarTest = function () {',
  '  var passed = 0, failed = 0, lines = [];',
  '  function check(name, cond) {',
  '    if (cond) { passed++; lines.push("  ✓ " + name); }',
  '    else { failed++; lines.push("  ✗ " + name); }',
  '  }',
  '  // 最小对局状态（渲染只依赖静态空表格 + 手工设置的声呐历史）',
  '  function setup() {',
  '    state.boardSize = "M";',
  '    state.seat = 0;',
  '    state.spectator = false;',
  '    state.over = false;',
  '    state.revealedPlanes = null;',
  '    state.myPlanes = [];',
  '    state.myShotsReceived = [];',
  '    state.enemyShotsReceived = [];',
  '    state.frozenCells = [];',
  '    state.steps = [0, 0];',
  '    state.marks = {};',
  '    state.mode = "props";',
  '    state.itemPick = null;',
  '    state.pickCells = [];',
  '    state.pickHover = [];',
  '    state.sonarResults = [];',
  '  }',
  '  function tdIn(boardId, r, c) {',
  '    return document.querySelector("#" + boardId + " td[data-row=\\"" + r + "\\"][data-col=\\"" + c + "\\"]");',
  '  }',
  '  function hasCls(td, cls) { return td && td.className.indexOf(cls) !== -1; }',
  '  // 声呐锚点 (3,4)：区域 3~5 行 × 4~6 列，中心格 (4,5) 显示数字',
  '',
  '  // ===== 1. 我放的声呐（探测对方棋盘）→ 画在对方棋盘 =====',
  '  lines.push("1. 我方声呐画在对方棋盘");',
  '  setup();',
  '  state.sonarResults = [{ row: 3, col: 4, count: 2, attacker: 0 }];',
  '  renderBattleBoards();',
  '  check("对方棋盘中心格显示数字 2", tdIn("enemy-board", 4, 5) && hasCls(tdIn("enemy-board", 4, 5), "cell-sonar") && tdIn("enemy-board", 4, 5).textContent === "2");',
  '  check("对方棋盘区域角格有金色外框", (tdIn("enemy-board", 3, 4).style.boxShadow || "").indexOf("#f6c945") !== -1);',
  '  check("我的棋盘不显示这个数字", !hasCls(tdIn("my-board", 4, 5), "cell-sonar"));',
  '  check("我的棋盘没有外框", (tdIn("my-board", 3, 4).style.boxShadow || "") === "");',
  '',
  '  // ===== 2. 对方放的声呐（探测我的棋盘）→ 画在我的棋盘 =====',
  '  lines.push("2. 对方声呐画在我的棋盘");',
  '  setup();',
  '  state.sonarResults = [{ row: 3, col: 4, count: 5, attacker: 1 }];',
  '  renderBattleBoards();',
  '  check("我的棋盘中心格显示数字 5", tdIn("my-board", 4, 5) && hasCls(tdIn("my-board", 4, 5), "cell-sonar") && tdIn("my-board", 4, 5).textContent === "5");',
  '  check("我的棋盘区域角格有金色外框", (tdIn("my-board", 3, 4).style.boxShadow || "").indexOf("#f6c945") !== -1);',
  '  check("对方棋盘不显示这个数字", !hasCls(tdIn("enemy-board", 4, 5), "cell-sonar"));',
  '  check("对方棋盘没有外框", (tdIn("enemy-board", 3, 4).style.boxShadow || "") === "");',
  '',
  '  // ===== 3. 双方都放过声呐：各自画在各自探测的棋盘 =====',
  '  lines.push("3. 双方声呐各画各的");',
  '  setup();',
  '  state.sonarResults = [',
  '    { row: 3, col: 4, count: 2, attacker: 0 }, // 我放的：画对方棋盘',
  '    { row: 0, col: 0, count: 3, attacker: 1 }  // 对方放的：画我的棋盘',
  '  ];',
  '  renderBattleBoards();',
  '  check("对方棋盘有我的声呐 2", hasCls(tdIn("enemy-board", 4, 5), "cell-sonar") && tdIn("enemy-board", 4, 5).textContent === "2");',
  '  check("我的棋盘有对方的声呐 3（中心 (1,1)）", hasCls(tdIn("my-board", 1, 1), "cell-sonar") && tdIn("my-board", 1, 1).textContent === "3");',
  '  check("我的棋盘没有对方的数字 2", !hasCls(tdIn("my-board", 4, 5), "cell-sonar"));',
  '  check("对方棋盘没有我的数字 3", !hasCls(tdIn("enemy-board", 1, 1), "cell-sonar"));',
  '',
  '  // ===== 4. 观战者：按被探测座位画（0 号玩家的声呐探测 1 号 → 对方棋盘） =====',
  '  lines.push("4. 观战者视角");',
  '  setup();',
  '  state.spectator = true;',
  '  state.sonarResults = [{ row: 3, col: 4, count: 2, attacker: 0 }];', // 0 号放的，探测 1 号 → 观战的「对方棋盘」
  '  renderBattleBoards();',
  '  check("观战：0 号声呐画在对方棋盘", hasCls(tdIn("enemy-board", 4, 5), "cell-sonar"));',
  '  setup();',
  '  state.spectator = true;',
  '  state.sonarResults = [{ row: 3, col: 4, count: 2, attacker: 1 }];', // 1 号放的，探测 0 号 → 观战的「我的棋盘」
  '  renderBattleBoards();',
  '  check("观战：1 号声呐画在我的棋盘", hasCls(tdIn("my-board", 4, 5), "cell-sonar"));',
  '',
  '  // ===== 5. 重连恢复的历史记录（服务器补发的 sonarHistory 带 attacker）同样正确 =====',
  '  lines.push("5. 重连恢复后渲染一致");',
  '  setup();',
  '  state.sonarResults = [{ row: 1, col: 1, count: 1, attacker: 1 }];', // 模拟 battleStart/reconnected 赋值
  '  renderBattleBoards();',
  '  check("重连后对方声呐画在我的棋盘", hasCls(tdIn("my-board", 2, 2), "cell-sonar") && tdIn("my-board", 2, 2).textContent === "1");',
  '',
  '  return { passed: passed, failed: failed, lines: lines };',
  '};'
].join('\n');

win.eval(wsSrc + '\n' + sharedSrc + '\n' + clientSrc + '\n' + testSrc);
const res = win.__sonarTest();
res.lines.forEach(function (l) { console.log(l); });
console.log('\n结果: ' + res.passed + ' 通过, ' + res.failed + ' 失败');
process.exitCode = res.failed ? 1 : 0;
setTimeout(function () { process.exit(process.exitCode); }, 500); // 等 ws 连接回收
