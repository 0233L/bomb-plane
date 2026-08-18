// ============================================
// test/double-tap-confirm-test.js —— 道具「二次点击定位格 = 确认」交互测试（jsdom 实测）
// 验证：选区完整后，再点一次定位格（3×3 锚点 / 十字中心 / 机头格 / 双发任一已选格）
//       直接发送 useItem，无需再点「确认使用」按钮；区域内其他格仍是重新定位
// 用法：node test/double-tap-confirm-test.js
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

// 测试代码与被测源码同一 eval 作用域：能直接访问 state / pickItemCell / confirmItem
const testSrc = [
  'window.__tapTest = function () {',
  '  var passed = 0, failed = 0, lines = [], emits = [];',
  '  function check(name, cond) {',
  '    if (cond) { passed++; lines.push("  ✓ " + name); }',
  '    else { failed++; lines.push("  ✗ " + name); }',
  '  }',
  '  function lastEmit() { return emits[emits.length - 1]; }',
  '  // 最小对局状态（渲染只依赖静态空表格，不依赖真实对局数据）',
  '  state.boardSize = "M";',
  '  state.seat = 0;',
  '  state.spectator = false;',
  '  state.over = false;',
  '  state.revealedPlanes = null;',
  '  state.myPlanes = [];',
  '  state.enemyShotsReceived = [];',
  '  state.myShotsReceived = [];',
  '  state.sonarResults = [];',
  '  state.frozenCells = [];',
  '  state.coins = [8, 8];',
  '  state.steps = [0, 0];',
  '  state.marks = {};',
  '  state.mode = "props";',
  '  state.socket.emit = function (ev, data) { emits.push({ ev: ev, data: data }); };',
  '  function enterPick(itemId) {',
  '    state.itemPick = { itemId: itemId };',
  '    state.pickCells = [];',
  '    state.pickAnchor = null;',
  '    state.pickReady = false;',
  '  }',
  '',
  '  // ===== 1. 声呐：区域内非锚点格 = 重新定位；再点锚点格 = 确认 =====',
  '  lines.push("1. 声呐二次点击锚点确认");',
  '  enterPick("sonar");',
  '  pickItemCell(3, 4);',
  '  check("第一次点击后选区就绪", state.pickReady === true);',
  '  check("锚点是包含点击格的区域左上角 (2,3)", state.pickAnchor && state.pickAnchor.row === 2 && state.pickAnchor.col === 3);',
  '  pickItemCell(3, 5); // 区域内其他格：重新定位，不是确认',
  '  check("点区域内其他格 = 重新定位（锚点变为 (2,4)）", state.pickAnchor && state.pickAnchor.row === 2 && state.pickAnchor.col === 4);',
  '  check("重新定位不发送", emits.length === 0);',
  '  pickItemCell(2, 4); // 再点锚点本身 = 确认',
  '  check("二次点击锚点格发送 useItem", emits.length === 1 && lastEmit().ev === "useItem");',
  '  check("发送的是锚点坐标", lastEmit().data.row === 2 && lastEmit().data.col === 4 && lastEmit().data.itemId === "sonar");',
  '  check("确认后选区清空", state.itemPick === null);',
  '',
  '  // ===== 2. 毁灭菇：再点十字中心 = 确认 =====',
  '  lines.push("2. 毁灭菇二次点击中心确认");',
  '  emits = [];',
  '  enterPick("doom");',
  '  pickItemCell(5, 5);',
  '  check("十字中心选区就绪", state.pickReady === true && state.pickCells[0] === "5,5");',
  '  pickItemCell(5, 5);',
  '  check("二次点击中心发送 useItem", emits.length === 1 && lastEmit().ev === "useItem");',
  '  check("发送的是十字中心", lastEmit().data.row === 5 && lastEmit().data.col === 5 && lastEmit().data.itemId === "doom");',
  '',
  '  // ===== 3. 无所遁形：再点已揭示机头格 = 确认 =====',
  '  lines.push("3. 无所遁形二次点击机头格确认");',
  '  emits = [];',
  '  state.enemyShotsReceived.push({ row: 1, col: 1, result: "head" });',
  '  enterPick("expose");',
  '  pickItemCell(1, 1);',
  '  check("机头格选区就绪", state.pickReady === true);',
  '  pickItemCell(1, 1);',
  '  check("二次点击机头格发送 useItem", emits.length === 1 && lastEmit().ev === "useItem");',
  '  check("发送的是机头格", lastEmit().data.row === 1 && lastEmit().data.col === 1 && lastEmit().data.itemId === "expose");',
  '',
  '  // ===== 4. 双发连射：点满 2 格后再点任一已选格 = 确认 =====',
  '  lines.push("4. 双发二次点击已选格确认");',
  '  emits = [];',
  '  enterPick("burst");',
  '  pickItemCell(2, 2);',
  '  check("第 1 格未就绪", state.pickReady === false);',
  '  pickItemCell(5, 5);',
  '  check("第 2 格后选区就绪", state.pickReady === true);',
  '  pickItemCell(5, 5);',
  '  check("二次点击已选格发送 useItem", emits.length === 1 && lastEmit().ev === "useItem");',
  '  check("发送两个格子", lastEmit().data.row === 2 && lastEmit().data.col === 2 && lastEmit().data.row2 === 5 && lastEmit().data.col2 === 5);',
  '  // 已就绪时点新格 = 重新从第 1 格开始',
  '  emits = [];',
  '  enterPick("burst");',
  '  pickItemCell(2, 2);',
  '  pickItemCell(5, 5);',
  '  pickItemCell(1, 1);',
  '  check("就绪后点新格 = 重新选（从第 1 格开始）", state.pickCells.length === 1 && state.pickCells[0] === "1,1" && state.pickReady === false);',
  '  check("重新选不发送", emits.length === 0);',
  '',
  '  // ===== 5. 「确认使用」按钮仍然可用 =====',
  '  lines.push("5. 确认按钮");',
  '  emits = [];',
  '  enterPick("sonar");',
  '  pickItemCell(3, 4);',
  '  document.getElementById("item-confirm").click();',
  '  check("点确认按钮发送 useItem", emits.length === 1 && lastEmit().ev === "useItem");',
  '  check("确认按钮发送锚点", lastEmit().data.row === 2 && lastEmit().data.col === 3);',
  '',
  '  return { passed: passed, failed: failed, lines: lines };',
  '};'
].join('\n');

win.eval(wsSrc + '\n' + sharedSrc + '\n' + clientSrc + '\n' + testSrc);
const res = win.__tapTest();
res.lines.forEach(function (l) { console.log(l); });
console.log('\n结果: ' + res.passed + ' 通过, ' + res.failed + ' 失败');
process.exitCode = res.failed ? 1 : 0;
setTimeout(function () { process.exit(process.exitCode); }, 500); // 等 ws 连接回收
