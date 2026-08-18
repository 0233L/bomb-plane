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
  mode: 'classic',          // 当前房间玩法：classic（经典）| props（道具版）
  boardSize: 'S',           // 当前房间地图规格：S=10×10/3架 | M=12×12/4架 | L=14×14/6架
  coins: [0, 0],            // 双方金币（道具版；经典版为 0）
  steps: [0, 0],
  score: [0, 0],
  headsLeft: [3, 3],
  sonarResults: [],         // 声呐脉冲的历史结果 [{row, col, count}]（扫雷式推理用）
  frozenCells: [],          // 毁灭菇冻结的格子 [{row, col, owner, expiry}]（只约束施放者自己，渲染 ❄）
  marks: {},                // 注释标记 {'r,c': 'body'}（长按标注机身，仅本机可见，按房间持久化）
  itemPick: null,           // 道具选区模式：null = 未选择 | {itemId}
  pickCells: [],            // 已固定的选区格子（'r,c' 字符串数组，金色高亮）
  pickAnchor: null,         // 3x3 道具的选区锚点（左上角，发给服务器）
  pickReady: false,         // 选区是否已完整（完整后显示「确认使用」按钮）
  pickFirstKey: null,       // 3×3 道具第一击的定位格（'r,c'；重复点击它 = 确认，不是锚点）
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
  phase: '',           // 服务器当前阶段（deploy/battle/over/waiting），导航和渲染用
  totalVisitors: 0     // 首页底部「已有 X 位玩家访问过」（服务端 visitResult 回报）
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
// 注释标记按房间持久化：进房 / 重连恢复，对局结束清除
function loadMarks() {
  const saved = loadStorage('bp_marks_' + (state.roomId || ''), null);
  state.marks = (saved && typeof saved === 'object') ? saved : {};
}
function clearMarks() {
  state.marks = {};
  saveStorage('bp_marks_' + (state.roomId || ''), {});
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

// ---------- 匿名访客 ID（访客统计用，不存任何个人信息） ----------
// 首次访问生成一次，之后一直复用；清掉小程序存储 = 算一个新访客（可接受）
function getVisitorId() {
  let id = loadStorage('bp_visitor_id', '');
  if (id) return id;
  id = 'v' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  saveStorage('bp_visitor_id', id);
  return id;
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

// 部署页棋盘：size×size 格 -> [{r, c, cls}]（规格跟随当前房间，10/12/14）
function deployCells() {
  const size = shared.getBoardSpec(state.boardSize).size;
  const cellType = {};
  state.draft.forEach(function (p) {
    shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell, i) {
      cellType[cell[0] + ',' + cell[1]] = (i === 0) ? 'head' : 'body';
    });
  });
  const outlines = outlineClassesFor(state.draft);
  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
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

// 冻结判断：该格是否正被毁灭菇冻结（只约束施放者本人，steps 超过 expiry 后解除）
function isFrozen(r, c) {
  return state.frozenCells.some(function (f) {
    return f.row === r && f.col === c && f.owner === state.seat && state.steps[state.seat] < f.expiry;
  });
}

// 对战页己方棋盘：自己的飞机（对战阶段不画轮廓）+ 对方打过的位置高亮
function myBoardCells() {
  const size = shared.getBoardSpec(state.boardSize).size;
  const revealed = state.over ? state.revealedPlanes : null;
  const myPlanesSrc = (state.spectator && revealed) ? (revealed[0] || []) : state.myPlanes;
  const myBoard = shared.buildBoard(myPlanesSrc, state.boardSize);
  const myMarks = {};
  state.myShotsReceived.forEach(function (s) { myMarks[s.row + ',' + s.col] = s.result; });
  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let cls = '';
      const cell = myBoard[r][c];
      if (cell === shared.CELL_HEAD) cls = 'cell-head';
      else if (cell === shared.CELL_BODY) cls = 'cell-body';
      if (!myMarks[r + ',' + c]) cls += ' dimmed';
      cells.push({ r: r, c: c, cls: cls, text: '' });
    }
  }
  return cells;
}

// 对战页对方棋盘：未知格 + 已揭示结果；对局结束后暗色公开真实飞机
function enemyBoardCells() {
  const size = shared.getBoardSpec(state.boardSize).size;
  const revealed = state.over ? state.revealedPlanes : null;
  const enemySeat = state.spectator ? 1 : (1 - state.seat);
  const enemyPlanes = revealed ? (revealed[enemySeat] || []) : [];
  const enemyBoard = shared.buildBoard(enemyPlanes, state.boardSize);
  // 注意：记录存整个对象（destroyed: true 的机头也是 head 结果，要区分渲染）
  const enemyMarks = {};
  state.enemyShotsReceived.forEach(function (s) { enemyMarks[s.row + ',' + s.col] = s; });
  // 声呐数字：显示在 3x3 区域的正中心格（扫雷式推理用）；
  // 区域外圈再画金色细边框，一眼看清这次声呐探测的范围（多个区域可叠加）
  const sonarMap = {};
  state.sonarResults.forEach(function (sr) { sonarMap[(sr.row + 1) + ',' + (sr.col + 1)] = sr.count; });
  const sonarShadows = {}; // 'r,c' -> box-shadow 字符串
  state.sonarResults.forEach(function (sr) {
    const r0 = sr.row, c0 = sr.col;
    const addEdge = function (rr, cc, shadow) {
      const k = rr + ',' + cc;
      // 多个 box-shadow 之间用逗号分隔（角落格会有两条边叠加）；
      // shadow 传 h v 两个偏移量，拼接成「h v blur spread color」4 个长度值——语法必须合法
      sonarShadows[k] = (sonarShadows[k] ? sonarShadows[k] + ',inset ' : 'inset ') + shadow + ' 0 0 #f6c945';
    };
    // 注意：inset 阴影的可见区是「元素盒 − 偏移后的阴影盒」——偏移 -3rpx 的可见条带在元素
    // 的相反侧。所以上边行要向下偏移（0 3rpx 画顶部）、下边行要向上偏移（0 -3rpx 画底部）
    for (let c = c0; c <= c0 + 2; c++) { addEdge(r0, c, '0 3rpx'); addEdge(r0 + 2, c, '0 -3rpx'); } // 上下边
    for (let r = r0; r <= r0 + 2; r++) { addEdge(r, c0, '3rpx 0'); addEdge(r, c0 + 2, '-3rpx 0'); } // 左右边
  });
  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let cls = '';
      let text = '';
      const s = enemyMarks[r + ',' + c];
      if (revealed && s && (s.result === 'destroyed' || s.destroyed)) {
        // 对局结束：被摧毁格子的真实内容公开（暗色显示，和没探测过的格子一致）
        const cell = enemyBoard[r][c];
        if (cell === shared.CELL_HEAD) cls = 'cell-head';
        else if (cell === shared.CELL_BODY) cls = 'cell-body';
        else cls = 'cell-empty';
        cls += ' dimmed';
      } else if (s && s.result === 'destroyed') {
        cls = 'cell-destroyed'; // 吞噬者摧毁的格子：深灰 + ✕（内容保密）
        text = '✕';
      } else if (s && s.result === 'head' && s.destroyed) {
        cls = 'cell-head-destroyed'; // 机头被摧毁：灰色机头（视为已发现）
        text = '✕';
      } else if (s && s.result === 'empty') cls = 'cell-empty';
      else if (s && s.result === 'body') cls = 'cell-body';
      else if (s && s.result === 'head') cls = 'cell-head';
      else if (isFrozen(r, c)) {
        // 毁灭菇冻结的格子：暗色 + 紫色 ❄（冻结期间不可揭示、不可被技能选中）
        cls = 'cell-unknown cell-frozen';
        text = '❄';
      } else if (revealed) {
        const cell = enemyBoard[r][c];
        if (cell === shared.CELL_HEAD) cls = 'cell-head';
        else if (cell === shared.CELL_BODY) cls = 'cell-body';
        else cls = 'cell-unknown';
        cls += ' dimmed';
      } else {
        cls = 'cell-unknown';
      }
      // 声呐数字（在已揭示格上也能显示；冻结格不显示——冻结期间声呐也不能探测）
      const count = sonarMap[r + ',' + c];
      if (count !== undefined && !isFrozen(r, c)) {
        text = String(count);
      }
      // 注释标记：长按在未揭示格上标的「机身」（绿框；中间仍是暗色；
      // 格子被揭示后自动不显示——注释只是本地猜测，揭示即作废；观战者不显示）
      if (!s && !state.spectator && !revealed && state.marks[r + ',' + c]) {
        cls += ' cell-mark-' + state.marks[r + ',' + c];
      }
      // 道具选区高亮（battle 页选区交互时设置 state.pickCells）；
      // 毁灭菇选区画「3×3 完整外圈方框」（和声呐外圈框同款差集模型——inset 阴影可见区
      // 在偏移相反侧）：外圈 12 条边围成完整方框，中心格加内缩 2rpx 小框标记定位格
      const isDoomPick = state.itemPick && state.itemPick.itemId === 'doom';
      let doomShadow = '';
      if (isDoomPick && state.pickCells.length) {
        const center = state.pickCells[0].split(',');
        const cr = +center[0], cc = +center[1];
        if (r === cr && c === cc) doomShadow = 'inset 0 0 0 2rpx #f59e0b';              // 中心：定位标记
        else if (r === cr - 1) doomShadow = 'inset 0 3rpx 0 0 #f59e0b';                 // 顶边
        else if (r === cr + 1) doomShadow = 'inset 0 -3rpx 0 0 #f59e0b';                // 底边
        else if (c === cc - 1) doomShadow = 'inset 3rpx 0 0 0 #f59e0b';                 // 左边
        else if (c === cc + 1) doomShadow = 'inset -3rpx 0 0 0 #f59e0b';                // 右边
      }
      if (state.pickCells.indexOf(r + ',' + c) !== -1 && !isDoomPick) cls += ' cell-pick';
      // 声呐区域外圈 / 毁灭菇十字轮廓：内联样式，多个效果叠加不冲突
      let boxShadow = sonarShadows[r + ',' + c];
      if (doomShadow) boxShadow = boxShadow ? boxShadow + ',' + doomShadow : doomShadow;
      cells.push({ r: r, c: c, cls: cls, text: text, style: boxShadow ? 'box-shadow:' + boxShadow : '' });
    }
  }
  return cells;
}

// ---------- Socket 事件绑定（对齐网页版 client.js 的 bindSocketEvents） ----------
const socket = new WSClient(SERVER_URL);

socket.on('connect', function () {
  socket.emit('visit', { visitorId: getVisitorId(), platform: 'mini' }); // 访客统计：每次连上服务器上报一次
  // 断线重连成功：如果之前正处在某个房间里（有 roomId + token），自动恢复现场
  if (state.roomId && state.token) {
    socket.emit('rejoin', { token: state.token, roomId: state.roomId });
  }
});

// 访客统计：服务器回报当前唯一访客总数，首页订阅后实时更新
socket.on('visitResult', function (d) {
  state.totalVisitors = d.total || 0;
  emitLocal('visitResult', d);
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
  state.mode = d.mode || 'classic';
  state.boardSize = d.boardSize || 'S';
  state.coins = d.coins || [0, 0];
  state.steps = d.steps;
  state.score = d.score;
  state.headsLeft = d.headsLeft;
  state.winner = d.winner;
  state.winReason = d.winReason;
  state.rematchVotes = [false, false];
  state.myShotsReceived = d.shots[0] || [];
  state.enemyShotsReceived = d.shots[1] || [];
  state.sonarResults = d.sonarHistory || [];
  state.frozenCells = d.frozenCells || [];
  state.itemPick = null;
  state.pickCells = [];
  state.pickAnchor = null;
  state.pickReady = false;
  state.pickFirstKey = null;
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
  state.mode = d.mode || 'classic';
  state.boardSize = d.boardSize || 'S';
  state.coins = d.coins || [0, 0];
  state.headsLeft = [PLANE_COUNT, PLANE_COUNT];
  state.myShotsReceived = [];
  state.enemyShotsReceived = [];
  state.sonarResults = [];
  state.frozenCells = [];
  loadMarks(); // 注释标记按房间持久化：进房后恢复
  state.itemPick = null;
  state.pickCells = [];
  state.pickAnchor = null;
  state.pickReady = false;
  state.pickFirstKey = null;
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
  state.coins = d.coins || state.coins; // 道具版：金币随时同步
  emitLocal('revealResult', d);
});

// 道具结果：声呐数字 / 吞噬摧毁 / 无所遁形整机揭示
// （探测者 和双发连射走上面的 revealResult，不在这里）
socket.on('itemResult', function (d) {
  if (d.attacker === state.seat) {
    // 自己用的道具：结果已出，选区模式结束
    state.itemPick = null;
    state.pickCells = [];
    state.pickAnchor = null;
    state.pickReady = false;
    if (d.itemId === 'devour' && d.headHit) {
      wx.showToast({ title: '吞噬者命中机头！🎯 你找到了一架飞机', icon: 'none' });
    }
    if (d.itemId === 'sonar') {
      wx.showToast({ title: '声呐：区域内有 ' + d.count + ' 个非空格', icon: 'none' });
    }
  }
  if (d.itemId === 'sonar') {
    // 声呐数字：记入历史（锚点格上显示数字，扫雷式推理用）
    state.sonarResults.push({ row: d.row, col: d.col, count: d.count });
  } else if (d.itemId === 'devour') {
    // 吞噬者：被摧毁的格子记入「已揭示」记录（灰色渲染；机头格单独记为灰色机头）
    (d.destroyed || []).forEach(function (cell) {
      if (d.headHit && cell[0] === d.headHit[0] && cell[1] === d.headHit[1]) return; // 机头格单独处理
      if (state.enemyShotsReceived.some(function (s) { return s.row === cell[0] && s.col === cell[1]; })) return;
      state.enemyShotsReceived.push({ row: cell[0], col: cell[1], result: 'destroyed' });
    });
    if (d.headHit && !state.enemyShotsReceived.some(function (s) { return s.row === d.headHit[0] && s.col === d.headHit[1]; })) {
      state.enemyShotsReceived.push({ row: d.headHit[0], col: d.headHit[1], result: 'head', destroyed: true });
    }
  } else if (d.itemId === 'expose') {
    // 无所遁形：整架飞机的 10 格补全揭示（都是机身，机头已揭示过）
    (d.cells || []).forEach(function (cell) {
      if (state.enemyShotsReceived.some(function (s) { return s.row === cell[0] && s.col === cell[1]; })) return;
      state.enemyShotsReceived.push({ row: cell[0], col: cell[1], result: 'body' });
    });
  } else if (d.itemId === 'doom') {
    // 毁灭菇：十字 5 格揭示 + 相邻未揭示格冻结（记录完整冻结信息，过期由 isFrozen 判断）
    (d.cells || []).forEach(function (cell) {
      if (state.enemyShotsReceived.some(function (s) { return s.row === cell.row && s.col === cell.col; })) return;
      state.enemyShotsReceived.push({ row: cell.row, col: cell.col, result: cell.result });
    });
    state.frozenCells = state.frozenCells.concat(d.frozen || []);
  }
  state.headsLeft = d.headsLeft;
  state.steps = d.steps;
  state.coins = d.coins || state.coins; // 道具版：金币随时同步
  emitLocal('itemResult', d);
});

socket.on('gameOver', function (d) {
  state.winner = d.winner;
  state.winReason = d.winReason;
  state.headsLeft = d.headsLeft;
  state.score = d.score;
  state.rematchVotes = [false, false];
  state.revealedPlanes = d.planes || null;
  state.frozenCells = []; // 冻结随对局结束解除（服务器端 activeFrozenCells 也已置空）
  clearMarks(); // 对局结束飞机全部公开，注释不再有意义；下一局从空注释开始
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
  state.coins = [0, 0]; // 金币在下一局 battleStart 时由服务器下发
  state.sonarResults = [];
  state.frozenCells = [];
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
  state.mode = d.mode || 'classic';
  state.boardSize = d.boardSize || 'S';
  state.coins = d.coins || [0, 0];
  state.steps = d.steps;
  state.score = d.score;
  state.headsLeft = d.headsLeft;
  state.deployConfirmed = d.deployConfirmed;
  state.myPlanes = d.myPlanes || [];
  state.myShotsReceived = d.myShotsReceived || [];
  state.enemyShotsReceived = d.enemyShotsReceived || [];
  state.sonarResults = d.sonarHistory || [];
  state.frozenCells = d.frozenCells || [];
  loadMarks(); // 重连后从本地恢复注释标记
  state.itemPick = null;
  state.pickCells = [];
  state.pickAnchor = null;
  state.pickReady = false;
  state.pickFirstKey = null;
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
  isFrozen: isFrozen,
  shared: shared,
  PLANE_COUNT: PLANE_COUNT
});
