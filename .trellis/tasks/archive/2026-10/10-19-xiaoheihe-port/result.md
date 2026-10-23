# 小黑盒移植 · 结果

验证日期：2026-10-19

## 1. 结论

移植实现与 Browser Mock 验收完成，构建通过，核心联机流程可用。

iPhone 真机第二轮（2026-10-19）：用户复测返回菜单、刷新续局、刘海安全区、改昵称、复制房间号和双人对局，全部通过。移植任务验收完成。

**尚未完成（属于上架任务，不阻塞本移植任务）：**

- `network` 权限仍在审核，生产包 CSP 仍为 `connect-src 'none'`，不能 `remote deploy`。
- 图标/封面仍为占位图，提审前需替换。

## 2. 环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 11 Home China 10.0.26200 |
| Node.js | v24.19.0 |
| hb-sdk | 0.9.1 |
| Vite | 8.3.4 |
| Browser Mock 浏览器 | Chrome Headless 155（puppeteer-core 25.8.0） |
| 游戏服务器 | `wss://bomb-plane.onrender.com/ws`（Render 免费实例） |
| 小程序 ID | `01a15288-dc63-73a6-90e7-f283d3b25abb` |
| 测试工程 | [`xiaoheihe/`](../../../xiaoheihe/) |

## 3. 实现内容

- `index.html`：来自 `public/index.html`；去掉外链 CSS/经典脚本，只保留 `type="module"` 入口；主题脚本 localStorage 加 `try/catch`；`viewport-fit=cover`；两个按钮改为「复制房间号」。
- `src/main.js`：先导入 `src/hb-sdk.js`（把 SDK 实例挂到 `window.__hbSDK`），再按 `shared.js → ws.js → client.js` 顺序导入；`hb-sdk` 初始化。
- `src/hb-sdk.js`：小黑盒 SDK 统一入口，供旧脚本读取宿主存储和窗口信息。
- `src/legacy/ws.js`：固定 `wss://bomb-plane.onrender.com/ws`；导出改为 window 优先（避免 Vite/Rollup 把 CommonJS 分支当有效导出）。
- `src/legacy/shared.js`：同上调整导出顺序，棋盘算法不变。
- `src/legacy/client.js`：
  - localStorage 不可用时 memoryStore 兜底（先读内存、持久化成功后清旧值）。
  - **iOS 刷新续局**：白名单 key（含 `bp_visitor_id`）同步镜像到 hb-sdk `storage`；启动时并行恢复全部 key（最多等 1 秒）再 `init()`，解决 iOS 刷新后 localStorage 丢失导致的「回首页」。超时后才完成恢复时会补一次最近房间渲染和自动续局；恢复期间用户已主动开局则不再打扰。
  - **返回菜单 / 改昵称**：iOS WebView 会屏蔽 `window.confirm` / `window.prompt`，改为页面内的 `#confirm-modal` / `#nickname-modal` 弹窗。
  - **安全区**：`viewport.getWindowInfo()` 读取真实安全区并写入 CSS 变量 `--hb-safe-*`，`env()` 为 0 时兜底；零宽/零高退化安全区按 0 处理。
  - `setRoomInUrl` / `clearRoomFromUrl` 改为空函数，邀请改用 4 位房间号。
  - 复制按钮优先用 clipboard；失败/不可用时 toast 显示房间号，不用 `window.prompt`。
  - `emitIfConnected`：WebSocket 未连接时提示「正在连接服务器，请稍候…」，覆盖创建/人机/加入/最近房间/改昵称/返回菜单。
  - `checkNickname`：昵称基础内容安全（NFKC、去控制/零宽字符、12 字上限、广告/联系方式/不雅词过滤）。
- `src/style.css`：安全区 padding 覆盖 body、主题按钮、toast、手机端规则弹窗底部抽屉和吸顶信息条；新增确认/昵称弹窗样式。
- 检查后加固：安全区在 `resize` / SDK `viewport_change` 时重新读取；切页自动收起残留弹窗；恢复的部署草稿校验为数组；宿主存储异常只 warn 一次。
- `index.html`：新增确认弹窗、改昵称弹窗。
- `package.json`：`heybox.name` = 炸飞机；`heybox.desc` = 双人实时对战：创建房间、加入好友、人机对战；`permissions.network.enabled = true`；`permissions.storage.enabled = true`（宿主存储，无需平台审批）。
- 删除模板遗留、未引用的 `src/assets/heybox-logo.svg`。

设计偏差已记录在 [`design.md`](design.md) 第 10 节。

## 4. Browser Mock 验收结果

测试脚本：[`evidence/browser-mock-test.js`](evidence/browser-mock-test.js)
补充回归：[`evidence/host-storage-hydration-test.js`](evidence/host-storage-hydration-test.js)（仅宿主存储刷新续局、晚到恢复、防劫持、切页弹窗、存储告警）

| 场景 | 结果 | 证据/说明 |
| --- | --- | --- |
| 首页渲染、SDK 握手、WebSocket 连接 | 通过 | 访客统计从「加载中」变为具体数字 |
| localStorage 可用性 | 通过（可用） | 沙箱内实测可用；不可用时走 memoryStore，真机由 hb-sdk storage 兜底 |
| 非法昵称「加群123456」 | 通过（被拒绝） | 停留在首页，toast「昵称包含不允许的内容，请换一个」 |
| 人机对战：创建 → 部署 → 开火 | 通过 | 房间 N5DX；开火格 `cell-empty last-reveal`；AI 有回击 |
| 复制房间号 | 通过（降级） | Headless 剪贴板不可用，toast「房间号：N5DX（请手动记下）」 |
| 改昵称弹窗（替代 `window.prompt`） | 通过 | 弹窗预填当前昵称；非法内容在弹窗内提示；合法昵称面板更新为「改名成功（我）」 |
| 返回菜单确认弹窗（替代 `window.confirm`） | 通过 | 点「取消」留在对战页；点「确定」回到首页，最近房间保留 |
| 双人：创建 → 加入 → 双方部署 → 开火 | 通过 | 房间 CSQ3；B 打 (0,0)，C 己方棋盘出现 `last-reveal` |
| 第三人观战 | 通过 | 页面显示「👁 观战中」，观战人数 1 |
| 刷新重连 | 通过 | C 刷新后回到 `view-battle`，本地房间历史恢复座位 |
| 页面 JS 错误 | 无 | A/B/C/D 均未捕获到应用错误（仅有 1 条与业务无关的 404 资源） |

### 4.1 真机（iPhone，2026-10-19）

**第一轮（发现问题）：**

| 场景 | 结果 | 说明 |
| --- | --- | --- |
| 首页加载 | 通过 | 用户确认 |
| 人机对战 | 通过 | 用户确认 |
| 返回菜单 | **失败 → 已修** | iOS WebView 屏蔽 `window.confirm`，点击无反应；已改为页面内确认弹窗 |
| 刷新续局 | **失败 → 已修** | 刷新后回首页；iOS 沙箱 localStorage 不保留，已改用 hb-sdk storage 镜像并启动恢复 |
| 刘海遮挡 | **失败 → 已修** | `env(safe-area-inset-top)` 为 0；已改用 `viewport.getWindowInfo()` 安全区写 CSS 变量 |
| 双人对局 | 未测 | 修复后复测 |

**第二轮（修复后复测，用户确认全部通过）：**

| 场景 | 结果 |
| --- | --- |
| 返回菜单：确认弹窗、取消留在对局、确定回首页 | 通过 |
| 刷新后自动续局 | 通过 |
| 刘海/状态栏不遮挡（含对战页顶部） | 通过 |
| 对局中改昵称（页面内输入弹窗） | 通过 |
| 复制房间号 | 通过 |
| 双人对局创建/加入/部署/开火 | 通过 |

截图：

- [`browser-mock-ai.png`](evidence/browser-mock-ai.png)
- [`browser-mock-pvp.png`](evidence/browser-mock-pvp.png)

### 测试环境注意

- 同一浏览器里 `127.0.0.1:5173` 的 localStorage 是共享的。测试脚本为每个玩家创建独立浏览器上下文，否则 B/C/D 会读到 A 的房间历史并自动重连到同一局；真实多设备不存在这个问题。
- 调试台 iframe 偶尔会卡在首页加载（与小程序代码无关）。测试脚本对打开调试台做了 3 次重试；最终运行第 1 次失败、第 2 次成功。
- Render 冷启动：一次诊断中首次 WebSocket 握手失败，自动重连后约 91 秒才收到访客统计。这正是新增 `emitIfConnected` 提示的原因；提审前仍需保持服务器热实例。

## 5. 存储降级与昵称内容安全

### 5.1 存储降级

- 单元测试：[`evidence/storage-fallback-test.js`](evidence/storage-fallback-test.js)，12 个用例全部通过。
- 覆盖：localStorage 只读、完全不可用、能读不能写、先写失败后恢复可写、删除失败、正常读写、不存在的 key。
- 关键行为：内存兜底优先；持久化成功后清掉内存旧值；删除时写入 `null` 墓碑，避免「删不掉 localStorage 又读回旧值」。

### 5.2 昵称内容安全

- 单元测试：[`evidence/nickname-filter-test.js`](evidence/nickname-filter-test.js)，19 个用例全部通过。
- 覆盖：正常中英文、空输入、全角转半角、零宽字符清除、12 字上限、网址/裸域名、加群/代练等广告词、微信/QQ 联系方式、长数字、常见不雅词。
- 局限：这是前端过滤，直接连 WebSocket 的客户端可以绕过。**提审前建议在服务器端补同一校验**；本任务按约束未修改 `server.js`。

## 6. 构建与静态检查

```text
npm run build
✓ 10 modules transformed
dist/index.html                  31.03 kB
dist/assets/index-*.css          17.85 kB
dist/assets/index-*.js          211.43 kB
待上传文件 5 个 / 255.4 KiB
```

- `dist/index.html` 含 hb-sdk runtime gate 与 CSP；当前 `connect-src 'none'`（权限审核中，预期）。
- `wss://bomb-plane.onrender.com/ws` 已进入产物；`src/` 中 `location.host` 为 0 处。
- `node --check`：`client.js` / `ws.js` / `shared.js` / `main.js` 全部通过。
- 未发现 token/Cookie/密码/apiKey。
- `git status --porcelain -- public server.js ai.js miniprogram` 为空，网页版和服务器零改动。
- 检查代理增量复验 23/23 通过：仅宿主存储刷新续局、强制 6 秒晚到恢复、晚到窗口内主动开局不被劫持、切页关闭弹窗、存储告警只出现一次。
- 未执行 git commit（用户未要求）。

## 7. 权限与发布状态

```text
network (网络)  原始审批=disabled  本地生效=disabled  最近申请=auditing
申请 ID：e4fecd41-51c1-4e56-86d0-704a508bc0c9
```

- `hb-sdk dev` 使用本地临时权限，Browser Mock 可正常连接。
- 生产构建仍带 `connect-src 'none'`，权限通过前**不能** `remote deploy`。
- 权限通过后，按 `xiaoheihe/README.md` 的命令部署，并先用真机确认 WebSocket。

## 8. 未完成与风险

1. **真机验收已完成**：iPhone 第二轮确认返回菜单、刷新续局、刘海安全区、改昵称、复制房间号和双人对局全部通过。
2. **network 权限审核中**：见第 7 节；批准前不能发布。
3. **宿主存储能力依赖 Host 版本**：`storage` 权限已声明（无需平台审批）；当前用户的小黑盒版本实测可用。若其他版本不支持会静默降级，刷新续局可能失效。
4. **安全区信息依赖 Host 版本**：`viewport.getWindowInfo()` 不可用时自动退回 CSS `env()`；当前 iPhone 实测通过。
5. **图标/封面占位图**：`xiaoheihe/assets/heybox-placeholder.png` 为 200×200；封面建议 510×272，提审前替换。
6. **服务器冷启动**：Render 免费实例可能 20–90 秒不可用；提审/上线前需 keep-alive 或常驻实例。
7. **`checkRooms` 在连接前发送**：冷启动时可能被丢弃，导致失效房间清理延迟；属网页版既有行为，本次未扩大差异去改。
8. **昵称服务端校验缺失**：见第 5 节。
9. **两份代码需手动同步**：`public/` 后续改动要同步到 `xiaoheihe/src/legacy/`。
10. **对局标注 `bp_marks_*` 未镜像宿主存储**：key 随房间动态增长，未加入白名单；iOS 刷新后标注会丢失，不影响对局本身。

## 9. 复现命令

```bash
cd d:/coding/project/bombPlane/xiaoheihe
npm run dev        # 保持运行（5173/5174）

# 另开终端，在项目根目录：
cd d:/coding/project/bombPlane
NODE_PATH=d:/coding/project/bombPlane/node_modules \
  node .trellis/tasks/10-19-xiaoheihe-port/evidence/browser-mock-test.js

node .trellis/tasks/10-19-xiaoheihe-port/evidence/nickname-filter-test.js
npx hb-sdk remote permission list   # 在 xiaoheihe/ 下
```

## 10. 变更范围

- 新增/修改：`xiaoheihe/`（移植工程）、本任务文档与 `evidence/`、`.trellis/spec/frontend/xiaoheihe-sandbox.md`。
- 未修改：`public/`、`server.js`、`ai.js`、`miniprogram/`。
- 未提交 git。
