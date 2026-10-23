// ============================================
// local-server.js —— 小黑盒离线版的「本地服务器」
//
// 网页版是「客户端 + 服务器」：服务器保存双方飞机、判定每一步。
// 离线版没有服务器，这个文件就在浏览器里扮演服务器：
//   - 对外提供和 ws.js 的 WSClient 一样的接口（on / emit / connected）；
//   - 内部保存房间、双方飞机、步数、金币等，规则全部照搬 server.js；
//   - 人机对战：用 local-ai.js（ai.js 的浏览器副本）驱动电脑走棋；
//   - 同屏双人：一台设备轮流操作，步数领先时提示换人，由玩家自己点按钮切换。
//
// 注意：飞机坐标只存在这里（内存），界面拿到的永远只是「某格被揭示后是什么」，
// 和联机版的服务器权威模型一致，渲染逻辑不用改。
// ============================================
(function () {
  'use strict';

  // ---------- 规则常量（与 server.js 保持一致） ----------
  const COIN_START = 6;   // 道具版开局金币
  const COIN_EMPTY = 0;   // 揭示到空格的金币
  const COIN_BODY = 1;    // 揭示到机身
  const COIN_HEAD = 3;    // 揭示到机头
  const ITEM_PRICES = {
    pro: 3,     // 探测者
    devour: 3,  // 吞噬者
    sonar: 4,   // 声呐脉冲
    expose: 4,  // 无所遁形
    burst: 4,   // 双发连射
    doom: 6     // 毁灭菇
  };
  const AI_THINK_MIN_MS = 800;   // AI 思考延迟（更像真人）
  const AI_THINK_MAX_MS = 1500;
  const AI_SAMPLES = 120;        // AI 概率场采样份数（与服务器默认一致）

  // 随机整数 [0, n)
  function rnd(n) { return Math.floor(Math.random() * n); }

  // 双方都确认后开战、再来一局等地方共用：把房间重置回部署阶段
  function resetToDeploy(room) {
    room.phase = 'deploy';
    room.steps = [0, 0];
    room.coins = [COIN_START, COIN_START];
    room.sonarHistory = [];
    room.frozenCells = [];
    room.winner = null;
    room.winReason = null;
    room.rematchVotes = [false, false];
    room.activeSeat = 0;      // 新一局默认从 0 号位开始（同屏再来一局会在外面改成当前持机者）
    room.players.forEach(function (p) {
      p.planes = null;        // 自己的飞机（只存这里，绝不直接交给界面）
      p.board = null;
      p.shotsReceived = [];
      p.deployConfirmed = false;
    });
  }

  // 还剩几个机头没被找到（随时从被揭示记录重算）
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

  // 3×3 区域左上角是否完整落在棋盘内
  function checkRegion(row, col, size) {
    return Number.isInteger(row) && Number.isInteger(col) &&
      row >= 0 && col >= 0 && row + 3 <= size && col + 3 <= size;
  }

  // 3×3 区域的 9 个格子
  function regionCells(row, col) {
    const cells = [];
    for (let r = row; r < row + 3; r++) {
      for (let c = col; c < col + 3; c++) cells.push([r, c]);
    }
    return cells;
  }

  // 毁灭菇的十字 5 格
  function crossCells(row, col) {
    return [[row, col], [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
  }

  // 施放者 seat 在 (row,col) 是否仍被自己的毁灭菇冻结
  function isFrozenCell(room, seat, row, col) {
    const defender = room.players[1 - seat];
    if (defender.shotsReceived.some(function (s) { return s.row === row && s.col === col; })) return false;
    return room.frozenCells.some(function (f) {
      return f.owner === seat && room.steps[seat] < f.expiry && f.row === row && f.col === col;
    });
  }

  // 一组格子里是否含冻结格（区域型道具整体拒绝）
  function hasFrozenCell(room, seat, cells) {
    return cells.some(function (c) { return isFrozenCell(room, seat, c[0], c[1]); });
  }

  // 未过期的冻结格（换人/重连快照用）
  function activeFrozenCells(room) {
    if (room.phase === 'over') return [];
    return room.frozenCells.filter(function (f) { return room.steps[f.owner] < f.expiry; });
  }

  // 校验昵称（同房间不能重名；ignoreSeat = 改昵称时排除自己）
  function checkName(room, name, ignoreSeat) {
    if (typeof name !== 'string') return '请输入昵称';
    const trimmed = name.trim();
    if (!trimmed) return '昵称不能为空';
    if (Array.from(trimmed).length > 12) return '昵称最长 12 个字符';
    if (room && room.players.some(function (p, i) {
      return i !== ignoreSeat && p && p.name === trimmed;
    })) {
      return '该昵称已被对方使用，换一个吧';
    }
    return null;
  }

  // 新建一个玩家档案
  function newPlayer(name, avatar) {
    return {
      name: name,
      avatar: avatar || '',
      planes: null,
      board: null,
      shotsReceived: [],
      deployConfirmed: false
    };
  }

  // ============================================
  // LocalServer：接口与 ws.js 的 WSClient 完全一致
  // ============================================
  class LocalServer {
    constructor() {
      this._handlers = new Map();  // 事件名 -> [回调]
      this.connected = true;       // 本地服务器永远在线
      this.room = null;            // 同一时间只有一个本地房间
      this._timers = new Set();    // 所有定时器（离开房间时统一清掉）

      // 等 client.js 挂好事件监听后再触发 connect（和真实 WebSocket 的时序一致）
      const self = this;
      this._setTimer(function () { self._fire('connect', {}); }, 0);
    }

    // ---------- 与 WSClient 相同的接口 ----------
    on(event, cb) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(cb);
      return this;
    }

    once(event, cb) {
      const self = this;
      const wrapper = function (data) {
        self.off(event, wrapper);
        cb(data);
      };
      return this.on(event, wrapper);
    }

    off(event, cb) {
      const list = this._handlers.get(event);
      if (!list) return this;
      const idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
      return this;
    }

    // 界面发来的「请求」：分发到对应的处理函数
    emit(event, data) {
      if (!this.connected) return;
      const d = (data && typeof data === 'object') ? data : {};
      const handlers = {
        createRoomAI: this._handleCreateAI,
        createRoomLocal: this._handleCreateLocal,
        deployConfirm: this._handleDeployConfirm,
        deployCancel: this._handleDeployCancel,
        reveal: this._handleReveal,
        useItem: this._handleUseItem,
        rematch: this._handleRematch,
        setAvatar: this._handleSetAvatar,
        setNickname: this._handleSetNickname,
        passReady: this._handlePassReady,
        leaveRoom: this._handleLeaveRoom,
        suspendRoom: this._handleSuspendRoom,
        resumeRoom: this._handleResumeRoom,
        // 联机相关：离线版明确告诉界面「不支持」
        createRoom: this._handleOnlineOnly,
        joinRoom: this._handleOnlineOnly,
        rejoin: this._handleRejoin,
        checkRooms: this._handleCheckRooms,
        visit: this._handleVisit
      };
      const handler = handlers[event];
      if (handler) handler.call(this, d);
      // 未知事件：忽略（和服务器一致）
    }

    // 主动断开（离线版一般用不到，保留给测试/容错）
    disconnect() {
      this.connected = false;
      this._clearRoom();
      this._fire('disconnect', {});
    }

    // ---------- 内部工具 ----------
    _fire(event, data) {
      const list = this._handlers.get(event);
      if (!list) return;
      list.slice().forEach(function (cb) {
        try { cb(data); } catch (e) {
          // 单个回调出错不能影响游戏其它部分
          if (typeof console !== 'undefined' && console.error) console.error('[local-server]', event, e);
        }
      });
    }

    _error(message) {
      this._fire('error', { message: message });
    }

    _setTimer(fn, ms) {
      const self = this;
      const id = setTimeout(function () {
        self._timers.delete(id); // 已经触发的定时器不用再清
        fn();
      }, ms);
      this._timers.add(id);
      return id;
    }

    _clearTimer(id) {
      if (id) clearTimeout(id);
      this._timers.delete(id);
    }

    // 清空当前房间和所有定时器（返回菜单 / 新开一局前调用）
    _clearRoom() {
      const room = this.room;
      if (room) {
        this._clearTimer(room.aiTimer);
        this._clearTimer(room.aiRematchTimer);
      }
      this._timers.forEach(function (id) { clearTimeout(id); });
      this._timers.clear();
      this.room = null;
    }

    // 当前轮到的玩家（同屏双人靠 activeSeat 换人；人机对战永远是 0）
    // 暂停期间返回 null：返回菜单后界面已经不在对局页，任何迟到的揭示/道具请求都不生效。
    _active() {
      const room = this.room;
      if (!room || room.suspended) return null;
      const seat = room.activeSeat;
      return { room: room, seat: seat, player: room.players[seat] };
    }

    // ---------- 创建房间 ----------
    _createRoom(data, isAI, isLocal2P) {
      this._clearRoom();

      const name = (typeof data.name === 'string' ? data.name.trim() : '') || randomName();
      if (Array.from(name).length > 12) return this._error('昵称最长 12 个字符');
      const mode = data.mode === 'props' ? 'props' : 'classic';
      const boardSize = Object.prototype.hasOwnProperty.call(BOARD_SPECS, data.boardSize)
        ? data.boardSize : 'S';
      const avatar = Array.from(String(data.avatar || '')).slice(0, 4).join('');

      const room = {
        id: isLocal2P ? 'LOCAL2' : 'LOCAL',
        players: [
          newPlayer(name, avatar),
          newPlayer(isAI ? '🤖 电脑' : '玩家2', isAI ? '' : randomAvatar())
        ],
        phase: 'deploy',
        mode: mode,
        boardSize: boardSize,
        coins: [COIN_START, COIN_START],
        sonarHistory: [],
        frozenCells: [],
        steps: [0, 0],
        score: [0, 0],
        winner: null,
        winReason: null,
        rematchVotes: [false, false],
        spectators: [],
        isAI: !!isAI,
        local: true,
        local2p: !!isLocal2P,
        activeSeat: 0,     // 同屏双人当前轮到谁
        clientSeat: 0,     // 界面当前显示的是谁的视角（交接后变化）
        suspended: false,  // 返回菜单后暂停：房间保留在内存里，可从首页继续上局
        aiTimer: null,
        aiRematchTimer: null
      };
      this.room = room;
      resetToDeploy(room);

      this._fire('roomCreated', {
        roomId: room.id, token: 'local', seat: 0, name: name,
        names: [room.players[0].name, room.players[1].name],
        avatars: [room.players[0].avatar, room.players[1].avatar],
        online: [true, true],
        isAI: !!isAI,
        local: true,
        local2p: !!isLocal2P,
        mode: mode,
        boardSize: boardSize,
        deployConfirmed: [false, !!isAI]
      });

      if (isAI) this._aiDeployAndConfirm();
    }

    _handleCreateAI(data) { this._createRoom(data, true, false); }
    _handleCreateLocal(data) { this._createRoom(data, false, true); }

    _handleOnlineOnly() {
      this._error('离线版不支持联机房间');
    }

    _handleRejoin(data) {
      this._fire('rejoinFailed', {
        roomId: String(data.roomId || ''),
        message: '离线版没有可恢复的联机对局'
      });
    }

    _handleCheckRooms(data) {
      // 旧的联机房间记录在离线版里一律视为失效，让界面自动清掉
      this._fire('roomsAlive', { alive: [] });
    }

    _handleVisit() {
      this._fire('visitResult', { total: 0 });
    }

    _handleLeaveRoom() {
      this._clearRoom();
      this._fire('leftRoom', {});
    }

    // ---------- 返回菜单 / 继续上局 ----------
    // 返回菜单不再销毁房间：只标记暂停、停掉 AI 思考，首页用摘要卡提示可以继续。
    // 摘要故意不含飞机和落子记录：首页不需要，也不该把布局暴露在菜单里。
    _roomSuspendedSummary(room) {
      return {
        phase: room.phase,
        mode: room.mode,
        boardSize: room.boardSize,
        names: room.players.map(function (p) { return p.name; }),
        avatars: room.players.map(function (p) { return p.avatar || ''; }),
        steps: room.steps.slice(),
        score: room.score.slice(),
        local2p: !!room.local2p,
        isAI: !!room.isAI,
        activeSeat: room.activeSeat,
        deployConfirmed: room.players.map(function (p) { return !!p.deployConfirmed; })
      };
    }

    _handleSuspendRoom() {
      const room = this.room;
      if (!room) {
        this._fire('leftRoom', {});
        return;
      }
      if (room.phase === 'over') {
        // 已结束的对局没有继续的必要（战绩已经写进对战历史），按原来的退出处理
        this._clearRoom();
        this._fire('leftRoom', {});
        return;
      }
      if (!room.suspended) {
        room.suspended = true;
        // AI 暂停思考：否则玩家在首页等一会儿，回来时步数已经被 AI 推着走了
        this._clearTimer(room.aiTimer);
        room.aiTimer = null;
      }
      this._fire('roomSuspended', this._roomSuspendedSummary(room));
    }

    _handleResumeRoom(data) {
      const room = this.room;
      if (!room || !room.suspended) {
        this._fire('resumeFailed', { fatal: true, message: '没有可继续的对局' });
        return;
      }

      let seat = 0;
      if (room.local2p) {
        const asked = data && data.seat;
        if (asked !== 0 && asked !== 1) {
          this._fire('resumeFailed', { fatal: false, message: '请选择当前操作的玩家' });
          return;
        }
        if (asked !== room.activeSeat) {
          this._fire('resumeFailed', {
            fatal: false,
            message: '现在轮到 ' + room.players[room.activeSeat].name + '，请把设备交给 TA'
          });
          return;
        }
        seat = asked;
      }

      room.suspended = false;
      room.clientSeat = seat;
      this._sendSnapshot(seat);
      // 暂停期间轮到 AI，定时器已经被清掉：恢复后重新开始思考
      if (room.phase === 'battle') this._scheduleAITurn();
    }

    // ---------- 部署 ----------
    _handleDeployConfirm(data) {
      const loc = this._active();
      if (!loc) return this._error('你不在任何房间中');
      const room = loc.room, seat = loc.seat, player = loc.player;
      if (room.phase !== 'deploy') return this._error('现在不是部署阶段');
      if (player.deployConfirmed) return this._error('你已经确认过了');

      const err = validateDeployment(data.planes, room.boardSize);
      if (err) return this._error(err);

      player.planes = data.planes.map(function (p) {
        return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
      });
      player.board = buildBoard(player.planes, room.boardSize);
      player.deployConfirmed = true;

      const confirmed = [room.players[0].deployConfirmed, room.players[1].deployConfirmed];
      this._fire('deployReady', { seat: seat, confirmed: confirmed });

      if (confirmed[0] && confirmed[1]) {
        // 双方就绪：开战。最后确认的人拿着设备，由他先手
        room.phase = 'battle';
        room.steps = [0, 0];
        this._fire('battleStart', {
          names: room.players.map(function (p) { return p.name; }),
          avatars: room.players.map(function (p) { return p.avatar || ''; }),
          steps: room.steps,
          score: room.score,
          online: [true, true],
          mode: room.mode,
          boardSize: room.boardSize,
          coins: room.coins
        });
        if (room.isAI) this._scheduleAITurn();
      }
      // 同屏双人还没都确认：不强制换人。界面会在顶部显示「请切换给另一位玩家」，
      // 由当前玩家自己点按钮进入交接页。
    }

    _handleDeployCancel() {
      const loc = this._active();
      if (!loc) return this._error('你不在任何房间中');
      const room = loc.room, player = loc.player, seat = loc.seat;
      if (room.phase !== 'deploy') return this._error('现在不是部署阶段');
      if (!player.deployConfirmed) return this._error('你还没有确认，无需取消');

      player.deployConfirmed = false;
      player.planes = null;
      player.board = null;
      this._fire('deployReady', {
        seat: seat,
        confirmed: [room.players[0].deployConfirmed, room.players[1].deployConfirmed]
      });
    }

    // ---------- 对战：揭示 ----------
    _handleReveal(data) {
      const loc = this._active();
      if (!loc) return this._error('你不在任何房间中');
      const room = loc.room, seat = loc.seat;
      if (room.phase !== 'battle') return this._error('现在还不能攻击（未开战或已结束）');

      const row = data.row, col = data.col;
      const size = getBoardSpec(room.boardSize).size;
      if (!Number.isInteger(row) || !Number.isInteger(col) ||
          row < 0 || row >= size || col < 0 || col >= size) {
        return this._error('坐标无效');
      }

      const defender = room.players[1 - seat];
      if (defender.shotsReceived.some(function (s) { return s.row === row && s.col === col; })) {
        return this._error('这个格子已经揭示过了');
      }
      if (isFrozenCell(room, seat, row, col)) {
        return this._error('这个格子被毁灭菇冻结，你还不能揭示它');
      }
      if (room.steps[seat] > room.steps[1 - seat]) {
        return this._error(room.local2p
          ? '你的步数已领先，请切换玩家'
          : '你的步数已领先，等待对方追上');
      }

      this._tryReveal(room, seat, row, col);
      // 同屏双人：不强制换人。步数落后的一方可以继续行动追平；
      // 步数领先时界面会显示更醒目的「请切换玩家」提示。
    }

    // 执行一次揭示（调用前已校验）
    _tryReveal(room, seat, row, col, noStep) {
      if (isFrozenCell(room, seat, row, col)) return false;
      const defender = room.players[1 - seat];
      const cell = defender.board[row][col];
      const result = cell === CELL_HEAD ? 'head' : cell === CELL_BODY ? 'body' : 'empty';
      defender.shotsReceived.push({ row: row, col: col, result: result });
      if (!noStep) room.steps[seat] += 1;

      let coinGain = 0;
      if (room.mode === 'props') {
        coinGain = result === 'head' ? COIN_HEAD : result === 'body' ? COIN_BODY : COIN_EMPTY;
        room.coins[seat] += coinGain;
      }

      const headsLeft = headsLeftOf(room);
      this._fire('revealResult', {
        attacker: seat, row: row, col: col, result: result,
        headsLeft: headsLeft, steps: room.steps,
        coinGain: coinGain, coins: room.coins
      });

      if (headsLeft[1 - seat] === 0) {
        this._endGame(seat, 'allHeads');
        return true;
      }
      if (room.isAI) this._scheduleAITurn();
      return true;
    }

    // ---------- 对战：道具 ----------
    _handleUseItem(data) {
      const loc = this._active();
      if (!loc) return this._error('你不在任何房间中');
      const room = loc.room, seat = loc.seat;
      if (room.phase !== 'battle') return this._error('现在还不能使用道具（未开战或已结束）');
      if (room.mode !== 'props') return this._error('经典玩法没有道具');

      const err = this._doUseItem(room, seat, data.itemId, data);
      if (err) return this._error(err);
      // 同屏双人：道具也算一次行动，但不强制换人（规则见 _handleReveal）
    }

    // 使用道具的「校验 + 执行」主体（返回 null = 成功；字符串 = 错误）
    _doUseItem(room, seat, itemId, data) {
      const price = ITEM_PRICES[itemId];
      if (!price) return '没有这个道具';

      if (room.steps[seat] > room.steps[1 - seat]) {
        return room.local2p
          ? '你的步数已领先，请切换玩家'
          : '你的步数已领先，等待对方追上';
      }
      if (room.coins[seat] < price) return '金币不够，买不起这个道具';

      const size = getBoardSpec(room.boardSize).size;
      const defender = room.players[1 - seat];
      const self = this;

      if (itemId === 'sonar') {
        const row = data.row, col = data.col;
        if (!checkRegion(row, col, size)) return '区域越界（3×3 必须完整落在棋盘内）';
        if (hasFrozenCell(room, seat, regionCells(row, col))) return '选区里包含冻结的格子，还不能选中';
        let count = 0;
        regionCells(row, col).forEach(function (cell) {
          if (defender.board[cell[0]][cell[1]] !== CELL_EMPTY) count++;
        });
        room.coins[seat] -= price;
        room.steps[seat] += 1;
        room.sonarHistory.push({ row: row, col: col, count: count, attacker: seat });
        this._finishItem(room, seat, 'sonar', { row: row, col: col, count: count });
        return null;
      }

      if (itemId === 'pro') {
        const row = data.row, col = data.col;
        if (!checkRegion(row, col, size)) return '区域越界（3×3 必须完整落在棋盘内）';
        if (hasFrozenCell(room, seat, regionCells(row, col))) return '选区里包含冻结的格子，还不能选中';
        const open = regionCells(row, col).filter(function (cell) {
          return !defender.shotsReceived.some(function (s) {
            return s.row === cell[0] && s.col === cell[1];
          });
        });
        if (!open.length) return '这个区域已经全部揭示过了';
        const tiers = [[], [], []];
        open.forEach(function (cell) { tiers[defender.board[cell[0]][cell[1]]].push(cell); });
        if (!tiers[CELL_BODY].length && !tiers[CELL_HEAD].length) {
          // 整片全空：一次揭示整个 3×3（逐格发 revealResult，界面逐条渲染）
          room.coins[seat] -= price;
          room.steps[seat] += 1;
          const headsLeft = headsLeftOf(room);
          open.forEach(function (cell) {
            defender.shotsReceived.push({ row: cell[0], col: cell[1], result: 'empty' });
            self._fire('revealResult', {
              attacker: seat, row: cell[0], col: cell[1], result: 'empty',
              headsLeft: headsLeft, steps: room.steps, coinGain: 0, coins: room.coins
            });
          });
          if (room.isAI) this._scheduleAITurn();
          return null;
        }
        const pool = tiers[CELL_BODY].length ? tiers[CELL_BODY]
          : tiers[CELL_HEAD].length ? tiers[CELL_HEAD] : tiers[CELL_EMPTY];
        const pick = pool[rnd(pool.length)];
        room.coins[seat] -= price;
        this._tryReveal(room, seat, pick[0], pick[1]);
        return null;
      }

      if (itemId === 'burst') {
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
        room.steps[seat] += 1;
        this._tryReveal(room, seat, cells[0][0], cells[0][1], true);
        if (room.phase === 'battle') this._tryReveal(room, seat, cells[1][0], cells[1][1], true);
        return null;
      }

      if (itemId === 'expose') {
        const row = data.row, col = data.col;
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= size || col < 0 || col >= size) {
          return '坐标无效';
        }
        const headRec = defender.shotsReceived.find(function (s) {
          return s.row === row && s.col === col && s.result === 'head';
        });
        if (!headRec) return '这格不是已经揭示的机头';
        const plane = defender.planes.find(function (p) {
          return p.headRow === row && p.headCol === col;
        });
        if (!plane) return '找不到对应的飞机';
        const cells = getPlaneCells(row, col, plane.dir);
        const allShown = cells.every(function (cell) {
          return defender.shotsReceived.some(function (s) { return s.row === cell[0] && s.col === cell[1]; });
        });
        if (allShown) return '这架飞机已经完整揭示了，不用浪费金币';
        cells.forEach(function (cell) {
          if (!defender.shotsReceived.some(function (s) {
            return s.row === cell[0] && s.col === cell[1];
          })) {
            defender.shotsReceived.push({ row: cell[0], col: cell[1], result: 'body' });
          }
        });
        room.coins[seat] -= price;
        room.steps[seat] += 1;
        this._finishItem(room, seat, 'expose', { row: row, col: col, cells: cells });
        return null;
      }

      if (itemId === 'devour') {
        const row = data.row, col = data.col;
        if (!checkRegion(row, col, size)) return '区域越界（3×3 必须完整落在棋盘内）';
        if (hasFrozenCell(room, seat, regionCells(row, col))) return '选区里包含冻结的格子，还不能选中';
        const destroyed = [];
        let headHit = null;
        regionCells(row, col).forEach(function (cell) {
          const r = cell[0], c = cell[1];
          if (defender.shotsReceived.some(function (s) { return s.row === r && s.col === c; })) return;
          if (defender.board[r][c] === CELL_HEAD) {
            headHit = [r, c];
            defender.shotsReceived.push({ row: r, col: c, result: 'head', destroyed: true });
          } else {
            defender.shotsReceived.push({ row: r, col: c, result: 'destroyed' });
          }
          destroyed.push([r, c]);
        });
        if (!destroyed.length) return '这个区域没有可摧毁的格子';
        room.coins[seat] -= price;
        room.steps[seat] += 1;
        this._finishItem(room, seat, 'devour', { row: row, col: col, destroyed: destroyed, headHit: headHit });
        return null;
      }

      if (itemId === 'doom') {
        const row = data.row, col = data.col;
        if (!Number.isInteger(row) || !Number.isInteger(col) ||
            row < 1 || row > size - 2 || col < 1 || col > size - 2) {
          return '十字中心离棋盘边太近，无法完整落盘';
        }
        const cells = crossCells(row, col);
        if (hasFrozenCell(room, seat, cells)) return '十字里包含冻结的格子，还不能选中';

        const revealed = [];
        cells.forEach(function (cell) {
          if (!defender.shotsReceived.some(function (s) {
            return s.row === cell[0] && s.col === cell[1];
          })) {
            revealed.push(this._revealCell(room, seat, cell[0], cell[1]));
          }
        }, this);
        if (!revealed.length) return '十字的 5 格都已经揭示过了';

        const frozen = [];
        [[row - 1, col - 1], [row - 1, col + 1], [row + 1, col - 1], [row + 1, col + 1]].forEach(function (n) {
          if (defender.shotsReceived.some(function (s) { return s.row === n[0] && s.col === n[1]; })) return;
          frozen.push([n[0], n[1]]);
        });

        room.coins[seat] -= price;
        room.steps[seat] += 1;
        const frozenRecs = frozen.map(function (f) {
          return { row: f[0], col: f[1], owner: seat, expiry: room.steps[seat] + 2 };
        });
        room.frozenCells = room.frozenCells.concat(frozenRecs);
        this._finishItem(room, seat, 'doom', { row: row, col: col, cells: revealed, frozen: frozenRecs });
        return null;
      }

      return '未知道具';
    }

    // 揭示一个格子（记录 + 金币），不改变步数：毁灭菇一次行动揭示多格专用
    _revealCell(room, seat, row, col) {
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

    // 道具结算公共部分：广播 itemResult、判胜、调度 AI
    _finishItem(room, seat, itemId, payload) {
      const headsLeft = headsLeftOf(room);
      this._fire('itemResult', Object.assign({
        itemId: itemId,
        attacker: seat,
        steps: room.steps,
        coins: room.coins,
        headsLeft: headsLeft
      }, payload));
      if (headsLeft[1 - seat] === 0) {
        this._endGame(seat, 'allHeads');
        return false;
      }
      if (room.isAI) this._scheduleAITurn();
      return true;
    }

    // ---------- AI（人机对战） ----------
    _aiDeployAndConfirm() {
      const room = this.room;
      if (!room || !room.isAI) return;
      const aiPlayer = room.players[1];
      const planes = LocalAI.smartDeployment(room.boardSize);
      if (!planes) return;
      aiPlayer.planes = planes;
      aiPlayer.board = buildBoard(planes, room.boardSize);
      aiPlayer.deployConfirmed = true;
      this._fire('deployReady', {
        seat: 1,
        confirmed: [room.players[0].deployConfirmed, true]
      });
    }

    // 轮到 AI 时安排它走一步（带随机「思考」延迟）
    _scheduleAITurn() {
      const self = this;
      const room = this.room;
      if (!room || !room.isAI || room.aiTimer) return;
      if (room.suspended) return; // 返回菜单期间 AI 不思考
      if (room.phase !== 'battle') return;
      if (room.steps[1] > room.steps[0]) return;

      const thinkMs = AI_THINK_MIN_MS + rnd(AI_THINK_MAX_MS - AI_THINK_MIN_MS + 1);
      room.aiTimer = this._setTimer(function () {
        room.aiTimer = null;
        if (self.room !== room || room.phase !== 'battle') return;
        if (room.suspended) return; // 暂停瞬间可能已排队，触发时再兜底一次
        if (room.steps[1] > room.steps[0]) return;

        const size = getBoardSpec(room.boardSize).size;
        const shots = room.players[0].shotsReceived;
        // 只有自己施放的冻结才限制自己
        const myFrozen = room.frozenCells.filter(function (f) { return f.owner === 1; })
          .map(function (f) { return { row: f.row, col: f.col }; });

        // 经典 S 规格用精确算法；其余组合用概率场（与服务器默认策略一致）
        const useLive = (room.boardSize === 'S' && room.mode === 'classic');
        let pf = null;
        let target1 = null;
        if (useLive) {
          target1 = LocalAI.chooseTargetLive(shots);
        } else {
          pf = LocalAI.buildProbField(shots, size, {
            samples: AI_SAMPLES,
            sonarCounts: room.sonarHistory.filter(function (s) { return s.attacker === 1; })
          });
          target1 = (pf.head ? LocalAI.chooseTargetProbField(shots, size, myFrozen, { probField: pf }) : null)
            || LocalAI.chooseTargetSimple(shots, size, myFrozen);
        }

        let acted = false;
        if (room.mode === 'props' && target1) {
          const item = LocalAI.decideItem(room.coins[1], shots, size, myFrozen, pf);
          if (item) {
            acted = !self._doUseItem(room, 1, item.itemId, item.data);
          }
        }
        if (!acted && target1) {
          self._tryReveal(room, 1, target1.row, target1.col);
        }

        if (room.phase === 'battle' && room.steps[1] <= room.steps[0]) self._scheduleAITurn();
      }, thinkMs);
    }

    // ---------- 同屏双人：交接设备 ----------
    // 界面只在「可以换人」时显示顶部悬浮条，玩家点「切换玩家」并确认后才发 passReady。
    // 这里再校验一次，防止落后方把设备交给领先方（对方接过去也不能行动）。
    _handlePassReady(data) {
      const room = this.room;
      if (!room || !room.local2p || room.suspended) return;
      const current = room.activeSeat;
      const next = 1 - current;
      if (data.seat != null && data.seat !== next) return; // 界面数据过期，忽略

      if (room.phase === 'deploy') {
        // 自己还没确认部署时不能换人：对方会看到还没提交的布局
        if (!room.players[current].deployConfirmed) {
          return this._error('请先确认你的部署');
        }
      } else if (room.phase === 'battle') {
        // 对方接过去必须能行动：对方步数不能领先
        if (room.steps[next] > room.steps[current]) {
          return this._error('你的步数落后，先追平再切换');
        }
      } else {
        return; // 对局已结束，不需要换人
      }

      room.activeSeat = next;
      room.clientSeat = next;
      this._sendSnapshot(next);
    }

    // 把某个座位的完整现场发给界面（等价于联机版的断线重连快照）
    _sendSnapshot(seat) {
      const room = this.room;
      if (!room) return;
      const player = room.players[seat];
      const enemy = room.players[1 - seat];
      this._fire('reconnected', {
        roomId: room.id,
        seat: seat,
        name: player.name,
        avatar: player.avatar,
        names: room.players.map(function (p) { return p.name; }),
        avatars: room.players.map(function (p) { return p.avatar || ''; }),
        online: [true, true],
        phase: room.phase,
        mode: room.mode,
        boardSize: room.boardSize,
        coins: room.coins,
        steps: room.steps,
        score: room.score,
        headsLeft: headsLeftOf(room),
        deployConfirmed: room.players.map(function (p) { return !!p.deployConfirmed; }),
        // 注意：这里必须复制一份数组再交给界面。
        // 界面收到 revealResult 会往 state 的数组里 push，如果直接传服务端的数组，
        // 同一条揭示记录会被服务器和界面各记一次，机头计数就错了。
        myPlanes: (player.planes || []).map(function (p) {
          return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
        }),
        myShotsReceived: player.shotsReceived.map(function (s) {
          return { row: s.row, col: s.col, result: s.result, destroyed: s.destroyed };
        }),
        enemyShotsReceived: enemy.shotsReceived.map(function (s) {
          return { row: s.row, col: s.col, result: s.result, destroyed: s.destroyed };
        }),
        sonarHistory: room.sonarHistory.map(function (s) {
          return { row: s.row, col: s.col, count: s.count, attacker: s.attacker };
        }),
        frozenCells: activeFrozenCells(room).map(function (f) {
          return { row: f.row, col: f.col, owner: f.owner, expiry: f.expiry };
        }),
        winner: room.winner,
        winReason: room.winReason,
        rematchVotes: room.rematchVotes.slice(),
        isAI: room.isAI,
        planes: room.phase === 'over' ? room.players.map(function (p) {
          return p ? p.planes : null;
        }) : null,
        local: true,
        local2p: !!room.local2p
      });
    }

    // ---------- 结束与再来一局 ----------
    _endGame(winnerSeat, reason) {
      const self = this;
      const room = this.room;
      if (!room || room.phase === 'over') return;
      room.phase = 'over';
      room.winner = winnerSeat;
      room.winReason = reason;
      room.score[winnerSeat] += 1;

      this._fire('gameOver', {
        winner: winnerSeat,
        reason: reason,
        headsLeft: headsLeftOf(room),
        score: room.score,
        planes: room.players.map(function (p) { return p ? p.planes : null; })
      });

      if (room.isAI) {
        this._clearTimer(room.aiTimer);
        room.aiTimer = null;
        // AI 稍等片刻自动投「再来一局」票（和真人点按钮一样）
        room.aiRematchTimer = this._setTimer(function () {
          room.aiRematchTimer = null;
          if (self.room !== room || room.phase !== 'over') return;
          room.rematchVotes[1] = true;
          self._fire('rematchVote', { seat: 1, votes: room.rematchVotes });
          if (room.rematchVotes[0]) self._startRematch();
        }, 1500);
      }
    }

    _handleRematch() {
      const room = this.room;
      if (!room) return this._error('你不在任何房间中');
      if (room.phase !== 'over') return this._error('游戏还没结束');

      if (room.local2p) {
        // 同屏双人：点按钮代表两人都同意，直接重开
        room.rematchVotes = [true, true];
        this._fire('rematchVote', { seat: room.clientSeat, votes: room.rematchVotes });
        this._startRematch();
        return;
      }

      room.rematchVotes[0] = true;
      this._fire('rematchVote', { seat: 0, votes: room.rematchVotes });
      if (room.rematchVotes[1]) this._startRematch();
    }

    _startRematch() {
      const room = this.room;
      if (!room) return;
      resetToDeploy(room);
      // 同屏双人：设备在谁手里，就由谁先重新部署（不强制换人）。
      // 另一位玩家部署前，顶部会出现「请切换玩家」提示。
      if (room.local2p) room.activeSeat = room.clientSeat;
      this._fire('rematchStart', {
        names: room.players.map(function (p) { return p.name; }),
        avatars: room.players.map(function (p) { return p.avatar || ''; })
      });
      if (room.isAI) this._aiDeployAndConfirm();
    }

    // ---------- 房内改名 / 换头像 ----------
    _handleSetNickname(data) {
      const loc = this._active();
      if (!loc) return; // 不在房间（首页改昵称）：只存本地
      const err = checkName(loc.room, data.name, loc.seat);
      if (err) return this._error(err);
      const name = data.name.trim();
      loc.player.name = name;
      this._fire('nicknameUpdated', { seat: loc.seat, name: name });
    }

    _handleSetAvatar(data) {
      const loc = this._active();
      if (!loc) return;
      const avatar = Array.from(String(data.avatar || '')).slice(0, 4).join('');
      loc.player.avatar = avatar;
      this._fire('avatarUpdated', { seat: loc.seat, avatar: avatar });
    }
  }

  // 挂到 window：client.js 的 init() 用 new LocalServer() 替换原来的 WSClient
  window.LocalServer = LocalServer;
})();
