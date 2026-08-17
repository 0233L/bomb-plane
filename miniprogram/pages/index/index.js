// ============================================
// pages/index/index.js —— 首页：昵称、创建房间、人机、加入房间、最近房间、规则、主题
// 所有操作都是「emit 给服务器」，服务器回包后由 app.js 更新全局 state 并导航。
// ============================================
'use strict';

const app = getApp();
const state = app.globalData.state;

Page({
  data: {
    themeClass: app.getThemeClass(),
    themeLabel: '',          // 主题按钮文字：跟随系统 / 浅色 / 深色
    name: '',                // 昵称输入框
    roomInput: '',           // 房间号输入框
    rooms: [],               // 最近加入的房间列表
    showRules: false,        // 规则弹窗
    diagrams: [],            // 规则弹窗里的 4 张飞机朝向图
    visitorCount: 0          // 底部「已有 X 位玩家访问过」
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
    this.setData({
      themeClass: app.getThemeClass(),
      name: (app.loadStorage('bp_name', '') || '').trim(),
      rooms: history.map(function (e) {
        return { roomId: e.roomId, token: e.token, name: e.name };
      }),
      diagrams: app.rulesDiagrams(),
      visitorCount: app.globalData.state.totalVisitors
    });
    this.updateThemeLabel();
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

  // 创建房间（双人）
  onCreateTap() {
    app.globalData.socket.emit('createRoom', { name: this.data.name });
  },
  // 人机对战：直接创建人机房间（唯一的 AI 已是最强档）
  onAITap() {
    app.globalData.socket.emit('createRoomAI', { name: this.data.name });
  },
  // 输入房间号加入（网页 / 小程序通用）
  onJoinTap() {
    app.globalData.socket.emit('joinRoom', { roomId: this.data.roomInput, name: this.data.name });
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
  noop() { /* 拦截点击穿透 */ }
});
