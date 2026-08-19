// ============================================
// pages/battle/battle.js —— 对战页：双棋盘 + 抢步揭示 + 道具 + 观战等待 + 结束横幅
// 渲染逻辑对齐网页版 client.js 的 goBattle / goWait / goOver /
// updateBattlePanels / updateOverRematchStatus；点对方棋盘的规则
// 对齐 onEnemyCellClick；道具选区交互对齐 pickItemCell。
// ============================================
'use strict';

const app = getApp();
const state = app.globalData.state;
const shared = app.shared;

// 道具价格表（与服务器 server.js 的 ITEM_PRICES 保持一致，按钮置灰用）
const ITEM_PRICES = { pro: 3, sonar: 4, expose: 4, burst: 4, devour: 3, doom: 6 };
// 道具的中文名 + 效果 + 操作指引（选区状态条显示：先讲效果，再讲怎么选）
const ITEM_NAMES = {
  sonar: '声呐脉冲', pro: '探测者', burst: '双发连射', expose: '无所遁形', devour: '吞噬者',
  doom: '毁灭菇'
};
const ITEM_TIPS = {
  sonar: '· 在对方棋盘选 3×3 区域，显示其中飞机格的数量',
  pro: '· 在对方棋盘选 3×3 区域，按「机身→机头→空」优先揭示 1 格真实内容',
  burst: '· 点对方棋盘 2 个未知格，一次行动同时揭示',
  expose: '· 点已揭示的机头格，完整揭示整架飞机（10 格全显示）',
  devour: '· 摧毁对方棋盘 3×3 区域内的未揭示格，命中机头即发现飞机',
  doom: '· 点对方棋盘任意格作十字中心：十字 5 格揭示，相邻未揭示格冻结 2 回合'
};

function toast(title) {
  wx.showToast({ title: title, icon: 'none' });
}

Page({
  data: {
    themeClass: app.getThemeClass(),
    roomId: '',
    spectator: false,
    spectatorCount: 0,
    showWait: false,          // 观战者在双方部署时的等待页
    scoreVisible: false,
    scoreA: 0,
    scoreB: 0,
    myName: '', myAvatar: '', myDot: false, mySteps: 0, myHeads: '0/3', myTurn: '',
    enemyName: '', enemyAvatar: '', enemyDot: false, enemySteps: 0, enemyHeads: '0/3', enemyTurn: '',
    boardTitleMy: '', boardTitleEnemy: '', boardNoteMy: '', boardNoteEnemy: '',
    modeBadge: '',          // 玩法徽章（道具版才显示：「道具版 · 规格 · 架数」）
    myCells: [],
    enemyCells: [],
    cellW: '10%',             // 格子宽度（按规格 10/12/14 自适应）
    cellH: '68rpx',           // 格子高度
    coinsVisible: false,      // 金币行（道具版显示，双方可见）
    myCoins: 0, enemyCoins: 0,
    items: [],                // 道具栏 [{id, label, price, disabled, active}]
    itemStatusVisible: false, // 道具选区状态条
    itemStatusText: '',
    showItemConfirm: false,
    over: false,
    overTitle: '', overDetail: '', overStatus: '',
    showRematchBtn: false, rematchText: '再来一局',
    pending: {},              // 'r,c' -> true：已点击、等待服务器回复的格子
    showRules: false,         // 规则弹窗（对战页副本，首页那份不动）
    rulesTab: 'classic',      // 当前规则栏：经典 / 道具（打开时默认当前模式）
    battleDiagrams: []        // 4 种飞机朝向示意图（复用首页规则弹窗的数据源）
  },

  onLoad() {
    this.setData({ battleDiagrams: app.rulesDiagrams() }); // 规则弹窗的朝向示意图
    this._subs = [];
    // 收到揭示结果 / 出错：先清掉"处理中"格子的样式，再整页重渲染
    // （其余事件直接整页重渲染即可）
    const self = this;
    ['battleStart', 'gameOver', 'playerStatus', 'avatarUpdated', 'rematchVote', 'rematchStart',
      'spectatorCount', 'reconnected', 'theme'].forEach(function (e) {
      self._sub(e, function () { self.render(); });
    });
    self._sub('revealResult', function () { self.data.pending = {}; self.render(); });
    self._sub('itemResult', function () { self.data.pending = {}; self.render(); });
    self._sub('error', function () { self.data.pending = {}; self.render(); });
  },

  _sub(event, cb) {
    app.on(event, cb);
    this._subs.push([event, cb]);
  },

  onUnload() {
    this._subs.forEach(function (pair) { app.off(pair[0], pair[1]); });
  },

  onShow() {
    this.render();
  },

  // 整页渲染（对齐 goWait + goBattle + goOver + updateBattlePanels）
  render() {
    const s = state;
    const showWait = s.spectator && (s.phase === 'deploy' || s.phase === 'waiting');
    if (showWait) {
      this.setData({
        themeClass: app.getThemeClass(),
        roomId: s.roomId,
        spectator: s.spectator,
        spectatorCount: s.spectatorCount,
        modeBadge: s.mode === 'props'
          ? '🎁 道具版 · ' + shared.getBoardSpec(s.boardSize).size + '×' + shared.getBoardSpec(s.boardSize).size + ' · ' + shared.getBoardSpec(s.boardSize).planeCount + ' 架' : '',
        boardNoteMy: '', boardNoteEnemy: '',
        showWait: true
      });
      return;
    }

    // ---- 双棋盘（含 last-reveal 蓝色框框选） ----
    const myCells = app.myBoardCells();
    const enemyCells = app.enemyBoardCells();
    const lastTheirs = s.myShotsReceived[s.myShotsReceived.length - 1];
    if (lastTheirs) addClass(myCells, lastTheirs.row, lastTheirs.col, 'last-reveal');
    const lastMine = s.enemyShotsReceived[s.enemyShotsReceived.length - 1];
    if (lastMine) addClass(enemyCells, lastMine.row, lastMine.col, 'last-reveal');
    // 我点过、还没收到服务器回复的格子：立即变色反馈
    Object.keys(this.data.pending).forEach(function (key) {
      const parts = key.split(',');
      addClass(enemyCells, +parts[0], +parts[1], 'cell-pending');
    });

    // ---- 面板（对齐 updateBattlePanels） ----
    let myName, myAvatar, myDot, mySteps, myHeads, myTurn;
    let enemyName, enemyAvatar, enemyDot, enemySteps, enemyHeads, enemyTurn;
    let boardTitleMy, boardTitleEnemy;
    // 棋盘标题旁的操作提示（观战者不需要，留空）
    let boardNoteMy = '', boardNoteEnemy = '';
    if (!s.spectator) {
      boardNoteMy = '（对方打过的位置高亮）';
      boardNoteEnemy = '（点未知格揭示 · 长按可标注机身）';
    }
    const sp = shared.getBoardSpec(s.boardSize); // 当前房间规格（机头数按规格显示）
    const headsOf = function (seat) { return (sp.planeCount - s.headsLeft[seat]) + '/' + sp.planeCount; };

    if (s.spectator) {
      myName = s.names[0]; myAvatar = s.avatars[0] || ''; myDot = !!s.online[0];
      mySteps = s.steps[0]; myHeads = headsOf(1); myTurn = '👁 观战中';
      enemyName = s.names[1]; enemyAvatar = s.avatars[1] || ''; enemyDot = !!s.online[1];
      enemySteps = s.steps[1]; enemyHeads = headsOf(0); enemyTurn = '';
      boardTitleMy = (s.names[0] || '1号') + ' 的棋盘';
      boardTitleEnemy = (s.names[1] || '2号') + ' 的棋盘';
    } else {
      myName = s.names[s.seat] + '（我）'; myDot = !!s.online[s.seat];
      // 我的头像用本地值（对局中换的头像立刻生效），对手用服务器广播的
      myAvatar = app.myAvatar();
      mySteps = s.steps[s.seat]; myHeads = headsOf(1 - s.seat);
      enemyName = s.names[1 - s.seat]; enemyAvatar = s.avatars[1 - s.seat] || ''; enemyDot = !!s.online[1 - s.seat];
      enemySteps = s.steps[1 - s.seat]; enemyHeads = headsOf(s.seat);
      boardTitleMy = '我的棋盘';
      boardTitleEnemy = '对方棋盘';

      const mine = s.steps[s.seat], theirs = s.steps[1 - s.seat];
      myTurn = mine <= theirs ? (mine === theirs ? '⚡ 双方抢步中' : '✓ 可行动') : '⏳ 等待对方';
      enemyTurn = theirs <= mine ? (theirs === mine ? '⚡ 双方抢步中' : '✓ 可行动') : '⏳ 等待对方';
    }

    // 比分条：从第二局起显示（第一局 0:0 不显示）
    const scoreVisible = (s.score[0] + s.score[1]) > 0;
    const a = s.spectator ? 0 : s.seat;

    // ---- 金币（道具版双方可见；经典版隐藏该行）。观战视角左 = 1 号玩家、右 = 2 号玩家 ----
    const coinsVisible = s.mode === 'props';
    const myCoins = s.coins[s.spectator ? 0 : s.seat];
    const enemyCoins = s.coins[s.spectator ? 1 : (1 - s.seat)];

    // ---- 道具栏（对齐 web 端 updateItemButtons）----
    // 道具版 + 非观战 + 非结束 + 步数不领先才可点；金币不够的单个置灰
    const canAct = !s.spectator && !s.over && s.steps[s.seat] <= s.steps[1 - s.seat];
    // 价格统一从 ITEM_PRICES 取（曾经写死 2/3/5/5/5/10 旧价导致按钮显示与真实价格不一致）
    const ITEM_ORDER = [
      { id: 'pro', label: '🔍 探测者', desc: '身→头→空优先揭 1 格 · 全空揭全区' },
      { id: 'sonar', label: '🔊 声呐', desc: '区域内飞机数量' },
      { id: 'expose', label: '👁 无所遁形', desc: '整架飞机全揭示' },
      { id: 'burst', label: '💥 双发', desc: '一次行动揭 2 格' },
      { id: 'devour', label: '🧨 吞噬者', desc: '3×3 区域摧毁' },
      { id: 'doom', label: '🌋 毁灭菇', desc: '十字揭示+冻结' }
    ];
    const items = ITEM_ORDER.map(function (it) {
      const price = ITEM_PRICES[it.id];
      return {
        id: it.id, label: it.label, price: price,
        disabled: !canAct || s.coins[s.seat] < price,
        active: !!(s.itemPick && s.itemPick.itemId === it.id)
      };
    });
    // 道具选区状态条：选择道具后显示操作指引；选区完整后出现「确认使用」按钮
    const itemStatusVisible = !!s.itemPick;
    const itemStatusText = s.itemPick ? ITEM_NAMES[s.itemPick.itemId] + ITEM_TIPS[s.itemPick.itemId] : '';
    const showItemConfirm = !!s.itemPick && s.pickReady;

    // ---- 结束横幅（对齐 goOver + updateOverRematchStatus） ----
    let overTitle = '', overDetail = '', overStatus = '', showRematchBtn = false, rematchText = '再来一局';
    if (s.over) {
      boardNoteMy = '';
      boardNoteEnemy = '（暗色 = 对方没被你探测过的格子）';
      myTurn = '🏁 对局结束';
      enemyTurn = '';
      const votes = s.rematchVotes.filter(Boolean).length;
      if (s.spectator) {
        overTitle = '🏁 ' + (s.names[s.winner] || '') + ' 获胜';
        overDetail = (s.names[0] || '1号') + ' 击中机头 ' + headsOf(1) + ' · ' +
          (s.names[1] || '2号') + ' 击中机头 ' + headsOf(0);
        overStatus = votes > 0 ? '双方想再来一局：' + votes + '/2' : '';
      } else {
        overTitle = s.winner === s.seat ? '🎉 你赢了！' : '你输了';
        overDetail = '你击中机头 ' + headsOf(1 - s.seat) + ' · 对方击中机头 ' + headsOf(s.seat);
        showRematchBtn = true;
        const mine = s.rematchVotes[s.seat];
        rematchText = mine ? '再来一局（' + votes + '/2）' : '再来一局';
        overStatus = mine ? '已提交，等待对方（' + votes + '/2）'
          : votes > 0 ? '对方想再来一局' : '';
      }
    }

    this.setData({
      themeClass: app.getThemeClass(),
      roomId: s.roomId,
      spectator: s.spectator,
      spectatorCount: s.spectatorCount,
      showWait: false,
      scoreVisible: scoreVisible,
      scoreA: s.score[a],
      scoreB: s.score[1 - a],
      myName: myName, myAvatar: myAvatar, myDot: myDot, mySteps: mySteps, myHeads: myHeads, myTurn: myTurn,
      enemyName: enemyName, enemyAvatar: enemyAvatar, enemyDot: enemyDot, enemySteps: enemySteps,
      enemyHeads: enemyHeads, enemyTurn: enemyTurn,
      boardTitleMy: boardTitleMy, boardTitleEnemy: boardTitleEnemy,
      boardNoteMy: boardNoteMy, boardNoteEnemy: boardNoteEnemy,
      modeBadge: s.mode === 'props'
        ? '🎁 道具版 · ' + sp.size + '×' + sp.size + ' · ' + sp.planeCount + ' 架' : '',
      myCells: myCells,
      enemyCells: enemyCells,
      cellW: (100 / sp.size).toFixed(2) + '%',
      cellH: Math.round(68 * 10 / sp.size) + 'rpx',
      coinsVisible: coinsVisible, myCoins: myCoins, enemyCoins: enemyCoins,
      items: items,
      itemStatusVisible: itemStatusVisible,
      itemStatusText: itemStatusText,
      showItemConfirm: showItemConfirm,
      over: !!s.over,
      overTitle: overTitle, overDetail: overDetail, overStatus: overStatus,
      showRematchBtn: showRematchBtn, rematchText: rematchText
    });
  },

  // 点对方棋盘：道具选区模式优先（选区域而不是揭示），否则正常揭示
  onEnemyCellTap(e) {
    // dataset 取出来恒为字符串，必须转数字再比对/发送（服务器 Number.isInteger 严格校验）
    const r = +e.currentTarget.dataset.r;
    const c = +e.currentTarget.dataset.c;
    if (state.itemPick) return this.pickItemCell(r, c);
    if (state.spectator) return toast('观战模式不能下棋');
    if (state.over) return toast('对局已结束，点「再来一局」继续');
    if (app.isFrozen(r, c)) {
      return toast('这格被毁灭菇冻结，还不能揭示');
    }
    if (state.enemyShotsReceived.some(function (x) { return x.row === r && x.col === c; })) {
      return toast('这个格子已经揭示过了');
    }
    if (state.steps[state.seat] > state.steps[1 - state.seat]) {
      return toast('你的步数已领先，等待对方');
    }
    // 点击后立即给格子一个"处理中"样式：网络慢时也能看到响应
    const pending = this.data.pending;
    pending[r + ',' + c] = true;
    this.setData({ pending: pending });
    app.globalData.socket.emit('reveal', { row: r, col: c });
    this.render(); // 让 pending 样式立即上屏
  },

  // 长按对方棋盘的未揭示格：标注「机身」（绿框），再长按 = 取消。只保留机身一种标注
  // 纯本地猜测，不发给服务器；格子被揭示后渲染时自动不显示
  onEnemyMark(e) {
    const r = +e.currentTarget.dataset.r;
    const c = +e.currentTarget.dataset.c;
    // 道具选区模式下，长按优先「取消道具选中」（避免误标到棋盘上）
    if (state.itemPick) {
      this.clearItemPick();
      this.render();
      return;
    }
    if (state.spectator) return toast('观战模式不能标注');
    if (state.over) return toast('对局已结束');
    const key = r + ',' + c;
    // 已揭示格不标；吞噬者摧毁的格（result === 'destroyed'）内容保密算未揭示，仍可标注
    if (state.enemyShotsReceived.some(function (s) {
      return s.row === r && s.col === c && s.result !== 'destroyed';
    })) {
      return toast('这格已经揭示过了');
    }
    if (state.marks[key] === 'body') delete state.marks[key];   // 已标机身 → 取消
    else state.marks[key] = 'body';                              // 无 → 标注机身
    app.saveStorage('bp_marks_' + (state.roomId || ''), state.marks);
    this.render();
  },

  // ---------- 道具选区交互（对齐 web 端 pickItemCell / updateItemButtons） ----------

  // 在道具选区模式点棋盘：按道具类型记录选区，高亮预览，完整后由用户确认执行
  pickItemCell(r, c) {
    const id = state.itemPick.itemId;
    const key = r + ',' + c;
    // 二次确认：选区完整后，再点一次「定位格」视作确认（3×3 道具的定位格 = 第一击的格子；
    // 毁灭菇 = 十字中心；无所遁形 = 机头格；双发 = 任一已选格）。
    // 区域内其他格仍算重新定位，不会误触确认
    if (state.pickReady) {
      if (id === 'burst') {
        if (state.pickCells.indexOf(key) !== -1) { this.confirmItem(); return; }
        state.pickCells = [key]; // 点新格：重新从第 1 格选起
        state.pickReady = false;
        this.render();
        return;
      }
      if (id === 'sonar' || id === 'pro' || id === 'devour') {
        // 再点「第一击的定位格」= 确认（用户自然重复点自己刚点的格子）；
        // 点区域内其他格 = 重新定位（走下方逻辑）
        if (key === state.pickFirstKey) { this.confirmItem(); return; }
      } else {
        // 毁灭菇 / 无所遁形：定位格是 pickCells[0]（十字中心 / 机头格）
        if (key === state.pickCells[0]) { this.confirmItem(); return; }
      }
    }
    if (id === 'burst') {
      // 双发连射：先点第 1 格再点第 2 格（未满 2 格时点已选格 = 取消重选；点已揭示格被拒）
      if (state.pickCells.indexOf(key) !== -1) {
        state.pickCells = []; // 反悔：取消重选
      } else {
        if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
          return toast('这格已经揭示过了，换一格');
        }
        state.pickCells = state.pickCells.concat([key]);
      }
      state.pickReady = state.pickCells.length === 2;
      this.render();
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
      this.render();
      return;
    }
    if (id === 'doom') {
      // 毁灭菇：点任意格作为十字中心（中心必须在 1..size-2，保证十字完整在棋盘内）
      const size = shared.getBoardSpec(state.boardSize).size;
      const center = clampCenter(r, c, size);
      if (!center) return toast('十字中心必须在棋盘内（不能靠边）');
      if (app.isFrozen(center.row, center.col)) return toast('这格被毁灭菇冻结，还不能选中');
      if (state.enemyShotsReceived.some(function (s) { return s.row === center.row && s.col === center.col; })) {
        return toast('这格已经揭示过了，换一格当中心');
      }
      state.pickAnchor = null;
      state.pickCells = crossKeys(center.row, center.col);
      state.pickReady = true;
      this.render();
      return;
    }
    // 声呐 / 探测者 / 吞噬者：点任意格，选包含它的 3×3 区域
    const anchor = hoverAnchor(r, c, shared.getBoardSpec(state.boardSize).size);
    state.pickAnchor = anchor;
    state.pickCells = regionKeys(anchor.row, anchor.col);
    state.pickFirstKey = key; // 记录第一击的定位格：重复点击它 = 确认（点锚点不是用户直觉）
    state.pickReady = true;
    this.render();
  },

  // 点道具按钮：进入选区模式（再点同一个 = 取消）。按钮 disabled 已挡掉
  // 金币不够/步数领先/观战/结束，这里再兜底校验一遍
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (state.itemPick && state.itemPick.itemId === id) {
      this.clearItemPick();
      this.render();
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
    state.pickFirstKey = null;
    this.render();
  },

  // 发送道具使用请求（点「确认使用」按钮 / 二次点击定位格共用；金币在服务器扣，这里只管发送）
  confirmItem() {
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
    } else {
      // 无所遁形 / 毁灭菇：单个中心格（毁灭菇用十字中心）
      const a = state.pickCells[0].split(',');
      data.row = +a[0]; data.col = +a[1];
    }
    this.clearItemPick();
    app.globalData.socket.emit('useItem', data);
  },

  // 确认执行：点「确认使用」按钮把选区发给服务器（二次点击定位格见 pickItemCell）
  onItemConfirmTap() {
    this.confirmItem();
  },

  // 取消道具选择：清空选区，回到普通揭示模式
  onItemCancelTap() {
    this.clearItemPick();
    this.render();
  },

  // 结束道具选区（确认 / 取消 / 收到自己的道具结果 / 新局）
  clearItemPick() {
    state.itemPick = null;
    state.pickCells = [];
    state.pickAnchor = null;
    state.pickReady = false;
    state.pickFirstKey = null;
  },

  onRematchTap() {
    if (state.rematchVotes[state.seat]) return; // 已提交，等对方
    app.globalData.socket.emit('rematch');
  },

  // 返回菜单：对局暂停，之后可从「最近加入的房间」回来继续
  onBackTap() {
    const msg = state.spectator
      ? '确定要退出观战、返回菜单吗？'
      : '确定要返回菜单吗？对局将暂停，之后可从「最近加入的房间」回来继续';
    wx.showModal({
      title: '返回菜单',
      content: msg,
      success: function (res) {
        if (res.confirm) app.globalData.socket.emit('leaveRoom');
      }
    });
  },

  // ---------- 规则弹窗（对战页副本）：打开时默认当前模式的规则栏 ----------
  onRulesTap() {
    this.setData({ showRules: true, rulesTab: state.mode === 'props' ? 'props' : 'classic' });
  },
  onRulesClose() { this.setData({ showRules: false }); },
  onRulesTabTap(e) {
    this.setData({ rulesTab: e.currentTarget.dataset.tab });
  },
  noop() {},

  // 邀请：复制房间号（朋友在网页端输入房间号即可加入）
  onCopyRoomTap() {
    wx.setClipboardData({
      data: state.roomId || '',
      success: function () { toast('房间号已复制，发给朋友即可加入'); }
    });
  },

  // 右上角转发
  onShareAppMessage() {
    return {
      title: '炸飞机：房间 ' + (state.roomId || '') + '，来和我对战！',
      path: '/pages/index/index?room=' + (state.roomId || '')
    };
  }
});

// 给某个格子的样式串追加一个类（cells 是 {r, c, cls} 数组）
function addClass(cells, r, c, cls) {
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].r === r && cells[i].c === c) {
      cells[i].cls = (cells[i].cls ? cells[i].cls + ' ' : '') + cls;
      return;
    }
  }
}

// 注释标记的循环顺序（无 → 机头 → 机身 → 空 → 无）
// 3x3 区域锚点（左上角）：让点击的格子落在区域里，同时保证区域完整在棋盘内
function hoverAnchor(r, c, size) {
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

// 毁灭菇十字中心：必须在 1..size-2（保证上下左右都在棋盘内），越界返回 null
function clampCenter(r, c, size) {
  if (r < 1 || r > size - 2 || c < 1 || c > size - 2) return null;
  return { row: r, col: c };
}

// 十字形的 5 个格子的 'r,c' 键（毁灭菇的选区：中心 + 上下左右）
function crossKeys(row, col) {
  return [row + ',' + col, (row - 1) + ',' + col, (row + 1) + ',' + col,
    row + ',' + (col - 1), row + ',' + (col + 1)];
}
