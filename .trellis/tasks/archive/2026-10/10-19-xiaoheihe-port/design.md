# 小黑盒移植 · 技术设计

## 1. 背景与边界

- spike 已确认 native WebSocket 在小黑盒沙箱可用（[result.md](../archive/2026-10/10-19-xiaoheihe-ws-spike/result.md)），因此保留现有服务器协议，不做轮询。
- 目标是把 [public/](../../../public/) 的网页版搬进 [xiaoheihe/](../../../xiaoheihe/) 的 Vite 工程，只做必要的沙箱适配。
- **不修改** `public/`、`server.js`、`ai.js`、`miniprogram/`。移植文件是副本，后续网页版改动需要手动同步。
- `network` 权限仍在审核；本地用 `hb-sdk dev` 的临时权限开发和测试，审核通过前不发布。

## 2. 目标目录结构

```text
xiaoheihe/
├── index.html                 # 由 public/index.html 复制并做 3 处改造
├── package.json               # 更新 name/desc；heybox 配置沿用
├── assets/                    # 占位图，提审前换正式图标/封面
├── src/
│   ├── main.js                # 唯一模块入口：初始化 SDK + 按顺序加载移植代码
│   ├── style.css              # 由 public/style.css 复制，末尾加安全区适配
│   └── legacy/
│       ├── shared.js          # 由 public/shared.js 原样复制
│       ├── ws.js              # 由 public/ws.js 复制，固定服务器地址
│       └── client.js          # 由 public/client.js 复制，做沙箱适配
└── dist/                      # hb-sdk build 产物（git 忽略）
```

### 为什么把旧脚本放进 `src/legacy/` 再由 `main.js` 导入

- `hb-sdk` 的运行时 gate 只接管 Vite 处理过的模块脚本；放进 `public/` 的经典 `<script>` 不会被 gate 延迟，可能在宿主握手完成前执行。
- 通过 `import` 让 Vite 把 `shared.js`、`ws.js`、`client.js` 打包进同一个受 gate 保护的模块，顺序可控，构建也只需要上传少量文件。
- 旧代码是 IIFE + 全局变量风格，作为副作用模块导入即可，不需要改写业务逻辑。

## 3. 入口与加载顺序

`src/main.js`：

```js
// 小黑盒 SDK 先初始化，后续如果需要 storage/share 可以直接使用
import hbSDK from '@heybox/hb-sdk';
import './style.css';

// 顺序不能乱：shared.js 提供棋盘函数，ws.js 提供 WSClient，client.js 依赖两者
import './legacy/shared.js';
import './legacy/ws.js';
import './legacy/client.js';
```

说明：

- ES module 的依赖按 import 顺序执行；`shared.js` 把 API 挂到 `window`，`ws.js` 把 `WSClient` 挂到 `window`，最后 `client.js` 读取这些全局变量。
- `shared.js` / `ws.js` 里的 `typeof module !== 'undefined'` 在 Vite ESM 打包后为 false，会走浏览器分支，行为与网页版一致。
- `client.js` 执行时 DOM 已解析（module 默认 defer），与原页面“脚本放在 body 末尾”等价。
- `hbSDK` 暂时不调用具体 API；保留 import 是为了让平台运行时完成初始化，后续加分享/存储时不用再改入口。

## 4. 逐文件改造

### 4.1 `index.html`

从 `public/index.html` 复制，只改这些地方：

1. 内联主题脚本里的 `localStorage` 加保护（沙箱可能禁用存储，不能让它抛异常导致主题属性没设置）：

```html
<script>
  (function () {
    var t = 'auto';
    try {
      t = localStorage.getItem('bp_theme') || 'auto';
    } catch (e) {
      // 小黑盒沙箱可能禁用 localStorage：退回跟随系统
    }
    if (t === 'auto') {
      t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  })();
</script>
```

2. 删除 `<link rel="stylesheet" href="style.css">` 和末尾三个经典 `<script src="...">`；CSS 由 `main.js` 导入，脚本由 `main.js` 打包。
3. 两个「📋 复制邀请链接」按钮改成「📋 复制房间号」：

```html
<button class="btn-copy-link small-btn">📋 复制房间号</button>
```

其余 HTML 结构、DOM id、class 全部保持不变。

### 4.2 `src/legacy/ws.js`

复制 `public/ws.js`，只改默认地址：

```js
// 小黑盒沙箱里的 location.host 是小黑盒自己的地址，必须写死游戏服务器
const DEFAULT_URL = 'wss://bomb-plane.onrender.com/ws';
```

`WSClient` 的 `new URL()`、自动重连、协议封装全部保留。

### 4.3 `src/legacy/shared.js`

原样复制，不改。它同时被服务器 `require`，移植版保持同一份算法。

### 4.4 `src/legacy/client.js`

复制 `public/client.js`，做 3 组最小改动。

#### A. 存储降级：localStorage 不可用时用内存保存

原代码 `safeGet` 在异常时直接返回 `null`，页面不会崩，但同一会话里刚写入的值也读不到。加一个内存兜底：

```js
// 小黑盒沙箱可能禁用 localStorage：同一会话内退回内存存储，至少不影响当前对局
const memoryStore = Object.create(null);

function safeGet(key) {
  try { return localStorage.getItem(key); }
  catch (e) { return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch (e) { memoryStore[key] = String(value); }
}

function safeRemove(key) {
  try { localStorage.removeItem(key); }
  catch (e) { delete memoryStore[key]; }
}
```

注意：`bp_room_history` 里有重连 token，内存兜底只能覆盖“页面不刷新”的会话；刷新后的恢复依赖沙箱是否允许 localStorage。这是可接受的降级，真机测试时记录实际行为。

#### B. 邀请链接改为房间号

沙箱内复制出的网页链接别人打不开，因此不再改地址栏，也不复制 URL：

```js
// 小黑盒沙箱里网页链接不可分享；刷新恢复依赖 localStorage 的房间历史
function setRoomInUrl(roomId) { /* 不再修改地址栏 */ }
function clearRoomFromUrl() { /* 不再修改地址栏 */ }
```

`init()` 里读取 `location.search` 的邀请逻辑保留；由于不再写入 `?room=`，正常流程不会进入邀请页。

#### C. 复制按钮改为复制房间号

把 `.btn-copy-link` 的点击处理替换为：

```js
document.querySelectorAll('.btn-copy-link').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const roomId = state.roomId || '';
    if (!roomId) return toast('还没有房间号');

    // 剪贴板不可用时直接把房间号显示在 toast 里，让用户手动记下
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(roomId).then(
        function () { toast('房间号已复制：' + roomId); },
        function () { toast('房间号：' + roomId + '（请手动记下）'); }
      );
    } else {
      toast('房间号：' + roomId + '（请手动记下）');
    }
  });
});
```

不调用 `window.prompt`，避免沙箱 WebView 不支持弹窗。

### 4.5 `src/style.css`

复制 `public/style.css`，在文件末尾追加安全区适配（普通浏览器里 `env()` 为 0，不影响网页版样式）：

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

### 4.6 `package.json`

- `heybox.name` 改为 `炸飞机`
- `heybox.desc` 改为 `双人实时对战：创建房间、加入好友、人机对战`
- `version` 保持 `0.1.0`（尚未上传过版本；提审时按平台要求递增）
- 其余 heybox 字段、scripts、依赖不变

### 4.7 `README.md`

改成移植工程说明：如何 dev/build、代码来自 `public/` 的副本、修改时需要同步、权限审核前不要 deploy。

## 5. 关键契约

| 项目 | 契约 |
|---|---|
| WebSocket 地址 | 固定 `wss://bomb-plane.onrender.com/ws`，不得使用 `location.host` |
| 消息协议 | `{ type, data }`，与 `server.js` 完全一致，不改协议 |
| 登录/身份 | 昵称 + emoji 头像；无账号体系，沿用现有匿名访客 ID |
| 存储 key | 沿用 `bp_theme`、`bp_name`、`bp_avatar`、`bp_visitor_id`、`bp_room_history`、`bp_draft`、`bp_marks_*`、`bp_spec_*` |
| 邀请 | 复制 4 位房间号；不使用网页链接 |
| 构建 | `npm run build` 产出 `dist/`，由 hb-sdk 注入 CSP/manifest |
| 权限 | `permissions.network.enabled = true`；线上发布等待审核通过 |

## 6. 错误与降级

- **localStorage 不可用**：内存兜底，当前会话可玩；刷新后主题/昵称/最近房间可能丢失。真机记录实际行为。
- **剪贴板不可用**：toast 直接显示房间号，用户手动输入。
- **WebSocket 被 CSP 拦截**：说明线上 network 权限未生效；本地 dev 不应出现。检查 `connect-src` 和 `remote permission list`。
- **Render 冷启动**：现有 `WSClient` 自动重连（0.5s 起指数退避，最长 30s）；UI 保持“等待对手/连接中”状态，不白屏。提审前需要 warm 实例。
- **`window.confirm` / `prompt` 在沙箱被禁用**：当前只用于“返回菜单确认”和“对局中改昵称”。Browser Mock 先验证；真机若失败，后续用现有 modal 结构补自定义弹窗，不在本次强行改造。
- **URL 不可改**：`setRoomInUrl` / `clearRoomFromUrl` 变成空函数，不影响游戏主流程。

## 7. 验证方案

### 构建

```bash
cd xiaoheihe
npm run build
```

断言：

- 构建成功，`dist/index.html` 只有受 gate 保护的模块脚本和打包后的 CSS。
- `dist/` 中没有 `location.host` 相关的 WebSocket 逻辑（`ws.js` 默认地址已固定）。
- 包大小远小于 100 MiB。

### Browser Mock

`npm run dev` 已在主会话运行（5173/5174）。实现完成后 Vite 会热更新；如未更新则重启 dev。

1. 页面正常显示首页，无白屏；SDK 握手 `ready`。
2. 创建经典房间 → 进入部署页；棋盘可操作。
3. 人机对战 → 完成部署 → 能开火、AI 能回击。
4. 第二个浏览器上下文用房间号加入 → 双方部署 → 对战一步。
5. 刷新第二个页面 → 若 localStorage 可用，能通过最近房间恢复；不可用则记录降级行为。
6. 点「复制房间号」→ 剪贴板或 toast 显示 4 位房间号。
7. 断网/关闭 socket → 自动重连，不白屏。

### 真机

需要用户用小黑盒 App 扫码：

- 首页加载、创建房间、人机对战、复制房间号。
- 与 PC Browser Mock 或另一台手机完成一次加入/部署/开火。
- 记录 Android/iOS 型号、App 版本、localStorage 是否可用、`confirm`/`prompt` 是否可用。

## 8. 回滚

- 只新增/修改 `xiaoheihe/`；网页版和服务器零改动。
- 如需回滚，删除 `xiaoheihe/src/legacy/`、恢复 `xiaoheihe/index.html` 为模板/验证页即可；不影响 `public/`。
- 不执行 git commit（用户未要求）。

## 9. 已知限制

- 网页版和移植版是两份代码，`public/` 后续改动需要手动同步到 `src/legacy/`。
- 分享能力暂未接入平台 API，只用房间号。
- 真机测试依赖用户配合；未完成前不能认为移植验收完成。

## 10. 实现偏差记录（2026-10-19）

实际实现与上面的计划有以下偏差，均已通过构建和 Browser Mock 验证：

1. **`shared.js` / `ws.js` 导出顺序调整**
   - 原因：Vite/Rollup 会把 `module.exports` 分支当成有效导出，浏览器里没有挂上 `window` 全局，导致 `WSClient` / 棋盘函数未定义。
   - 做法：把 `typeof window !== 'undefined'` 分支放到最前面，Node 分支放进 `else if`。
   - 影响：`public/` 原件不变；移植副本行为与网页版一致。

2. **冷启动连接提示**
   - 新增 `emitIfConnected(event, data)`：WebSocket 未连接时提示「正在连接服务器，请稍候…」，用于创建房间、人机对战、加入房间、最近房间「进入」和对局中改昵称。
   - 原因：Render 免费实例冷启动期间 `WSClient.emit` 会直接丢弃消息，用户点击没有任何反应。实测首次握手失败后自动重连，约 91 秒才收到访客统计。

3. **`viewport-fit=cover` 与额外安全区**
   - `index.html` 的 viewport 增加 `viewport-fit=cover`；否则 iOS/刘海屏上 `env(safe-area-inset-*)` 恒为 0。
   - `.toast` 和规则弹窗底部抽屉追加 `env(safe-area-inset-bottom)`；fixed 定位元素不受 body padding 影响。

4. **存储兜底顺序**
   - `safeGet` 先查 `memoryStore`；`safeSet` 持久化成功后清掉内存旧值。
   - `safeRemove` 在内存里写 `null` 墓碑：即使 localStorage 删除失败，后续读取也不会把旧值读回来。
   - 覆盖「能读不能写」（例如存储空间满）和「删除失败」的情况。

5. **昵称基础内容安全**
   - 新增 `checkNickname`：NFKC 归一化、去掉控制/零宽字符、12 字上限、基础广告/联系方式/不雅词过滤。
   - 用于首页创建/加入/人机、受邀加入、对局中改昵称；留空仍自动生成随机昵称。
   - 限制：纯前端过滤，直接连 WebSocket 的客户端可以绕过；提审前建议在服务器补同一校验（本任务不改 `server.js`）。

6. **模板遗留资源**
   - 删除未被引用的 `src/assets/heybox-logo.svg`，避免误以为它是正式图标。

## 11. iPhone 真机问题修复（2026-10-19）

第一轮真机验证发现三个问题，均已修复：

1. **`window.confirm` / `window.prompt` 被 iOS 沙箱屏蔽**
   - 现象：点「返回菜单」没有任何反应；`confirm()` 直接返回 false。
   - 做法：在 `index.html` 增加 `#confirm-modal` 和 `#nickname-modal`，`client.js` 用页面内弹窗代替原生弹窗；`leaveRoom` 走 `emitIfConnected`，冷启动未连接时也有提示。
   - 覆盖：返回菜单（部署页 / 对战页 / 观战等待页）、对局中改昵称。

2. **刷新后 localStorage 丢失，无法续局**
   - 现象：iPhone 刷新后回到首页，「最近加入的房间」为空。
   - 做法：新增 `src/hb-sdk.js`，把 SDK 实例挂到 `window.__hbSDK`；`package.json` 声明 `permissions.storage.enabled = true`。
   - `safeSet` 同步写 localStorage，同时异步镜像白名单 key 到 hb-sdk `storage`；`safeRemove` 写 `null` 墓碑。
   - 启动时 `hydrateHostStorage()` 先恢复（localStorage 有值则以本地为准），最多等 1 秒再 `init()`，避免宿主存储异常时卡住。
   - 宿主不支持 `storage` 时静默降级，不影响原有 localStorage / 内存兜底。

3. **刘海/状态栏遮挡页面顶部**
   - 现象：`viewport-fit=cover` 已配置，但 iOS WebView 里 `env(safe-area-inset-top)` 仍为 0。
   - 做法：`applyHostSafeArea()` 调用 `viewport.getWindowInfo()`（无需权限声明），把 `safeArea` 换算成四边留白写入 `--hb-safe-top/right/bottom/left`。
   - CSS 统一改为 `var(--hb-safe-*, env(safe-area-inset-*, 0px))`：body padding、主题按钮、toast、规则弹窗底部、手机端吸顶信息条。
   - 宿主返回零宽/零高退化安全区时按 0 处理，避免把整屏宽高当成 padding。

验证：Browser Mock 回归通过（返回菜单取消/确定、改昵称、双人、观战、刷新）；iPhone 第二轮真机复测全部通过（返回菜单、刷新续局、刘海、改昵称、复制房间号、双人对局）。

### 11.1 检查后的加固（2026-10-19）

1. **宿主存储恢复并行化**
   - `hydrateHostStorage()` 改为 `Promise.all` 并行读取所有 key，1 秒上限只花一个来回；
     逐个 `await` 时 7 个 key 可能超时，导致恢复逻辑恰好失效。
   - 每次 await 返回后重新检查 `memoryStore` 和 `localStorage`，等待期间用户写入的新值不会被迟到的宿主旧值覆盖。
2. **超时后的补偿续局**
   - 1 秒兜底先触发时，`init()` 照常执行；宿主存储稍后完成会再渲染一次最近房间并调用 `tryResumeLastRoom()`。
   - `userStarted` 标记用户是否已主动创建/加入/人机/点最近房间；已操作或已在房间时不打扰。
3. **安全区随窗口更新**
   - `applyHostSafeArea()` 增加 `resize` 防抖调用和 SDK `viewport_change` 监听，横竖屏切换后重新计算。
4. **弹窗与脏数据加固**
   - `showView()` 切页时收起确认/昵称弹窗，避免房间被服务器回收后弹窗残留。
   - 恢复的 `bp_draft` 校验必须是数组；`bp_visitor_id` 也纳入宿主镜像。
   - 宿主存储失败只 `console.warn` 一次，方便真机排查，不影响游戏。
