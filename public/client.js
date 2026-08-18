// ============================================
// client.js —— 炸飞机前端逻辑
// 负责：连接服务器、切换页面、渲染棋盘、处理点击、断线恢复
// 依赖：shared.js 里的全局函数（getPlaneCells、canPlacePlane 等）
// ============================================
'use strict';

// ---------- 小工具 ----------
function $(sel) { return document.querySelector(sel); }

// 底部弹出小提示，2 秒后消失
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2000);
}

// 切换显示哪一个页面（home / deploy / battle / over）
function showView(name) {
  document.querySelectorAll('.view').forEach(function (v) {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
}

// 部署页/对战页顶部的玩法徽标：道具版才显示（含地图规格），经典模式隐藏
function renderModeBadge() {
  const spec = curSpec();
  const isProps = state.mode === 'props';
  document.querySelectorAll('.mode-badge').forEach(function (el) {
    el.textContent = '🎁 道具版 · ' + spec.size + '×' + spec.size + ' · ' + spec.planeCount + ' 架';
    el.classList.toggle('hidden', !isProps);
  });
}

// 按当前房间规格重建三张棋盘（进房/开战/重连时规格可能不同，10×10 老房间无感）
function rebuildBoards() {
  makeBoard($('#deploy-board'), onDeployCellClick);
  makeBoard($('#my-board'), null);
  makeBoard($('#enemy-board'), onEnemyCellClick);
}

// ---------- 主题切换（右上角按钮） ----------
// 三种模式循环：跟随系统 → 浅色 → 深色。选择存在 localStorage 里，默认跟随系统
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_ICONS = { auto: '🌓', light: '☀️', dark: '🌙' };
const THEME_TITLES = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };

function savedTheme() {
  return localStorage.getItem('bp_theme') || 'auto';
}

// 「跟随系统」模式下实际显示哪种颜色
function resolvedTheme() {
  if (savedTheme() === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return savedTheme();
}

// 应用主题（给 <html> 加 data-theme，CSS 按它换色）+ 更新按钮图标和悬停提示
function applyTheme() {
  document.documentElement.setAttribute('data-theme', resolvedTheme());
  const btn = $('#btn-theme');
  btn.textContent = THEME_ICONS[savedTheme()];
  btn.title = THEME_TITLES[savedTheme()];
}

// 点按钮：切到下一个模式
function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(savedTheme()) + 1) % THEME_ORDER.length];
  localStorage.setItem('bp_theme', next);
  applyTheme();
}

// 系统深浅色变化时：只有「跟随系统」模式才跟着变
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
  if (savedTheme() === 'auto') applyTheme();
});

// ---------- 最近加入的房间（重连用） ----------
// 历史记录存在 localStorage 里，形如 [{roomId, token, name, lastSeen}]，最多 5 条
// lastSeen = 我最后一次在这个房间里在线的时间（毫秒时间戳），列表按它从新到旧排序
function loadRoomHistory() {
  try {
    return JSON.parse(localStorage.getItem('bp_room_history') || '[]');
  } catch (e) { return []; }
}

// 按最后在线时间从新到旧排序后写回 localStorage（旧数据没有 lastSeen，按 0 处理排最后）
function sortAndSaveHistory(list) {
  list.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  localStorage.setItem('bp_room_history', JSON.stringify(list.slice(0, 5)));
  return list;
}

// 创建/加入房间成功后记录到历史（同一房间只保留最新一条，时间戳更新为现在）
function saveRoomToHistory(roomId, token, name) {
  const list = sortAndSaveHistory(
    loadRoomHistory().filter(function (e) { return e.roomId !== roomId; })
      .concat([{ roomId: roomId, token: token, name: name, lastSeen: Date.now() }])
  );
  renderRecentRooms();
}

// 刷新某个房间的最后在线时间（重连成功、点「进入」时调用），并重新排序
function updateRoomLastSeen(roomId) {
  const list = loadRoomHistory();
  const entry = list.find(function (e) { return e.roomId === roomId; });
  if (!entry) return;
  entry.lastSeen = Date.now();
  sortAndSaveHistory(list);
  renderRecentRooms();
}
function removeRoomFromHistory(roomId) {
  localStorage.setItem('bp_room_history', JSON.stringify(
    loadRoomHistory().filter(function (e) { return e.roomId !== roomId; })
  ));
  renderRecentRooms();
}

// ---------- 匿名访客 ID（访客统计用，不存任何个人信息） ----------
// 首次访问生成一次，之后一直复用；清掉浏览器存储 = 算一个新访客（可接受）
function getVisitorId() {
  const id = localStorage.getItem('bp_visitor_id');
  if (id) return id;
  const gen = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('bp_visitor_id', 'v' + gen);
  return 'v' + gen;
}

// ---------- 网址中的房间号（邀请链接） ----------

// 把地址栏更新为带房间号的链接（?room=XXXX），不刷新页面
// 这样刷新页面、或把链接转发给朋友，都能直接回到这个房间
function setRoomInUrl(roomId) {
  history.replaceState(null, '', '/?room=' + roomId);
}

// 清掉地址栏里的房间号参数，回到干净首页（避免刷新时反复自动进房）
function clearRoomFromUrl() {
  history.replaceState(null, '', location.pathname);
}

// 渲染首页的「最近加入的房间」列表：点「进入」用保存的凭证重连该房间
function renderRecentRooms() {
  const list = loadRoomHistory();
  const card = $('#recent-card');
  const ul = $('#recent-list');
  ul.innerHTML = '';
  if (!list.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  list.forEach(function (e) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.textContent = '房间 ' + e.roomId + ' · ' + e.name;
    const joinBtn = document.createElement('button');
    joinBtn.textContent = '进入';
    joinBtn.addEventListener('click', function () {
      updateRoomLastSeen(e.roomId); // 即将进入该房间，刷新它的最后在线时间
      state.socket.emit('rejoin', { token: e.token, roomId: e.roomId });
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', function () { removeRoomFromHistory(e.roomId); });
    li.appendChild(info);
    li.appendChild(joinBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  });
}

// ---------- 全局状态 ----------
const state = {
  token: null, roomId: null, seat: null, name: '',
  names: ['', ''],           // 双方昵称
  online: [false, false],    // 双方是否在线（绿点/红点）
  mode: 'classic',           // 当前房间玩法：classic（经典）| props（道具版）
  boardSize: 'S',            // 当前房间地图规格：S=10×10/3架 | M=12×12/4架 | L=14×14/6架
  coins: [0, 0],             // 双方金币（道具版；经典版为 0）
  steps: [0, 0],             // 双方步数（各自揭示了多少格）
  score: [0, 0],             // 双方累计胜场（同一房间连续对局，第二局起显示）
  headsLeft: [3, 3],         // 双方还剩几个机头没被打中
  sonarResults: [],          // 声呐脉冲的历史结果 [{row, col, count}]（扫雷式推理用）
  frozenCells: [],           // 毁灭菇冻结的格子 [{row, col, owner, expiry}]（只约束施放者自己，渲染 ❄）
  marks: {},                 // 注释标记 {'r,c': 'head'|'body'|'empty'}（右键循环标注，仅本机可见，按房间持久化）
  itemPick: null,            // 道具选区模式：null = 未选择 | {itemId}
  pickCells: [],             // 已固定的选区格子（'r,c' 字符串数组，金色高亮）
  pickAnchor: null,          // 3x3 道具的选区锚点（左上角，发给服务器）
  pickReady: false,          // 选区是否已完整（完整后显示「确认使用」按钮）
  pickHover: [],             // 鼠标悬停预览的格子（'r,c' 数组，仅区域型道具）
  deployConfirmed: [false, false],
  myPlanes: [],              // 自己已确认的 3 架飞机（battle 阶段必有）
  myShotsReceived: [],       // 对方打我的记录 [{row, col, result}]
  enemyShotsReceived: [],    // 我打对方的记录
  winner: null, winReason: null,
  rematchVotes: [false, false],
  curDir: 'up',              // 部署页当前选中的朝向
  draft: [],                 // 部署草稿 [{headRow, headCol, dir}]
  inviteRoomId: null,        // 从邀请链接读到的房间号（受邀加入页用）
  spectator: false,          // 我是不是观战者（房间满员时进入观战席）
  spectatorCount: 0,         // 本房间的观战人数（0 时不显示徽章）
  ai: false,                 // 对手是不是电脑（人机对战房间）
  over: false,               // 本局是否已结束（结束后棋盘保留并公开飞机）
  revealedPlanes: null       // 对局结束后服务器公开的双方飞机 [A 的, B 的]
};

// 当前房间的规格（未进房或未知规格 = 经典 10×10/3 架）
function curSpec() {
  return (BOARD_SPECS[state.boardSize] || BOARD_SPECS.S);
}

// 道具价格表（与服务器 server.js 的 ITEM_PRICES 保持一致，按钮置灰用）
const ITEM_PRICES = { sonar: 3, pro: 4, burst: 5, expose: 5, devour: 6, doom: 10 };
// 道具的中文名 + 效果 + 操作指引（选区状态条显示：先讲效果，再讲怎么选）
const ITEM_NAMES = {
  sonar: '声呐脉冲', pro: '探测者 Pro', burst: '双发连射', expose: '无所遁形', devour: '吞噬者', doom: '毁灭菇'
};
const ITEM_TIPS = {
  sonar: '· 效果：3×3 区域内飞机格的数量。操作：点对方棋盘选 3×3 区域',
  pro: '· 效果：3×3 区域内随机揭示 1 格真实内容。操作：点对方棋盘选 3×3 区域',
  burst: '· 效果：一次行动揭示 2 格（占两步）。操作：点对方棋盘上的 2 个未知格',
  expose: '· 效果：完整揭示整架飞机（10 格全显示）。操作：点已揭示的机头（红色）格',
  devour: '· 效果：摧毁 3×3 区域（命中机头 = 发现飞机）。操作：点对方棋盘选 3×3 区域',
  doom: '· 效果：十字 5 格揭示 + 相邻未揭示格冻结 2 回合。操作：点对方棋盘任意格作十字中心'
};

// ---------- 棋盘渲染 ----------

// 生成一个 size×size 的空棋盘表格；onCellClick 不为空时格子可点击
// 棋盘大小跟随当前房间规格（进房后按规格重建）
function makeBoard(tableEl, onCellClick) {
  const size = curSpec().size;
  tableEl.innerHTML = '';
  for (let r = 0; r < size; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < size; c++) {
      const td = document.createElement('td');
      td.dataset.row = r;
      td.dataset.col = c;
      if (onCellClick) {
        td.addEventListener('click', function () { onCellClick(r, c); });
      }
      // 对方棋盘右键 = 循环标注（无 → 机头 → 机身 → 空 → 无），注释是纯本地标记；
      // 但如果正处于道具选区模式，右键优先「取消道具选中」（避免误标到棋盘上）
      if (tableEl.id === 'enemy-board') {
        td.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          if (state.itemPick) {
            clearItemPick();
            renderBattleBoards();
            updateItemButtons();
            return;
          }
          onEnemyMark(r, c);
        });
      }
      // 道具选区的悬停预览（只在对方棋盘 + 区域型道具选区模式时生效）
      td.addEventListener('mousemove', onBoardHover);
      td.addEventListener('mouseleave', function () { updatePickHover([]); });
      tr.appendChild(td);
    }
    tableEl.appendChild(tr);
  }
}

// 鼠标移到对方棋盘上：预览包含它的 3×3 区域（声呐/Pro/吞噬）或十字 5 格（毁灭菇）
function onBoardHover(e) {
  if (!state.itemPick || state.pickReady) return; // 点选固定选区后不再预览
  const id = state.itemPick.itemId;
  if (id !== 'sonar' && id !== 'pro' && id !== 'devour' && id !== 'doom') return;
  if (e.currentTarget.closest('#enemy-board') !== $('#enemy-board')) return;
  const r = +e.currentTarget.dataset.row, c = +e.currentTarget.dataset.col;
  if (id === 'doom') {
    // 毁灭菇：十字中心 = 点击的格子（距边至少 1 格，十字完整落盘）
    const size = curSpec().size;
    const center = { row: Math.max(1, Math.min(size - 2, r)), col: Math.max(1, Math.min(size - 2, c)) };
    updatePickHover(crossKeys(center.row, center.col));
  } else {
    const anchor = hoverAnchor(r, c);
    updatePickHover(regionKeys(anchor.row, anchor.col));
  }
}

// 收集若干飞机占的所有格子（exceptIdx 表示跳过第几架，旋转时用）
function allPlaneCells(planes, exceptIdx) {
  const cells = [];
  planes.forEach(function (p, i) {
    if (i === exceptIdx) return;
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      cells.push(cell);
    });
  });
  return cells;
}

// 随机生成一份合法布局（点「随机布局」按钮时用，可反复点击换方案）
function randomDraft() {
  const spec = curSpec();
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < spec.planeCount; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * spec.size);
    const headCol = Math.floor(Math.random() * spec.size);
    if (canPlacePlane(allPlaneCells(planes), headRow, headCol, dir, state.boardSize)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes.length === spec.planeCount ? planes : null;
}

// 给若干飞机计算轮廓：返回 map（'r,c' -> 'edge-t edge-l …'）
// 轮廓统一深黑色，只画在飞机的外边缘，同一架飞机内部相邻的格子之间不画线
function outlineClassesFor(planes) {
  // 先算出每架飞机占的格子集合
  const sets = planes.map(function (p) {
    const set = new Set();
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      set.add(cell[0] + ',' + cell[1]);
    });
    return set;
  });
  const result = {};
  planes.forEach(function (p, pi) {
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
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

// 渲染部署页棋盘：把草稿里的飞机画上去（带彩色轮廓）
function renderDeployBoard() {
  const cellType = {}; // 'r,c' -> 'head' | 'body'
  state.draft.forEach(function (p) {
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell, i) {
      cellType[cell[0] + ',' + cell[1]] = (i === 0) ? 'head' : 'body';
    });
  });
  const outlines = outlineClassesFor(state.draft);
  $('#deploy-board').querySelectorAll('td').forEach(function (td) {
    const key = td.dataset.row + ',' + td.dataset.col;
    td.className = (cellType[key] ? 'cell-' + cellType[key] : '') +
      (outlines[key] ? ' ' + outlines[key] : '');
  });
}

// 渲染对战页双棋盘
function renderBattleBoards() {
  const revealed = state.over ? state.revealedPlanes : null; // 对局结束后公开的双方飞机

  // ---- 己方棋盘：自己的飞机（对战阶段不画轮廓）+ 对方打过的位置高亮 ----
  // 观战者平时看不到任何飞机；对局结束后公开 1 号玩家的飞机
  const myPlanesSrc = (state.spectator && revealed) ? (revealed[0] || []) : state.myPlanes;
  const myBoard = buildBoard(myPlanesSrc, state.boardSize);
  const myMarks = {};
  state.myShotsReceived.forEach(function (s) { myMarks[s.row + ',' + s.col] = s.result; });

  $('#my-board').querySelectorAll('td').forEach(function (td) {
    const r = +td.dataset.row, c = +td.dataset.col;
    td.className = '';
    td.textContent = ''; // 清掉上次渲染留下的文字（如声呐数字）
    const cell = myBoard[r][c];
    if (cell === CELL_HEAD) td.classList.add('cell-head');
    else if (cell === CELL_BODY) td.classList.add('cell-body');
    if (!myMarks[r + ',' + c]) {
      // 没被打过的格子：蒙上深色遮罩调暗（被打过的保持原色高亮，不加额外标记）
      td.classList.add('dimmed');
    }
  });

  // ---- 对方棋盘：未知格 + 已揭示结果 ----
  // 对局结束后：没被探测到的格子按己方棋盘同款样式公开（暗色），探测过的保持结果颜色
  const enemySeat = state.spectator ? 1 : (1 - state.seat);
  const enemyPlanes = revealed ? (revealed[enemySeat] || []) : [];
  const enemyBoard = buildBoard(enemyPlanes, state.boardSize);
  // 注意：记录存整个对象（destroyed: true 的机头也是 head 结果，要区分渲染）
  const enemyMarks = {};
  state.enemyShotsReceived.forEach(function (s) { enemyMarks[s.row + ',' + s.col] = s; });
  // 声呐数字：显示在 3x3 锚点格上（金色小字，扫雷式推理用）
  const sonarMap = {};
  state.sonarResults.forEach(function (sr) { sonarMap[sr.row + ',' + sr.col] = sr.count; });

  $('#enemy-board').classList.toggle('revealed', !!revealed);
  // 选区模式：对方棋盘用十字光标提示正在选区域
  $('#enemy-board').classList.toggle('picking', !!state.itemPick);
  $('#enemy-board').querySelectorAll('td').forEach(function (td) {
    const r = +td.dataset.row, c = +td.dataset.col;
    td.className = '';
    td.textContent = '';
    const s = enemyMarks[r + ',' + c];
    if (revealed && s && (s.result === 'destroyed' || s.destroyed)) {
      // 对局结束：被摧毁格子的真实内容公开（和没探测过的格子一样暗色显示）
      const cell = enemyBoard[r][c];
      if (cell === CELL_HEAD) td.classList.add('cell-head');
      else if (cell === CELL_BODY) td.classList.add('cell-body');
      else td.classList.add('cell-empty');
      td.classList.add('dimmed');
    } else if (s && s.result === 'destroyed') {
      td.classList.add('cell-destroyed'); // 吞噬者摧毁的格子：深灰 + ✕（内容保密）
    } else if (s && s.result === 'head' && s.destroyed) {
      td.classList.add('cell-head-destroyed'); // 机头被摧毁：灰色机头（视为已发现）
    } else if (s && s.result === 'empty') td.classList.add('cell-empty');
    else if (s && s.result === 'body') td.classList.add('cell-body');
    else if (s && s.result === 'head') td.classList.add('cell-head');
    else if (revealed) {
      // 没探测过的格子：公开真实飞机（暗色遮罩，和己方棋盘同款显示方式）
      const cell = enemyBoard[r][c];
      if (cell === CELL_HEAD) td.classList.add('cell-head');
      else if (cell === CELL_BODY) td.classList.add('cell-body');
      else td.classList.add('cell-unknown');
      td.classList.add('dimmed');
    } else if (isFrozen(r, c)) {
      // 毁灭菇冻结的格子：中间仍是暗色，❄ 标记（施放者接下来 2 回合不能碰）
      td.classList.add('cell-unknown', 'cell-frozen');
      td.textContent = '❄';
    } else {
      td.classList.add('cell-unknown');
    }
    // 注释标记：右键在未揭示格上标的预期内容（红=机头 绿=机身 灰=空，中间仍是暗色；
    // 格子被揭示后自动不显示——注释只是本地猜测，揭示即作废；观战视角不显示）
    if (!s && !revealed && !state.spectator && state.marks[r + ',' + c]) {
      td.classList.add('cell-mark-' + state.marks[r + ',' + c]);
    }
    // 声呐数字（在已揭示格上也能显示；冻结格显示 ❄ 不显示数字）
    const count = sonarMap[r + ',' + c];
    if (count !== undefined && !isFrozen(r, c)) {
      td.classList.add('cell-sonar');
      td.textContent = count;
    }
    // 道具选区高亮：金色描边（点选固定的选区 + 鼠标悬停预览）
    if (state.pickCells.indexOf(r + ',' + c) !== -1) td.classList.add('cell-pick');
    if (state.pickHover.indexOf(r + ',' + c) !== -1) td.classList.add('cell-pick-hover');
  });

  // ---- 上一手揭示的格子：蓝色框框选 ----
  // 己方棋盘：框出对方上一手打的位置
  const lastTheirs = state.myShotsReceived[state.myShotsReceived.length - 1];
  if (lastTheirs) {
    const td = $('#my-board').querySelector(
      'td[data-row="' + lastTheirs.row + '"][data-col="' + lastTheirs.col + '"]');
    if (td) td.classList.add('last-reveal');
  }
  // 对方棋盘：框出我上一手打的位置
  const lastMine = state.enemyShotsReceived[state.enemyShotsReceived.length - 1];
  if (lastMine) {
    const td = $('#enemy-board').querySelector(
      'td[data-row="' + lastMine.row + '"][data-col="' + lastMine.col + '"]');
    if (td) td.classList.add('last-reveal');
  }
}

// ---------- 各页面渲染 ----------

// 部署页：更新计数、按钮状态、双方确认状态
function updateDeployUI() {
  $('#deploy-count').textContent = '已放置 ' + state.draft.length + ' / ' + curSpec().planeCount + ' 架';
  const confirmed = state.deployConfirmed[state.seat];
  $('#btn-confirm').disabled = state.draft.length !== curSpec().planeCount || confirmed;
  $('#btn-clear').disabled = confirmed;
  $('#btn-random').disabled = confirmed;
  $('#btn-unconfirm').classList.toggle('hidden', !confirmed);

  $('#deploy-opponent-name').textContent = state.names[1 - state.seat] || '等待加入…';
  const hasOpp = !!state.names[1 - state.seat];
  $('#deploy-opponent-dot').classList.toggle('hidden', !hasOpp);
  if (hasOpp) setDot($('#deploy-opponent-dot'), state.online[1 - state.seat]);

  let txt = '';
  if (!state.names[1 - state.seat]) txt = '等待对方加入…';
  else if (confirmed && state.deployConfirmed[1 - state.seat]) txt = '双方已就绪，即将开战！';
  else if (confirmed) txt = '已确认，等待 ' + state.names[1 - state.seat] + ' 确认…';
  else if (state.deployConfirmed[1 - state.seat]) txt = '对方已确认，等你的部署';
  $('#deploy-ready-status').textContent = txt;
}

// 进入部署页
function goDeploy() {
  $('#deploy-room-id').textContent = state.roomId;
  rebuildBoards(); // 房间规格确定后重建棋盘（经典 10×10 无变化）
  renderModeBadge();
  if (state.myPlanes.length) {
    // 已确认过部署（比如刷新后重连回来）：直接用已确认的飞机
    state.draft = state.myPlanes.map(function (p) {
      return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
    });
  } else {
    // 恢复本地草稿（部署到一半刷新页面不丢）
    try {
      state.draft = JSON.parse(localStorage.getItem('bp_draft') || '[]');
    } catch (e) { state.draft = []; }
  }
  renderDeployBoard();
  updateDeployUI();
  showView('deploy');
}

// 在线状态点：绿 = 在线，红 = 离线
function setDot(el, online) {
  el.classList.toggle('dot-on', online);
  el.classList.toggle('dot-off', !online);
}

// 渲染观战人数徽章（对战页 + 观战等待页各一个，无人观战时不显示）
function renderSpectatorBadge() {
  const show = state.spectatorCount > 0;
  $('#spectator-badge').classList.toggle('hidden', !show);
  $('#wait-spectator-badge').classList.toggle('hidden', !show);
  if (show) {
    $('#spectator-count').textContent = state.spectatorCount;
    $('#wait-spectator-count').textContent = state.spectatorCount;
  }
}

// 更新对战页左右两侧的玩家信息栏（昵称+在线状态点、步数、已找到机头数、行动提示）
function updateBattlePanels() {
  const mine = state.steps[state.seat], theirs = state.steps[1 - state.seat];

  const planeCount = curSpec().planeCount;
  if (state.spectator) {
    // 观战视角：固定按 1 号玩家（房主）在左、2 号玩家在右显示，昵称不加「（我）」
    $('#panel-my-name').textContent = state.names[0];
    setDot($('#panel-my-dot'), state.online[0]);
    $('#panel-my-steps').textContent = state.steps[0];
    $('#panel-my-heads').textContent = (planeCount - state.headsLeft[1]) + '/' + planeCount;
    $('#panel-enemy-name').textContent = state.names[1];
    setDot($('#panel-enemy-dot'), state.online[1]);
    $('#panel-enemy-steps').textContent = state.steps[1];
    $('#panel-enemy-heads').textContent = (planeCount - state.headsLeft[0]) + '/' + planeCount;
    $('#panel-my-turn').textContent = '👁 观战中';
    $('#panel-enemy-turn').textContent = '';
  } else {
    $('#panel-my-name').textContent = state.names[state.seat] + '（我）';
    setDot($('#panel-my-dot'), state.online[state.seat]);
    $('#panel-my-steps').textContent = mine;
    $('#panel-my-heads').textContent = (planeCount - state.headsLeft[1 - state.seat]) + '/' + planeCount;
    $('#panel-enemy-name').textContent = state.names[1 - state.seat];
    setDot($('#panel-enemy-dot'), state.online[1 - state.seat]);
    $('#panel-enemy-steps').textContent = theirs;
    $('#panel-enemy-heads').textContent = (planeCount - state.headsLeft[state.seat]) + '/' + planeCount;

    // 行动提示：步数少（或相等）的一方可以下棋
    const myTurnText = mine <= theirs ? (mine === theirs ? '⚡ 双方抢步中' : '✓ 可行动') : '⏳ 等待对方';
    const theirTurnText = theirs <= mine ? (theirs === mine ? '⚡ 双方抢步中' : '✓ 可行动') : '⏳ 等待对方';
    $('#panel-my-turn').textContent = myTurnText;
    $('#panel-enemy-turn').textContent = theirTurnText;
  }

  // 对局已结束：行动提示换成结束标志
  if (state.over) {
    $('#panel-my-turn').textContent = '🏁 对局结束';
    $('#panel-enemy-turn').textContent = '';
  }

  // 金币（道具版双方可见；经典版隐藏该行）。观战视角左 = 1 号玩家、右 = 2 号玩家
  const coinsVisible = state.mode === 'props';
  $('#panel-my-coins-row').classList.toggle('hidden', !coinsVisible);
  $('#panel-enemy-coins-row').classList.toggle('hidden', !coinsVisible);
  $('#panel-my-coins').textContent = state.coins[state.spectator ? 0 : state.seat];
  $('#panel-enemy-coins').textContent = state.coins[state.spectator ? 1 : (1 - state.seat)];
  updateItemButtons();

  // 双方累计比分：从第二局起显示，居中在棋盘上端（第一局 0:0 不显示）
  // 只显示数字，玩家视角左边永远是「我」的比分；观战视角按 1 号玩家在左、2 号在右
  // 昵称存在 data-name 里，悬停在数字上才显示
  const scoreEl = $('#battle-score');
  if (state.score[0] + state.score[1] > 0) {
    scoreEl.classList.remove('hidden');
    const a = state.spectator ? 0 : state.seat; // 观战者固定左 = 1 号玩家
    $('#score-a').textContent = state.score[a];
    $('#score-a').dataset.name = state.names[a];
    $('#score-b').textContent = state.score[1 - a];
    $('#score-b').dataset.name = state.names[1 - a];
  } else {
    scoreEl.classList.add('hidden');
  }

  renderSpectatorBadge();
}

// ---------- 道具（道具版对战页） ----------

// 道具面板状态：道具版才显示；观战/结束/步数领先时全部禁用；金币不够的单个置灰
function updateItemButtons() {
  $('#items-panel').classList.toggle('hidden', state.mode !== 'props');
  const canAct = !state.spectator && !state.over &&
    state.steps[state.seat] <= state.steps[1 - state.seat];
  document.querySelectorAll('.item-btn').forEach(function (btn) {
    const id = btn.dataset.item;
    btn.classList.toggle('active', !!(state.itemPick && state.itemPick.itemId === id));
    btn.disabled = !canAct || state.coins[state.seat] < ITEM_PRICES[id];
  });
  updateItemStatus();
}

// 选区状态条：选择道具后显示操作指引；选区完整后出现「确认使用」按钮
function updateItemStatus() {
  const bar = $('#item-status');
  const text = $('#item-status-text');
  if (!state.itemPick) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  text.textContent = ITEM_NAMES[state.itemPick.itemId] + ITEM_TIPS[state.itemPick.itemId];
  $('#item-confirm').classList.toggle('hidden', !state.pickReady);
  $('#item-cancel').classList.toggle('hidden', false);
}

// 结束道具选区（确认 / 取消 / 收到自己的道具结果 / 新局）
function clearItemPick() {
  state.itemPick = null;
  state.pickCells = [];
  state.pickAnchor = null;
  state.pickReady = false;
  state.pickHover = [];
}

// 3x3 区域锚点（左上角）：让点击的格子落在区域里，同时保证区域完整在棋盘内
function hoverAnchor(r, c) {
  const size = curSpec().size;
  return { row: Math.max(0, Math.min(size - 3, r - 1)), col: Math.max(0, Math.min(size - 3, c - 1)) };
}

// 3x3 区域的 9 个格子的 'r,c' 键（区域型道具的选区）
function regionKeys(row, col) {
  const keys = [];
  for (let r = row; r < row + 3; r++) {
    for (let c = col; c < col + 3; c++) keys.push(r + ',' + c);
  }
  return keys;
}

// 毁灭菇十字 5 格的 'r,c' 键（中心 + 上下左右）
function crossKeys(row, col) {
  return [row + ',' + col, (row - 1) + ',' + col, (row + 1) + ',' + col, row + ',' + (col - 1), row + ',' + (col + 1)];
}

// 这个格子是否还在毁灭菇冻结期（只查自己视角的对方棋盘；渲染 ❄ 与点击拦截共用）
function isFrozen(r, c) {
  return state.frozenCells.some(function (f) {
    return f.owner === state.seat && state.steps[state.seat] < f.expiry && f.row === r && f.col === c;
  });
}

// 在道具选区模式点对方棋盘：按道具类型记录选区，高亮预览，完整后由用户确认执行
function pickItemCell(r, c) {
  const id = state.itemPick.itemId;
  if (id === 'burst') {
    // 双发连射：先点第 1 格再点第 2 格（点已选格 = 取消重选；点已揭示格被拒）
    const key = r + ',' + c;
    if (state.pickCells.indexOf(key) !== -1) {
      state.pickCells = []; // 反悔：取消重选
    } else {
      if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
        return toast('这格已经揭示过了，换一格');
      }
      state.pickCells = state.pickCells.concat([key]);
    }
    state.pickReady = state.pickCells.length === 2;
    renderBattleBoards();
    updateItemStatus();
    return;
  }
  if (id === 'expose') {
    // 无所遁形：点已揭示的机头格（红色）
    const hit = state.enemyShotsReceived.find(function (s) {
      return s.row === r && s.col === c && s.result === 'head';
    });
    if (!hit) return toast('请点已揭示的机头（红色）格');
    state.pickCells = [r + ',' + c];
    state.pickAnchor = null;
    state.pickReady = true;
    renderBattleBoards();
    updateItemStatus();
    return;
  }
  if (id === 'doom') {
    // 毁灭菇：点任意格作为十字中心（中心距边至少 1 格，十字 5 格完整落盘）
    const size = curSpec().size;
    if (r < 1 || r > size - 2 || c < 1 || c > size - 2) {
      return toast('十字中心离棋盘边太近，换个格子');
    }
    if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
      return toast('这格已经揭示过了，换一格');
    }
    if (isFrozen(r, c)) return toast('这格被毁灭菇冻结，还不能选中');
    state.pickAnchor = null; // 毁灭菇用中心格，不用 3×3 锚点
    state.pickCells = crossKeys(r, c);
    state.pickReady = true;
    renderBattleBoards();
    updateItemStatus();
    return;
  }
  // 声呐 / 探测者 Pro / 吞噬者：点任意格，选包含它的 3×3 区域
  const anchor = hoverAnchor(r, c);
  state.pickAnchor = anchor;
  state.pickCells = regionKeys(anchor.row, anchor.col);
  state.pickReady = true;
  renderBattleBoards();
  updateItemStatus();
}

// 悬停预览（仅区域型道具）：鼠标移到哪，预览包含它的 3×3 区域
// 只改格子的类不动整盘渲染；点选固定选区后预览停止
function updatePickHover(keys) {
  state.pickHover = keys;
  $('#enemy-board').querySelectorAll('td').forEach(function (td) {
    const on = keys.indexOf(td.dataset.row + ',' + td.dataset.col) !== -1;
    td.classList.toggle('cell-pick-hover', on);
  });
}

// 进入对战页
function goBattle() {
  state.over = false;
  clearItemPick();      // 新一局：清掉上一局的选区状态
  state.sonarResults = [];
  // 注意：这里不清 state.frozenCells——重连恢复现场（reconnected）时冻结要保留，
  // 只有开新一局（battleStart）才清零
  loadMarks();          // 注释标记按房间持久化：再来一局 / 重连后恢复
  $('#over-banner').classList.add('hidden');
  $('#battle-room-id').textContent = state.roomId;
  rebuildBoards(); // 房间规格确定后重建棋盘（经典 10×10 无变化）
  renderModeBadge();
  if (state.spectator) {
    // 观战视角：棋盘标题改成双方昵称，而不是「我的 / 对方的」
    $('#board-title-my').textContent = state.names[0] + ' 的棋盘';
    $('#board-title-enemy').textContent = state.names[1] + ' 的棋盘';
  } else {
    $('#board-title-my').textContent = '我的棋盘';
    $('#board-title-enemy').textContent = '对方棋盘';
  }
  $('#board-title-enemy-note').textContent = '（点击未知格子揭示）';
  renderBattleBoards();
  updateBattlePanels();
  showView('battle');
}

// 观战等待页：双方还在部署（或等待对手加入），开战后自动进入对战页
function goWait() {
  $('#wait-room-id').textContent = state.roomId;
  renderSpectatorBadge();
  showView('wait');
}

// 对局结束：留在对战页（棋盘保留），顶部弹出结束横幅，
// 双方飞机公开——没被探测的格子用暗色显示（和己方棋盘同款样式）
// （只有击中 3 个机头一种结束方式，任何情况都不判负）
function goOver() {
  state.over = true;
  clearItemPick(); // 对局结束：清掉未执行的选区
  state.frozenCells = []; // 冻结随对局结束解除（服务器端 activeFrozenCells 也已置空）
  state.marks = {}; // 对局结束飞机全部公开，注释不再有意义；下一局从空注释开始
  try { localStorage.removeItem('bp_marks_' + state.roomId); } catch (e) { /* 忽略 */ }
  const planeCount = curSpec().planeCount;
  if (state.spectator) {
    // 观战视角：标题显示获胜者昵称，不参与再来一局投票
    $('#over-title').textContent = '🏁 ' + state.names[state.winner] + ' 获胜';
    const hitsA = planeCount - state.headsLeft[1]; // 1 号玩家打中对方的机头数
    const hitsB = planeCount - state.headsLeft[0];
    $('#over-detail').textContent =
      state.names[0] + ' 击中机头 ' + hitsA + '/' + planeCount + ' · ' + state.names[1] + ' 击中机头 ' + hitsB + '/' + planeCount;
    $('#btn-rematch').classList.add('hidden');
  } else {
    $('#over-title').textContent = state.winner === state.seat ? '🎉 你赢了！' : '你输了';

    const myHits = planeCount - state.headsLeft[1 - state.seat];
    const theirHits = planeCount - state.headsLeft[state.seat];
    $('#over-detail').textContent = '你击中机头 ' + myHits + '/' + planeCount + ' · 对方击中机头 ' + theirHits + '/' + planeCount;

    $('#btn-rematch').classList.remove('hidden');
  }
  $('#board-title-enemy-note').textContent = '（暗色 = 对方没被你探测过的格子）';
  renderBattleBoards();   // 公开渲染：探测过的保持结果颜色，没探测过的暗色公开
  updateBattlePanels();
  updateOverRematchStatus();
  showView('battle');     // 留在对战页，棋盘不消失
  $('#over-banner').classList.remove('hidden');
}

// 结束页的「再来一局」投票显示
function updateOverRematchStatus() {
  const votes = state.rematchVotes.filter(Boolean).length;
  if (state.spectator) {
    // 观战者不参与投票，只显示双方意愿
    $('#over-rematch-status').textContent = votes > 0 ? '双方想再来一局：' + votes + '/2' : '';
    return;
  }
  const mine = state.rematchVotes[state.seat];
  const btn = $('#btn-rematch');
  btn.textContent = mine ? '再来一局（' + votes + '/2）' : '再来一局';
  btn.disabled = mine;
  if (mine) $('#over-rematch-status').textContent = '已提交，等待对方（' + votes + '/2）';
  else if (votes > 0) $('#over-rematch-status').textContent = '对方想再来一局';
  else $('#over-rematch-status').textContent = '';
}

// ---------- 部署页交互 ----------

// 点部署棋盘：
//   空白格 → 放新飞机（以点击处为机头）
//   机头格 → 移除该架飞机
//   机身格 → 该架飞机顺次旋转（上→右→下→左）
function onDeployCellClick(r, c) {
  if (state.deployConfirmed[state.seat]) {
    return toast('已确认部署，点「取消确认」才能修改');
  }

  // 找点击位置属于哪架飞机
  let planeIdx = -1, isHead = false;
  for (let i = 0; i < state.draft.length; i++) {
    const p = state.draft[i];
    const cells = getPlaneCells(p.headRow, p.headCol, p.dir);
    for (let j = 0; j < cells.length; j++) {
      if (cells[j][0] === r && cells[j][1] === c) {
        planeIdx = i;
        isHead = (j === 0);
        break;
      }
    }
    if (planeIdx !== -1) break;
  }

  if (planeIdx === -1) {
    // 空白格：放新飞机
    if (state.draft.length >= curSpec().planeCount) return toast('已放满 ' + curSpec().planeCount + ' 架飞机');
    if (!canPlacePlane(allPlaneCells(state.draft), r, c, state.curDir, state.boardSize)) {
      return toast('这里放不下（越界或与其它飞机重叠）');
    }
    state.draft.push({ headRow: r, headCol: c, dir: state.curDir });
  } else if (isHead) {
    // 点机头：移除
    state.draft.splice(planeIdx, 1);
  } else {
    // 点机身：旋转到下一朝向（上→右→下→左）
    const p = state.draft[planeIdx];
    const dirs = ['up', 'right', 'down', 'left'];
    const next = dirs[(dirs.indexOf(p.dir) + 1) % 4];
    if (!canPlacePlane(allPlaneCells(state.draft, planeIdx), p.headRow, p.headCol, next, state.boardSize)) {
      return toast('转不过去（越界或与其它飞机重叠）');
    }
    p.dir = next;
  }

  saveDraft();
  renderDeployBoard();
  updateDeployUI();
}

function saveDraft() {
  localStorage.setItem('bp_draft', JSON.stringify(state.draft));
}

// ---------- 对战页交互 ----------

// 点对方棋盘：道具选区模式优先（选区域而不是揭示），否则正常揭示
function onEnemyCellClick(r, c) {
  if (state.itemPick) return pickItemCell(r, c);
  if (state.spectator) {
    return toast('观战模式不能下棋');
  }
  if (state.over) {
    return toast('对局已结束，点「再来一局」继续');
  }
  if (isFrozen(r, c)) {
    return toast('这个格子被毁灭菇冻结，还不能揭示');
  }
  if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
    return toast('这个格子已经揭示过了');
  }
  if (state.steps[state.seat] > state.steps[1 - state.seat]) {
    return toast('你的步数已领先，等待对方');
  }
  // 点击后立即给格子一个"处理中"样式：网络慢时也能看到响应，不觉得卡
  const td = $('#enemy-board').querySelector(
    'td[data-row="' + r + '"][data-col="' + c + '"]');
  if (td) td.classList.add('cell-pending');
  state.socket.emit('reveal', { row: r, col: c });
}

// ---------- 注释标记（纯本地功能，不进服务器） ----------
// 右键在对方棋盘的未揭示格上循环标注：无 → 机头（红）→ 机身（绿）→ 空（灰）→ 无
// 猜测的颜色画在格子四周一圈，中间保持未揭示的暗色；格子被揭示后标记自动不再显示。
// 按房间号持久化到 localStorage（重新进房 / 重连后标记还在，刷新页面也不丢）。
const MARK_CYCLE = ['head', 'body', 'empty'];

function saveMarks() {
  try {
    localStorage.setItem('bp_marks_' + state.roomId, JSON.stringify(state.marks));
  } catch (e) { /* 本地存储满 / 不可用时静默失败，标记只在本页有效 */ }
}

function loadMarks() {
  state.marks = {};
  try {
    const raw = localStorage.getItem('bp_marks_' + state.roomId);
    if (raw) state.marks = JSON.parse(raw) || {};
  } catch (e) { state.marks = {}; }
}

function onEnemyMark(r, c) {
  if (state.spectator || state.over) return; // 观战 / 对局结束不标注
  const key = r + ',' + c;
  if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) return; // 已揭示格不标
  const idx = MARK_CYCLE.indexOf(state.marks[key]);
  if (idx === -1) state.marks[key] = 'head';                        // 无 → 机头
  else if (idx < MARK_CYCLE.length - 1) state.marks[key] = MARK_CYCLE[idx + 1]; // 机身 → 空
  else delete state.marks[key];                                     // 空 → 无
  saveMarks();
  renderBattleBoards();
}

// ---------- Socket 事件 ----------
function bindSocketEvents() {
  const s = state.socket;

  // 连接建立（原生 WebSocket 自动重连成功后也会触发）：
  // 如果之前正处在某个房间里（有 roomId + token），自动恢复现场——
  // 等价于刷新页面后按网址恢复，顺便修复网络闪断后页面僵住的问题
  s.on('connect', function () {
    s.emit('visit', { visitorId: getVisitorId(), platform: 'web' }); // 访客统计：每次连上服务器上报一次
    if (state.roomId && state.token) {
      s.emit('rejoin', { token: state.token, roomId: state.roomId });
    }
  });

  // 访客统计：服务器回报当前唯一访客总数，显示在首页底部
  s.on('visitResult', function (d) {
    const el = $('#visitor-count');
    if (el) el.textContent = '👥 已有 ' + (d.total || 0) + ' 位玩家访问过';
  });

  // 连接断开：提示正在重连（ws.js 会按指数退避自动重连）
  s.on('disconnect', function () {
    toast('连接断开，正在重连…');
  });

  s.on('error', function (d) {
    toast(d.message);
    // 清除所有"处理中"格子的样式（比如领先方点击被拒绝，格子不会收到揭示结果）
    document.querySelectorAll('.cell-pending').forEach(function (td) {
      td.classList.remove('cell-pending');
    });
    // 自动加入房间失败（比如房间已满）：还没进入任何房间且网址带房间号时，
    // 清掉房间号参数，免得刷新页面反复重试
    if (!state.roomId && location.search.indexOf('room=') !== -1) clearRoomFromUrl();
  });

  // 创建/加入房间成功：保存凭证、记入最近房间，进入部署页
  s.on('roomCreated', function (d) {
    state.token = d.token;
    state.roomId = d.roomId;
    setRoomInUrl(d.roomId); // 网址带上房间号，方便刷新恢复和转发邀请
    saveRoomToHistory(d.roomId, d.token, d.name);
    state.seat = 0;
    state.name = d.name;
    state.names = d.names;
    state.online = d.online;
    state.myPlanes = [];
    state.deployConfirmed = d.deployConfirmed || [false, false]; // 人机房间：AI 已经确认
    state.spectator = false;
    state.inviteRoomId = null;
    state.ai = !!d.isAI;      // 人机对战房间标记
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = [0, 0];
    localStorage.removeItem('bp_draft');
    goDeploy();
  });
  s.on('joinedRoom', function (d) {
    state.token = d.token;
    state.roomId = d.roomId;
    setRoomInUrl(d.roomId); // 网址带上房间号，方便刷新恢复和转发邀请
    saveRoomToHistory(d.roomId, d.token, d.name);
    state.seat = 1;
    state.name = d.name;
    state.names = d.names;
    state.online = d.online;
    state.myPlanes = [];
    state.deployConfirmed = [false, false];
    state.spectator = false;
    state.inviteRoomId = null;
    state.ai = false; // 人机房间满员，真人不可能走到这里
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = [0, 0];
    localStorage.removeItem('bp_draft');
    goDeploy();
  });

  // 房间已满，我进入观战席：收到完整的对局快照（只含双方已公开的信息，绝不含飞机坐标）
  s.on('spectatorJoined', function (d) {
    state.spectator = true;
    state.roomId = d.roomId;
    setRoomInUrl(d.roomId); // 观战者不写历史，但网址带上房间号，刷新后能重新进入
    state.inviteRoomId = null;
    state.seat = 0; // 借用 1 号玩家（房主）的视角：左 = 房主，右 = 2 号玩家
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = d.coins || [0, 0];
    state.names = d.names;
    state.online = d.online;
    state.steps = d.steps;
    state.score = d.score;
    state.headsLeft = d.headsLeft;
    state.winner = d.winner;
    state.winReason = d.winReason;
    state.rematchVotes = [false, false];
    state.myShotsReceived = d.shots[0] || [];   // 打在 1 号玩家棋盘上的记录
    state.enemyShotsReceived = d.shots[1] || []; // 打在 2 号玩家棋盘上的记录
    state.sonarResults = d.sonarHistory || [];  // 声呐数字历史（观战者也能看到）
    state.frozenCells = d.frozenCells || [];    // 毁灭菇冻结格（观战者也能看到 ❄）
    state.revealedPlanes = d.planes || null;    // 对局结束后才有的双方飞机
    if (d.phase === 'battle') goBattle();
    else if (d.phase === 'over') goOver();
    else goWait(); // deploy / waiting：双方还在部署，显示等待页
  });

  // 观战人数变化：更新徽章（0 人时隐藏）
  s.on('spectatorCount', function (d) {
    state.spectatorCount = d.count;
    renderSpectatorBadge();
  });

  // 房间被回收（双方都离线超时）：回首页，观战者和玩家都会收到
  s.on('roomClosed', function (d) {
    toast(d.message || '房间已回收');
    clearRoomFromUrl();
    showView('home');
  });

  // 对手加入（房主收到）
  s.on('opponentJoined', function (d) {
    state.names = d.names;
    updateDeployUI();
  });

  // 有人确认/取消确认部署
  s.on('deployReady', function (d) {
    state.deployConfirmed = d.confirmed;
    if (d.confirmed[state.seat]) {
      // 我的部署被服务器接受了：草稿变成正式飞机
      state.myPlanes = state.draft.map(function (p) {
        return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
      });
    }
    updateDeployUI();
  });

  // 开战
  s.on('battleStart', function (d) {
    state.names = d.names;
    state.steps = d.steps;
    state.score = d.score;
    state.online = d.online;
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = d.coins || [0, 0];
    state.frozenCells = []; // 新一局：毁灭菇冻结清零（服务器端 activeFrozenCells 也已清空）
    state.headsLeft = [curSpec().planeCount, curSpec().planeCount];
    state.myShotsReceived = [];
    state.enemyShotsReceived = [];
    state.revealedPlanes = null; // 新一局：上一局公开的飞机作废
    goBattle();
  });

  // 有人揭示了一个格子
  s.on('revealResult', function (d) {
    if (d.attacker === state.seat) {
      state.enemyShotsReceived.push({ row: d.row, col: d.col, result: d.result });
    } else {
      state.myShotsReceived.push({ row: d.row, col: d.col, result: d.result });
    }
    state.headsLeft = d.headsLeft;
    state.steps = d.steps;
    state.coins = d.coins || state.coins; // 道具版：金币随时同步
    renderBattleBoards();
    updateBattlePanels();
  });

  // 道具结果：声呐数字 / 吞噬摧毁 / 无所遁形整机揭示
  // （探测者 Pro 和双发连射走上面的 revealResult，不在这里）
  s.on('itemResult', function (d) {
    if (d.attacker === state.seat) {
      // 自己用的道具：结果已出，选区模式结束
      state.itemPick = null;
      state.pickCells = [];
      state.pickAnchor = null;
      state.pickReady = false;
      state.pickHover = [];
      if (d.itemId === 'devour' && d.headHit) {
        toast('吞噬者命中机头！🎯 你找到了一架飞机');
      }
      if (d.itemId === 'sonar') {
        toast('声呐：区域内有 ' + d.count + ' 个非空格');
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
    renderBattleBoards();
    updateBattlePanels();
  });

  // 对局结束
  s.on('gameOver', function (d) {
    state.winner = d.winner;
    state.winReason = d.winReason;
    state.headsLeft = d.headsLeft;
    state.score = d.score;
    state.rematchVotes = [false, false];
    state.revealedPlanes = d.planes || null; // 服务器公开双方飞机，棋盘暗色显示
    goOver();
  });

  // 双方在线状态变化（断线 / 重连 / 离开）：更新绿点/红点，不做其它反应
  s.on('playerStatus', function (d) {
    state.online[d.seat] = d.connected;
    updateBattlePanels();
    updateDeployUI();
  });

  // 再来一局投票
  s.on('rematchVote', function (d) {
    state.rematchVotes = d.votes;
    updateOverRematchStatus();
  });

  // 双方同意，重新开始
  s.on('rematchStart', function (d) {
    state.names = d.names;
    state.steps = [0, 0];
    state.coins = [0, 0]; // 每局金币在 battleStart 时由服务器下发
    state.headsLeft = [curSpec().planeCount, curSpec().planeCount];
    state.myPlanes = [];
    state.myShotsReceived = [];
    state.enemyShotsReceived = [];
    state.winner = null;
    state.winReason = null;
    state.over = false;
    state.revealedPlanes = null; // 新一局：上一局公开的飞机作废
    state.deployConfirmed = [false, false];
    if (state.spectator) {
      goWait(); // 观战者不参与部署，回等待页看双方重新部署
    } else {
      localStorage.removeItem('bp_draft');
      goDeploy();
    }
  });

  // 我自己离开了房间：清空草稿回首页（房间记录保留，随时可以回来继续）
  // 观战者离开观战席也走这里（不写历史，回首页后身份恢复成普通玩家）
  s.on('leftRoom', function () {
    localStorage.removeItem('bp_draft');
    state.spectator = false;
    state.spectatorCount = 0;
    clearRoomFromUrl(); // 地址栏回到干净的首页
    showView('home');
  });

  // 重连失败（房间没了 / 凭证无效）：从「最近加入的房间」列表里删掉这条，避免下次再点
  s.on('rejoinFailed', function (d) {
    if (d.roomId) removeRoomFromHistory(d.roomId);
    clearRoomFromUrl();
    toast(d.message);
    showView('home');
  });

  // 启动时批量校验历史房间是否还存在：不存在的自动从列表删除
  s.on('roomsAlive', function (d) {
    const alive = d.alive || [];
    const list = loadRoomHistory();
    const kept = list.filter(function (e) { return alive.indexOf(e.roomId) !== -1; });
    if (kept.length !== list.length) {
      localStorage.setItem('bp_room_history', JSON.stringify(kept));
      renderRecentRooms();
    }
  });

  // 重连成功：用服务器发来的完整现场恢复页面
  s.on('reconnected', function (d) {
    state.roomId = d.roomId;
    state.seat = d.seat;
    state.name = d.name;
    state.names = d.names;
    state.online = d.online;
    state.steps = d.steps;
    state.score = d.score;
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = d.coins || [0, 0];
    state.headsLeft = d.headsLeft;
    state.deployConfirmed = d.deployConfirmed;
    state.myPlanes = d.myPlanes || [];
    state.myShotsReceived = d.myShotsReceived || [];
    state.enemyShotsReceived = d.enemyShotsReceived || [];
    state.sonarResults = d.sonarHistory || []; // 声呐数字历史（重连后还能看到）
    state.frozenCells = d.frozenCells || [];   // 毁灭菇冻结格（重连后还能看到 ❄）
    state.winner = d.winner;
    state.winReason = d.winReason;
    state.rematchVotes = d.rematchVotes || [false, false];
    state.ai = !!d.isAI;          // 人机房间断线重连后仍感知对手是电脑
    state.revealedPlanes = d.planes || null; // 对局结束后才有的双方飞机

    updateRoomLastSeen(d.roomId); // 重连成功 = 又在这个房间在线过，列表顺序同步刷新
    setRoomInUrl(d.roomId);       // 网址带上房间号，刷新也能直接回来

    if (d.phase === 'deploy') goDeploy();
    else if (d.phase === 'battle') goBattle();
    else if (d.phase === 'over') goOver();
    else showView('home'); // waiting 阶段不会发生（满 2 人才有对局）
  });
}

// ---------- 游戏规则弹窗 ----------

// 用真实飞机形状数据（getPlaneCells）画 4 张 5×5 小图，保证配图和实际玩法完全一致
// 机头坐标要让机身（从机头向反方向延伸 3 格）和翼展（5 格）恰好占满 5×5：
//   朝上/朝下：机头放第 1 / 第 3 行（机身纵向延伸 3 格，尾翼刚好顶到对边）
//   朝右/朝左：机头放第 3 / 第 1 列（机身横向延伸 3 格，尾翼刚好顶到对边）
function renderRulesDiagram() {
  const dirs = [
    { dir: 'up',    headRow: 1, headCol: 2, label: '朝上' },
    { dir: 'right', headRow: 2, headCol: 3, label: '朝右' },
    { dir: 'down',  headRow: 3, headCol: 2, label: '朝下' },
    { dir: 'left',  headRow: 2, headCol: 1, label: '朝左' },
  ];
  const box = $('#rules-diagram');
  box.innerHTML = '';
  dirs.forEach(function (item) {
    // 一张小图 = 一个 5×5 迷你棋盘 + 朝向文字
    const wrap = document.createElement('div');
    wrap.className = 'rules-plane';

    const table = document.createElement('table');
    table.className = 'board mini-board';
    const cellType = {}; // 'r,c' -> 'head' | 'body'
    getPlaneCells(item.headRow, item.headCol, item.dir).forEach(function (cell, i) {
      cellType[cell[0] + ',' + cell[1]] = (i === 0) ? 'head' : 'body';
    });
    for (let r = 0; r < 5; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < 5; c++) {
        const td = document.createElement('td');
        if (cellType[r + ',' + c]) td.className = 'cell-' + cellType[r + ',' + c];
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    wrap.appendChild(table);

    const p = document.createElement('p');
    p.textContent = item.label;
    wrap.appendChild(p);
    box.appendChild(wrap);
  });
}

// ---------- 首页玩法与规格选择（两栏：经典 / 道具） ----------
// 玩法两栏卡片 + 地图规格（S/M/L）自由组合。
// 每栏记住自己的规格（localStorage：bp_spec_classic / bp_spec_props），
// 经典默认 S、道具默认 M；切栏时规格自动换成该栏的选择。
state.homeMode = 'classic'; // 当前选中的玩法栏：classic / props

function savedSpecFor(mode) {
  const key = mode === 'props' ? 'bp_spec_props' : 'bp_spec_classic';
  const s = localStorage.getItem(key);
  return (s === 'S' || s === 'M' || s === 'L') ? s : (mode === 'props' ? 'M' : 'S');
}

// 首页当前选择的玩法/规格（创建、加入房间时读取）
function currentMode() { return state.homeMode; }
function currentSpec() { return savedSpecFor(state.homeMode); }

// 同步首页 UI：玩法卡片高亮、规格按钮高亮、模式提示文字
function renderHomeMode() {
  const mode = state.homeMode;
  const spec = savedSpecFor(mode);
  const sp = BOARD_SPECS[spec];
  document.querySelectorAll('.mode-card').forEach(function (c) {
    c.classList.toggle('active', c.dataset.mode === mode);
  });
  document.querySelectorAll('.spec-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.spec === spec);
  });
  $('#mode-help').textContent = mode === 'props'
    ? '🎁 道具版 · ' + sp.size + '×' + sp.size + ' · ' + sp.planeCount + ' 架 · 金币买道具更刺激'
    : '经典玩法 · ' + sp.size + '×' + sp.size + ' · ' + sp.planeCount + ' 架';
}

// ---------- 按钮事件 ----------
function bindUIEvents() {
  // 右上角主题切换：跟随系统 → 浅色 → 深色 循环
  $('#btn-theme').addEventListener('click', cycleTheme);

  // 首页：玩法两栏卡片（点卡片任意处选中）+ 地图规格选择（S/M/L，每栏各自记忆）
  // 点卡片切换玩法栏：规格自动换成该栏记着的选择
  document.querySelectorAll('.mode-card').forEach(function (card) {
    card.addEventListener('click', function () {
      state.homeMode = card.dataset.mode;
      renderHomeMode();
    });
  });
  document.querySelectorAll('.spec-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // 规格保存到当前玩法栏自己的键（经典/道具互不影响）
      localStorage.setItem(state.homeMode === 'props' ? 'bp_spec_props' : 'bp_spec_classic', btn.dataset.spec);
      renderHomeMode();
    });
  });

  // 首页：两栏卡片内的「创建房间」/「人机对战」按钮（data-mode 指明用哪种玩法开局）
  document.querySelectorAll('.mode-create').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.homeMode = btn.dataset.mode; // 直接以本栏玩法开局（即使刚才点的是另一栏）
      const name = $('#name-input').value;
      localStorage.setItem('bp_name', name.trim());
      state.socket.emit('createRoom', { name: name, mode: currentMode(), boardSize: currentSpec() });
    });
  });
  document.querySelectorAll('.mode-ai').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.homeMode = btn.dataset.mode;
      const name = $('#name-input').value;
      localStorage.setItem('bp_name', name.trim());
      state.socket.emit('createRoomAI', { name: name, mode: currentMode(), boardSize: currentSpec() });
    });
  });
  $('#btn-join').addEventListener('click', function () {
    const name = $('#name-input').value;
    localStorage.setItem('bp_name', name.trim());
    state.socket.emit('joinRoom', { roomId: $('#room-input').value, name: name, mode: currentMode(), boardSize: currentSpec() });
  });
  // 对局中的「返回菜单」按钮（部署页 + 对战页 + 观战等待页各一个）
  document.querySelectorAll('.btn-back-menu').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // 观战者退出不影响对局，确认文案区分开
      const msg = state.spectator
        ? '确定要退出观战、返回菜单吗？'
        : '确定要返回菜单吗？对局将暂停，之后可从「最近加入的房间」回来继续';
      if (!window.confirm(msg)) return;
      state.socket.emit('leaveRoom');
    });
  });

  // 部署页：朝向按钮
  document.querySelectorAll('.dir-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.curDir = btn.dataset.dir;
      document.querySelectorAll('.dir-btn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
    });
  });

  // 部署页：随机布局 / 清空 / 确认 / 取消确认
  $('#btn-random').addEventListener('click', function () {
    if (state.deployConfirmed[state.seat]) {
      return toast('已确认部署，点「取消确认」才能修改');
    }
    const planes = randomDraft();
    if (!planes) return toast('生成失败，再点一次试试');
    state.draft = planes;
    saveDraft();
    renderDeployBoard();
    updateDeployUI();
  });
  $('#btn-clear').addEventListener('click', function () {
    state.draft = [];
    saveDraft();
    renderDeployBoard();
    updateDeployUI();
  });
  $('#btn-confirm').addEventListener('click', function () {
    if (state.draft.length !== curSpec().planeCount) return toast('请先放满 ' + curSpec().planeCount + ' 架飞机');
    state.socket.emit('deployConfirm', { planes: state.draft });
  });
  $('#btn-unconfirm').addEventListener('click', function () {
    state.socket.emit('deployCancel');
  });

  // 结束横幅：再来一局（返回菜单用对战页顶部的「← 返回菜单」按钮）
  $('#btn-rematch').addEventListener('click', function () {
    state.socket.emit('rematch');
  });

  // 道具面板：点道具进入选区模式（再点同一个 = 取消）。按钮 disabled 已挡掉
  // 金币不够/步数领先/观战/结束，这里再兜底校验一遍
  document.querySelectorAll('.item-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const id = btn.dataset.item;
      if (state.itemPick && state.itemPick.itemId === id) {
        clearItemPick();
        renderBattleBoards();
        updateItemButtons();
        return;
      }
      if (state.spectator) return toast('观战模式不能使用道具');
      if (state.over) return toast('对局已结束');
      if (state.steps[state.seat] > state.steps[1 - state.seat]) return toast('你的步数已领先，等待对方');
      if (state.coins[state.seat] < ITEM_PRICES[id]) return toast('金币不够，买不起这个道具');
      state.itemPick = { itemId: id };
      state.pickCells = [];
      state.pickAnchor = null;
      state.pickReady = false;
      renderBattleBoards(); // 进入选区模式：棋盘十字光标 + 清掉旧的悬停预览
      updateItemButtons();
    });
  });

  // 道具确认执行：把选区发给服务器（金币在服务器扣，这里只管发送）
  $('#item-confirm').addEventListener('click', function () {
    if (!state.itemPick || !state.pickReady) return;
    const id = state.itemPick.itemId;
    const data = { itemId: id };
    if (id === 'burst') {
      // 双发连射：2 个格子坐标
      const a = state.pickCells[0].split(',');
      const b = state.pickCells[1].split(',');
      data.row = +a[0]; data.col = +a[1];
      data.row2 = +b[0]; data.col2 = +b[1];
    } else if (id === 'sonar' || id === 'pro' || id === 'devour') {
      // 区域型道具：3x3 锚点（左上角）
      data.row = state.pickAnchor.row;
      data.col = state.pickAnchor.col;
    } else if (id === 'doom') {
      // 毁灭菇：十字中心格（pickCells[0] 就是中心）
      const a = state.pickCells[0].split(',');
      data.row = +a[0]; data.col = +a[1];
    } else {
      // 无所遁形：已揭示的机头格
      const a = state.pickCells[0].split(',');
      data.row = +a[0]; data.col = +a[1];
    }
    clearItemPick();
    state.socket.emit('useItem', data);
  });

  // 取消道具选择：清空选区，回到普通揭示模式
  $('#item-cancel').addEventListener('click', function () {
    clearItemPick();
    renderBattleBoards();
    updateItemButtons();
  });

  // 受邀加入页：确认加入 / 返回菜单
  $('#btn-invite-join').addEventListener('click', function () {
    const name = $('#invite-name-input').value;
    localStorage.setItem('bp_name', name.trim());
    // 房间号存在 state 里（而不是网址里），即使加入失败清掉了网址也能重试
    state.socket.emit('joinRoom', { roomId: state.inviteRoomId, name: name });
  });
  $('#btn-invite-back').addEventListener('click', function () {
    state.inviteRoomId = null;
    clearRoomFromUrl();
    showView('home');
  });

  // 首页「游戏规则」弹窗：打开 / 关闭（点深色背景也能关闭）
  $('#btn-rules').addEventListener('click', function () {
    $('#rules-modal').classList.remove('hidden');
  });
  $('#btn-rules-close').addEventListener('click', function () {
    $('#rules-modal').classList.add('hidden');
  });
  $('#rules-modal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  });

  // 「复制邀请链接」按钮（部署页 + 对战页）：复制带房间号的网址，发给朋友点开即可自动加入
  document.querySelectorAll('.btn-copy-link').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const url = location.origin + '/?room=' + state.roomId;
      // 剪贴板 API 只在 https 或 localhost 下可用；不可用时弹出输入框让用户手动复制
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          toast('邀请链接已复制，发给朋友即可加入');
        }, function () {
          window.prompt('复制这个链接发给朋友：', url);
        });
      } else {
        window.prompt('复制这个链接发给朋友：', url);
      }
    });
  });
}

// ---------- 启动 ----------
function init() {
  // 用原生 WebSocket 长连接（一次建立、持续复用，消息更快更稳）
  // ws.js 的 WSClient 接口与 socket.io 兼容，断开后自动重连
  state.socket = new WSClient();
  bindSocketEvents();
  bindUIEvents();
  applyTheme(); // 按上次选择 / 系统偏好设置主题（含右上角按钮图标）

  // 预生成三个棋盘
  makeBoard($('#deploy-board'), onDeployCellClick);
  makeBoard($('#my-board'), null);
  makeBoard($('#enemy-board'), onEnemyCellClick);

  // 画规则弹窗里的 4 张飞机朝向配图
  renderRulesDiagram();

  // 记住上次用的昵称
  const savedName = (localStorage.getItem('bp_name') || '').trim();
  if (savedName) $('#name-input').value = savedName;

  // 默认经典玩法 + S 规格（不恢复上次记忆：每次打开都从默认开始）
  state.homeMode = 'classic';
  renderHomeMode();

  renderRecentRooms();

  // 校验「最近加入的房间」里还有哪些房间活着，失效的自动删除
  const history = loadRoomHistory();
  if (history.length) {
    state.socket.emit('checkRooms', { roomIds: history.map(function (e) { return e.roomId; }) });
  }

  // 邀请链接：网址带 ?room=XXXX 时的处理
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(urlRoom)) {
    const entry = loadRoomHistory().find(function (e) { return e.roomId === urlRoom; });
    if (entry) {
      // 这个房间我进去过：走重连恢复自己的座位（而不是重新加入被「房间已满」挡掉）
      state.socket.emit('rejoin', { token: entry.token, roomId: entry.roomId });
    } else {
      // 朋友点开的邀请链接：显示专属「受邀加入」界面（不是菜单，没有创建房间等选项），
      // 房间号和昵称都填好，等 ta 点「加入房间」确认；也可以点「返回菜单」回普通首页
      state.inviteRoomId = urlRoom;
      $('#invite-room-id').textContent = urlRoom;
      $('#invite-name-input').value = savedName;
      showView('invite');
      if (!savedName) $('#invite-name-input').focus();
    }
  }
}

init();
