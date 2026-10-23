# WebSocket 可行性验证 · 结果

验证日期：2026-10-19

## 1. 环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 11 Home China 10.0.26200 |
| Node.js | v24.19.0 |
| hb-sdk | 0.9.1 |
| 构建工具 | Vite 8.3.4 |
| Browser Mock 浏览器 | Chrome Headless 155.0.0.0 |
| 真机 | 未测试（需要用户扫码配合） |
| 小程序 ID | `01a15288-dc63-73a6-90e7-f283d3b25abb` |
| 测试工程 | [`xiaoheihe/`](../../../../../xiaoheihe/) |

## 2. Browser Mock 结果：成功

测试入口：`hb-sdk dev` 调试台 → 模拟手机屏幕中的「测试 WebSocket」按钮。

页面日志（原文）：

```text
[14:45:45] 页面 origin：http://127.0.0.1:5173
[14:45:45] 是否在 iframe 内：是
[14:45:45] SDK 初始握手状态：connecting（握手中）
[14:45:45] SDK 握手状态变化：connecting（握手中）
[14:45:45] SDK 握手状态变化：ready（握手成功）
[14:45:45] ----------------------------------------
[14:45:45] 开始连接：wss://bomb-plane.onrender.com/ws
[14:45:46] open 事件：连接成功（readyState=1）
[14:45:46] 发送：{"type":"checkRooms","data":{"roomIds":[]}}
[14:45:47] 收到消息：{"type":"roomsAlive","data":{"alive":[]}}
```

最终状态：`成功：连接 + 双向通信正常`（`data-level="success"`）。

结论：

- native `WebSocket` 在 hb-sdk 的 Browser Mock 沙箱中可以正常创建、`open`、发送和接收消息。
- 页面没有出现 `securitypolicyviolation`，本次开发会话的临时 network 权限按预期跳过了平台 CSP。
- 本次服务器已处于热启动状态，从点击到 `open` 约 1 秒；Render 免费版冷启动曾实测 23.6 秒，提审/上线前仍需 keep-alive 或常驻实例，避免审核时首屏等待过久。
- 调试台「问题 1：资源加载被阻止」经核对是调试台自身的 `favicon.ico` 404，与小程序、网络权限无关。

证据截图：[browser-mock-success.png](evidence/browser-mock-success.png)

## 3. 真机结果：未测试

- `hb-sdk dev` 调试台右上角已确认存在「手机扫码调试」二维码，当前局域网地址可被手机访问。
- 真机测试需要用户用小黑盒 App 扫码并在手机上点击同一个测试按钮；本次未执行。
- 开发会话的临时权限同样覆盖真机调试，但只能证明沙箱宿主可用，不能替代线上权限获批后的生产验证。

## 4. network 权限申请状态

- 申请 ID：`e4fecd41-51c1-4e56-86d0-704a508bc0c9`
- 域名：`bomb-plane.onrender.com`
- 申请理由：联机对战 WebSocket 服务器
- 当前状态：`auditing`（审核中）
- CLI 输出：`network (网络) 原始审批=disabled 本地生效=disabled 最近申请=auditing`

注意：在权限获批前，`hb-sdk remote deploy` 构建出的生产包仍会带 `connect-src 'none'`，此时**不要发布**；线上 WebSocket 会被 CSP 拦截。

## 5. 结论

**GO**：native WebSocket 方案在 hb-sdk 沙箱中可行，后续移植可以继续使用现有的 `wss://bomb-plane.onrender.com/ws` 协议，不需要改成 `network.request` 轮询。

适用的前提与剩余风险：

1. 线上版本必须等 `network` 权限获批。按 hb-sdk 0.9.1 的实现，`remote deploy` 只有在有效 network 权限启用时才跳过平台 CSP；这是生产环境 WebSocket 能工作的关键。
2. 若权限被拒，再切换到 `network.request` 轮询方案；届时需要为现有消息协议补一层 HTTP 接口，并处理超时、重定向和请求大小限制。
3. 真机（Android/iOS 小黑盒 App）尚未验证；建议在权限审核期间补做，确认宿主 WebSocket 没有额外限制。
4. 服务器需保持可用的热实例，避免审核期间冷启动导致首屏或连接超时。

## 6. 复现命令

```bash
cd xiaoheihe
npm install
npx hb-sdk login          # 需要用户在浏览器完成小黑盒登录
npm run dev               # 打开调试台，点击「测试 WebSocket」
npx hb-sdk remote permission list
```

## 7. 变更范围

- 新增 `xiaoheihe/` 验证工程（模板 + 最小测试页）。
- 新增本任务文档与证据截图。
- 现有游戏代码零改动：`git status --porcelain -- public server.js ai.js miniprogram` 输出为空。
