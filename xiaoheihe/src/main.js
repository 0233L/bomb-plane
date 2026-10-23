// ============================================
// main.js —— 小黑盒离线版入口
//
// 离线版没有服务器：local-server.js 在浏览器里扮演服务器，
// local-ai.js 是 ai.js 的浏览器副本（人机对战用）。
// 原来的 ws.js 不再导入——发布包里不会出现服务器地址和 WebSocket。
//
// 注意：import 顺序就是执行顺序，不能乱：
//   shared.js  → 提供棋盘/飞机函数（挂在 window 上）
//   local-ai.js → 依赖 shared，挂到 window.LocalAI
//   local-server.js → 依赖上面两个，挂到 window.LocalServer
//   match-history.js → 纯数据模块（对战历史），校验棋盘时用 shared 的 getPlaneCells
//   client.js  → 最后加载，初始化界面
// ============================================
// 必须第一个导入：hb-sdk.js 会把 SDK 实例挂到 window.__hbSDK，
// 后面的 legacy/client.js 要用它读写宿主存储、安全区信息。
import hbSDK from './hb-sdk.js';
import './style.css';

import './legacy/shared.js';
import './legacy/local-ai.js';
import './legacy/local-server.js';
import './legacy/match-history.js';  // 纯数据模块：对战历史的校验/格式化（依赖 shared 的棋盘函数）
import './legacy/client.js';

// hbSDK 暂时不做具体调用；保留导入是为了让平台运行时先完成初始化。
void hbSDK;
