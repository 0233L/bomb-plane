// ============================================
// test/home-ui-test.js —— 首页两栏卡片 UI 交互测试（jsdom 实测）
// 验证：默认经典卡+S、点卡片切换玩法栏、每栏各自记住规格（互不串扰）、
//       卡内创建/人机按钮按所点栏的玩法+规格开局、加入房间用当前选中栏
// 用法：node test/home-ui-test.js
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

// 测试代码与被测源码同一 eval 作用域：能直接访问 state，拦截 emit 记录开局参数
const testSrc = [
  'window.__uiTest = function () {',
  '  var passed = 0, failed = 0, lines = [], emits = [];',
  '  function check(name, cond) {',
  '    if (cond) { passed++; lines.push("  ✓ " + name); }',
  '    else { failed++; lines.push("  ✗ " + name); }',
  '  }',
  '  function activeMode() { var c = document.querySelector(".mode-card.active"); return c ? c.dataset.mode : null; }',
  '  function activeSpec() { var b = document.querySelector(".spec-btn.active"); return b && b.dataset.spec; }',
  '  function lastEmit() { return emits[emits.length - 1]; }',
  '  state.socket.emit = function (ev, data) { emits.push({ ev: ev, data: data }); };',
  '',
  '  // ===== 1. 默认状态：经典卡 + S =====',
  '  lines.push("1. 默认状态");',
  '  check("经典卡片默认选中", activeMode() === "classic");',
  '  check("规格默认 S 高亮", activeSpec() === "S");',
  '  check("帮助文字是经典", document.getElementById("mode-help").textContent.indexOf("经典") !== -1);',
  '',
  '  // ===== 2. 点道具卡片：选中 + 规格自动切道具默认 M =====',
  '  lines.push("2. 点道具卡片");',
  '  document.querySelector(".mode-card[data-mode=\\"props\\"]").click();',
  '  check("道具卡片选中", activeMode() === "props");',
  '  check("经典卡片取消选中", !document.querySelector(".mode-card[data-mode=\\"classic\\"]").classList.contains("active"));',
  '  check("规格自动换成道具默认 M", activeSpec() === "M");',
  '  check("帮助文字是道具版", document.getElementById("mode-help").textContent.indexOf("道具版") !== -1);',
  '',
  '  // ===== 2.5 道具说明弹窗：点「查看道具说明」打开，点「知道了」关闭 =====',
  '  lines.push("2.5 道具说明弹窗");',
  '  document.getElementById("btn-item-guide").click();',
  '  check("点「查看道具说明」弹窗打开", !document.getElementById("item-guide-modal").classList.contains("hidden"));',
  '  check("弹窗里有 6 个道具条目", document.querySelectorAll("#item-guide-modal .rules-list li").length === 6);',
  '  document.getElementById("btn-item-guide-close").click();',
  '  check("点「知道了」弹窗关闭", document.getElementById("item-guide-modal").classList.contains("hidden"));',
  '',
  '  // ===== 3. 道具栏改规格 L：存入 bp_spec_props =====',
  '  lines.push("3. 道具栏改规格");',
  '  document.querySelector(".spec-btn[data-spec=\\"L\\"]").click();',
  '  check("道具栏点 L 后高亮", activeSpec() === "L");',
  '  check("存入 bp_spec_props", window.localStorage.getItem("bp_spec_props") === "L");',
  '',
  '  // ===== 4. 切回经典卡：规格自动换回经典默认 S =====',
  '  lines.push("4. 切回经典卡片");',
  '  document.querySelector(".mode-card[data-mode=\\"classic\\"]").click();',
  '  check("经典卡片重新选中", activeMode() === "classic");',
  '  check("规格自动换回经典默认 S", activeSpec() === "S");',
  '',
  '  // ===== 5. 经典栏改 L → 切道具：还是道具栏自己的 L（互不串扰） =====',
  '  lines.push("5. 两栏规格互不串扰");',
  '  document.querySelector(".spec-btn[data-spec=\\"L\\"]").click();',
  '  check("经典栏点 L 后高亮", activeSpec() === "L");',
  '  check("存入 bp_spec_classic", window.localStorage.getItem("bp_spec_classic") === "L");',
  '  document.querySelector(".mode-card[data-mode=\\"props\\"]").click();',
  '  check("切道具后规格仍是道具栏的 L", activeSpec() === "L");',
  '  document.querySelector(".mode-card[data-mode=\\"classic\\"]").click();',
  '  check("切回经典规格仍是经典栏的 L", activeSpec() === "L");',
  '',
  '  // ===== 6. 卡内按钮：按所点栏的玩法+规格开局 =====',
  '  lines.push("6. 卡内创建/人机按钮");',
  '  emits = [];',
  '  document.querySelector(".mode-card[data-mode=\\"props\\"] .mode-create").click();',
  '  check("道具卡「创建房间」emit 玩法 props", lastEmit().data.mode === "props");',
  '  check("道具卡「创建房间」emit 规格 L（道具栏记忆）", lastEmit().data.boardSize === "L");',
  '  document.querySelector(".mode-card[data-mode=\\"classic\\"] .mode-ai").click();',
  '  check("经典卡「人机对战」emit 玩法 classic", lastEmit().data.mode === "classic");',
  '  check("经典卡「人机对战」emit 规格 L（经典栏记忆）", lastEmit().data.boardSize === "L");',
  '',
  '  // ===== 7. 加入房间按钮：用当前选中栏的玩法+规格 =====',
  '  lines.push("7. 加入房间按钮");',
  '  emits = [];',
  '  document.querySelector(".mode-card[data-mode=\\"props\\"]").click(); // 选中道具栏',
  '  document.getElementById("room-input").value = "1234";',
  '  document.getElementById("btn-join").click();',
  '  check("加入房间 emit 玩法 props", lastEmit().data.mode === "props");',
  '  check("加入房间 emit 规格 L", lastEmit().data.boardSize === "L");',
  '  check("加入房间 emit 房间号", lastEmit().data.roomId === "1234");',
  '',
  '  // ===== 8. 道具选区模式下右键 = 取消选中（而不是标记） =====',
  '  lines.push("8. 道具选区右键取消");',
  '  state.seat = 0;',
  '  state.spectator = false;',
  '  state.over = false;',
  '  state.enemyShotsReceived = [];',
  '  state.marks = {};',
  '  var enemyTd = document.querySelector("#enemy-board td");', // init 已给对手棋盘绑好右键处理器
  '  state.itemPick = { itemId: "sonar" };',
  '  enemyTd.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));',
  '  check("选区模式下右键取消道具选中", state.itemPick === null);',
  '  check("取消时没有误标到棋盘", Object.keys(state.marks).length === 0);',
  '  state.itemPick = null;',
  '  enemyTd.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));',
  '  check("非选区模式右键正常循环标注机头", state.marks["0,0"] === "head");',
  '',
  '  // ===== 9. 回到菜单再重进：冻结标记不能丢（goBattle 不得清空 frozenCells） =====',
  '  lines.push("9. 重连后冻结标记保留");',
  '  function fireEvent(ev, data) {', // 直接触发 WSClient 已注册的事件回调（绕过被替换的 emit）
  '    var list = state.socket._handlers.get(ev);',
  '    if (list) list.slice().forEach(function (cb) { cb(data); });',
  '  }',
  '  var rec = {',
  '    roomId: "T123", seat: 0, name: "A", names: ["A", "B"], online: [true, true],',
  '    steps: [12, 12], score: [0, 0], mode: "props", boardSize: "M", coins: [5, 3],',
  '    headsLeft: [4, 3], deployConfirmed: [true, true], myPlanes: [],',
  '    myShotsReceived: [], enemyShotsReceived: [], sonarHistory: [],',
  '    frozenCells: [{ row: 3, col: 1, owner: 0, expiry: 20 }],',
  '    winner: null, winReason: null, rematchVotes: [false, false], isAI: false,',
  '    planes: null, phase: "battle"',
  '  };',
  '  fireEvent("reconnected", rec);',
  '  check("重连后 frozenCells 保留", state.frozenCells.length === 1);',
  '  var frozenTd = document.querySelector("#enemy-board td[data-row=\\"3\\"][data-col=\\"1\\"]");',
  '  check("重连后冻结格渲染 ❄", frozenTd && frozenTd.classList.contains("cell-frozen"));',
  '  // 再来一局（battleStart 新局）：冻结才清零',
  '  state.socket._handlers.get("battleStart").slice().forEach(function (cb) { cb({ names: ["A", "B"], steps: [0, 0], score: [0, 0], online: [true, true], mode: "props", boardSize: "M", coins: [8, 8] }); });',
  '  check("开新一局（battleStart）冻结清零", state.frozenCells.length === 0);',
  '',
  '  // ===== 10. 声呐渲染：数字在中心格 + 3×3 区域外圈金色边框 =====',
  '  lines.push("10. 声呐区域框与中心数字");',
  '  state.sonarResults = [{ row: 2, col: 3, count: 4 }];',
  '  renderBattleBoards();',
  '  var sonarCenter = document.querySelector("#enemy-board td[data-row=\\"3\\"][data-col=\\"4\\"]");',
  '  check("声呐数字显示在区域中心格", sonarCenter && sonarCenter.textContent === "4" && sonarCenter.classList.contains("cell-sonar"));',
  '  var sonarCorner = document.querySelector("#enemy-board td[data-row=\\"2\\"][data-col=\\"3\\"]");',
  '  check("区域外圈格有金色边框（左上角）", sonarCorner && sonarCorner.style.boxShadow.indexOf("inset") !== -1 && sonarCorner.style.boxShadow.indexOf("f6c945") !== -1);',
  '  check("中心格无边框（只标数字）", sonarCenter.style.boxShadow === "");',
  '  var sonarOut = document.querySelector("#enemy-board td[data-row=\\"1\\"][data-col=\\"3\\"]");',
  '  check("区域外没有边框", sonarOut.style.boxShadow === "");',
  '  state.sonarResults = [];',
  '',
  '  return { passed: passed, failed: failed, lines: lines };',
  '};'
].join('\n');

try {
  win.eval(wsSrc + '\n' + sharedSrc + '\n' + clientSrc + '\n' + testSrc);
} catch (e) {
  console.error('client.js 执行异常:', e.message);
  console.error((e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

const result = win.__uiTest();
console.log(result.lines.join('\n'));
console.log('\n结果: ' + result.passed + ' 通过, ' + result.failed + ' 失败');
process.exitCode = result.failed ? 1 : 0;
setTimeout(function () { process.exit(process.exitCode); }, 500); // 等 ws 连接回收
