// ============================================
// pages/deploy/deploy.js —— 部署页：按房间规格的棋盘摆放飞机
// 交互规则与网页版 client.js 的 onDeployCellClick 完全一致：
//   空白格 → 放新飞机（以点击处为机头）
//   机头格 → 移除该架飞机
//   机身格 → 顺次旋转（上→右→下→左）
// ============================================
'use strict';

const app = getApp();
const state = app.globalData.state;
const shared = app.shared;

// 当前房间规格（S=10×10/3架 | M=12×12/4架 | L=14×14/6架）
function spec() { return shared.getBoardSpec(state.boardSize); }

// 收集若干飞机占的所有格子（exceptIdx 表示跳过第几架，旋转时用）
function allPlaneCells(planes, exceptIdx) {
  const cells = [];
  planes.forEach(function (p, i) {
    if (i === exceptIdx) return;
    shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      cells.push(cell);
    });
  });
  return cells;
}

// 随机生成一份合法布局（点「随机布局」按钮时用，可反复点击换方案）
function randomDraft() {
  const sp = spec();
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < sp.planeCount; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * sp.size);
    const headCol = Math.floor(Math.random() * sp.size);
    if (shared.canPlacePlane(allPlaneCells(planes), headRow, headCol, dir, state.boardSize)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes.length === sp.planeCount ? planes : null;
}

function toast(title) {
  wx.showToast({ title: title, icon: 'none' });
}

Page({
  data: {
    themeClass: app.getThemeClass(),
    cells: [],
    cellW: '10%',           // 格子宽度（按规格 10/12/14 自适应）
    cellH: '68rpx',         // 格子高度
    countText: '',
    roomId: '',
    dirs: [],               // [{key, label, active}]
    confirmed: false,
    showUnconfirm: false,
    oppName: '',
    oppAvatar: '',
    hasOpp: false,
    oppOnline: false,
    readyStatus: ''
  },

  onLoad() {
    this._subs = [];
    this._sub('deployReady', () => this.render());
    this._sub('opponentJoined', () => this.render());
    this._sub('playerStatus', () => this.render());
    this._sub('reconnected', () => { this.refreshDraft(); this.render(); });
    this._sub('theme', () => this.setData({ themeClass: app.getThemeClass() }));
  },

  _sub(event, cb) {
    app.on(event, cb);
    this._subs.push([event, cb]);
  },

  onUnload() {
    this._subs.forEach(function (pair) { app.off(pair[0], pair[1]); });
  },

  onShow() {
    this.refreshDraft();
    this.render();
  },

  // 草稿来源：已确认过部署（重连回来）→ 直接用服务器确认过的飞机；否则恢复本地草稿
  refreshDraft() {
    if (state.myPlanes.length) {
      state.draft = state.myPlanes.map(function (p) {
        return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
      });
    } else {
      try {
        state.draft = JSON.parse(app.loadStorage('bp_draft', '[]'));
      } catch (e) {
        state.draft = [];
      }
    }
  },

  saveDraft() {
    app.saveStorage('bp_draft', JSON.stringify(state.draft));
  },

  // 渲染整页（对齐网页版 renderDeployBoard + updateDeployUI）
  render() {
    const s = state;
    const confirmed = !!s.deployConfirmed[s.seat];
    const names = ['上', '右', '下', '左'];
    const dirKeys = ['up', 'right', 'down', 'left'];

    let readyStatus = '';
    if (!s.names[1 - s.seat]) {
      readyStatus = '等待对方加入…';
    } else if (confirmed && s.deployConfirmed[1 - s.seat]) {
      readyStatus = '双方已就绪，即将开战！';
    } else if (confirmed) {
      readyStatus = '已确认，等待 ' + s.names[1 - s.seat] + ' 确认…';
    } else if (s.deployConfirmed[1 - s.seat]) {
      readyStatus = '对方已确认，等你的部署';
    }

    this.setData({
      cells: app.deployCells(),
      cellW: (100 / spec().size).toFixed(2) + '%',
      cellH: Math.round(68 * 10 / spec().size) + 'rpx',
      countText: '已放置 ' + s.draft.length + ' / ' + spec().planeCount + ' 架',
      roomId: s.roomId,
      dirs: dirKeys.map(function (d, i) { return { key: d, label: names[i], active: s.curDir === d }; }),
      confirmed: confirmed,
      showUnconfirm: confirmed,
      oppName: s.names[1 - s.seat] || '等待加入…',
      oppAvatar: s.avatars[1 - s.seat] || '',
      hasOpp: !!s.names[1 - s.seat],
      oppOnline: !!s.online[1 - s.seat],
      readyStatus: readyStatus
    });
  },

  // 点棋盘（规则与网页版 onDeployCellClick 一致）
  onCellTap(e) {
    if (state.deployConfirmed[state.seat]) {
      return toast('已确认部署，点「取消确认」才能修改');
    }
    const r = e.currentTarget.dataset.r;
    const c = e.currentTarget.dataset.c;

    // 找点击位置属于哪架飞机
    let planeIdx = -1, isHead = false;
    for (let i = 0; i < state.draft.length; i++) {
      const p = state.draft[i];
      const cells = shared.getPlaneCells(p.headRow, p.headCol, p.dir);
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
      if (state.draft.length >= spec().planeCount) return toast('已放满 ' + spec().planeCount + ' 架飞机');
      if (!shared.canPlacePlane(allPlaneCells(state.draft), r, c, state.curDir, state.boardSize)) {
        return toast('这里放不下（越界或与其它飞机重叠）');
      }
      state.draft.push({ headRow: r, headCol: c, dir: state.curDir });
    } else if (isHead) {
      // 点机头：移除
      state.draft.splice(planeIdx, 1);
    } else {
      // 点机身：旋转到下一朝向
      const p = state.draft[planeIdx];
      const dirs = ['up', 'right', 'down', 'left'];
      const next = dirs[(dirs.indexOf(p.dir) + 1) % 4];
      if (!shared.canPlacePlane(allPlaneCells(state.draft, planeIdx), p.headRow, p.headCol, next, state.boardSize)) {
        return toast('转不过去（越界或与其它飞机重叠）');
      }
      p.dir = next;
    }

    this.saveDraft();
    this.render();
  },

  // 朝向按钮：只影响之后放置的飞机
  onDirTap(e) {
    state.curDir = e.currentTarget.dataset.dir;
    this.render();
  },

  onRandomTap() {
    if (state.deployConfirmed[state.seat]) {
      return toast('已确认部署，点「取消确认」才能修改');
    }
    const planes = randomDraft();
    if (!planes) return toast('生成失败，再点一次试试');
    state.draft = planes;
    this.saveDraft();
    this.render();
  },

  onClearTap() {
    state.draft = [];
    this.saveDraft();
    this.render();
  },

  onConfirmTap() {
    if (state.draft.length !== spec().planeCount) return toast('请先放满 ' + spec().planeCount + ' 架飞机');
    app.globalData.socket.emit('deployConfirm', { planes: state.draft });
  },

  onUnconfirmTap() {
    app.globalData.socket.emit('deployCancel');
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

  // 右上角转发：把房间号写进标题和路径
  onShareAppMessage() {
    return {
      title: '炸飞机：房间 ' + (state.roomId || '') + '，来和我对战！',
      path: '/pages/index/index?room=' + (state.roomId || '')
    };
  }
});
