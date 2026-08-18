// ============================================
// test/avatar-ui-test.js —— 头像 UI 交互测试（jsdom 实测）
// 验证：首次/坏值自动随机修复、点自己头像开面板、池按钮数 === 20、
//       点选换头像立即生效、🎲 随机、弹窗关闭、对战面板（含观战分支）、
//       比分 tooltip、部署页对手头像、最近房间列表、入房 emit 带头像
// 用法：node test/avatar-ui-test.js
// 说明：同 home-ui-test.js —— 被测源码和测试代码合并成一段脚本一次 eval（同一作用域），
//       能直接访问 state；init 会真实连接本地服务器（WSClient），emit 被替换为记录。
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
win.matchMedia = function () {
  return { matches: false, addEventListener: function () {}, removeEventListener: function () {} };
};

const testSrc = [
  'window.__avatarTest = function () {',
  '  var passed = 0, failed = 0, lines = [], emits = [];',
  '  function check(name, cond) {',
  '    if (cond) { passed++; lines.push("  ✓ " + name); }',
  '    else { failed++; lines.push("  ✗ " + name); }',
  '  }',
  '  function inPool(emoji) { return AVATAR_POOL.indexOf(emoji) !== -1; }',
  '  function fireEvent(ev, data) {',
  '    var list = state.socket._handlers.get(ev);',
  '    if (list) list.slice().forEach(function (cb) { cb(data); });',
  '  }',
  '  state.socket.emit = function (ev, data) { emits.push({ ev: ev, data: data }); };',
  '  var modal = document.getElementById("avatar-modal");',
  '  var homeAvatar = document.getElementById("home-avatar");',
  '  var inviteAvatar = document.getElementById("invite-avatar");',
  '',
  '  // ===== 1. 首次访问：init 已自动分配随机头像 =====',
  '  lines.push("1. 首次随机分配");',
  '  var av0 = myAvatar();',
  '  check("myAvatar() 返回池内成员", inPool(av0));',
  '  check("已写入 localStorage", window.localStorage.getItem("bp_avatar") === av0);',
  '  check("首页昵称卡显示头像", homeAvatar.textContent === av0);',
  '  check("邀请页昵称卡显示头像", inviteAvatar.textContent === av0);',
  '',
  '  // ===== 2. 坏值自动修复：不在池里 → 重新随机并覆盖 =====',
  '  lines.push("2. 坏值自动修复");',
  '  window.localStorage.setItem("bp_avatar", "zzz");',
  '  var fixed = myAvatar();',
  '  check("坏值后返回池内成员", inPool(fixed));',
  '  check("坏值已被覆盖写入", window.localStorage.getItem("bp_avatar") === fixed);',
  '',
  '  // ===== 3. 点头像开面板 + 池按钮 =====',
  '  lines.push("3. 头像选择面板");',
  '  check("初始弹窗是关闭的", modal.classList.contains("hidden"));',
  '  homeAvatar.click();',
  '  check("点首页头像打开弹窗", !modal.classList.contains("hidden"));',
  '  var btns = document.querySelectorAll("#avatar-pool button");',
  '  check("池按钮数量 === 20", btns.length === 20);',
  '  var allInPool = true;',
  '  btns.forEach(function (b) { if (!inPool(b.textContent)) allInPool = false; });',
  '  check("每个按钮都在池里", allInPool);',
  '',
  '  // ===== 4. 点选换头像：立即生效并关闭弹窗 =====',
  '  lines.push("4. 点选换头像");',
  '  var picked = btns[2].textContent;',
  '  btns[2].click();',
  '  check("点选后写入 localStorage", window.localStorage.getItem("bp_avatar") === picked);',
  '  check("首页头像立即更新", homeAvatar.textContent === picked);',
  '  check("邀请页头像同步更新", inviteAvatar.textContent === picked);',
  '  check("state.avatar 同步", state.avatar === picked);',
  '  check("弹窗已关闭", modal.classList.contains("hidden"));',
  '  check("重新打开面板时按钮仍只有 20 个（不重复渲染）", document.querySelectorAll("#avatar-pool button").length === 20);',
  '',
  '  // ===== 5. 🎲 随机按钮 + 关闭按钮 + 点背景关闭 =====',
  '  lines.push("5. 随机/关闭/背景");',
  '  homeAvatar.click();',
  '  document.getElementById("btn-avatar-random").click();',
  '  var rnd = window.localStorage.getItem("bp_avatar");',
  '  check("随机后仍在池里", inPool(rnd));',
  '  homeAvatar.click();',
  '  document.getElementById("btn-avatar-close").click();',
  '  check("关闭按钮关弹窗", modal.classList.contains("hidden"));',
  '  homeAvatar.click();',
  '  modal.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));',
  '  check("点弹窗背景关闭", modal.classList.contains("hidden"));',
  '',
  '  // ===== 6. 开战渲染：玩家视角自己用本地头像、对手用广播头像 =====',
  '  lines.push("6. 对战面板（玩家视角）");',
  '  state.seat = 0; state.spectator = false; state.boardSize = "S";',
  '  fireEvent("battleStart", { names: ["甲", "乙"], avatars: ["🐱", "🦊"], steps: [0, 0], score: [0, 0], online: [true, true], mode: "classic", boardSize: "S", coins: [8, 8] });',
  '  check("我的面板头像 = 本地头像（当前已换成的 " + state.avatar + "）", document.getElementById("panel-my-avatar").textContent === state.avatar);',
  '  check("对手面板头像 = 广播 avatars[1]", document.getElementById("panel-enemy-avatar").textContent === "🦊");',
  '  check("对战页可见", !document.getElementById("view-battle").classList.contains("hidden"));',
  '',
  '  // ===== 6.5 对局中换头像：自己面板立刻生效（对手下一局才看到） =====',
  '  lines.push("6.5 对局中换头像");',
  '  var mid = state.avatar === "😎" ? "🤩" : "😎";',
  '  setMyAvatar(mid);',
  '  check("换完自己面板立即更新", document.getElementById("panel-my-avatar").textContent === mid);',
  '  check("对手头像不受影响", document.getElementById("panel-enemy-avatar").textContent === "🦊");',
  '',
  '  // ===== 7. 观战视角：固定左=房主 avatars[0]，右=avatars[1] =====',
  '  lines.push("7. 对战面板（观战视角）");',
  '  state.spectator = true;',
  '  updateBattlePanels();',
  '  check("观战左面板 = avatars[0]", document.getElementById("panel-my-avatar").textContent === "🐱");',
  '  check("观战右面板 = avatars[1]", document.getElementById("panel-enemy-avatar").textContent === "🦊");',
  '  state.spectator = false;',
  '',
  '  // ===== 8. 比分 tooltip：头像 + 昵称（玩家视角自己座位用本地头像） =====',
  '  lines.push("8. 比分 tooltip");',
  '  state.score = [1, 0];',
  '  updateBattlePanels();',
  '  var scoreA = document.getElementById("score-a");',
  '  var scoreB = document.getElementById("score-b");',
  '  check("左分 tooltip = 本地头像 + 昵称", scoreA.dataset.name === state.avatar + " 甲");',
  '  check("右分 tooltip = 广播头像 + 昵称", scoreB.dataset.name === "🦊 乙");',
  '  check("比分条可见", !document.getElementById("battle-score").classList.contains("hidden"));',
  '  state.spectator = true;',
  '  updateBattlePanels();',
  '  check("观战左分 tooltip = avatars[0] + 昵称", scoreA.dataset.name === "🐱 甲");',
  '  state.spectator = false; state.score = [0, 0];',
  '',
  '  // ===== 9. 部署页对手头像 =====',
  '  lines.push("9. 部署页对手头像");',
  '  state.names = ["甲", "乙"]; state.avatars = ["🐱", "🦊"]; state.online = [true, true];',
  '  state.deployConfirmed = [false, false]; state.draft = []; state.boardSize = "S";',
  '  updateDeployUI();',
  '  check("部署页对手头像 = avatars[1-seat]", document.getElementById("deploy-opponent-avatar").textContent === "🦊");',
  '  state.names = ["甲", ""]; state.avatars = ["🐱", ""];',
  '  updateDeployUI();',
  '  check("无对手时头像为空", document.getElementById("deploy-opponent-avatar").textContent === "");',
  '',
  '  // ===== 10. 最近房间列表：带头像（历史记录统一显示当前头像） =====',
  '  lines.push("10. 最近房间列表");',
  '  window.localStorage.setItem("bp_room_history", JSON.stringify([{ roomId: "AAAA", token: "t", name: "历史玩家", lastSeen: 1 }]));',
  '  renderRecentRooms();',
  '  var recentCard = document.getElementById("recent-card");',
  '  var firstLi = document.querySelector("#recent-list li");',
  '  check("有历史时卡片可见", !recentCard.classList.contains("hidden"));',
  '  check("列表项包含当前头像 + 昵称", firstLi && firstLi.textContent.indexOf(myAvatar()) !== -1 && firstLi.textContent.indexOf("历史玩家") !== -1);',
  '',
  '  // ===== 11. 入房 emit 都带头像 =====',
  '  lines.push("11. 入房 emit 带头像");',
  '  emits = [];',
  '  document.querySelector(".mode-create").click();',
  '  check("createRoom 带头像", emits.length > 0 && emits[emits.length - 1].ev === "createRoom" && emits[emits.length - 1].data.avatar === myAvatar());',
  '  emits = [];',
  '  document.querySelector(".mode-ai").click();',
  '  check("createRoomAI 带头像", emits.length > 0 && emits[emits.length - 1].ev === "createRoomAI" && emits[emits.length - 1].data.avatar === myAvatar());',
  '  emits = [];',
  '  document.getElementById("room-input").value = "1234";',
  '  document.getElementById("btn-join").click();',
  '  check("joinRoom 带头像", emits.length > 0 && emits[emits.length - 1].ev === "joinRoom" && emits[emits.length - 1].data.avatar === myAvatar());',
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

const result = win.__avatarTest();
console.log(result.lines.join('\n'));
console.log('\n结果: ' + result.passed + ' 通过, ' + result.failed + ' 失败');
process.exitCode = result.failed ? 1 : 0;
setTimeout(function () { process.exit(process.exitCode); }, 500); // 等 ws 连接回收
