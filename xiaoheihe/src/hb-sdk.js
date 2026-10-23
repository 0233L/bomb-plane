// ============================================
// hb-sdk.js —— 小黑盒 SDK 统一入口
//
// 只在这里初始化一次，并把实例挂到 window。
// legacy/client.js 是移植的旧脚本（IIFE 风格），不能直接 import，
// 只能通过 window.__hbSDK 使用宿主存储（storage）和窗口信息（viewport）。
// ============================================
import hbSDK from '@heybox/hb-sdk';

// 挂到全局，供 legacy/client.js 读取
window.__hbSDK = hbSDK;

export default hbSDK;
