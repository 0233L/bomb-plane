// ============================================
// server.js —— 炸飞机游戏服务器（全部后端逻辑）
// 启动方式：node server.js （或 npm start）
// 然后浏览器打开 http://localhost:3000
//
// 设计原则：服务器是"裁判"。玩家的飞机坐标只存在服务器内存里，
// 客户端只能收到"某个格子被揭示后是什么"，无法作弊偷看对方。
// ============================================
'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs'); // 访客统计的落盘读写
const express = require('express');
const { WebSocketServer } = require('ws');

// 前后端共用的游戏逻辑（飞机形状、摆放校验等）
const shared = require('./public/shared.js');
const { BOARD_SIZE, CELL_EMPTY, CELL_HEAD, CELL_BODY, buildBoard, validateDeployment, getBoardSpec, getPlaneCells } = shared;

// ---------- 道具版经济常量（经典模式不用，仅 room.mode === 'props' 时生效） ----------
const COIN_START = 8;   // 开局每人金币
const COIN_EMPTY = 0;   // 揭示到空格的金币
const COIN_BODY = 1;    // 揭示到机身
const COIN_HEAD = 3;    // 揭示到机头（找到机头离胜利最近，奖励适度下调）

// ---------- 道具表（道具版） ----------
// 道具没有「持有」概念：使用时才购买，校验通过当场扣金币、立即生效。
// 价格初版，标注待实测调整；道具使用 = 一次标准行动（steps +1，双发连射 +2）。
const ITEM_PRICES = {
  sonar: 3,   // 声呐脉冲：3x3 区域显示非空格数量（0~9）
  pro: 2,     // 探测者：3x3 区域内随机揭示 1 格真实内容（机身→机头→空格；区域全空则揭示整个区域）
  burst: 5,   // 双发连射：一次行动揭示 2 格（只占一步）
  expose: 5,  // 无所遁形：对已揭示的机头使用，完整揭示整架飞机（10 格）
  devour: 5,  // 吞噬者：3x3 区域内所有未揭示格变为「摧毁」（机头被摧毁 = 发现飞机）
  doom: 10    // 毁灭菇：十字 5 格揭示 + 相邻未揭示格冻结（施放者接下来 2 次行动不能碰）
};

// 人机对战的 AI 决策模块（精确枚举 + 机头概率图）
const ai = require('./ai.js');

// 访客统计的 GitHub 保险柜（未配置 GITHUB_TOKEN/GITHUB_REPO 时自动跳过）
const githubBackup = require('./stats-github.js');

// ---------- 常量 ----------
const PORT = process.env.PORT || 3000;  // 部署到 Render 等平台时会自动注入 PORT
const RECYCLE_SECONDS = Number(process.env.RECYCLE_SECONDS) || 600; // 双方都离线后回收房间的等待时间（秒，默认 10 分钟）；可用环境变量覆盖（测试用）
const AI_THINK_MIN_MS = Number(process.env.AI_THINK_MIN_MS) || 800; // AI 每步"思考"延迟的随机范围（默认 0.8~1.5 秒，更像真人）；测试时可压小
const AI_THINK_MAX_MS = Number(process.env.AI_THINK_MAX_MS) || 1500;
const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 房间号字符表（去掉易混淆的 I/O/0/1）

// ---------- 访客统计常量 ----------
const STATS_KEY = process.env.STATS_KEY || 'bombplane-stats-2026'; // /stats 明细页的钥匙（数据无个人信息，默认值见 README；可在 Render 后台改）
const STATS_FILE = path.join(__dirname, 'stats.json');
const STATS_TMP_FILE = STATS_FILE + '.tmp'; // 先写临时文件再改名，保证不会写坏原文件
const STATS_SAVE_DELAY_MS = 1000; // 防抖：1 秒内的多次访问合并成一次写盘
const MIN_VISIT_GAP_MS = 5 * 60 * 1000; // 同一访客 5 分钟内的重复连接不算一次新访问（防重连刷频次）
const MAX_VISITORS = 20000; // 上限：防止恶意刷大量假 ID 撑爆内存

// ---------- 数据 ----------
const rooms = new Map(); // 房间号 -> 房间对象（内存存储，服务器重启后清空，当前规模够用）
const visitors = new Map(); // visitorId -> { platform, firstVisit, lastVisit, visits }（匿名，无任何个人信息）

// ---------- 工具函数 ----------

// 生成一个 4 位且不重复的房间号
function generateRoomId() {
  let id;
  do {
    id = '';
    for (let i = 0; i < 4; i++) {
      id += ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)];
    }
  } while (rooms.has(id));
  return id;
}

// 创建一个新房间
function createRoom() {
  return {
    id: generateRoomId(),
    players: [],              // 下标即座位 seat：先加入=0，后加入=1
    phase: 'waiting',         // waiting（等人）| deploy（部署）| battle（对战）| over（结束）
    mode: 'classic',          // classic（经典推理）| props（道具版：金币 + 道具）
    boardSize: 'S',           // 地图规格：S=10×10/3架 | M=12×12/4架 | L=14×14/6架
    coins: [COIN_START, COIN_START], // 道具版金币（开局各 8，每局重置；经典版不用）
    sonarHistory: [],         // 声呐脉冲的历史结果 [{row, col, count}]（观战/重连时补发）
    frozenCells: [],          // 毁灭菇冻结的格子 [{row, col, owner, expiry}]（只约束施放者自己）
    steps: [0, 0],            // 双方各揭示了多少格（步数）
    score: [0, 0],            // 双方累计胜场（同一房间连续对局，从第二局起显示）
    winner: null,             // 结束时的胜者 seat
    winReason: null,          // allHeads（任何情况都不判负，只有这一种结束方式）
    rematchVotes: [false, false], // 结束页"再来一局"的投票
    cleanupTimer: null,           // 双方都离线时的房间回收计时器
    spectators: [],               // 观战者列表 [{name, socketId}]（房间满员后可进入观战席）
    isAI: false,                  // 人机对战房间（AI 坐 1 号位，永不掉线）
    aiTimer: null,                // AI 走棋的定时器
    aiRematchTimer: null          // AI 自动投「再来一局」的定时器
  };
}

// 解析前端传来的玩法 + 规格（非法值一律回落经典默认，防篡改）
// hasOwnProperty：防止 data.boardSize 传 'constructor' / 'toString' 等原型链属性绕过校验
function parseMode(data) {
  return {
    mode: data.mode === 'props' ? 'props' : 'classic',
    boardSize: Object.prototype.hasOwnProperty.call(shared.BOARD_SPECS, data.boardSize) ? data.boardSize : 'S'
  };
}

// 计算双方还剩几个机头没被打中（随时从被揭示记录重算，避免状态不一致）
function headsLeftOf(room) {
  const planeCount = getBoardSpec(room.boardSize).planeCount;
  return [0, 1].map(function (seat) {
    const p = room.players[seat];
    if (!p) return 0;
    let heads = 0;
    p.shotsReceived.forEach(function (s) { if (s.result === 'head') heads++; });
    return planeCount - heads;
  });
}

// 给房间里所有在线玩家广播事件（roomConns 注册表见文件尾「连接层」）
function emitToRoom(room, event, data) {
  const set = roomConns.get(room.id);
  if (!set) return;
  set.forEach(function (conn) { conn.emit(event, data); });
}

// 房间双方头像数组（下标 = 座位，与 names 一一对应；空位返回 ''）
function avatarsOf(room) {
  // 固定按 2 个座位补齐（建房后 players 只有 1 位，但 names 广播固定 2 位，两者长度保持一致）
  return [0, 1].map(function (i) { return room.players[i] ? room.players[i].avatar || '' : ''; });
}

// 给单个 socket 发中文错误提示（客户端会弹小提示条）
function sendError(socket, message) {
  socket.emit('error', { message: message });
}

// 校验昵称：去空格后 1~12 字，且同房间内不重复
function checkName(room, name) {
  if (typeof name !== 'string') return '请输入昵称';
  const trimmed = name.trim();
  if (trimmed.length === 0) return '昵称不能为空';
  if (trimmed.length > 12) return '昵称最长 12 个字符';
  if (room && room.players.some(function (p) { return p.name === trimmed; })) {
    return '该昵称已被对方使用，换一个吧';
  }
  return null;
}

// 通过 socket 找到它所属的房间和座位（数据绑定 + token 双重校验）
function locate(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return null;
  const seat = socket.data.seat;
  const player = room.players[seat];
  if (!player || player.token !== socket.data.token) return null;
  return { room: room, player: player, seat: seat };
}

// 结束游戏：phase 改为 over 并广播结果。若已结束则直接返回（防止重复判负）
function endGame(room, winnerSeat, reason) {
  if (room.phase === 'over') return;
  room.phase = 'over';
  room.winner = winnerSeat;
  room.winReason = reason;
  room.score[winnerSeat] += 1; // 累计胜场（第二局起显示比分）
  console.log(`[${room.id}] 对局结束：seat${winnerSeat} 获胜（${reason}），比分 ${room.score[0]}:${room.score[1]}`);
  emitToRoom(room, 'gameOver', {
    winner: winnerSeat,
    reason: reason,
    headsLeft: headsLeftOf(room),
    score: room.score,
    planes: room.players.map(function (p) { return p ? p.planes : null; }) // 对局结束：公开双方飞机坐标
  });

  if (room.isAI) {
    // 对局结束：清掉还没触发的走棋定时器
    if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
    // AI 稍等片刻自动投「再来一局」票（和真人点按钮效果一样）
    room.aiRematchTimer = setTimeout(function () {
      room.aiRematchTimer = null;
      const r = rooms.get(room.id);
      if (!r || r.phase !== 'over') return; // 房间没了或已经重开
      r.rematchVotes[1] = true;
      console.log(`[${r.id}] AI 想再来一局`);
      emitToRoom(r, 'rematchVote', { seat: 1, votes: r.rematchVotes });
      // 玩家可能已经先点了「再来一局」，两票齐了就开
      if (r.rematchVotes[0]) startRematch(r);
    }, 1500);
  }
}

// 双方都同意再来一局：重置并进入新一轮部署（真人房间 + 人机房间共用）
function startRematch(room) {
  console.log(`[${room.id}] 双方同意再来一局`);
  resetToDeploy(room);
  emitToRoom(room, 'rematchStart', {
    names: room.players.map(function (p) { return p.name; }),
    avatars: avatarsOf(room)
  });
  if (room.isAI) aiDeployAndConfirm(room); // AI 自动重新部署
}

// 重置房间，回到部署阶段（第一次开战 / 再来一局共用）
function resetToDeploy(room) {
  // 防御性清理：任何时刻回到部署阶段，AI 的走棋定时器都不该再触发
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
  room.phase = 'deploy';
  room.steps = [0, 0];
  room.coins = [COIN_START, COIN_START]; // 每局金币清零重发（道具版）
  room.sonarHistory = [];                // 声呐历史每局清零
  room.frozenCells = [];                 // 毁灭菇冻结每局清零
  room.winner = null;
  room.winReason = null;
  room.rematchVotes = [false, false];
  room.players.forEach(function (p) {
    p.planes = null;          // 自己的 3 架飞机（只存服务端，绝不外发）
    p.board = null;           // 10×10 数组（0/1/2），揭示时查表用
    p.shotsReceived = [];     // 被对方揭示的记录 [{row, col, result}]
    p.deployConfirmed = false;
  });
}

// 玩家断线后的处理：只广播在线状态（对方的状态点变红），不做其它任何反应
function onDisconnect(room, seat) {
  const player = room.players[seat];
  player.connected = false;
  player.socketId = null;
  console.log(`[${room.id}] ${player.name} 断开连接`);
  emitToRoom(room, 'playerStatus', { seat: seat, connected: false });
  scheduleRoomCleanup(room);
}

// 真人玩家是否全部离线（人机房间里的 AI 永不掉线，只判断真人）
function allHumansOffline(room) {
  return room.players.every(function (p, seat) {
    if (!p) return true;
    if (room.isAI && seat === 1) return true; // AI 不算真人
    return !p.connected;
  });
}

// 真人全部离线时启动房间回收计时；到点后再确认一次，期间有人回来就不回收
function scheduleRoomCleanup(room) {
  if (!allHumansOffline(room) || room.cleanupTimer) return;
  console.log(`[${room.id}] 真人全部离线，${RECYCLE_SECONDS} 秒后回收房间`);
  room.cleanupTimer = setTimeout(function () {
    const r = rooms.get(room.id);
    if (!r) return;
    r.cleanupTimer = null;
    if (allHumansOffline(r)) {
      console.log(`[${room.id}] 真人离线超时，回收房间`);
      emitToRoom(r, 'roomClosed', { message: '双方都已离开，房间已回收' }); // 提醒还挂着的观战者
      // 清掉 AI 的定时器，防止回收后还触发
      if (r.aiTimer) clearTimeout(r.aiTimer);
      if (r.aiRematchTimer) clearTimeout(r.aiRematchTimer);
      rooms.delete(room.id);
    }
  }, RECYCLE_SECONDS * 1000);
}

// 主动离开房间：不判负，和断线一样只是暂停，随时可以凭凭证回来继续
function onLeave(room, seat, socket) {
  const player = room.players[seat];
  player.left = true;
  console.log(`[${room.id}] ${player.name} 离开，对局暂停等待重连`);

  if (room.phase === 'waiting') {
    // 还没开局就离开，直接销毁房间（对局还没开始，不涉及判负）
    console.log(`[${room.id}] 开局前离开，房间销毁`);
    rooms.delete(room.id);
  }

  // 解绑 socket 并走断线流程（对方只会看到在线状态变红点）
  socket.leave(room.id);
  socket.data.roomId = null;
  socket.data.seat = null;
  socket.data.token = null;
  onDisconnect(room, seat);
  socket.emit('leftRoom', {}); // 客户端收到后清空草稿、回首页
}

// 同一条连接可能还绑着旧房间（网页端全局复用一条 WS 连接，退出后再建房/加入时，
// 旧房间的注册表里仍挂着这条连接 → 旧房间永不回收，还会收到它的广播）。
// 进新房间前先解绑旧绑定：旧对局按「暂停」处理（玩家标记离线，交给回收计时器），
// 不广播 leftRoom——否则刚发起的建房流程会被打断；想回去可凭凭证 rejoin。
function unbindRoom(socket) {
  const old = socket.data.roomId;
  const oldSeat = socket.data.seat;
  socket.data.roomId = null;
  socket.data.seat = null;
  socket.data.token = null;
  if (!old) return;
  socket.leave(old); // 从 roomConns 注册表移除，旧房间广播不再打扰
  const room = rooms.get(old);
  if (!room) return;
  const player = room.players[oldSeat];
  if (!player || player.socketId !== socket.id) return; // 旧座位已换人/观战者，不用管
  if (room.phase === 'waiting') {
    // 还没开局就离开：直接销毁房间（与 onLeave 同规则）
    rooms.delete(room.id);
  } else {
    onDisconnect(room, oldSeat); // 标记离线：对局暂停，可凭凭证回来，或超时回收
  }
}

// ---------- Socket 事件处理 ----------

// 创建房间（坐 0 号位）
function handleCreateRoom(socket, data) {
  unbindRoom(socket); // 防同连接残留旧房间绑定（详见 unbindRoom）
  const name = (typeof data.name === 'string' ? data.name : '').trim();
  const err = checkName(null, name);
  if (err) return sendError(socket, err);

  const room = createRoom();
  const p = parseMode(data);
  room.mode = p.mode;
  room.boardSize = p.boardSize;
  const token = crypto.randomBytes(8).toString('hex'); // 身份凭证，重连用
  room.players[0] = {
    name: name, token: token,
    avatar: Array.from(String(data.avatar || '')).slice(0, 4).join(''), // 头像纯转发不校验；按码点截 4 个防超大消息（slice 会截出半个 emoji）
    socketId: socket.id, connected: true, left: false,
    planes: null, board: null, shotsReceived: [],
    deployConfirmed: false
  };
  rooms.set(room.id, room);

  socket.data.roomId = room.id;
  socket.data.seat = 0;
  socket.data.token = token;
  socket.join(room.id);
  console.log(`[${room.id}] 房间创建（${p.mode}/${p.boardSize}），玩家：${name}`);

  socket.emit('roomCreated', {
    roomId: room.id, token: token, seat: 0, name: name,
    names: [name, ''],
    avatars: avatarsOf(room),
    online: [true, false],
    isAI: false,
    mode: p.mode,
    boardSize: p.boardSize,
    deployConfirmed: [false, false]
  });
}

// 创建人机对战房间：真人坐 0 号位，AI 立刻坐 1 号位并自动部署
function handleCreateRoomAI(socket, data) {
  unbindRoom(socket); // 防同连接残留旧房间绑定（详见 unbindRoom）
  const name = (typeof data.name === 'string' ? data.name : '').trim();
  const err = checkName(null, name);
  if (err) return sendError(socket, err);

  const room = createRoom();
  room.isAI = true;
  // 玩法 × 规格自由组合：经典规格走 ai.js 的精确枚举算法，其余组合走简单贪心
  // （ai.js 提供两种决策：chooseTargetLive = S 规格最优算法；chooseTargetSimple = 任意规格通用）
  const p = parseMode(data);
  room.mode = p.mode;
  room.boardSize = p.boardSize;

  const token = crypto.randomBytes(8).toString('hex'); // 身份凭证，重连用
  room.players[0] = {
    name: name, token: token,
    avatar: Array.from(String(data.avatar || '')).slice(0, 4).join(''), // 头像纯转发不校验；按码点截 4 个防超大消息（slice 会截出半个 emoji）
    socketId: socket.id, connected: true, left: false,
    planes: null, board: null, shotsReceived: [],
    deployConfirmed: false
  };
  // AI 坐 1 号位：没有 socket，永不掉线，走棋由服务器定时器驱动
  room.players[1] = {
    name: '🤖 电脑', token: crypto.randomBytes(8).toString('hex'),
    avatar: '', // AI 不用头像：昵称「🤖 电脑」自带机器人图标，避免头像和图标重复
    socketId: null, connected: true, left: false,
    planes: null, board: null, shotsReceived: [],
    deployConfirmed: false
  };
  rooms.set(room.id, room);
  resetToDeploy(room); // 真人房间靠第二人加入时切到部署阶段，人机房间在这里切

  socket.data.roomId = room.id;
  socket.data.seat = 0;
  socket.data.token = token;
  socket.join(room.id);
  console.log(`[${room.id}] 人机房间创建，玩家：${name}`);

  socket.emit('roomCreated', {
    roomId: room.id, token: token, seat: 0, name: name,
    names: [name, '🤖 电脑'],
    avatars: avatarsOf(room),
    online: [true, true],
    isAI: true,
    mode: room.mode,
    boardSize: room.boardSize,
    deployConfirmed: [false, true] // AI 马上就自动确认部署
  });

  aiDeployAndConfirm(room); // AI 随机部署并确认
}

// AI 自动部署并确认（创建人机房间时、每局重新开始时调用）
function aiDeployAndConfirm(room) {
  const aiPlayer = room.players[1];
  const planes = ai.smartDeployment(room.boardSize);
  if (!planes) return console.error(`[${room.id}] AI 生成部署失败（极少见，忽略即可）`);
  aiPlayer.planes = planes;
  aiPlayer.board = buildBoard(planes, room.boardSize);
  aiPlayer.deployConfirmed = true;
  console.log(`[${room.id}] AI 确认部署`);
  emitToRoom(room, 'deployReady', {
    seat: 1,
    confirmed: [room.players[0].deployConfirmed, true]
  });
}

// 轮到 AI 时安排它走一步（带随机"思考"延迟，更像真人）。
// 触发时机：开战 / 每次揭示后 / 玩家重连回来；玩家断线时 AI 暂停等待
function scheduleAITurn(room) {
  if (!room.isAI || room.aiTimer) return;      // 已经有定时器在等
  if (room.phase !== 'battle') return;         // 只在对战阶段走棋
  const human = room.players[0];
  if (!human || !human.connected) return;      // 玩家不在线：暂停，等重连
  if (room.steps[1] > room.steps[0]) return;   // 步数领先时等待玩家追上（和真人同一套规则）

  const thinkMs = crypto.randomInt(AI_THINK_MIN_MS, AI_THINK_MAX_MS + 1);
  room.aiTimer = setTimeout(function () {
    room.aiTimer = null;
    const r = rooms.get(room.id);
    if (!r || r.phase !== 'battle') return;           // 房间被回收 / 对局已结束
    const h = r.players[0];
    if (!h || !h.connected) return;                   // 玩家中途断线：暂停
    if (r.steps[1] > r.steps[0]) return;              // 玩家抢步领先了：等待

    // —— AI 行动（与真人共用同一套服务器规则：步数门控 / 金币 / 冻结 / 区域校验） ——
    const size = getBoardSpec(r.boardSize).size;
    const shots = r.players[0].shotsReceived;
    // 只有「自己施放的冻结」才限制自己（对手的冻结只约束对手，见 isFrozenCell）
    const myFrozen = r.frozenCells.filter(function (f) { return f.owner === 1; })
      .map(function (f) { return { row: f.row, col: f.col }; });
    // 选格算法：经典/S 用精确枚举最优算法（第 7 轮调校成果，行为不变）；
    // 其余组合用采样概率场（AI 加强第 2 步）；AI_PROB_FIELD=0 回退旧简单贪心。
    // 概率场只采样一次，选格与道具决策共用
    const useLive = (r.boardSize === 'S' && r.mode === 'classic');
    let pf = null;
    let target1 = null;
    if (useLive) {
      target1 = ai.chooseTargetLive(shots);
    } else if (process.env.AI_PROB_FIELD === '0') {
      target1 = ai.chooseTargetSimple(shots, size, myFrozen);
    } else {
      // AI 的声呐数字一并传入：数字对候选约束有信息价值（计数 0 = 区域全空、非零 = 精确计数）
      pf = ai.buildProbField(shots, size, {
        samples: aiSamples,
        sonarCounts: r.sonarHistory.filter(function (s) { return s.attacker === 1; })
      });
      target1 = (pf.head ? ai.chooseTargetProbField(shots, size, myFrozen, { probField: pf }) : null)
        || ai.chooseTargetSimple(shots, size, myFrozen); // 概率场失败兜底，别停摆
    }

    let acted = false; // 道具使用成功 = true（省得走普通揭示）
    if (r.mode === 'props' && target1) {
      // 道具版 AI 道具决策（AI 加强第 3 步：价值驱动，不再瞎概率；
      // 被服务器拒绝时自动退回普通揭示）
      const item = aiDecideItem(r, shots, size, myFrozen, pf);
      if (item) {
        acted = !doUseItem(r, 1, item.itemId, item.data);
        if (acted) console.log(`[${r.id}] AI 使用 ${item.itemId}`);
      }
    }
    if (!acted && target1) {
      tryReveal(r, 1, target1.row, target1.col);
    }

    // 走完一步若还轮得到 AI（比如之前落后一步），继续调度
    if (r.phase === 'battle' && r.steps[1] <= r.steps[0]) scheduleAITurn(r);
  }, thinkMs);
}

// 概率场采样份数（AI 加强：env AI_SAMPLES 可调）
const aiSamples = parseInt(process.env.AI_SAMPLES || '120', 10);

// AI 道具决策（AI 加强第 3 步：价值驱动）。返回 {itemId, data}；不用返回 null。
// 优先级（每步最多用一个道具）：
//   1. 无所遁形：机头已找到且整机未完整揭示 → 5 金币换整机 10 格信息，非常值
//   2. 毁灭菇：金币 ≥10 且残局（未揭示 ≤30%）→ 概率密度最高的十字中心，收割 + 冻结
//   3. 双发：金币 ≥5 且概率场 top2 格都 ≥0.35（确定性够高才花 5 金币）
//   4. 声呐：金币 ≥3 且锚点分布熵 ≥0.4（信息价值足够才用）
//   5. 探测者：金币富余（≥8）且概率场峰值 ≥0.5（与普通揭示等价，低优先级）
// 吞噬者永不用：摧毁的格子 AI 自己也永远探测不了 = 自损信息，赌 25% 机头不值 6 金币
function aiDecideItem(room, shots, size, myFrozen, pf) {
  const coins = room.coins[1];
  // 1) 无所遁形（价格 5，阈值联动）
  if (coins >= 5) {
    const head = ai.findExposeHead(shots, size);
    if (head) return { itemId: 'expose', data: { row: head.row, col: head.col } };
  }
  // 2) 毁灭菇（残局收割）
  if (coins >= 10 && pf && pf.head) {
    const unknown = size * size - shots.length; // 每枪揭示 1 格（AI 不用吞噬者）
    if (unknown <= size * size * 0.3) {
      const center = ai.bestDoomCenter(pf, size, myFrozen);
      if (center) return { itemId: 'doom', data: { row: center.row, col: center.col } };
    }
  }
  // 概率场还没建出来（概率场失败兜底路径）→ 不再考虑价值道具
  if (!pf || !pf.head) return null;
  // 3) 双发：未揭示未冻结格按 (P头+P身) 排序，top2 都够高才用
  const revealed = new Set();
  shots.forEach(function (s) { revealed.add(s.row * size + s.col); });
  const scored = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (revealed.has(r * size + c)) continue;
      if (isFrozenCell(room, 1, r, c)) continue;
      scored.push({
        row: r, col: c,
        v: pf.head[r * size + c] + pf.body[r * size + c]
      });
    }
  }
  scored.sort(function (a, b) { return b.v - a.v; });
  if (coins >= 5 && scored.length >= 2 && scored[0].v >= 0.35 && scored[1].v >= 0.35) {
    return {
      itemId: 'burst',
      data: { row: scored[0].row, col: scored[0].col, row2: scored[1].row, col2: scored[1].col }
    };
  }
  // 4) 声呐：锚点分布熵 ≥0.4 才有信息价值
  if (coins >= 3) {
    const anchor = ai.chooseSonarAnchor(pf, size, myFrozen);
    if (anchor && anchor.entropy >= 0.4) {
      return { itemId: 'sonar', data: { row: anchor.row, col: anchor.col } };
    }
  }
  // 5) 探测者：金币富余 + 概率峰值高
  if (coins >= 8 && scored.length && scored[0].v >= 0.5) {
    return { itemId: 'pro', data: { row: scored[0].row, col: scored[0].col } };
  }
  return null;
}

// 加入房间：不满 2 人坐 1 号位；满员则进入观战席
function handleJoinRoom(socket, data) {
  unbindRoom(socket); // 防同连接残留旧房间绑定（详见 unbindRoom）
  const roomId = String(data.roomId || '').toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return sendError(socket, '房间不存在，请检查房间号');

  const name = (typeof data.name === 'string' ? data.name : '').trim();
  if (!name) return sendError(socket, '昵称不能为空');
  if (name.length > 12) return sendError(socket, '昵称最长 12 个字符');

  // 满员 → 观战席（观战者昵称不和玩家查重，可以随便起）
  if (room.players.length >= 2) return handleSpectatorJoin(socket, room, name);

  const err = checkName(room, name); // 玩家还要查同房重名
  if (err) return sendError(socket, err);

  const token = crypto.randomBytes(8).toString('hex');
  room.players[1] = {
    name: name, token: token,
    avatar: Array.from(String(data.avatar || '')).slice(0, 4).join(''), // 头像纯转发不校验；按码点截 4 个防超大消息（slice 会截出半个 emoji）
    socketId: socket.id, connected: true, left: false,
    planes: null, board: null, shotsReceived: [],
    deployConfirmed: false
  };

  socket.data.roomId = room.id;
  socket.data.seat = 1;
  socket.data.token = token;
  socket.join(room.id);
  console.log(`[${room.id}] ${name} 加入房间，进入部署阶段`);

  resetToDeploy(room); // 满员，进入部署阶段

  socket.emit('joinedRoom', {
    roomId: room.id, token: token, seat: 1, name: name,
    names: [room.players[0].name, name],
    avatars: avatarsOf(room),
    online: [room.players[0].connected, true], // 房主可能正处于断线中
    mode: room.mode,
    boardSize: room.boardSize
  });
  // 通知房主：对手来了
  emitToOthers(socket, room.id, 'opponentJoined', {
    names: [room.players[0].name, name],
    avatars: avatarsOf(room)
  });
}

// 观战席：房间已满时进入。能看双方已揭示的格子，不能下棋；
// 平时只拿到双方互相可见的揭示记录；对局结束后才公开双方飞机坐标
function handleSpectatorJoin(socket, room, name) {
  room.spectators.push({ name: name, socketId: socket.id });
  socket.data.roomId = room.id;
  socket.data.spectator = true; // 没有 seat/token，玩家操作（locate）一律查不到它
  socket.join(room.id);
  console.log(`[${room.id}] ${name} 进入观战席（共 ${room.spectators.length} 人）`);

  socket.emit('spectatorJoined', {
    roomId: room.id,
    phase: room.phase,
    mode: room.mode,
    boardSize: room.boardSize,
    coins: room.coins,
    names: room.players.map(function (p) { return p.name; }),
    avatars: avatarsOf(room),
    online: room.players.map(function (p) { return p.connected; }),
    steps: room.steps,
    score: room.score,
    headsLeft: headsLeftOf(room),
    shots: room.players.map(function (p) { return p.shotsReceived; }), // [A 被打的, B 被打的]
    sonarHistory: room.sonarHistory, // 声呐数字历史（观战者也能看到）
    frozenCells: activeFrozenCells(room), // 毁灭菇冻结格（观战者也能看到 ❄）
    winner: room.winner,
    winReason: room.winReason,
    planes: room.phase === 'over' ? room.players.map(function (p) { return p.planes; }) : null
  });
  emitToRoom(room, 'spectatorCount', { count: room.spectators.length });
}

// 观战者离开（主动离开或断线）：移除并广播最新观战人数
function removeSpectator(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;
  room.spectators = room.spectators.filter(function (s) { return s.socketId !== socket.id; });
  emitToRoom(room, 'spectatorCount', { count: room.spectators.length });
}

// 断线重连：凭 token + 房间号恢复现场。
// 注意：这里绝不能调用 unbindRoom——重连总是用新连接（data.roomId 本来就是 null，
// 旧连接由下方 oldConn.disconnect() 顶掉）；若对无效 rejoin（坏 token / 假房间号）
// 也解绑当前连接，会把玩家当前所在房间按「离开」处理，waiting 房间甚至直接销毁。
function handleRejoin(socket, data) {
  const roomId = String(data.roomId || '').toUpperCase();
  const token = String(data.token || '');
  const room = rooms.get(roomId);
  // 失败时把 roomId 一起发回，客户端好从「最近加入的房间」列表里删掉失效条目
  if (!room) return socket.emit('rejoinFailed', { roomId: roomId, message: '对局不存在或已结束' });

  let seat = -1;
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].token === token) { seat = i; break; }
  }
  if (seat === -1) return socket.emit('rejoinFailed', { roomId: roomId, message: '身份凭证无效，无法恢复对局' });

  const player = room.players[seat];

  // 如果旧连接还活着（比如在另一个标签页），先顶掉它，
  // 清空它的房间绑定，这样它的 disconnect 事件不会误触断线流程
  const oldConn = allConns.get(player.socketId);
  if (oldConn && oldConn.id !== socket.id) {
    oldConn.data.roomId = null;
    oldConn.data.seat = null;
    oldConn.data.token = null;
    oldConn.disconnect(); // ws.close() → onclose → handleDisconnect，此时 locate 查不到它，忽略
  }

  // 把新连接绑定到房间
  socket.data.roomId = roomId;
  socket.data.seat = seat;
  socket.data.token = token;
  socket.join(roomId);
  player.socketId = socket.id;
  player.connected = true;
  player.left = false;
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  console.log(`[${room.id}] ${player.name} 重连成功`);

  // 广播在线状态（对方的状态点变绿）
  emitToRoom(room, 'playerStatus', { seat: seat, connected: true });

  // 人机房间：玩家回来了，AI 恢复行动
  if (room.isAI && room.phase === 'battle') scheduleAITurn(room);

  // 拼出完整现场发给重连方（只含公开信息；对局结束后才公开双方飞机坐标）
  const enemy = room.players[1 - seat];
  socket.emit('reconnected', {
    roomId: roomId,
    seat: seat,
    name: player.name,
    names: room.players.map(function (p) { return p ? p.name : ''; }),
    avatars: avatarsOf(room),
    online: room.players.map(function (p) { return !!p && p.connected; }),
    phase: room.phase,
    mode: room.mode,
    boardSize: room.boardSize,
    coins: room.coins,
    steps: room.steps,
    score: room.score,
    headsLeft: headsLeftOf(room),
    deployConfirmed: [0, 1].map(function (i) {
      return !!(room.players[i] && room.players[i].deployConfirmed);
    }),
    myPlanes: player.planes,              // 自己的飞机（已确认时才有）
    myShotsReceived: player.shotsReceived,      // 对方打我的记录
    enemyShotsReceived: enemy ? enemy.shotsReceived : [], // 我打对方的记录
    sonarHistory: room.sonarHistory, // 声呐数字历史（断线重连后还能看到）
    frozenCells: activeFrozenCells(room), // 毁灭菇冻结格（断线重连后还能看到 ❄）
    winner: room.winner,
    winReason: room.winReason,
    rematchVotes: room.rematchVotes,
    isAI: room.isAI,                      // 人机对战房间标记（前端据此显示）
    planes: room.phase === 'over' ? room.players.map(function (p) { return p ? p.planes : null; }) : null
  });
}

// 确认部署：服务端完整校验后才接受
function handleDeployConfirm(socket, data) {
  const loc = locate(socket);
  if (!loc) return sendError(socket, '你不在任何房间中');
  const room = loc.room, player = loc.player, seat = loc.seat;
  if (room.phase !== 'deploy') return sendError(socket, '现在不是部署阶段');
  if (player.deployConfirmed) return sendError(socket, '你已经确认过了');

  const err = validateDeployment(data.planes, room.boardSize);
  if (err) return sendError(socket, err);

  // 保存（只存服务端，绝不外发）
  player.planes = data.planes.map(function (p) {
    return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
  });
  player.board = buildBoard(player.planes, room.boardSize);
  player.deployConfirmed = true;
  console.log(`[${room.id}] ${player.name} 确认部署`);

  const confirmed = [room.players[0].deployConfirmed, room.players[1].deployConfirmed];
  emitToRoom(room, 'deployReady', { seat: seat, confirmed: confirmed });

  if (confirmed[0] && confirmed[1]) {
    // 双方都确认，开战！步数归零：双方都可行动（无先手后手之分）
    room.phase = 'battle';
    room.steps = [0, 0];
    console.log(`[${room.id}] 双方部署完成，开战（${room.mode}/${room.boardSize}）`);
    emitToRoom(room, 'battleStart', {
      names: room.players.map(function (p) { return p.name; }),
      avatars: avatarsOf(room),
      steps: room.steps,
      score: room.score,
      online: room.players.map(function (p) { return p.connected; }),
      mode: room.mode,
      boardSize: room.boardSize,
      coins: room.coins
    });
    if (room.isAI) scheduleAITurn(room); // 人机房间：轮到 AI 就自动走棋
  }
}

// 取消确认（想改部署时反悔）
function handleDeployCancel(socket) {
  const loc = locate(socket);
  if (!loc) return sendError(socket, '你不在任何房间中');
  const room = loc.room, player = loc.player, seat = loc.seat;
  if (room.phase !== 'deploy') return sendError(socket, '现在不是部署阶段');
  if (!player.deployConfirmed) return sendError(socket, '你还没有确认，无需取消');

  player.deployConfirmed = false;
  console.log(`[${room.id}] ${player.name} 取消确认`);
  emitToRoom(room, 'deployReady', {
    seat: seat,
    confirmed: [room.players[0].deployConfirmed, room.players[1].deployConfirmed]
  });
}

// 揭示对方一个格子（对战核心操作）
function handleReveal(socket, data) {
  const loc = locate(socket);
  if (!loc) return sendError(socket, '你不在任何房间中');
  const room = loc.room, seat = loc.seat;
  if (room.phase !== 'battle') return sendError(socket, '现在还不能攻击（未开战或已结束）');

  const row = data.row, col = data.col;
  const size = getBoardSpec(room.boardSize).size;
  if (!Number.isInteger(row) || !Number.isInteger(col) ||
      row < 0 || row >= size || col < 0 || col >= size) {
    return sendError(socket, '坐标无效');
  }

  const defender = room.players[1 - seat];
  if (defender.shotsReceived.some(function (s) { return s.row === row && s.col === col; })) {
    return sendError(socket, '这个格子已经揭示过了');
  }

  // 冻结检查：施放者自己在冻结期内不能揭示冻结格（对手不受限）
  if (isFrozenCell(room, seat, row, col)) {
    return sendError(socket, '这个格子被毁灭菇冻结，你还不能揭示它');
  }

  // 步数规则：步数超过对方的人不能行动（相等时双方都可行动，先到先得）
  if (room.steps[seat] > room.steps[1 - seat]) {
    return sendError(socket, '你的步数已领先，等待对方追上');
  }

  // —— 全部校验通过，执行揭示 ——
  tryReveal(room, seat, row, col);
}

// 执行一次揭示：查表、记录、步数 +1、金币结算、广播、判胜（调用前已通过全部校验）
// 真人玩家（handleReveal）和 AI（scheduleAITurn）共用，保证两边遵守同一套规则
function tryReveal(room, seat, row, col, noStep) {
  // 防御性冻结检查（AI 路径兜底；调用方已校验过，正常流程不会走到）
  if (isFrozenCell(room, seat, row, col)) return false;
  const defender = room.players[1 - seat];
  const cell = defender.board[row][col];
  const result = cell === CELL_HEAD ? 'head' : cell === CELL_BODY ? 'body' : 'empty';
  defender.shotsReceived.push({ row: row, col: col, result: result });
  if (!noStep) room.steps[seat] += 1; // noStep：双发连射第 2 格不再计步（双发总共只占一步）

  // 道具版：揭示赚金币（空格 0 / 机身 1 / 机头 3）；经典版不结算
  let coinGain = 0;
  if (room.mode === 'props') {
    coinGain = result === 'head' ? COIN_HEAD : result === 'body' ? COIN_BODY : COIN_EMPTY;
    room.coins[seat] += coinGain;
  }
  console.log(`[${room.id}] ${room.players[seat].name} 揭示 (${row},${col}) = ${result}` + (coinGain > 0 ? ' +' + coinGain + ' 金币' : ''));

  const headsLeft = headsLeftOf(room);
  emitToRoom(room, 'revealResult', {
    attacker: seat, row: row, col: col, result: result,
    headsLeft: headsLeft, steps: room.steps,
    coinGain: coinGain, coins: room.coins
  });

  // 对方 3 个机头全被揭示 → 我方获胜
  if (headsLeft[1 - seat] === 0) {
    endGame(room, seat, 'allHeads');
    return;
  }

  if (room.isAI) scheduleAITurn(room); // 人机房间：每次揭示后看是否轮到 AI
}

// ---------- 道具（道具版） ----------

// 揭示一个格子（记录 + 金币结算），不改变步数——毁灭菇一次行动揭示 5 格专用。
// 普通揭示/连射走 tryReveal（每次 +1 步），毁灭菇统一只 +1 步。
function revealCell(room, seat, row, col) {
  const defender = room.players[1 - seat];
  const cell = defender.board[row][col];
  const result = cell === CELL_HEAD ? 'head' : cell === CELL_BODY ? 'body' : 'empty';
  defender.shotsReceived.push({ row: row, col: col, result: result });
  let coinGain = 0;
  if (room.mode === 'props') {
    coinGain = result === 'head' ? COIN_HEAD : result === 'body' ? COIN_BODY : COIN_EMPTY;
    room.coins[seat] += coinGain;
  }
  return { row: row, col: col, result: result };
}

// 3x3 区域校验：左上角 (row, col) 必须完整落在棋盘内（3x3 固定大小，不随规格缩放）
function checkRegion(row, col, size) {
  return Number.isInteger(row) && Number.isInteger(col) &&
    row >= 0 && col >= 0 && row + 3 <= size && col + 3 <= size;
}

// 区域内 9 个格子坐标
function regionCells(row, col) {
  const cells = [];
  for (let r = row; r < row + 3; r++) {
    for (let c = col; c < col + 3; c++) cells.push([r, c]);
  }
  return cells;
}

// 毁灭菇的十字 5 格（中心 + 上下左右）
function crossCells(row, col) {
  return [[row, col], [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
}

// 8 邻域坐标（边界裁剪，不含自身）——毁灭菇冻结范围
function neighbor8(row, col, size) {
  const cells = [];
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      if (r >= 0 && r < size && c >= 0 && c < size && !(r === row && c === col)) cells.push([r, c]);
    }
  }
  return cells;
}

// ---------- 毁灭菇冻结（只约束施放者自己，对手不受任何影响） ----------

// 施放方 (seat) 在 (row, col) 是否仍被冻结：
// 施放后 steps[seat] = S+1，expiry = S+3；steps[seat] < expiry 时行动仍受限制
// （接下来 2 次行动），到第 3 次行动（steps = S+3）解除。非施放方永远 false。
function isFrozenCell(room, seat, row, col) {
  // 防御性：已经揭示过的格子不再冻结（玩家已看到内容，冻结无意义；
  // 正常流程冻结格在被揭示前就过期，这里是防未来逻辑变化）
  const defender = room.players[1 - seat];
  if (defender.shotsReceived.some(function (s) { return s.row === row && s.col === col; })) return false;
  return room.frozenCells.some(function (f) {
    return f.owner === seat && room.steps[seat] < f.expiry && f.row === row && f.col === col;
  });
}

// 一组格子中是否含冻结格（区域型道具整体拒绝用）
function hasFrozenCell(room, seat, cells) {
  return cells.some(function (c) { return isFrozenCell(room, seat, c[0], c[1]); });
}

// 未过期的冻结格（观战/重连快照用；对局结束后全部公开，不再报冻结）
function activeFrozenCells(room) {
  if (room.phase === 'over') return [];
  return room.frozenCells.filter(function (f) { return room.steps[f.owner] < f.expiry; });
}

// 道具结算公共部分：扣金币、步数 +1、广播 itemResult、判胜、调度 AI
// 返回 false 表示已经结束对局（调用方不要再继续）
function finishItem(room, seat, itemId, payload) {
  const headsLeft = headsLeftOf(room);
  emitToRoom(room, 'itemResult', Object.assign({
    itemId: itemId,
    attacker: seat,
    steps: room.steps,
    coins: room.coins,
    headsLeft: headsLeft
  }, payload));
  if (headsLeft[1 - seat] === 0) {
    endGame(room, seat, 'allHeads'); // 道具直接摧毁/找到最后一个机头 → 同样获胜
    return false;
  }
  if (room.isAI) scheduleAITurn(room); // 人机房间：使用道具也占一步，之后可能轮到 AI
  return true;
}

// 使用道具（道具版核心操作）：所有判定都在服务器，客户端只提供选择
// 使用道具的「校验 + 执行」主体（真人 handleUseItem 和 AI 共用同一套规则）。
// 返回 null = 成功；返回字符串 = 错误消息（真人弹提示条，AI 忽略并转为普通揭示）
function doUseItem(room, seat, itemId, data) {
  const price = ITEM_PRICES[itemId];
  if (!price) return '没有这个道具';

  // 步数规则（和揭示完全一样）：领先者不能行动
  if (room.steps[seat] > room.steps[1 - seat]) {
    return '你的步数已领先，等待对方追上';
  }

  // 金币检查：使用即购买（先校验后扣费，绝不提前扣钱）
  if (room.coins[seat] < price) {
    return '金币不够，买不起这个道具';
  }

  const size = getBoardSpec(room.boardSize).size;
  const defender = room.players[1 - seat];

  if (itemId === 'sonar') {
    // 声呐脉冲：3x3 区域内非空格数量（只发数字，不泄露位置）
    const row = data.row, col = data.col;
    if (!checkRegion(row, col, size)) return '区域越界（3x3 必须完整落在棋盘内）';
    if (hasFrozenCell(room, seat, regionCells(row, col))) return '选区里包含冻结的格子，还不能选中';
    let count = 0;
    regionCells(row, col).forEach(function (cell) {
      if (defender.board[cell[0]][cell[1]] !== CELL_EMPTY) count++;
    });
    room.coins[seat] -= price;
    room.steps[seat] += 1;
    // 记录历史（观战/重连补发）。attacker = 施放者座位：声呐探测的是「对方的棋盘」，
    // 客户端靠它判断结果数字要画在谁的棋盘上（施放者视角 = 对方棋盘，被探测者视角 = 自己的棋盘）
    room.sonarHistory.push({ row: row, col: col, count: count, attacker: seat });
    console.log(`[${room.id}] ${room.players[seat].name} 声呐脉冲 (${row},${col}) = ${count} 个非空格`);
    finishItem(room, seat, 'sonar', { row: row, col: col, count: count });
    return;
  }

  if (itemId === 'pro') {
    // 探测者：3x3 内按 机身→机头→空格 的优先级随机揭示 1 格真实内容；
    // 若区域内没有任何飞机（未揭示格全空）：一次性揭示整个 3x3 区域
    const row = data.row, col = data.col;
    if (!checkRegion(row, col, size)) return '区域越界（3x3 必须完整落在棋盘内）';
    if (hasFrozenCell(room, seat, regionCells(row, col))) return '选区里包含冻结的格子，还不能选中';
    const open = regionCells(row, col).filter(function (cell) {
      return !defender.shotsReceived.some(function (s) {
        return s.row === cell[0] && s.col === cell[1];
      });
    });
    if (!open.length) return '这个区域已经全部揭示过了';
    const tiers = [[], [], []]; // 按格子类型分桶：0=空 1=机身 2=机头
    open.forEach(function (cell) { tiers[defender.board[cell[0]][cell[1]]].push(cell); });
    if (!tiers[CELL_BODY].length && !tiers[CELL_HEAD].length) {
      // 整片全空：一次行动把整个区域逐格揭示为空（空格 0 金币，不需要额外结算）。
      // 发 9 条 revealResult（与逐格揭示同协议），客户端逐条渲染即得整片空区
      room.coins[seat] -= price; // 先扣费（空格揭示不赚金币）
      room.steps[seat] += 1;     // 一次行动只占一步
      const headsLeft = headsLeftOf(room); // 全是空格，机头剩余数不变
      open.forEach(function (cell) {
        defender.shotsReceived.push({ row: cell[0], col: cell[1], result: 'empty' });
        emitToRoom(room, 'revealResult', {
          attacker: seat, row: cell[0], col: cell[1], result: 'empty',
          headsLeft: headsLeft, steps: room.steps, coinGain: 0, coins: room.coins
        });
      });
      console.log(`[${room.id}] ${room.players[seat].name} 探测者 (${row},${col}) 全空 → 揭示整个 3x3`);
      if (room.isAI) scheduleAITurn(room); // 人机房间：用道具占一步，之后可能轮到 AI
      return;
    }
    const pool = tiers[CELL_BODY].length ? tiers[CELL_BODY]
      : tiers[CELL_HEAD].length ? tiers[CELL_HEAD] : tiers[CELL_EMPTY];
    const pick = pool[Math.floor(Math.random() * pool.length)];
    room.coins[seat] -= price; // 先扣费，再揭示（揭示本身按正常规则赚金币）
    console.log(`[${room.id}] ${room.players[seat].name} 探测者 (${row},${col}) → 揭示 (${pick[0]},${pick[1]})`);
    tryReveal(room, seat, pick[0], pick[1]); // 记录/步数+1/金币/广播/判胜全部复用
    return;
  }

  if (itemId === 'burst') {
    // 双发连射：一次行动揭示 2 格（两格同时选定，看不到第一格结果后改第二格）
    const cells = [[data.row, data.col], [data.row2, data.col2]];
    for (let i = 0; i < 2; i++) {
      const r = cells[i][0], c = cells[i][1];
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= size || c < 0 || c >= size) {
        return '坐标无效';
      }
      if (defender.shotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
        return '双发的第 ' + (i + 1) + ' 格已经揭示过了';
      }
      if (isFrozenCell(room, seat, r, c)) {
        return '双发的第 ' + (i + 1) + ' 格被冻结，还不能选中';
      }
    }
    if (cells[0][0] === cells[1][0] && cells[0][1] === cells[1][1]) {
      return '两格不能相同';
    }
    room.coins[seat] -= price;
    // 步数：双发连射只占一步（先 +1，两次揭示都不再计步，广播时步数就是最终值）
    room.steps[seat] += 1;
    console.log(`[${room.id}] ${room.players[seat].name} 双发连射 (${cells[0][0]},${cells[0][1]}) + (${cells[1][0]},${cells[1][1]})`);
    tryReveal(room, seat, cells[0][0], cells[0][1], true);
    if (room.phase === 'battle') tryReveal(room, seat, cells[1][0], cells[1][1], true); // 第一格若直接获胜就不再打
    return;
  }

  if (itemId === 'expose') {
    // 无所遁形：对已揭示的机头使用 → 完整揭示该机头所属的整架飞机（10 格）
    const row = data.row, col = data.col;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= size || col < 0 || col >= size) {
      return '坐标无效';
    }
    const headRec = defender.shotsReceived.find(function (s) {
      return s.row === row && s.col === col && s.result === 'head';
    });
    if (!headRec) return '这格不是已经揭示的机头';
    // 无需冻结检查：目标必须是已揭示的机头，而冻结只作用于未揭示格
    const plane = defender.planes.find(function (p) {
      return p.headRow === row && p.headCol === col;
    });
    if (!plane) return '找不到对应的飞机'; // 防御性校验
    const cells = getPlaneCells(row, col, plane.dir);
    // 整架都已揭示就不用再花金币（十格全部打过，无所遁形没有信息价值）
    const allShown = cells.every(function (cell) {
      return defender.shotsReceived.some(function (s) { return s.row === cell[0] && s.col === cell[1]; });
    });
    if (allShown) return '这架飞机已经完整揭示了，不用浪费金币';
    cells.forEach(function (cell) {
      const r = cell[0], c = cell[1];
      if (!defender.shotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
        // 整架飞机补全揭示（机头已揭示，这里补上的都是机身）
        defender.shotsReceived.push({ row: r, col: c, result: 'body' });
      }
    });
    room.coins[seat] -= price;
    room.steps[seat] += 1;
    console.log(`[${room.id}] ${room.players[seat].name} 无所遁形 (${row},${col}) 揭示整架飞机`);
    finishItem(room, seat, 'expose', { row: row, col: col, cells: cells });
    return;
  }

  if (itemId === 'devour') {
    // 吞噬者：3x3 内所有未揭示格变为「摧毁」（不给金币，机头被摧毁视作发现飞机）
    const row = data.row, col = data.col;
    if (!checkRegion(row, col, size)) return '区域越界（3x3 必须完整落在棋盘内）';
    if (hasFrozenCell(room, seat, regionCells(row, col))) return '选区里包含冻结的格子，还不能选中';
    const destroyed = []; // 被摧毁的格子坐标（用于灰色渲染）
    let headHit = null;   // 若机头被摧毁：这格的坐标（明确反馈「命中机头！」）
    regionCells(row, col).forEach(function (cell) {
      const r = cell[0], c = cell[1];
      if (defender.shotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
        return; // 已揭示的格子不受影响
      }
      if (defender.board[r][c] === CELL_HEAD) {
        // 机头被摧毁 = 发现飞机：这格按机头公开记录（带 destroyed 标记，渲染为灰色机头）
        headHit = [r, c];
        defender.shotsReceived.push({ row: r, col: c, result: 'head', destroyed: true });
      } else {
        // 机身/空格被摧毁：只记「摧毁」状态，内容保密（对局结束后才公开）
        defender.shotsReceived.push({ row: r, col: c, result: 'destroyed' });
      }
      destroyed.push([r, c]);
    });
    if (!destroyed.length) return '这个区域没有可摧毁的格子';
    room.coins[seat] -= price;
    room.steps[seat] += 1;
    console.log(`[${room.id}] ${room.players[seat].name} 吞噬者 (${row},${col}) 摧毁 ${destroyed.length} 格` + (headHit ? '，命中机头！' : ''));
    finishItem(room, seat, 'devour', { row: row, col: col, destroyed: destroyed, headHit: headHit });
    return;
  }

  if (itemId === 'doom') {
    // 毁灭菇：十字 5 格揭示 + 相邻未揭示格冻结。
    // 冻结只约束施放者自己（接下来 2 次行动不能揭示/选中这些格），对手不受影响。
    const row = data.row, col = data.col;
    // 十字中心必须完整落盘（离边至少 1 格，上下左右才不会出界）
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || row > size - 2 || col < 1 || col > size - 2) {
      return '十字中心离棋盘边太近，无法完整落盘';
    }
    const cells = crossCells(row, col);
    if (hasFrozenCell(room, seat, cells)) {
      return '十字里包含冻结的格子，还不能选中';
    }

    // 揭示十字 5 格（已揭示的格跳过，和吞噬者「已揭示格不受影响」同一逻辑）；
    // 只走 revealCell（记录 + 金币），步数整体 +1，避免 5 条 revealResult 的步数竞态
    const revealed = [];
    cells.forEach(function (cell) {
      if (!defender.shotsReceived.some(function (s) { return s.row === cell[0] && s.col === cell[1]; })) {
        revealed.push(revealCell(room, seat, cell[0], cell[1]));
      }
    });
    if (!revealed.length) return '十字的 5 格都已经揭示过了';

    // 生成冻结：与十字 5 格相邻（8 邻域）且未揭示的格子（去重，十字本身不冻结）
    const frozen = [];
    cells.forEach(function (cell) {
      neighbor8(cell[0], cell[1], size).forEach(function (n) {
        const nr = n[0], nc = n[1];
        if (cells.some(function (c2) { return c2[0] === nr && c2[1] === nc; })) return;
        if (defender.shotsReceived.some(function (s) { return s.row === nr && s.col === nc; })) return;
        if (frozen.some(function (f) { return f[0] === nr && f[1] === nc; })) return;
        frozen.push([nr, nc]);
      });
    });

    room.coins[seat] -= price;
    room.steps[seat] += 1;
    // 冻结记录带 owner/expiry 广播：客户端用它判断「我的冻结格」和过期（渲染 ❄ 用）
    const frozenRecs = frozen.map(function (f) {
      return { row: f[0], col: f[1], owner: seat, expiry: room.steps[seat] + 2 };
    });
    room.frozenCells = room.frozenCells.concat(frozenRecs);
    console.log(`[${room.id}] ${room.players[seat].name} 毁灭菇 (${row},${col}) 揭示 ${revealed.length} 格，冻结 ${frozen.length} 格`);
    finishItem(room, seat, 'doom', { row: row, col: col, cells: revealed, frozen: frozenRecs });
    return;
  }

  return '未知道具';
}

// 真人使用道具入口：定位 + 阶段/玩法检查后交给 doUseItem（AI 走 doUseItem 但不走这里）
function handleUseItem(socket, data) {
  const loc = locate(socket);
  if (!loc) return sendError(socket, '你不在任何房间中');
  const room = loc.room, seat = loc.seat;
  if (room.phase !== 'battle') return sendError(socket, '现在还不能使用道具（未开战或已结束）');
  if (room.mode !== 'props') return sendError(socket, '经典玩法没有道具');
  const err = doUseItem(room, seat, data.itemId, data);
  if (err) sendError(socket, err);
}

// 再来一局投票
function handleRematch(socket) {
  const loc = locate(socket);
  if (!loc) return sendError(socket, '你不在任何房间中');
  const room = loc.room, seat = loc.seat;
  if (room.phase !== 'over') return sendError(socket, '游戏还没结束');

  room.rematchVotes[seat] = true;
  emitToRoom(room, 'rematchVote', { seat: seat, votes: room.rematchVotes });

  if (room.rematchVotes[0] && room.rematchVotes[1]) {
    startRematch(room);
  }
}

// 对局中换头像：存进玩家记录（重连/观战加入时随 avatarsOf 下发），并广播给房间所有人（含观战者）
function handleSetAvatar(socket, data) {
  const loc = locate(socket);
  if (!loc) return; // 不在房间（比如首页换头像）：只存本地，无需同步
  const avatar = Array.from(String(data.avatar || '')).slice(0, 4).join(''); // 与建房同款：按码点截 4 个
  loc.player.avatar = avatar;
  emitToRoom(loc.room, 'avatarUpdated', { seat: loc.seat, avatar: avatar });
}

// ---------- 连接层：原生 WebSocket（替代 socket.io，2026-08 全站迁移） ----------
// 协议：客户端发 { type: 事件名, data: 数据 }，服务器按 type 分发到
// 同一个 handleXxx 处理函数；服务器广播同样发 { type, data }。
// 事件名与 socket.io 时代完全一致，业务逻辑一行没改。
// 网页端、小程序端（wx.connectSocket）、测试脚本走同一个协议。

// 两个注册表，替代 socket.io 的 io.to / io.sockets.sockets.get：
const allConns = new Map();   // 连接 id -> 连接对象（重连时按 id 顶掉旧连接用）
const roomConns = new Map();  // 房间号 -> 连接对象 Set（给房间广播用）
let connSeq = 0;              // 连接 id 递增计数器

// 给房间里除了自己以外的连接广播（替代 socket.to(room.id).emit）
function emitToOthers(conn, roomId, event, data) {
  const set = roomConns.get(roomId);
  if (!set) return;
  set.forEach(function (c) { if (c !== conn) c.emit(event, data); });
}

// 把一条原生 WebSocket 包装成 handler 认识的「连接对象」：
// 接口与 socket.io 的 socket 一致（id / data / join / leave / emit / to().emit / disconnect）
function wrapWs(ws) {
  const conn = {
    id: 'ws_' + (++connSeq),
    data: {},              // 绑定 roomId / seat / token / spectator（和原来一样）
    _rooms: new Set(),     // 加入过的房间，断线时清理注册表用
    _ws: ws
  };
  conn.join = function (roomId) {
    conn._rooms.add(roomId);
    if (!roomConns.has(roomId)) roomConns.set(roomId, new Set());
    roomConns.get(roomId).add(conn);
  };
  conn.leave = function (roomId) {
    conn._rooms.delete(roomId);
    const set = roomConns.get(roomId);
    if (set) set.delete(conn);
  };
  conn.emit = function (event, data) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({ type: event, data: data === undefined ? {} : data }));
    }
  };
  conn.to = function (roomId) {
    return { emit: function (event, data) { emitToOthers(conn, roomId, event, data); } };
  };
  conn.disconnect = function () { try { ws.close(); } catch (e) { /* 忽略 */ } };
  return conn;
}

// 断开连接时清理注册表（连接从所有房间移除后，广播就再也碰不到它）
function cleanupConns(conn) {
  allConns.delete(conn.id);
  conn._rooms.forEach(function (roomId) {
    const set = roomConns.get(roomId);
    if (set) {
      set.delete(conn);
      if (set.size === 0) roomConns.delete(roomId);
    }
  });
  conn._rooms.clear();
}

// 收到一条消息：JSON -> {type, data} -> 分发到对应 handler；坏 JSON 关连接
function handleWsMessage(conn, raw) {
  // 限频：1 秒内超过 20 条消息视为异常刷接口，断开（正常操作点一下才 1 条）
  const now = Date.now();
  const times = conn._ws.msgTimes;
  times.push(now);
  while (times.length && now - times[0] > 1000) times.shift();
  if (times.length > 20) {
    conn._ws.close(1008, 'too many messages');
    return;
  }

  let msg;
  try { msg = JSON.parse(raw); } catch (e) {
    conn._ws.close(1003, 'invalid json');
    return;
  }
  if (!msg || typeof msg.type !== 'string') return; // 未知格式忽略（容错测试覆盖）
  const data = (msg.data && typeof msg.data === 'object') ? msg.data : {};
  const handlers = {
    createRoom: handleCreateRoom,
    createRoomAI: handleCreateRoomAI,
    joinRoom: handleJoinRoom,
    rejoin: handleRejoin,
    checkRooms: handleCheckRooms,
    deployConfirm: handleDeployConfirm,
    deployCancel: handleDeployCancel,
    reveal: handleReveal,
    useItem: handleUseItem,
    rematch: handleRematch,
    setAvatar: handleSetAvatar,
    leaveRoom: handleLeaveRoom,
    visit: handleVisit
  };
  const handler = handlers[msg.type];
  if (handler) {
    // 单个消息处理出错不能拖垮整个服务器（其他对局还在进行）
    try { handler(conn, data); } catch (e) {
      console.error(`处理消息 ${msg.type} 出错:`, e);
      conn.emit('errorMessage', { message: '操作出错，请重试' });
    }
  }
  // 未知事件名：忽略不崩
}

// 批量查询房间是否还存在（客户端启动时校验「最近加入的房间」列表，自动删掉失效条目）
function handleCheckRooms(conn, data) {
  const ids = Array.isArray(data.roomIds) ? data.roomIds : [];
  conn.emit('roomsAlive', { alive: ids.filter(function (id) { return rooms.has(String(id)); }) });
}

// 主动离开房间（玩家离开 / 观战者退出共用）
function handleLeaveRoom(conn) {
  if (conn.data.spectator) {
    // 观战者离开：只从观战席移除，不影响对局
    removeSpectator(conn);
    conn.leave(conn.data.roomId);
    conn.data.roomId = null;
    conn.data.spectator = false;
    conn.emit('leftRoom', {});
    return;
  }
  const loc = locate(conn);
  if (loc) onLeave(loc.room, loc.seat, conn);
}

// 连接断开：观战者移除；玩家标记离线（不判负）
function handleDisconnect(conn) {
  if (conn.data.spectator) {
    // 观战者断线：从观战席移除（观战者不重连，刷新后重新进即可）
    removeSpectator(conn);
    return;
  }
  const loc = locate(conn);
  if (!loc) return; // 没有绑定房间（比如刚被新连接顶掉），忽略
  onDisconnect(loc.room, loc.seat);
}

// ---------- 访客统计（匿名 ID，无任何个人信息） ----------
let statsDirty = false; // 是否有未落盘的改动
let statsSaveTimer = null; // 防抖定时器

// 启动时加载 stats.json；文件不存在或损坏都从空开始（不影响服务器启动）
function loadStats() {
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (!data || typeof data.visitors !== 'object') throw new Error('格式不对');
    Object.keys(data.visitors).forEach(function (id) {
      const v = data.visitors[id];
      if (v && typeof v.firstVisit === 'number' && typeof v.lastVisit === 'number' &&
          typeof v.visits === 'number' && v.visits >= 1 &&
          (v.platform === 'web' || v.platform === 'mini')) {
        visitors.set(id, v); // 逐条校验，坏条目直接丢弃
      }
    });
    console.log('访客统计已加载：' + visitors.size + ' 位访客');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('访客统计文件损坏，从零开始：' + e.message);
    // ENOENT = 文件不存在；两种情况都静默从空开始
  }
}

// 防抖：有访问就安排一次落盘，1 秒内的访问合并成一次写
function scheduleSaveStats() {
  statsDirty = true;
  if (statsSaveTimer) return;
  statsSaveTimer = setTimeout(function () {
    statsSaveTimer = null;
    flushSaveStats();
  }, STATS_SAVE_DELAY_MS);
}

// 立即写盘：先写 .tmp 再 rename（原子替换）；失败只记日志，绝不影响游戏
function flushSaveStats() {
  if (!statsDirty) return;
  statsDirty = false;
  const payload = { version: 1, visitors: {} };
  visitors.forEach(function (v, id) { payload.visitors[id] = v; });
  try {
    fs.writeFileSync(STATS_TMP_FILE, JSON.stringify(payload, null, 2));
    fs.renameSync(STATS_TMP_FILE, STATS_FILE);
  } catch (e) {
    statsDirty = true; // 写失败（磁盘满/只读）：留着脏标记，下次访问再试
    console.error('访客统计写盘失败（忽略，不影响游戏）：' + e.message);
    return;
  }
  // 写盘成功后顺便同步到 GitHub 保险柜（异步执行，失败只记日志）
  githubBackup.upload(visitors);
}

// 启动时从 GitHub 保险柜拉回上次的统计，与本地合并后继续累计
async function syncFromGitHub() {
  if (!githubBackup.enabled) return;
  console.log('GitHub 保险柜：尝试拉取上次的统计…');
  const remote = await githubBackup.download();
  if (!remote.records) return; // 拉取失败：用本地的继续（日志已打）
  let merged = 0;
  remote.records.forEach(function (r) {
    const rec = visitors.get(r.id);
    if (!rec) {
      visitors.set(r.id, { platform: r.platform, firstVisit: r.firstVisit, lastVisit: r.lastVisit, visits: r.visits });
      merged++;
    } else {
      if (r.firstVisit < rec.firstVisit) { rec.firstVisit = r.firstVisit; merged++; }
      if (r.lastVisit > rec.lastVisit) { rec.lastVisit = r.lastVisit; merged++; }
      if (r.visits > rec.visits) { rec.visits = r.visits; merged++; }
    }
  });
  if (merged > 0) {
    console.log('GitHub 保险柜：从远程合并了 ' + merged + ' 条记录，当前共 ' + visitors.size + ' 位访客');
    scheduleSaveStats(); // 合并结果写回本地 + 上传 GitHub（两边保持一致）
  } else {
    console.log('GitHub 保险柜：与远程一致，当前共 ' + visitors.size + ' 位访客');
  }
}

// 收到客户端的 visit 事件：登记/更新访客，回复当前总人数
function handleVisit(conn, data) {
  const vid = typeof data.visitorId === 'string' ? data.visitorId.trim() : '';
  if (!vid || vid.length > 64) return; // 空 / 异常 ID：直接忽略，不计数
  const platform = data.platform === 'mini' ? 'mini' : 'web'; // 只认两种端，其它一律按 web
  const now = Date.now();

  const rec = visitors.get(vid);
  if (!rec) {
    if (visitors.size >= MAX_VISITORS) return conn.emit('visitResult', { total: visitors.size });
    visitors.set(vid, { platform: platform, firstVisit: now, lastVisit: now, visits: 1 });
  } else {
    rec.platform = platform; // 同一 ID 换了端再连（极少见）：记最新端
    if (now - rec.lastVisit >= MIN_VISIT_GAP_MS) rec.visits += 1; // 5 分钟内重连不刷频次
    rec.lastVisit = now;
  }
  scheduleSaveStats();
  conn.emit('visitResult', { total: visitors.size }); // 首页显示「已有 X 位玩家访问过」
}

// HTML 转义（/stats 页面里显示的 visitorId 是客户端传的字符串，必须转义防注入）
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 渲染 /stats 明细页（纯字符串拼 HTML，不用任何前端框架/JS）
function renderStatsHtml() {
  const list = Array.from(visitors.entries()).sort(function (a, b) { return b[1].firstVisit - a[1].firstVisit; });
  let rows = '';
  list.forEach(function (entry) {
    const id = entry[0], v = entry[1];
    rows += '<tr><td>' + (v.platform === 'mini' ? '小程序' : '网页') + '</td>' +
      '<td>' + escapeHtml(id) + '</td>' +
      '<td>' + new Date(v.firstVisit).toLocaleString('zh-CN', { hour12: false }) + '</td>' +
      '<td>' + new Date(v.lastVisit).toLocaleString('zh-CN', { hour12: false }) + '</td>' +
      '<td>' + v.visits + '</td></tr>';
  });
  let webCount = 0, miniCount = 0, totalVisits = 0;
  visitors.forEach(function (v) {
    if (v.platform === 'mini') miniCount++; else webCount++;
    totalVisits += v.visits;
  });
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>访客统计</title>' +
    '<style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 16px;color:#333}' +
    'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}' +
    '.note{color:#888;font-size:13px}</style></head><body>' +
    '<h1>访客统计</h1>' +
    '<p>共 ' + visitors.size + ' 位访客（网页 ' + webCount + ' / 小程序 ' + miniCount + '），累计访问 ' + totalVisits + ' 次。</p>' +
    '<table><tr><th>平台</th><th>访客 ID</th><th>首次访问</th><th>最后访问</th><th>访问次数</th></tr>' + rows + '</table>' +
    '<p class="note">时间显示为服务器本地时间。数据只含平台与时间戳，无任何个人信息。' +
    'Render 免费版磁盘是临时的：休眠/重启/重新部署后统计会从零开始。</p>' +
    '</body></html>';
}

// ---------- 服务器启动 ----------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 访客统计明细页（私有：必须带正确的 ?key= 才看得到，数据只含平台与时间）
app.get('/stats', function (req, res) {
  if (req.query.key !== STATS_KEY) {
    res.status(403).send('<h1>403 禁止访问</h1><p>需要正确的 ?key= 参数</p>');
    return;
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderStatsHtml());
});

// 访客统计 JSON 接口（本地备份脚本 backup-stats.js 用；同样要 ?key= 才能看）
app.get('/stats.json', function (req, res) {
  if (req.query.key !== STATS_KEY) {
    res.status(403).json({ error: '需要正确的 ?key= 参数' });
    return;
  }
  const list = [];
  visitors.forEach(function (v, id) {
    list.push({ id: id, platform: v.platform, firstVisit: v.firstVisit, lastVisit: v.lastVisit, visits: v.visits });
  });
  list.sort(function (a, b) { return b.firstVisit - a.firstVisit; });
  let webCount = 0, miniCount = 0, totalVisits = 0;
  visitors.forEach(function (v) {
    if (v.platform === 'mini') miniCount++; else webCount++;
    totalVisits += v.visits;
  });
  res.json({ total: visitors.size, web: webCount, mini: miniCount, totalVisits: totalVisits, visitors: list });
});

const server = http.createServer(app);
// maxPayload：单条消息限 16KB（正常消息最大不过几 KB，超限的是攻击/异常客户端）
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

// 升级握手：只接管 /ws 路径（其它路径的升级请求直接断开）
server.on('upgrade', function (request, socket, head) {
  if (request.url.split('?')[0] === '/ws') {
    wss.handleUpgrade(request, socket, head, function (ws) {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 心跳：每 5 秒 ping 一次，15 秒没等到 pong 就判死关闭（断网后能较快察觉）
wss.on('connection', function (ws) {
  ws.isAlive = true;
  ws.msgTimes = []; // 限频滑动窗口（见 handleWsMessage）
  ws.on('pong', function () { ws.isAlive = true; });

  const conn = wrapWs(ws);
  allConns.set(conn.id, conn);
  console.log(`新连接 ${conn.id}`);

  ws.on('message', function (raw) { handleWsMessage(conn, raw); });
  ws.on('close', function () {
    cleanupConns(conn);      // 先从注册表移除，广播不再碰到它
    handleDisconnect(conn);  // 再走断线流程（观战者移除 / 玩家标记离线）
  });
  ws.on('error', function () { /* 出错后 close 一定会跟着来，由 close 统一处理 */ });
});

const heartbeatTimer = setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (ws.isAlive === false) { ws.terminate(); return; } // 上次 ping 没回应：判死
    ws.isAlive = false;
    ws.ping();
  });
}, 5000);
wss.on('close', function () { clearInterval(heartbeatTimer); });

server.listen(PORT, function () {
  loadStats(); // 启动时加载历史访客统计
  syncFromGitHub(); // 再从 GitHub 保险柜拉回合并（未配置时自动跳过）
  console.log('炸飞机服务器已启动：http://localhost:' + PORT);
  console.log('提示：开两个浏览器窗口（一个普通 + 一个无痕）即可自己和自己对战测试');
  console.log('访客统计明细页：http://localhost:' + PORT + '/stats?key=' + STATS_KEY);
});

// 关服前把还没落盘的访客统计写掉（Render 重启发 SIGTERM，本地 Ctrl+C 发 SIGINT）
process.on('SIGTERM', function () { flushSaveStats(); process.exit(0); });
process.on('SIGINT', function () { flushSaveStats(); process.exit(0); });

// 兜底：任何未捕获异常 / 未处理的 Promise 拒绝都不能让服务器进程退出
// （对局中途挂掉比个别操作出错更糟；错误已记日志，服务器继续服务）
process.on('uncaughtException', function (e) { console.error('未捕获异常（服务器继续运行）:', e); });
process.on('unhandledRejection', function (reason) { console.error('未处理的 Promise 拒绝（服务器继续运行）:', reason); });
