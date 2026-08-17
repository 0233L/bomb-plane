// ============================================
// pages/battle/battle.js —— 对战页：双棋盘 + 抢步揭示 + 观战等待 + 结束横幅
// 渲染逻辑对齐网页版 client.js 的 goBattle / goWait / goOver /
// updateBattlePanels / updateOverRematchStatus；点对方棋盘的规则
// 对齐 onEnemyCellClick。
// ============================================
'use strict';

const app = getApp();
const state = app.globalData.state;
const PLANE_COUNT = app.PLANE_COUNT;

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
    myName: '', myDot: false, mySteps: 0, myHeads: '0/3', myTurn: '',
    enemyName: '', enemyDot: false, enemySteps: 0, enemyHeads: '0/3', enemyTurn: '',
    boardTitleMy: '', boardTitleEnemy: '', boardNote: '',
    myCells: [],
    enemyCells: [],
    over: false,
    overTitle: '', overDetail: '', overStatus: '',
    showRematchBtn: false, rematchText: '再来一局',
    pending: {}               // 'r,c' -> true：已点击、等待服务器回复的格子
  },

  onLoad() {
    this._subs = [];
    // 收到揭示结果 / 出错：先清掉"处理中"格子的样式，再整页重渲染
    // （其余事件直接整页重渲染即可）
    const self = this;
    ['battleStart', 'gameOver', 'playerStatus', 'rematchVote', 'rematchStart',
      'spectatorCount', 'reconnected', 'theme'].forEach(function (e) {
      self._sub(e, function () { self.render(); });
    });
    self._sub('revealResult', function () { self.data.pending = {}; self.render(); });
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
    let myName, myDot, mySteps, myHeads, myTurn;
    let enemyName, enemyDot, enemySteps, enemyHeads, enemyTurn;
    let boardTitleMy, boardTitleEnemy;
    const headsOf = function (seat) { return (PLANE_COUNT - s.headsLeft[seat]) + '/' + PLANE_COUNT; };

    if (s.spectator) {
      myName = s.names[0]; myDot = !!s.online[0];
      mySteps = s.steps[0]; myHeads = headsOf(1); myTurn = '👁 观战中';
      enemyName = s.names[1]; enemyDot = !!s.online[1];
      enemySteps = s.steps[1]; enemyHeads = headsOf(0); enemyTurn = '';
      boardTitleMy = (s.names[0] || '1号') + ' 的棋盘';
      boardTitleEnemy = (s.names[1] || '2号') + ' 的棋盘';
    } else {
      myName = s.names[s.seat] + '（我）'; myDot = !!s.online[s.seat];
      mySteps = s.steps[s.seat]; myHeads = headsOf(1 - s.seat);
      enemyName = s.names[1 - s.seat]; enemyDot = !!s.online[1 - s.seat];
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

    // ---- 结束横幅（对齐 goOver + updateOverRematchStatus） ----
    let overTitle = '', overDetail = '', overStatus = '', showRematchBtn = false, rematchText = '再来一局';
    let boardNote = '';
    if (s.over) {
      boardNote = '（暗色 = 对方没被你探测过的格子）';
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
      myName: myName, myDot: myDot, mySteps: mySteps, myHeads: myHeads, myTurn: myTurn,
      enemyName: enemyName, enemyDot: enemyDot, enemySteps: enemySteps,
      enemyHeads: enemyHeads, enemyTurn: enemyTurn,
      boardTitleMy: boardTitleMy, boardTitleEnemy: boardTitleEnemy, boardNote: boardNote,
      myCells: myCells,
      enemyCells: enemyCells,
      over: !!s.over,
      overTitle: overTitle, overDetail: overDetail, overStatus: overStatus,
      showRematchBtn: showRematchBtn, rematchText: rematchText
    });
  },

  // 点对方棋盘：只有"未知 + 我有行动权"的格子才会发出揭示请求
  onEnemyCellTap(e) {
    const r = e.currentTarget.dataset.r;
    const c = e.currentTarget.dataset.c;
    if (state.spectator) return toast('观战模式不能下棋');
    if (state.over) return toast('对局已结束，点「再来一局」继续');
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
