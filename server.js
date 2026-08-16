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
const express = require('express');
const { Server } = require('socket.io');

// 前后端共用的游戏逻辑（飞机形状、摆放校验等）
const shared = require('./public/shared.js');
const { BOARD_SIZE, CELL_HEAD, CELL_BODY, buildBoard, validateDeployment } = shared;

// ---------- 常量 ----------
const PORT = process.env.PORT || 3000;  // 部署到 Render 等平台时会自动注入 PORT
const RECYCLE_SECONDS = Number(process.env.RECYCLE_SECONDS) || 600; // 双方都离线后回收房间的等待时间（秒，默认 10 分钟）；可用环境变量覆盖（测试用）
const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 房间号字符表（去掉易混淆的 I/O/0/1）

// ---------- 数据 ----------
const rooms = new Map(); // 房间号 -> 房间对象（内存存储，服务器重启后清空，当前规模够用）

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
    cleanupTimer: null            // 双方都离线时的房间回收计时器
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

// 给房间里所有在线玩家广播事件
function emitToRoom(room, event, data) {
  io.to(room.id).emit(event, data);
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
    score: room.score
  });
}

// 重置房间，回到部署阶段（第一次开战 / 再来一局共用）
function resetToDeploy(room) {
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

// 双方都离线时启动房间回收计时；到点后再确认一次，期间有人回来就不回收
function scheduleRoomCleanup(room) {
  const allOffline = room.players.every(function (p) { return !p || !p.connected; });
  if (!allOffline || room.cleanupTimer) return;
  console.log(`[${room.id}] 双方都已离线，${RECYCLE_SECONDS} 秒后回收房间`);
  room.cleanupTimer = setTimeout(function () {
    const r = rooms.get(room.id);
    if (!r) return;
    r.cleanupTimer = null;
    if (r.players.every(function (p) { return !p || !p.connected; })) {
      console.log(`[${room.id}] 双方离线超时，回收房间`);
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
    online: [true, false]
  });
}

// 加入房间（坐 1 号位），满 2 人进入部署阶段
function handleJoinRoom(socket, data) {
  const roomId = String(data.roomId || '').toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return sendError(socket, '房间不存在，请检查房间号');
  if (room.players.length >= 2) return sendError(socket, '房间已满');

  const name = (typeof data.name === 'string' ? data.name : '').trim();
  const err = checkName(room, name);
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
  socket.to(room.id).emit('opponentJoined', { names: [room.players[0].name, name] });
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
  const oldSocket = io.sockets.sockets.get(player.socketId);
  if (oldSocket && oldSocket.id !== socket.id) {
    oldSocket.data.roomId = null;
    oldSocket.data.seat = null;
    oldSocket.data.token = null;
    oldSocket.disconnect(true);
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

  // 拼出完整现场发给重连方（只含公开信息，绝不含对方飞机坐标）
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
    rematchVotes: room.rematchVotes
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
  }
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
    console.log(`[${room.id}] 双方同意再来一局`);
    resetToDeploy(room);
    emitToRoom(room, 'rematchStart', {
      names: room.players.map(function (p) { return p.name; })
    });
  }
}

// ---------- 服务器启动 ----------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 5000,   // 心跳间隔 5 秒
  pingTimeout: 15000    // 15 秒没心跳判定断线（断网后能较快察觉）
});

io.on('connection', function (socket) {
  console.log(`新连接 ${socket.id}`);

  socket.on('createRoom', function (data) { handleCreateRoom(socket, data || {}); });
  socket.on('joinRoom', function (data) { handleJoinRoom(socket, data || {}); });
  socket.on('rejoin', function (data) { handleRejoin(socket, data || {}); });

  // 批量查询房间是否还存在（客户端启动时校验「最近加入的房间」列表，自动删掉失效条目）
  socket.on('checkRooms', function (data) {
    const ids = Array.isArray(data && data.roomIds) ? data.roomIds : [];
    socket.emit('roomsAlive', { alive: ids.filter(function (id) { return rooms.has(String(id)); }) });
  });
  socket.on('deployConfirm', function (data) { handleDeployConfirm(socket, data || {}); });
  socket.on('deployCancel', function () { handleDeployCancel(socket); });
  socket.on('reveal', function (data) { handleReveal(socket, data || {}); });
  socket.on('rematch', function () { handleRematch(socket); });
  socket.on('leaveRoom', function () {
    const loc = locate(socket);
    if (loc) onLeave(loc.room, loc.seat, socket);
  });

  socket.on('disconnect', function () {
    const loc = locate(socket);
    if (!loc) return; // 没有绑定房间（比如刚被新连接顶掉），忽略
    onDisconnect(loc.room, loc.seat);
  });
});

server.listen(PORT, function () {
  console.log('炸飞机服务器已启动：http://localhost:' + PORT);
  console.log('提示：开两个浏览器窗口（一个普通 + 一个无痕）即可自己和自己对战测试');
});
