// ============================================
// pages/index/index.js —— 首页：昵称、创建房间、人机、加入房间、最近房间、规则、主题
// 所有操作都是「emit 给服务器」，服务器回包后由 app.js 更新全局 state 并导航。
// ============================================
'use strict';

const app = getApp();
const state = app.globalData.state;
const shared = require('../../utils/shared.js');

Page({
  data: {
    themeClass: app.getThemeClass(),
    themeLabel: '',          // 主题按钮文字：跟随系统 / 浅色 / 深色
    name: '',                // 昵称输入框
    roomInput: '',           // 房间号输入框
    rooms: [],               // 最近加入的房间列表
    showRules: false,        // 规则弹窗
    showItemGuide: false,    // 道具说明弹窗（道具卡「查看道具说明」点开）
    diagrams: [],            // 规则弹窗里的 4 张飞机朝向图
    visitorCount: 0,         // 底部「已有 X 位玩家访问过」
    homeMode: 'classic',     // 当前选中的玩法栏：classic / props
    spec: 'S',               // 地图规格：S=10×10 M=12×12 L=14×14（随玩法栏切换）
    modeHelp: ''             // 玩法提示文字
  },

  // 当前玩法栏记住的规格（每栏独立：bp_spec_classic / bp_spec_props，经典默认 S、道具默认 M）
  specFor(mode) {
    const key = mode === 'props' ? 'bp_spec_props' : 'bp_spec_classic';
    const s = app.loadStorage(key, '');
    return (s === 'S' || s === 'M' || s === 'L') ? s : (mode === 'props' ? 'M' : 'S');
  },

  onShow() {
    this.refresh();
  },

  // 首页重新出现 / 历史房间被批量校验时刷新列表
  onLoad(options) {
    // 朋友从小程序转发的邀请打开：?room=XXXX → 自动填好房间号
    if (options && options.room) {
      this.setData({ roomInput: options.room });
    }
    // 服务器校验完「最近加入的房间」后，失效的已被 app.js 删除，这里重新渲染
    this._roomsAliveRefresh = this.refresh.bind(this);
    app.on('roomsAlive', this._roomsAliveRefresh);
    // 访客统计回报（可能早于本页订阅到达，所以 refresh() 里也直接读全局 state）
    this._visitRefresh = this.refresh.bind(this);
    app.on('visitResult', this._visitRefresh);
  },

  onUnload() {
    if (this._roomsAliveRefresh) app.off('roomsAlive', this._roomsAliveRefresh);
    if (this._visitRefresh) app.off('visitResult', this._visitRefresh);
  },

  refresh() {
    const history = app.loadRoomHistory();
    const homeMode = this.data.homeMode || 'classic';
    const spec = this.specFor(homeMode);
    const sp = shared.getBoardSpec(spec);
    this.setData({
      themeClass: app.getThemeClass(),
      name: (app.loadStorage('bp_name', '') || '').trim(),
      rooms: history.map(function (e) {
        return { roomId: e.roomId, token: e.token, name: e.name };
      }),
      diagrams: app.rulesDiagrams(),
      visitorCount: app.globalData.state.totalVisitors,
      homeMode: homeMode,
      spec: spec,
      modeHelp: homeMode === 'props'
        ? '🎁 道具版 · ' + sp.size + '×' + sp.size + ' · ' + sp.planeCount + ' 架 · 金币买道具更刺激'
        : '经典玩法 · ' + sp.size + '×' + sp.size + ' · ' + sp.planeCount + ' 架'
    });
    this.updateThemeLabel();
  },

  // 点玩法卡片（经典/道具）：切栏，规格自动换成该栏记着的选择
  onModeTap(e) {
    this.setData({ homeMode: e.currentTarget.dataset.mode });
    this.refresh();
  },
  // 地图规格选择（10×10 / 12×12 / 14×14）：保存到当前玩法栏自己的键（互不影响）
  onSpecTap(e) {
    const mode = this.data.homeMode;
    app.saveStorage(mode === 'props' ? 'bp_spec_props' : 'bp_spec_classic', e.currentTarget.dataset.spec);
    this.refresh();
  },

  // 主题文字：auto=跟随系统 light=浅色 dark=深色
  updateThemeLabel() {
    const map = { auto: '跟随系统', light: '浅色', dark: '深色' };
    const mode = app.loadStorage('bp_theme', 'auto');
    this.setData({ themeLabel: map[mode] || '跟随系统' });
  },

  onThemeTap() {
    app.cycleTheme();
    this.setData({ themeClass: app.getThemeClass() });
    this.updateThemeLabel();
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
    app.saveStorage('bp_name', e.detail.value.trim());
  },
  onRoomInput(e) {
    this.setData({ roomInput: e.detail.value });
  },

  // 创建房间（双人）：按钮自带 data-mode，直接以该栏玩法+该栏规格开局（即使刚才点的是另一栏）
  onCreateTap(e) {
    const mode = (e && e.currentTarget && e.currentTarget.dataset.mode) || this.data.homeMode;
    this.setData({ homeMode: mode });
    app.globalData.socket.emit('createRoom', {
      name: this.data.name,
      mode: mode,
      boardSize: this.specFor(mode)
    });
  },
  // 人机对战：玩法×规格自由组合（经典/S 走最强算法，其余组合简单贪心）
  onAITap(e) {
    const mode = (e && e.currentTarget && e.currentTarget.dataset.mode) || this.data.homeMode;
    this.setData({ homeMode: mode });
    app.globalData.socket.emit('createRoomAI', {
      name: this.data.name,
      mode: mode,
      boardSize: this.specFor(mode)
    });
  },
  // 输入房间号加入（网页 / 小程序通用）：带当前玩法 + 规格
  onJoinTap() {
    app.globalData.socket.emit('joinRoom', {
      roomId: this.data.roomInput,
      name: this.data.name,
      mode: this.data.homeMode,
      boardSize: this.specFor(this.data.homeMode)
    });
  },

  // 最近房间：点「进入」= 用上次的凭证直接重连恢复现场
  onRoomJoin(e) {
    const ds = e.currentTarget.dataset;
    app.globalData.socket.emit('rejoin', { token: ds.token, roomId: ds.roomId });
  },
  // 删除某个历史房间记录
  onRoomDel(e) {
    app.removeRoomFromHistory(e.currentTarget.dataset.room);
    this.refresh();
  },

  // 规则弹窗
  onRulesTap() { this.setData({ showRules: true }); },
  onRulesClose() { this.setData({ showRules: false }); },
  // 道具说明弹窗
  onItemGuideTap() { this.setData({ showItemGuide: true }); },
  onItemGuideClose() { this.setData({ showItemGuide: false }); },
  noop() { /* 拦截点击穿透 */ }
});
