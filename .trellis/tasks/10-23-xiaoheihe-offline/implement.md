# 执行清单：小黑盒离线版

> 初版范围：只改 `xiaoheihe/`，`public/`、`server.js`、`ai.js`、`miniprogram/` 零改动。
> 2026-10-23 用户追加「网页版同步只读对战历史」，网页端改动仅限历史功能，见第 8 节。

## 1. 本地 AI

- [x] 复制 `ai.js` → `xiaoheihe/src/legacy/local-ai.js`（算法不动）。
- [x] 替换依赖包装：全局 shared、`process.env` 默认值、`window.LocalAI` 导出。
- [x] 确认 `randomDeployment` / `smartDeployment` / `buildProbField` /
      `chooseTargetProbField` / `chooseTargetLive` / `decideItem` 可用。

## 2. 本地服务器

- [x] 新建 `xiaoheihe/src/legacy/local-server.js`，实现 WSClient 同款接口。
- [x] 房间创建：人机（座位 0 真人、1 AI）、同屏双人（两座位都是本地玩家）。
- [x] 移植 server.js 规则：部署校验、揭示、6 个道具、步数/金币/冻结/胜负。
- [x] AI 定时器、AI 自动部署、AI 再来一局投票。
- [x] 同屏换人：`activeSeat` / `clientSeat`、`passReady` 服务端校验、全量快照；
      不强制换人，由顶部悬浮条按步数提示。
- [x] leaveRoom / rejoinFailed / roomsAlive / visitResult 的离线响应。

## 3. 客户端

- [x] `main.js` 加载顺序加入 `local-ai.js`、`local-server.js`。
- [x] `init()` 改用 `LocalServer`；首页新增「同屏双人」入口。
- [x] `roomCreated.local`：标记本地模式、隐藏房间号/复制/观战 UI、不写历史。
- [x] 新增玩家主动切换的交接页 DOM/CSS/事件；快照到达后再关闭。
- [x] 新增顶部换人悬浮条：落后隐藏、相等半透明询问、领先高亮提示；
      插在顶部菜单栏下方，不遮挡返回菜单/规则。
- [x] 本地模式不落盘部署草稿；切换座位时清空。
- [x] `goBattle` 不再清空声呐历史（改由 `battleStart` 清）。
- [x] 首页文案与布局整理；移除联机入口、访客统计、连接提示。
- [x] 修复 `pickKeys` 空数组导致的 `split` 崩溃。
- [x] 同屏双人 2 号位改名/换头像不覆盖设备主人的本地记忆。
- [x] 随机昵称保证 ≤ 12 字；启动时忽略并清除超长的旧昵称。

## 4. 清单/权限

- [x] `package.json#heybox`：删除 `network`，更新 `desc`。
- [x] 版本号提升到 `0.2.0`。

## 5. 验证

- [x] `npm run build` 通过；产物不含 `wss://` / `bomb-plane.onrender.com` / `WebSocket`，
      manifest 仅 `storage`。
- [x] Puppeteer Browser Mock：
  - 人机：首页 → 部署 → 开战 → 开火 → AI 回应 → 结束 → 再来一局；
  - 同屏：P0 部署 → 顶部提示（不自动换）→ 主动切换 → P1 部署 → 对战；
    落后继续行动、追平半透明提示、领先高亮且禁止行动；
  - 只有点「切换玩家」才出现交接页；交接页不透明、覆盖全屏；
  - 再来一局不强制换人，步数/比分正确重置；
  - 经典/道具 × S/M/L 抽样开局；
  - 随机昵称 2 万次采样均 ≤ 12 字；超长旧昵称不回填并被清除；
  - 规则、主题、昵称、头像、刷新回首页。
- [ ] 真机 iPhone：人机 + 同屏各一局，检查刘海安全区与右下角按钮；再补一次历史弹窗验收。
- [x] 初版离线移植期间 `public/`、`server.js`、`ai.js`、`miniprogram/` 零改动；
      后续仅因网页版历史需求修改 `public/`，`server.js`、`ai.js`、`miniprogram/` 仍零改动。

## 6. 文档

- [x] 更新任务 `submission.md` / 父任务 `prd.md` / `implement.md`。
- [x] 更新 `.trellis/spec/frontend/xiaoheihe-sandbox.md`（离线版契约）。
- [x] 更新 `xiaoheihe/README.md`。

## 7. 对战历史（追加功能）

- [x] 新建 `xiaoheihe/src/legacy/match-history.js`：`window.MatchHistory`，
      负责记录校验、排序、格式化（不碰 DOM / 存储）。
- [x] `main.js` 在 local-server 之后、client 之前导入 `match-history.js`。
- [x] `client.js`：`bp_match_history` 加入 `HOST_STORAGE_KEYS`；新增
      `historyRecorded` 标记和 `loadMatchHistory` / `saveMatchHistory` /
      `recordMatchResult` / `renderMatchHistory` / `openHistoryModal` /
      `closeHistoryModal` / `clearMatchHistory`；`battleStart` 重置标记；
      `gameOver` 只写一次；`showView` 关闭弹窗；绑定历史弹窗按钮。
- [x] `index.html`：首页「📜 对战历史」按钮 + `#history-modal` 弹窗。
- [x] `style.css`：历史列表 / 结果颜色 / 深色变量 / 手机端滚动 /
      `#confirm-modal { z-index: 96 }`。
- [x] `npm run build` 通过；`dist` 无 `onrender` / `wss://` / `WebSocket`；
      `dist/manifest.json` 权限只有 `storage`。
- [x] `window.MatchHistory` 纯函数临时脚本检查（坏 JSON、坏记录、20 条上限、
      数组复制、格式化输出）。
- [x] Browser Mock / Puppeteer 完整流程：空状态、纯函数、坏数据/20 条/HTML/移动布局、
      同屏双人 + 清空取消/确认、人机两局 + 刷新 + 宿主存储恢复，全部通过。
- [ ] 真机 iPhone：历史弹窗滚动、清空确认层级、刷新后记录仍在。

## 8. 网页版同步：只读对战历史（追加）

- [x] 新建 `public/match-history.js`：`window.MatchHistory`，与离线版同 schema，
      但网页版只产生 `ai` / `online`；`append()` 返回数组，存储前需 `serialize()`。
- [x] `public/index.html`：首页 `#btn-history` + `#history-modal`（无清空按钮），
      脚本顺序 `ws → shared → match-history → client`。
- [x] `public/client.js`：`state.isAI` / `historyRecorded`；`roomCreated` /
      `reconnected` 读取 `isAI`；`battleStart` 重置标记；`gameOver` 只写一次；
      `showView` 关闭弹窗；观战者不记录；不改 `bp_name` / `bp_avatar`。
- [x] `public/style.css`：独立历史列表样式、主题颜色、手机端固定头尾 + 列表滚动。
- [x] 新增正式回归测试 `test/match-history-ui-test.js`（jsdom，62 项，
      含终局棋盘与坏快照校验）。
- [x] 网页版真实浏览器验收（本地 3100）：人机 + 刷新、联机双方 + 刷新、
      只读弹窗、坏数据/HTML/20 条/390×844 布局、无控制台错误。
- [x] 现有网页测试回归：home-ui 95、avatar-ui 37、double-tap 25、
      item-render 31、sonar-render 17，全部通过。
- [x] 文档：根 `README.md`、`.trellis/spec/frontend/web-match-history.md`。

## 9. 历史详情：查看终局棋盘（追加）

- [x] 两版 `match-history.js`：记录新增可选 `planes` / `shots`；校验座位数、
      飞机架数、朝向、越界（用 `getPlaneCells`）、单条落子结果与坐标；
      坏快照整局丢弃但保留列表记录；新增 `hasBoard()`。每方最多 400 条落子。
- [x] 两版 `client.js`：`gameOver` 传入 `d.planes`；按当前 `state.seat` 映射
      `myShotsReceived` / `enemyShotsReceived` 到 `shots[seat]`；列表行可点击
      （`role="button"`、Enter/Space），旧记录显示「旧记录未保存棋盘」。
- [x] `openHistoryDetail` / `closeHistoryDetail`：结果、元信息、双方棋盘；
      赢家标 👑；`buildBoard` 画机头/机身；未探测格 `.hist-dimmed`，
      摧毁格 `.hist-x`；CSS Grid + `--n` + `aspect-ratio` 支持 14×14。
- [x] 两版 `index.html`：新增 `#history-detail-modal`（结果、元信息、棋盘容器、
      ✕、返回列表）。
- [x] 两版 CSS：详情弹窗 z-index 97（历史 95、确认 96、toast 100）；
      点击行样式；棋盘/格子/暗格/摧毁标记；手机端棋盘区滚动、头部和按钮固定。
- [x] 永久 jsdom 测试 62 项通过；离线 Browser Mock：AI 对局详情、同屏双人详情、
      20 条记录 + 旧记录提示、14×14 详情布局、返回列表全部通过。
- [x] 网页真实浏览器：AI / 联机详情、刷新后仍可点、双方保存的 `planes` /
      `shots` 完全一致（验证座位映射）、20 条 + 14×14 手机/桌面布局全部通过。
- [x] 文档：两份 spec、根 `README.md`、`xiaoheihe/README.md`、本任务 PRD。
- [ ] 真机 iPhone：历史记录点进 14×14 棋盘详情并返回。

## 10. 换人条布局 + 离线续局 + 探测二次确认（第二批）

### 换人条布局

- [x] `xiaoheihe/index.html`：对战页把 `#switch-slot` 和 `.battle-info-row`
      包进 `.battle-sticky-top`。
- [x] `xiaoheihe/src/style.css`：`.battle-sticky-top` 作为唯一吸顶点；
      `.switch-bar` 在其内部改为 `position: static`；手机断点删除信息栏自己的
      sticky/top/z-index。
- [x] `dockSwitchBar()` 优先停靠到当前页 `#switch-slot`，部署页仍退回 `.topbar` 后。

### 离线续局

- [x] `local-server.js`：房间新增 `suspended`；新增 `suspendRoom` / `resumeRoom`；
      暂停时清 AI 定时器，恢复时重新排程；`_active()` / `passReady` /
      `_scheduleAITurn` 全部加暂停守卫；`_sendSnapshot` 的 `local2p` 改为真实值。
- [x] `client.js`：`state.suspended` / `state.resumeDraft`；返回菜单改为
      `suspendRoom`；`roomSuspended` / `resumeFailed` 处理器；首页续局卡
      `renderResumeCard()` / `resumeSuspendedGame()` / `discardSuspendedGame()`。
- [x] `showPassCover(seat, opts)` 支持续局文案和不透明确认；`#btn-pass-ready`
      按 `pendingPassIsResume` 发送 `resumeRoom` 或 `passReady`。
- [x] `reconnected` 恢复未确认部署草稿（仅内存、匹配房间/座位）；刷新或离开后清空。
- [x] 已结束对局 `suspendRoom` 清房并 `leftRoom`，不出现续局卡。

### 探测二次确认

- [x] 两版 `index.html`：敌方棋盘 `h3` 内新增 `#reveal-confirm-wrap` /
      `#reveal-confirm`。
- [x] 两版 `client.js`：`revealConfirm` / `revealPending`、`loadRevealConfirm` /
      `updateRevealConfirmUI` / `clearRevealPending` / `onRevealConfirmChange`；
      `onEnemyCellClick` 在道具分支之后、emit 之前处理连点确认；
      `renderBattleBoards` 画 `.cell-probe-target`；新局/结束/道具/换人时清空。
- [x] 离线版 `bp_reveal_confirm` 加入 `HOST_STORAGE_KEYS`。
- [x] 同屏双人按座位分开记忆：新增 `bp_reveal_confirm_p0` / `_p1`（同样镜像
      宿主存储）；`revealConfirmKey()` 按 `state.local2p` + `state.seat` 选 key；
      `goBattle()` 每次换人/续局重新读取当前座位偏好；0 号位同步设备级 key，
      1 号位只写自己的，未设置时回退到设备级设置。
- [x] 两版 CSS：标题区相对定位、右侧勾选框、虚线探测目标高亮。
- [x] 顺带修复网页版 `renderBattleBoards` 的 `pickKeys` 空数组崩溃
      （与离线版第 3 节同一修复对齐）。

### 验证

- [x] 新增 `test/reveal-confirm-test.js`（39 项）与
      `test/xiaoheihe-resume-test.js`（35 项），全部通过。
- [x] 网页测试回归：历史 62、首页 95、头像 37、二次点击 25、道具渲染 31、
      声呐 17，全部通过。
- [x] 网页版真实浏览器（390×844 + 1000×900）：默认关闭、连点确认、改选、
      刷新记忆、道具流程、标题居中、勾选框不溢出、桌面两列对齐，全部通过。
- [x] 离线 Browser Mock：换人条在信息栏上方（顶部 + 滚动后）、续局流程 A–F
      （部署草稿、AI 暂停、同屏交接、错误座位、刷新、已结束）、二次确认，全部通过。
- [x] `npm run build` 通过；`dist` 无 `wss://` / `WebSocket` / `onrender`；
      `dist/manifest.json` 权限仍只有 `storage`。
- [ ] 真机 iPhone：续局卡片、交接页、二次确认勾选与记忆。
- [x] `server.js`、`ai.js`、`miniprogram/` 零改动。

### 文档

- [x] 本任务 `prd.md` / `implement.md`。
- [x] `.trellis/spec/frontend/xiaoheihe-sandbox.md`：续局、布局、二次确认契约。
- [x] 新建 `.trellis/spec/frontend/web-reveal-confirm.md` 并登记到 `index.md`。
- [x] 根 `README.md`、`xiaoheihe/README.md`。
