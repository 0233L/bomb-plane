// ============================================
// test/mini-logic-test.js —— 小程序端纯逻辑冒烟测试（可选）
//
// 在不启动微信开发者工具的情况下，用 Node 模拟 wx 环境，
// 加载真实的 miniprogram/app.js + 三个页面，连上真实服务器：
//   小程序建房 → 部署 → 网页端加入 → 跨端打完整局 → 再来一局 → 断线重连
//
// 用法（和 e2e-test.js 相同，先起服务器）：
//   RECYCLE_SECONDS=3 node server.js
//   node test/mini-logic-test.js
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;

// ---------- 模拟 wx 环境（只 mock 用到的 API） ----------
const storage = new Map();
let appObj = null;
const pageDefs = {};          // 页面名 -> Page 定义
let currentPage = '';

global.wx = {
  connectSocket(opts) {
    const ws = new WebSocket(opts.url);
    return {
      _ws: ws,
      onOpen(cb) { ws.on('open', function () { cb(); }); },
      onMessage(cb) { ws.on('message', function (d) { cb({ data: d.toString() }); }); },
      onClose(cb) { ws.on('close', function (code, reason) { cb({ code: code, reason: reason && reason.toString() }); }); },
      onError(cb) { ws.on('error', function () { cb({ errMsg: 'socket error' }); }); },
      send(o) { ws.send(o.data); },
      close() { ws.close(); }
    };
  },
  _debugLog(s) { console.log('[debug] ' + s); },
  showToast() {},
  showModal(o) { if (o.success) o.success({ confirm: true }); },
  setClipboardData(o) { if (o.success) o.success({}); },
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : ''; },
  setStorageSync(k, v) { storage.set(k, v); },
  getSystemInfoSync() { return { theme: 'light' }; },
  redirectTo(o) { currentPage = o.url.split('/')[2]; }
};
global.getApp = function () { return appObj; };
global.App = function (o) { appObj = o; };
// 页面按 require 顺序注册：index → deploy → battle
let pageSeq = 0;
const PAGE_ORDER = ['index', 'deploy', 'battle'];
global.Page = function (o) { pageDefs[PAGE_ORDER[pageSeq++]] = o; };

// ---------- 加载小程序端真实代码（先 mock 全局，再 require） ----------
require('../miniprogram/app.js');
require('../miniprogram/pages/index/index.js');
require('../miniprogram/pages/deploy/deploy.js');
require('../miniprogram/pages/battle/battle.js');
const app = appObj;
const state = app.globalData.state;
app.globalData.socket.on('error', function (d) { console.log('[test] 服务器错误: ' + (d && d.message)); });

// 页面实例工厂：真实的 Page 定义 + 模拟的 data / setData
function makePage(name) {
  const def = pageDefs[name];
  if (!def) throw new Error('没有这个页面: ' + name);
  const inst = Object.assign({}, def);
  inst.data = JSON.parse(JSON.stringify(def.data || {}));
  inst.setData = function (updates) { Object.assign(this.data, updates); };
  return inst;
}

// 网页端客户端（对家）
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

// ---------- 测试小工具 ----------
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitUntil(fn, timeoutMs, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 5000)) {
    if (fn()) return true;
    await sleep(20);
  }
  throw new Error('等待超时: ' + (desc || fn.toString()));
}
function randomDeployment() {
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < shared.PLANE_COUNT; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * shared.BOARD_SIZE);
    const headCol = Math.floor(Math.random() * shared.BOARD_SIZE);
    const occupied = [];
    planes.forEach(function (p) {
      shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (c) { occupied.push(c); });
    });
    if (shared.canPlacePlane(occupied, headRow, headCol, dir)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes.length === shared.PLANE_COUNT ? planes : null;
}
// 挑一个还没揭示过的格子
function pickUnknown(received) {
  const seen = new Set(received.map(function (x) { return x.row + ',' + x.col; }));
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (!seen.has(r + ',' + c)) return [r, c];
    }
  }
  return [0, 0];
}

async function main() {
  const index = makePage('index');
  const deploy = makePage('deploy');
  const battle = makePage('battle');

  // 0. 启动校验
  app.onLaunch();
  await waitUntil(function () { return app.globalData.socket.connected; }, 5000, '小程序 socket 连接');
  console.log('— 首页 —');

  index.onLoad({});
  index.onShow();
  check('首页渲染出 4 张飞机朝向图（各 25 格）',
    index.data.diagrams.length === 4 && index.data.diagrams.every(function (d) { return d.cells.length === 25; }));
  index.onNameInput({ detail: { value: '小程序玩家' } });
  check('昵称写入本地存储', storage.get('bp_name') === '小程序玩家');

  // 1. 小程序创建房间 → 自动进部署页
  index.onCreateTap();
  await waitUntil(function () { return state.roomId && currentPage === 'deploy'; }, 5000, '创建房间并进入部署页');
  check('创建房间成功并进入部署页（房间号: ' + state.roomId + '）', /^[A-Z0-9]{4}$/.test(state.roomId));
  check('房主是 0 号玩家', state.seat === 0 && !state.spectator);

  deploy.onLoad();
  deploy.onShow();
  check('部署页渲染出 100 格棋盘', deploy.data.cells.length === 100);
  check('初始计数 0 / 3', deploy.data.countText.indexOf('0 / 3') !== -1);

  // 2. 部署交互（本地草稿操作，不涉及服务器）：
  //    点放一架 → 点机身旋转 → 点机头移除 → 随机布局 → 清空
  //    注意：服务器要求先有第二人加入才能确认部署（真人房间建好后是
  //    waiting 阶段，第二人加入才进入 deploy 阶段），所以确认放到第 3 步。
  //    旋转测试用棋盘中心 (4,4)：4 个方向旋转都不会越界
  deploy.onCellTap({ currentTarget: { dataset: { r: 4, c: 4 } } });
  check('点空格放置 1 架（1 / 3）', state.draft.length === 1 && deploy.data.countText.indexOf('1 / 3') !== -1);
  const first = state.draft[0];
  const dirBefore = first.dir;
  const bodyCell = shared.getPlaneCells(first.headRow, first.headCol, first.dir)[5];
  deploy.onCellTap({ currentTarget: { dataset: { r: bodyCell[0], c: bodyCell[1] } } });
  check('点机身旋转 1 次（上→右）', state.draft[0].dir !== dirBefore);
  deploy.onCellTap({ currentTarget: { dataset: { r: first.headRow, c: first.headCol } } });
  check('点机头移除该架（0 / 3）', state.draft.length === 0);
  deploy.onRandomTap();
  check('随机布局放满 3 架且合法', state.draft.length === 3 && shared.validateDeployment(state.draft) === null);
  deploy.onClearTap();
  check('清空后 0 / 3', state.draft.length === 0);
  deploy.onRandomTap();

  // 3. 网页端先加入（房间切到部署阶段），随后跨端各自确认部署
  console.log('— 跨端对战 —');
  const W = new WSClient('http://localhost:3000');
  await waitUntil(function () { return W.connected; }, 5000, '网页端连接');
  W.emit('joinRoom', { roomId: state.roomId, name: '网页玩家' });
  await waitUntil(function () { return state.names[1] === '网页玩家'; }, 5000, '网页端加入');
  check('网页端加入后昵称同步', state.names[1] === '网页玩家');
  check('部署页显示对方信息', deploy.data.oppName === '网页玩家' && deploy.data.hasOpp);

  // 小程序确认部署（取消确认再确认，各走一遍）
  deploy.onConfirmTap();
  await waitUntil(function () { return state.deployConfirmed[0]; }, 5000, '部署已确认');
  check('确认部署后按钮变为「取消确认」', deploy.data.showUnconfirm === true);
  deploy.onUnconfirmTap();
  await waitUntil(function () { return !state.deployConfirmed[0]; }, 5000, '取消确认');
  check('取消确认生效', state.deployConfirmed[0] === false);
  deploy.onConfirmTap();
  await waitUntil(function () { return state.deployConfirmed[0]; }, 5000, '再次确认');

  // 网页端部署并确认
  W.emit('deployConfirm', { planes: randomDeployment() });
  await waitUntil(function () { return state.phase === 'battle'; }, 5000, '双方就绪开战');
  check('开战后自动进入对战页', currentPage === 'battle' && state.phase === 'battle');

  battle.onLoad();
  battle.onShow();
  check('对战页渲染 200 格双棋盘', battle.data.myCells.length === 100 && battle.data.enemyCells.length === 100);
  check('己方面板显示昵称', battle.data.myName.indexOf('小程序玩家') !== -1);

  // 5. 打完整局：小程序端走页面真实点击路径，网页端直接 emit
  console.log('— 对局进行中 —');
  const webMarks = [];   // 网页端被打过的位置（含结果）
  let miniReveals = 0, webReveals = 0;
  W.on('revealResult', function (d) {
    if (d.attacker === 1) { webMarks.push({ row: d.row, col: d.col, result: d.result }); webReveals++; }
  });
  app.globalData.socket.on('revealResult', function (d) {
    if (d.attacker === 0) miniReveals++;
  });

  let guard = 0;
  while (!state.over && guard++ < 400) {
    if (state.steps[0] <= state.steps[1]) {
      // 小程序行动：选一个没打过的格子，走页面真实点击路径
      const cell = pickUnknown(state.enemyShotsReceived);
      const before = state.enemyShotsReceived.length;
      battle.onEnemyCellTap({ currentTarget: { dataset: { r: cell[0], c: cell[1] } } });
      try {
        await waitUntil(function () { return state.enemyShotsReceived.length > before || state.over; }, 3000, '小程序揭示结果');
      } catch (e) { /* 抢步被拒等偶发：下轮重试 */ }
    } else {
      // 网页行动
      const cell = pickUnknown(webMarks);
      const before = webMarks.length;
      W.emit('reveal', { row: cell[0], col: cell[1] });
      try {
        await waitUntil(function () { return webMarks.length > before || state.over; }, 3000, '网页揭示结果');
      } catch (e) { /* 同上 */ }
    }
    await sleep(20);
  }
  check('跨端对局分出胜负（' + state.steps[0] + ':' + state.steps[1] + ' 步）', state.over === true);
  check('双方都用页面/协议路径发出过揭示', miniReveals > 0 && webReveals > 0);

  // 6. 结束横幅 + 再来一局
  battle.render();
  check('结束横幅出现', battle.data.over === true && battle.data.overTitle.length > 0);
  check('双方飞机已公开（棋盘有飞机色）',
    battle.data.myCells.some(function (c) { return c.cls.indexOf('cell-head') !== -1; }));
  battle.onRematchTap();
  W.emit('rematch');
  await waitUntil(function () { return state.phase === 'deploy' && currentPage === 'deploy'; }, 5000, '再来一局进入部署');
  check('再来一局后回到部署页', state.phase === 'deploy');
  deploy.onShow();
  check('重开一局计数清零', deploy.data.countText.indexOf('0 / 3') !== -1);

  // 7. 断线重连（模拟网络断开：底层 socket 被关闭，客户端自动重连 + 自动 rejoin 恢复现场）
  console.log('— 断线重连 —');
  // 重连前先随机摆好 3 架（写入本地草稿），验证断线后草稿不丢
  deploy.onRandomTap();
  check('重连前草稿 3 架', state.draft.length === 3);
  const before = { roomId: state.roomId, phase: state.phase };
  app.globalData.socket._ws.close();
  await waitUntil(function () { return app.globalData.socket.connected; }, 8000, '自动重连成功');
  await waitUntil(function () { return state.roomId === before.roomId && state.phase === 'deploy'; }, 5000, '重连后自动恢复现场');
  check('重连后自动 rejoin 恢复现场（房间 ' + state.roomId + '）',
    state.roomId === before.roomId && state.phase === 'deploy');
  deploy.onShow();
  check('重连后本地草稿 3 架飞机不丢', state.draft.length === 3);

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  // 显式退出：自动重连定时器和 WebSocket 连接会让 Node 进程一直挂着
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.log('✗ 测试中断: ' + e.message);
  process.exit(1);
});
