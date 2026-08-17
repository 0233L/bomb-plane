// ============================================
// ws.js —— 原生 WebSocket 客户端（替代 socket.io 客户端）
//
// 接口和 socket.io 客户端兼容，方便业务代码零改动：
//   new WSClient(url)        （不传 url 时浏览器自动用当前网址的 /ws）
//   on('事件名', 回调)       监听事件；连接建立时额外触发 'connect'，
//                           断开时触发 'disconnect'（测试和界面提示用）
//   emit('事件名', 数据)     发送事件
//   disconnect()            主动断开（不再自动重连）
//
// 协议：收发都是 JSON { type: 事件名, data: 数据 }，事件名与
// 原来的 socket.io 一一对应，服务器端处理逻辑完全不用改。
//
// 自动重连：断开后按指数退避（0.5s → 1s → 2s … 最长 30s）自动重连；
// 重连成功后由业务代码（client.js 的 connect 事件）决定是否恢复现场。
//
// 双环境：浏览器里挂到 window.WSClient；Node（e2e 测试）里走
// module.exports 导出，测试脚本只需先 global.WebSocket = require('ws').WebSocket
// ============================================
(function () {
  'use strict';

  // 默认连接地址：浏览器里取当前网址的主机；Node 里是 localhost:3000
  const DEFAULT_URL = (typeof location !== 'undefined' && location.host)
    ? ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws')
    : 'ws://localhost:3000/ws';

  class WSClient {
    constructor(url, opts) {
      // 兼容 http(s):// 或没有路径的地址：自动补 /ws 并转成 ws(s)://
      const u = new URL(String(url || DEFAULT_URL));
      if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
      this.url = u.href.replace(/^http/, 'ws');
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

    // 监听事件，触发一次后自动移除（测试的 waitFor 用）
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
      if (this._ws && this._ws.readyState === 1 /* OPEN */) {
        this._ws.send(JSON.stringify({
          type: event,
          data: data === undefined ? {} : data
        }));
      }
    }

    // 主动断开（之后不再自动重连）
    disconnect() {
      this._autoReconnect = false;
      if (this._ws) { try { this._ws.close(); } catch (e) { /* 忽略 */ } }
    }

    _connect() {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this._scheduleReconnect();
        return;
      }
      this._ws = ws;

      ws.onopen = () => {
        this._reconnectAttempts = 0;
        this.connected = true;
        this._fire('connect', {});
      };

      ws.onmessage = (e) => {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch (err) { return; } // 坏消息忽略
        if (msg && typeof msg.type === 'string') this._fire(msg.type, msg.data || {});
      };

      ws.onclose = () => {
        this.connected = false;
        this._fire('disconnect', {});
        this._scheduleReconnect();
      };

      ws.onerror = () => {
        // 出错后 close 一定会跟着来，由 onclose 统一处理
        try { ws.close(); } catch (e) { /* 忽略 */ }
      };
    }

    _scheduleReconnect() {
      if (!this._autoReconnect) return;
      const delay = Math.min(30000, 500 * Math.pow(2, this._reconnectAttempts)) +
        Math.floor(Math.random() * 400); // 加一点随机抖动，避免所有人同时重连
      this._reconnectAttempts++;
      setTimeout(() => {
        if (this._autoReconnect && (!this._ws || this._ws.readyState === 3 /* CLOSED */)) {
          this._connect();
        }
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

  // 双环境导出
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WSClient;
  } else if (typeof window !== 'undefined') {
    window.WSClient = WSClient;
  }
})();
