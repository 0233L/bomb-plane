// ============================================
// utils/ws.js —— 小程序版 WebSocket 客户端
// 接口与网页版 public/ws.js 完全一致（on/once/off/emit/disconnect +
// connect/disconnect 事件 + 自动重连），底层用 wx.connectSocket。
// 协议：收发都是 JSON { type: 事件名, data: 数据 }，与网页端、服务器同构。
// ============================================
'use strict';

class WSClient {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts || {};
    this._handlers = new Map();   // 事件名 -> [回调]
    this.connected = false;
    this._autoReconnect = this.opts.autoReconnect !== false;
    this._reconnectAttempts = 0;
    this._ws = null;
    this._connect();
  }

  // 监听事件；同一个事件可以挂多个回调
  on(event, cb) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(cb);
    return this;
  }

  // 监听事件，触发一次后自动移除
  once(event, cb) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      cb(data);
    };
    this.on(event, wrapper);
    return this;
  }

  // 移除某个回调
  off(event, cb) {
    const list = this._handlers.get(event);
    if (!list) return this;
    const idx = list.indexOf(cb);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }

  // 发送事件。未连接时直接丢弃（配合自动重连 + 业务层 rejoin 恢复现场）
  emit(event, data) {
    if (this._ws && this.connected) {
      this._ws.send({
        data: JSON.stringify({ type: event, data: data === undefined ? {} : data })
      });
    }
  }

  // 主动断开（之后不再自动重连）
  disconnect() {
    this._autoReconnect = false;
    if (this._ws) this._ws.close({});
  }

  _connect() {
    let task;
    try {
      task = wx.connectSocket({ url: this.url });
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this._ws = task;

    task.onOpen(() => {
      this._reconnectAttempts = 0;
      this.connected = true;
      this._fire('connect', {});
    });

    task.onMessage((res) => {
      let msg = null;
      try { msg = JSON.parse(res.data); } catch (err) { return; } // 坏消息忽略
      if (msg && typeof msg.type === 'string') this._fire(msg.type, msg.data || {});
    });

    task.onClose(() => {
      this.connected = false;
      this._fire('disconnect', {});
      this._scheduleReconnect();
    });

    task.onError(() => { /* 出错后 onClose 会跟着来，由 onClose 统一处理 */ });
  }

  _scheduleReconnect() {
    if (!this._autoReconnect) return;
    const delay = Math.min(30000, 500 * Math.pow(2, this._reconnectAttempts)) +
      Math.floor(Math.random() * 400);
    this._reconnectAttempts++;
    setTimeout(() => {
      if (this._autoReconnect && (!this._ws || !this.connected)) this._connect();
    }, delay);
  }

  _fire(event, data) {
    const list = this._handlers.get(event);
    if (!list) return;
    list.slice().forEach(function (cb) {
      try { cb(data); } catch (e) { /* 单个回调出错不影响其它回调 */ }
    });
  }
}

module.exports = WSClient;
