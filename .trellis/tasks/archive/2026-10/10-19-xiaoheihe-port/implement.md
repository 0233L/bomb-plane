# 小黑盒移植 · 执行清单

> **执行状态（2026-10-19）**：第 0–11 步全部完成。真机第一轮发现返回菜单无效、刷新回首页、刘海遮挡；
> 修复后第二轮（返回菜单、刷新续局、刘海、改昵称、复制房间号、双人对局）用户确认全部通过。
> 检查后加固：宿主存储并行恢复 + 超时补偿续局、安全区随窗口更新、切页关闭弹窗、草稿数组校验。
> 本移植任务验收完成；`network` 权限仍在审核，`remote deploy` 属于上架任务，未执行。
> 详细结果见 [`result.md`](result.md)，修复设计见 [`design.md`](design.md) 第 11 节。

> 实现前先读 `design.md` 和 `prd.md`。本任务只改 `xiaoheihe/`，**不要修改** `public/`、`server.js`、`ai.js`、`miniprogram/`。

## 0. 预检

```bash
cd d:/coding/project/bombPlane
git status --porcelain -- public server.js ai.js miniprogram   # 必须为空
ls xiaoheihe
```

确认：

- `xiaoheihe/node_modules` 已安装。
- `npm run dev` 已在主会话运行（端口 5173/5174）；实现子任务不要重复启动，避免端口冲突。
- 不要执行 git commit。

## 1. 复制网页版文件

```bash
cd d:/coding/project/bombPlane
cp public/index.html xiaoheihe/index.html
cp public/style.css xiaoheihe/src/style.css
mkdir -p xiaoheihe/src/legacy
cp public/shared.js xiaoheihe/src/legacy/shared.js
cp public/ws.js xiaoheihe/src/legacy/ws.js
cp public/client.js xiaoheihe/src/legacy/client.js
rm -f xiaoheihe/src/styles.css
```

说明：

- `xiaoheihe/index.html` 和 `src/main.js` 当前是 spike 验证页，允许覆盖。
- `src/styles.css` 是 spike 页面样式，移植后不再使用，删除。
- 复制后不要回头修改 `public/` 原件。

## 2. 改造 `xiaoheihe/index.html`

按 `design.md` 4.1：

- [ ] 内联主题脚本的 `localStorage.getItem` 用 `try/catch` 包住，失败时 `t = 'auto'`。
- [ ] 删除 `<link rel="stylesheet" href="style.css">`。
- [ ] 删除末尾三个 `<script src="ws.js"></script>`、`shared.js`、`client.js`。
- [ ] 两个「📋 复制邀请链接」改为「📋 复制房间号」。
- [ ] 标题、viewport、DOM 结构保持不变。

验证：

```bash
grep -n "复制房间号\|复制邀请链接\|<script\|<link" xiaoheihe/index.html
```

预期：只有内联主题 `<script>`；没有外链样式/脚本；两个按钮文案都是「复制房间号」。

## 3. 写 `xiaoheihe/src/main.js`

```js
import hbSDK from '@heybox/hb-sdk';
import './style.css';

// 顺序不能乱：shared.js 提供棋盘函数，ws.js 提供 WSClient，client.js 依赖两者
import './legacy/shared.js';
import './legacy/ws.js';
import './legacy/client.js';
```

注意：

- `hbSDK` 变量暂时不使用；保留 import 用于平台运行时初始化。如构建报未使用变量（项目没有 lint），可改为 `import '@heybox/hb-sdk';`，但优先保留默认导入，方便后续加 storage/share。
- 不要从 `public/` 外部路径 import；所有文件都在 `xiaoheihe/src/` 下。

## 4. 改造 `xiaoheihe/src/legacy/ws.js`

- [ ] 把 `DEFAULT_URL` 改为 `const DEFAULT_URL = 'wss://bomb-plane.onrender.com/ws';`
- [ ] 其余逻辑（自动重连、JSON 协议、`window.WSClient` 导出）保持不变。

验证：

```bash
grep -n "DEFAULT_URL\|location.host" xiaoheihe/src/legacy/ws.js
```

预期：只有固定 wss 地址，没有 `location.host`。

## 5. 改造 `xiaoheihe/src/legacy/client.js`

按 `design.md` 4.4，做 3 组修改：

### 5.1 存储降级

- [ ] 在 `safeGet/safeSet/safeRemove` 上方加 `const memoryStore = Object.create(null);`
- [ ] 三个函数改为异常时读写 `memoryStore`。
- [ ] 保持函数名、签名、调用点不变。

### 5.2 邀请地址

- [ ] `setRoomInUrl(roomId)` 改为空函数，并加中文注释。
- [ ] `clearRoomFromUrl()` 改为空函数，并加中文注释。
- [ ] 保留 `init()` 里读取 `location.search` 的代码，不做额外删除。

### 5.3 复制按钮

- [ ] 把 `.btn-copy-link` 的点击处理器改为复制 `state.roomId`（4 位房间号）。
- [ ] 剪贴板失败/不可用时用 `toast('房间号：' + roomId + '（请手动记下）')`。
- [ ] 不使用 `window.prompt`。

验证：

```bash
grep -n "memoryStore\|function setRoomInUrl\|function clearRoomFromUrl\|房间号已复制\|复制邀请链接" xiaoheihe/src/legacy/client.js
```

## 6. 安全区 CSS

在 `xiaoheihe/src/style.css` 末尾追加：

```css
/* ---------- 小黑盒 App 安全区 ---------- */
body {
  padding-top: calc(20px + env(safe-area-inset-top, 0px));
  padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  padding-left: calc(12px + env(safe-area-inset-left, 0px));
  padding-right: calc(12px + env(safe-area-inset-right, 0px));
}
#btn-theme {
  top: calc(12px + env(safe-area-inset-top, 0px));
  right: calc(12px + env(safe-area-inset-right, 0px));
}
```

## 7. 更新配置与文档

### `xiaoheihe/package.json`

- [ ] `heybox.name` → `炸飞机`
- [ ] `heybox.desc` → `双人实时对战：创建房间、加入好友、人机对战`
- [ ] 其他 heybox 字段、scripts、依赖不动。

### `xiaoheihe/README.md`

改成移植说明，至少包含：

- 这是 `public/` 网页版的移植副本，不是微信小程序。
- `npm run dev` / `npm run build` 的用法。
- `network` 权限审核通过前不要 `remote deploy`。
- 修改 `public/` 后需要同步到 `xiaoheihe/src/legacy/`。

## 8. 构建验证

```bash
cd d:/coding/project/bombPlane/xiaoheihe
npm run build
```

检查：

- [ ] 构建成功。
- [ ] `dist/index.html` 有 hb-sdk 注入的 CSP 和 runtime gate。
- [ ] `dist/assets/` 下有打包后的 JS/CSS，文件数量合理。
- [ ] `grep -R "location.host" src/` 无结果。
- [ ] `dist/` 总大小远小于 100 MiB。

## 9. Browser Mock 验收

`npm run dev` 已在主会话运行。Vite 会热更新；如果页面还是 spike 测试页，重启 dev。

在调试台模拟手机中：

- [ ] 首页正常显示，无白屏，SDK 握手 `ready`。
- [ ] 创建经典房间 → 部署页棋盘可点。
- [ ] 人机对战 → 部署 → 能开火，AI 能回击。
- [ ] 第二个浏览器上下文用房间号加入 → 双方部署 → 对战一步。
- [ ] 刷新页面（或重开调试页）→ 记录 localStorage 是否可用、能否恢复房间。
- [ ] 点「复制房间号」→ 剪贴板或 toast 显示 4 位房间号。
- [ ] 断网/关闭连接 → 自动重连，UI 不白屏。

把结果（成功/失败、错误原文、localStorage 行为）记录到本任务目录的 `result.md`。真机测试未完成时标注「未做真机验证」。

## 10. 真机测试（需要用户配合）

- [ ] 调试台右上角二维码 → 用户用小黑盒 App 扫码。
- [ ] 首页、创建房间、人机对战、复制房间号。
- [ ] 与 PC Browser Mock 或另一台手机完成一次加入/部署/开火。
- [ ] 记录设备型号、App 版本、localStorage/confirm/prompt 行为。

## 11. 检查与收尾

- [ ] 派发 `trellis-check` 检查改动。
- [ ] 修复检查发现的问题。
- [ ] `git status --porcelain -- public server.js ai.js miniprogram` 仍为空。
- [ ] 没有把 token/Cookie/账号凭据写入文件。
- [ ] 不执行 git commit。
- [ ] 需要时更新 `.trellis/spec/frontend/xiaoheihe-sandbox.md`（本次已建立，补充移植约定即可）。

## 回滚点

1. **复制后、改造前**：重新从 `public/` 复制即可恢复。
2. **构建失败**：按报错修 `xiaoheihe/`，不要回退 `public/`。
3. **Browser Mock 严重失败**：保留 `xiaoheihe/src/legacy/` 原文件，按 `design.md` 的改动逐项排查；必要时恢复 spike 页面（spike 已归档，结果不受影响）。
4. **真机失败**：记录具体错误，回到本清单第 5/6 步调整，不要猜测性大改。
