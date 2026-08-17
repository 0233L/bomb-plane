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
const { BOARD_SIZE, CELL_HEAD, CELL_BODY, buildBoard, validateDeployment } = shared;

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

// 计算双方还剩几个机头没被打中（随时从被揭示记录重算，避免状态不一致）
function headsLeftOf(room) {
  return [0, 1].map(function (seat) {
    const p = room.players[seat];
    if (!p) return 0;
    let heads = 0;
    p.shotsReceived.forEach(function (s) { if (s.result === 'head') heads++; });
    return shared.PLANE_COUNT - heads;
  });
}

// 给房间里所有在线玩家广播事件（roomConns 注册表见文件尾「连接层」）
function emitToRoom(room, event, data) {
  const set = roomConns.get(room.id);
  if (!set) return;
  set.forEach(function (conn) { conn.emit(event, data); });
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
    names: room.players.map(function (p) { return p.name; })
  });
  if (room.isAI) aiDeployAndConfirm(room); // AI 自动重新部署
}

// 重置房间，回到部署阶段（第一次开战 / 再来一局共用）
function resetToDeploy(room) {
  // 防御性清理：任何时刻回到部署阶段，AI 的走棋定时器都不该再触发
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
  room.phase = 'deploy';
  room.steps = [0, 0];
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

// ---------- Socket 事件处理 ----------

// 创建房间（坐 0 号位）
function handleCreateRoom(socket, data) {
  const name = (typeof data.name === 'string' ? data.name : '').trim();
  const err = checkName(null, name);
  if (err) return sendError(socket, err);

  const room = createRoom();
  const token = crypto.randomBytes(8).toString('hex'); // 身份凭证，重连用
  room.players[0] = {
    name: name, token: token,
    socketId: socket.id, connected: true, left: false,
    planes: null, board: null, shotsReceived: [],
    deployConfirmed: false
  };
  rooms.set(room.id, room);

  socket.data.roomId = room.id;
  socket.data.seat = 0;
  socket.data.token = token;
  socket.join(room.id);
  console.log(`[${room.id}] 房间创建，玩家：${name}`);

  socket.emit('roomCreated', {
    roomId: room.id, token: token, seat: 0, name: name,
    names: [name, ''],
    online: [true, false],
    isAI: false,
    deployConfirmed: [false, false]
  });
}

// 创建人机对战房间：真人坐 0 号位，AI 立刻坐 1 号位并自动部署
function handleCreateRoomAI(socket, data) {
  const name = (typeof data.name === 'string' ? data.name : '').trim();
  const err = checkName(null, name);
  if (err) return sendError(socket, err);

  const room = createRoom();
  room.isAI = true;

  const token = crypto.randomBytes(8).toString('hex'); // 身份凭证，重连用
  room.players[0] = {
    name: name, token: token,
    socketId: socket.id, connected: true, left: false,
    planes: null, board: null, shotsReceived: [],
    deployConfirmed: false
  };
  // AI 坐 1 号位：没有 socket，永不掉线，走棋由服务器定时器驱动
  room.players[1] = {
    name: '🤖 电脑', token: crypto.randomBytes(8).toString('hex'),
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
    online: [true, true],
    isAI: true,
    deployConfirmed: [false, true] // AI 马上就自动确认部署
  });

  aiDeployAndConfirm(room); // AI 随机部署并确认
}

// AI 自动部署并确认（创建人机房间时、每局重新开始时调用）
function aiDeployAndConfirm(room) {
  const aiPlayer = room.players[1];
  const planes = ai.randomDeployment();
  if (!planes) return console.error(`[${room.id}] AI 生成部署失败（极少见，忽略即可）`);
  aiPlayer.planes = planes;
  aiPlayer.board = buildBoard(planes);
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

    // 实战用一步贪心；AI_ROLLOUT=1 可切换 rollout 版（500 盘实测未优于贪心，详见 ai.js 头注释）
    const target = ai.chooseTargetLive(r.players[0].shotsReceived);
    tryReveal(r, 1, target.row, target.col);

    // 走完一步若还轮得到 AI（比如之前落后一步），继续调度
    if (r.phase === 'battle' && r.steps[1] <= r.steps[0]) scheduleAITurn(r);
  }, thinkMs);
}

// 加入房间：不满 2 人坐 1 号位；满员则进入观战席
function handleJoinRoom(socket, data) {
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
    online: [room.players[0].connected, true] // 房主可能正处于断线中
  });
  // 通知房主：对手来了
  emitToOthers(socket, room.id, 'opponentJoined', { names: [room.players[0].name, name] });
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
    names: room.players.map(function (p) { return p.name; }),
    online: room.players.map(function (p) { return p.connected; }),
    steps: room.steps,
    score: room.score,
    headsLeft: headsLeftOf(room),
    shots: room.players.map(function (p) { return p.shotsReceived; }), // [A 被打的, B 被打的]
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

// 断线重连：凭 token + 房间号恢复现场
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
    online: room.players.map(function (p) { return !!p && p.connected; }),
    phase: room.phase,
    steps: room.steps,
    score: room.score,
    headsLeft: headsLeftOf(room),
    deployConfirmed: [0, 1].map(function (i) {
      return !!(room.players[i] && room.players[i].deployConfirmed);
    }),
    myPlanes: player.planes,              // 自己的飞机（已确认时才有）
    myShotsReceived: player.shotsReceived,      // 对方打我的记录
    enemyShotsReceived: enemy ? enemy.shotsReceived : [], // 我打对方的记录
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

  const err = validateDeployment(data.planes);
  if (err) return sendError(socket, err);

  // 保存（只存服务端，绝不外发）
  player.planes = data.planes.map(function (p) {
    return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
  });
  player.board = buildBoard(player.planes);
  player.deployConfirmed = true;
  console.log(`[${room.id}] ${player.name} 确认部署`);

  const confirmed = [room.players[0].deployConfirmed, room.players[1].deployConfirmed];
  emitToRoom(room, 'deployReady', { seat: seat, confirmed: confirmed });

  if (confirmed[0] && confirmed[1]) {
    // 双方都确认，开战！步数归零：双方都可行动（无先手后手之分）
    room.phase = 'battle';
    room.steps = [0, 0];
    console.log(`[${room.id}] 双方部署完成，开战`);
    emitToRoom(room, 'battleStart', {
      names: room.players.map(function (p) { return p.name; }),
      steps: room.steps,
      score: room.score,
      online: room.players.map(function (p) { return p.connected; })
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
  if (!Number.isInteger(row) || !Number.isInteger(col) ||
      row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    return sendError(socket, '坐标无效');
  }

  const defender = room.players[1 - seat];
  if (defender.shotsReceived.some(function (s) { return s.row === row && s.col === col; })) {
    return sendError(socket, '这个格子已经揭示过了');
  }

  // 步数规则：步数超过对方的人不能行动（相等时双方都可行动，先到先得）
  if (room.steps[seat] > room.steps[1 - seat]) {
    return sendError(socket, '你的步数已领先，等待对方追上');
  }

  // —— 全部校验通过，执行揭示 ——
  tryReveal(room, seat, row, col);
}

// 执行一次揭示：查表、记录、步数 +1、广播、判胜（调用前已通过全部校验）
// 真人玩家（handleReveal）和 AI（scheduleAITurn）共用，保证两边遵守同一套规则
function tryReveal(room, seat, row, col) {
  const defender = room.players[1 - seat];
  const cell = defender.board[row][col];
  const result = cell === CELL_HEAD ? 'head' : cell === CELL_BODY ? 'body' : 'empty';
  defender.shotsReceived.push({ row: row, col: col, result: result });
  room.steps[seat] += 1;
  console.log(`[${room.id}] ${room.players[seat].name} 揭示 (${row},${col}) = ${result}`);

  const headsLeft = headsLeftOf(room);
  emitToRoom(room, 'revealResult', {
    attacker: seat, row: row, col: col, result: result,
    headsLeft: headsLeft, steps: room.steps
  });

  // 对方 3 个机头全被揭示 → 我方获胜
  if (headsLeft[1 - seat] === 0) {
    endGame(room, seat, 'allHeads');
    return;
  }

  if (room.isAI) scheduleAITurn(room); // 人机房间：每次揭示后看是否轮到 AI
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
    rematch: handleRematch,
    leaveRoom: handleLeaveRoom,
    visit: handleVisit
  };
  const handler = handlers[msg.type];
  if (handler) handler(conn, data);
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
const wss = new WebSocketServer({ noServer: true });

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
