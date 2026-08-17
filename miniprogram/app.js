// ============================================
// app.js —— 小程序全局：状态 + 网络连接 + 事件分发 + 导航
// 结构对齐网页版 public/client.js 的 bindSocketEvents：
// 服务器发来的每个事件 → 更新 state → 通知页面重新渲染。
// 页面只做两件事：渲染 state、把用户操作 emit 给服务器。
// ============================================
'use strict';

const shared = require('./utils/shared.js');
const WSClient = require('./utils/ws.js');

// 服务器地址：
//  - 开发者工具：ws://localhost:3000/ws（记得勾选「不校验合法域名」）
//  - 真机预览：改成电脑的局域网 IP，如 ws://192.168.1.100:3000/ws
//  - 正式体验版/上线：需要 wss 合法域名（见 README「正式上架门槛」）
const SERVER_URL = 'ws://localhost:3000/ws';

const PLANE_COUNT = shared.PLANE_COUNT;

// ---------- 全局状态（字段与网页版 client.js 的 state 一致） ----------
const state = {
  token: null, roomId: null, seat: null, name: '',
  names: ['', ''],
  online: [false, false],
  steps: [0, 0],
  score: [0, 0],
  headsLeft: [3, 3],
  deployConfirmed: [false, false],
  myPlanes: [],
  myShotsReceived: [],
  enemyShotsReceived: [],
  winner: null, winReason: null,
  rematchVotes: [false, false],
  curDir: 'up',
  draft: [],
  spectator: false,
  spectatorCount: 0,
  ai: false,
  over: false,
  revealedPlanes: null,
  phase: ''           // 服务器当前阶段（deploy/battle/over/waiting），导航和渲染用
};

// ---------- 本地事件总线：app.on(事件, 回调)，页面订阅用 ----------
const listeners = new Map();
function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(cb);
}
function off(event, cb) {
  const list = listeners.get(event);
  if (!list) return;
  const idx = list.indexOf(cb);
  if (idx !== -1) list.splice(idx, 1);
}
function emitLocal(event, data) {
  const list = listeners.get(event);
  if (!list) return;
  list.slice().forEach(function (cb) {
    try { cb(data); } catch (e) { /* 单个回调出错不影响其它回调 */ }
  });
}

// ---------- 本地存储（对应网页的 localStorage） ----------
function loadStorage(key, fallback) {
  try { return wx.getStorageSync(key) || fallback; } catch (e) { return fallback; }
}
function saveStorage(key, value) {
  try { wx.setStorageSync(key, value); } catch (e) { /* 忽略 */ }
}
function loadRoomHistory() {
  const list = loadStorage('bp_room_history', []);
  return Array.isArray(list) ? list : [];
}
function sortAndSaveHistory(list) {
  list.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  saveStorage('bp_room_history', list.slice(0, 5));
  return list;
}
function saveRoomToHistory(roomId, token, name) {
  sortAndSaveHistory(
    loadRoomHistory().filter(function (e) { return e.roomId !== roomId; })
      .concat([{ roomId: roomId, token: token, name: name, lastSeen: Date.now() }])
  );
}
function removeRoomFromHistory(roomId) {
  saveStorage('bp_room_history',
    loadRoomHistory().filter(function (e) { return e.roomId !== roomId; }));
}

// ---------- 主题（跟随系统 / 浅色 / 深色，对应网页右上角按钮） ----------
const THEME_ORDER = ['auto', 'light', 'dark'];
let theme = loadStorage('bp_theme', 'auto');
let themeClass = 'theme-light';

function resolvedTheme() {
  if (theme === 'auto') {
    // 跟随系统：小程序取系统的深浅色
    const sys = wx.getSystemInfoSync().theme;
    return sys === 'dark' ? 'dark' : 'light';
  }
  return theme;
}
function applyTheme() {
  themeClass = 'theme-' + resolvedTheme();
  emitLocal('theme', { themeClass: themeClass });
}
function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  theme = next;
  saveStorage('bp_theme', next);
  applyTheme();
}

// ---------- 页面导航（只在页面不同时才跳转，避免死循环） ----------
let currentPage = 'index';
function navTo(page) {
  if (currentPage === page) return;
  currentPage = page;
  wx.redirectTo({ url: '/pages/' + page + '/' + page });
}

// ---------- 棋盘渲染辅助：由 state 算出每个格子的样式类 ----------
// （逻辑照搬网页版 renderDeployBoard / renderBattleBoards，只是把 DOM 操作
//   换成返回数组，交给 WXML 渲染）

// 给若干飞机计算轮廓：返回 map（'r,c' -> 'edge-t edge-l …'）
function outlineClassesFor(planes) {
  const sets = planes.map(function (p) {
    const set = new Set();
    shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      set.add(cell[0] + ',' + cell[1]);
    });
    return set;
  });
  const result = {};
  planes.forEach(function (p, pi) {
    shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      const r = cell[0], c = cell[1];
      const set = sets[pi];
      const classes = [];
      // 四个方向：邻居不在同一架飞机里，就说明这条边是外边缘
      if (!set.has((r - 1) + ',' + c)) classes.push('edge-t');
      if (!set.has((r + 1) + ',' + c)) classes.push('edge-b');
      if (!set.has(r + ',' + (c - 1))) classes.push('edge-l');
      if (!set.has(r + ',' + (c + 1))) classes.push('edge-r');
      result[r + ',' + c] = classes.join(' ');
    });
  });
  return result;
}

// 部署页棋盘：100 格 -> [{r, c, cls}]
function deployCells() {
  const cellType = {};
  state.draft.forEach(function (p) {
    shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell, i) {
      cellType[cell[0] + ',' + cell[1]] = (i === 0) ? 'head' : 'body';
    });
  });
  const outlines = outlineClassesFor(state.draft);
  const cells = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const key = r + ',' + c;
      cells.push({
        r: r, c: c,
        cls: (cellType[key] ? 'cell-' + cellType[key] : '') +
          (outlines[key] ? ' ' + outlines[key] : '')
      });
    }
  }
  return cells;
}

// 对战页己方棋盘：自己的飞机（对战阶段不画轮廓）+ 对方打过的位置高亮
function myBoardCells() {
  const revealed = state.over ? state.revealedPlanes : null;
  const myPlanesSrc = (state.spectator && revealed) ? (revealed[0] || []) : state.myPlanes;
  const myBoard = shared.buildBoard(myPlanesSrc);
  const myMarks = {};
  state.myShotsReceived.forEach(function (s) { myMarks[s.row + ',' + s.col] = s.result; });
  const cells = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      let cls = '';
      const cell = myBoard[r][c];
      if (cell === shared.CELL_HEAD) cls = 'cell-head';
      else if (cell === shared.CELL_BODY) cls = 'cell-body';
      if (!myMarks[r + ',' + c]) cls += ' dimmed';
      cells.push({ r: r, c: c, cls: cls });
    }
  }
  return cells;
}

// 对战页对方棋盘：未知格 + 已揭示结果；对局结束后暗色公开真实飞机
function enemyBoardCells() {
  const revealed = state.over ? state.revealedPlanes : null;
  const enemySeat = state.spectator ? 1 : (1 - state.seat);
  const enemyPlanes = revealed ? (revealed[enemySeat] || []) : [];
  const enemyBoard = shared.buildBoard(enemyPlanes);
  const enemyMarks = {};
  state.enemyShotsReceived.forEach(function (s) { enemyMarks[s.row + ',' + s.col] = s.result; });
  const cells = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      let cls = '';
      const res = enemyMarks[r + ',' + c];
      if (res === 'empty') cls = 'cell-empty';
      else if (res === 'body') cls = 'cell-body';
      else if (res === 'head') cls = 'cell-head';
      else if (revealed) {
        const cell = enemyBoard[r][c];
        if (cell === shared.CELL_HEAD) cls = 'cell-head';
        else if (cell === shared.CELL_BODY) cls = 'cell-body';
        else cls = 'cell-unknown';
        cls += ' dimmed';
      } else {
        cls = 'cell-unknown';
      }
      cells.push({ r: r, c: c, cls: cls });
    }
  }
  return cells;
}

// ---------- Socket 事件绑定（对齐网页版 client.js 的 bindSocketEvents） ----------
const socket = new WSClient(SERVER_URL);

socket.on('connect', function () {
  // 断线重连成功：如果之前正处在某个房间里（有 roomId + token），自动恢复现场
  if (state.roomId && state.token) {
    socket.emit('rejoin', { token: state.token, roomId: state.roomId });
  }
});
socket.on('disconnect', function () {
  wx.showToast({ title: '连接断开，正在重连…', icon: 'none' });
});

socket.on('error', function (d) {
  wx.showToast({ title: d.message || '出错了', icon: 'none' });
});

socket.on('roomCreated', function (d) {
  state.token = d.token;
  state.roomId = d.roomId;
  saveRoomToHistory(d.roomId, d.token, d.name);
  state.seat = 0;
  state.name = d.name;
  state.names = d.names;
  state.online = d.online;
  state.myPlanes = [];
  state.deployConfirmed = d.deployConfirmed || [false, false];
  state.spectator = false;
  state.ai = !!d.isAI;
  state.phase = 'deploy';
  saveStorage('bp_draft', []);
  emitLocal('roomCreated', d);
  navTo('deploy');
});

socket.on('joinedRoom', function (d) {
  state.token = d.token;
  state.roomId = d.roomId;
  saveRoomToHistory(d.roomId, d.token, d.name);
  state.seat = 1;
  state.name = d.name;
  state.names = d.names;
  state.online = d.online;
  state.myPlanes = [];
  state.deployConfirmed = [false, false];
  state.spectator = false;
  state.ai = false;
  state.phase = 'deploy';
  saveStorage('bp_draft', []);
  emitLocal('joinedRoom', d);
  navTo('deploy');
});

socket.on('spectatorJoined', function (d) {
  state.spectator = true;
  state.roomId = d.roomId;
  state.seat = 0; // 借用 1 号玩家的视角：左 = 房主，右 = 2 号玩家
  state.names = d.names;
  state.online = d.online;
  state.steps = d.steps;
  state.score = d.score;
  state.headsLeft = d.headsLeft;
  state.winner = d.winner;
  state.winReason = d.winReason;
  state.rematchVotes = [false, false];
  state.myShotsReceived = d.shots[0] || [];
  state.enemyShotsReceived = d.shots[1] || [];
  state.revealedPlanes = d.planes || null;
  state.phase = d.phase;
  emitLocal('spectatorJoined', d);
  navTo('battle'); // 等待页/对战页/结束页都在 battle 页里按 phase 显示
});

socket.on('spectatorCount', function (d) {
  state.spectatorCount = d.count;
  emitLocal('spectatorCount', d);
});

socket.on('roomClosed', function (d) {
  wx.showToast({ title: d.message || '房间已回收', icon: 'none' });
  state.roomId = null;
  state.spectator = false;
  emitLocal('roomClosed', d);
  navTo('index');
});

socket.on('opponentJoined', function (d) {
  state.names = d.names;
  emitLocal('opponentJoined', d);
});

socket.on('deployReady', function (d) {
  state.deployConfirmed = d.confirmed;
  if (d.confirmed[state.seat]) {
    state.myPlanes = state.draft.map(function (p) {
      return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
    });
  }
  emitLocal('deployReady', d);
});

socket.on('battleStart', function (d) {
  state.names = d.names;
  state.steps = d.steps;
  state.score = d.score;
  state.online = d.online;
  state.headsLeft = [PLANE_COUNT, PLANE_COUNT];
  state.myShotsReceived = [];
  state.enemyShotsReceived = [];
  state.revealedPlanes = null;
  state.over = false;
  state.phase = 'battle';
  emitLocal('battleStart', d);
  navTo('battle');
});

socket.on('revealResult', function (d) {
  if (d.attacker === state.seat) {
    state.enemyShotsReceived.push({ row: d.row, col: d.col, result: d.result });
  } else {
    state.myShotsReceived.push({ row: d.row, col: d.col, result: d.result });
  }
  state.headsLeft = d.headsLeft;
  state.steps = d.steps;
  emitLocal('revealResult', d);
});

socket.on('gameOver', function (d) {
  state.winner = d.winner;
  state.winReason = d.winReason;
  state.headsLeft = d.headsLeft;
  state.score = d.score;
  state.rematchVotes = [false, false];
  state.revealedPlanes = d.planes || null;
  state.over = true;
  state.phase = 'over';
  emitLocal('gameOver', d);
});

socket.on('playerStatus', function (d) {
  state.online[d.seat] = d.connected;
  emitLocal('playerStatus', d);
});

socket.on('rematchVote', function (d) {
  state.rematchVotes = d.votes;
  emitLocal('rematchVote', d);
});

socket.on('rematchStart', function (d) {
  state.names = d.names;
  state.steps = [0, 0];
  state.headsLeft = [PLANE_COUNT, PLANE_COUNT];
  state.myPlanes = [];
  state.myShotsReceived = [];
  state.enemyShotsReceived = [];
  state.winner = null;
  state.winReason = null;
  state.over = false;
  state.revealedPlanes = null;
  state.deployConfirmed = [false, false];
  state.phase = 'deploy';
  emitLocal('rematchStart', d);
  if (state.spectator) {
    state.phase = 'waiting';
    navTo('battle'); // 观战者不参与部署，回等待页
  } else {
    saveStorage('bp_draft', []);
    navTo('deploy');
  }
});

socket.on('leftRoom', function () {
  saveStorage('bp_draft', []);
  state.spectator = false;
  state.spectatorCount = 0;
  state.roomId = null;
  state.phase = '';
  emitLocal('leftRoom', {});
  navTo('index');
});

socket.on('rejoinFailed', function (d) {
  if (d.roomId) removeRoomFromHistory(d.roomId);
  wx.showToast({ title: d.message || '重连失败', icon: 'none' });
  state.roomId = null;
  emitLocal('rejoinFailed', d);
  navTo('index');
});

socket.on('roomsAlive', function (d) {
  const alive = d.alive || [];
  const list = loadRoomHistory();
  const kept = list.filter(function (e) { return alive.indexOf(e.roomId) !== -1; });
  if (kept.length !== list.length) {
    saveStorage('bp_room_history', kept);
  }
  emitLocal('roomsAlive', d);
});

socket.on('reconnected', function (d) {
  state.roomId = d.roomId;
  state.seat = d.seat;
  state.name = d.name;
  state.names = d.names;
  state.online = d.online;
  state.steps = d.steps;
  state.score = d.score;
  state.headsLeft = d.headsLeft;
  state.deployConfirmed = d.deployConfirmed;
  state.myPlanes = d.myPlanes || [];
  state.myShotsReceived = d.myShotsReceived || [];
  state.enemyShotsReceived = d.enemyShotsReceived || [];
  state.winner = d.winner;
  state.winReason = d.winReason;
  state.rematchVotes = d.rematchVotes || [false, false];
  state.ai = !!d.isAI;
  state.revealedPlanes = d.planes || null;
  state.over = d.phase === 'over';
  state.phase = d.phase;

  emitLocal('reconnected', d);
  if (d.phase === 'deploy') navTo('deploy');
  else if (d.phase === 'battle' || d.phase === 'over') navTo('battle');
});

// ---------- 游戏规则弹窗数据（和网页版 renderRulesDiagram 相同） ----------
function rulesDiagrams() {
  const dirs = [
    { dir: 'up',    headRow: 1, headCol: 2, label: '朝上' },
    { dir: 'right', headRow: 2, headCol: 3, label: '朝右' },
    { dir: 'down',  headRow: 3, headCol: 2, label: '朝下' },
    { dir: 'left',  headRow: 2, headCol: 1, label: '朝左' }
  ];
  return dirs.map(function (item) {
    const cellType = {};
    shared.getPlaneCells(item.headRow, item.headCol, item.dir).forEach(function (cell, i) {
      cellType[cell[0] + ',' + cell[1]] = (i === 0) ? 'head' : 'body';
    });
    const cells = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        cells.push({
          r: r, c: c,
          cls: cellType[r + ',' + c] ? 'cell-' + cellType[r + ',' + c] : ''
        });
      }
    }
    return { label: item.label, cells: cells };
  });
}

// ---------- App ----------
App({
  onLaunch: function () {
    // 检查本地「最近加入的房间」还有哪些活着，失效的自动删掉
    const history = loadRoomHistory();
    if (history.length) {
      socket.emit('checkRooms', { roomIds: history.map(function (e) { return e.roomId; }) });
    }
  },
  globalData: {
    state: state,
    themeClass: themeClass,
    socket: socket
  },
  on: on,
  off: off,
  emitLocal: emitLocal,
  navTo: navTo,
  cycleTheme: cycleTheme,
  applyTheme: applyTheme,
  getThemeClass: function () { return themeClass; },
  loadRoomHistory: loadRoomHistory,
  saveRoomToHistory: saveRoomToHistory,
  removeRoomFromHistory: removeRoomFromHistory,
  loadStorage: loadStorage,
  saveStorage: saveStorage,
  rulesDiagrams: rulesDiagrams,
  deployCells: deployCells,
  myBoardCells: myBoardCells,
  enemyBoardCells: enemyBoardCells,
  shared: shared,
  PLANE_COUNT: PLANE_COUNT
});
