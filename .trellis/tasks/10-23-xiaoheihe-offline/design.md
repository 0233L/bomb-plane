# 设计：小黑盒离线版

## 1. 总体结构

```
xiaoheihe/src/
├── main.js                  入口：按 shared → local-ai → local-server → client 顺序加载
└── legacy/
    ├── shared.js            原样保留（棋盘/飞机/规格）
    ├── ws.js                保留但不再导入（可被 LocalServer 顶替）
    ├── local-ai.js          ai.js 的浏览器副本（只改导出/依赖包装，算法不变）
    ├── local-server.js      本地「服务器」：房间、规则、AI 定时器、同屏换人
    └── client.js            UI；增加 localMode / 换人悬浮条 / 交接页 / 新入口
```

`LocalServer` 实现与 `WSClient` 相同的接口（`on/once/off/emit/connected`），
`client.js` 只把 `new WSClient()` 换成 `new LocalServer()`，其余协议事件保持不变。

## 2. 事件协议（与 server.js 一致）

客户端 → 本地服务器：

| 事件 | 用途 |
|---|---|
| `createRoomAI` | 创建人机房间（mode/boardSize/name/avatar） |
| `createRoomLocal` | 创建同屏双人房间（mode/boardSize/name/avatar） |
| `deployConfirm` / `deployCancel` | 部署确认 / 取消 |
| `reveal` | 揭示一格 |
| `useItem` | 使用道具 |
| `rematch` | 再来一局 |
| `setNickname` / `setAvatar` | 房间内改名 / 换头像 |
| `passReady` | 同屏双人：对方已接过设备（服务端重新校验后换人） |
| `leaveRoom` | 返回菜单 |

本地服务器 → 客户端：沿用 `roomCreated`、`joinedRoom`、`deployReady`、
`battleStart`、`revealResult`、`itemResult`、`gameOver`、`rematchStart`、
`rematchVote`、`playerStatus`、`avatarUpdated`、`nicknameUpdated`、
`leftRoom`、`reconnected`、`error`、`rejoinFailed`、`roomsAlive`、`visitResult`。

没有 `passDevice`：换人不由服务器自动触发。

## 3. 同屏双人（关键设计）

- 房间多一个 `activeSeat`（当前能行动的人）和 `clientSeat`（界面显示谁的视角）；
  客户端多一个 `state.seat`（= `clientSeat`）。
- **不强制换人**：沿用原步数规则 `steps[seat] <= steps[other]`，客户端据此
  渲染顶部悬浮条（`renderSwitchBar`）：
  - 落后（`mine < theirs`）：隐藏悬浮条，继续行动追平；
  - 相等：半透明（opacity `.62`）询问「可以切换给 X 行动」，可继续行动；
  - 领先：`.urgent`（opacity `1`、主色边框）提示「请切换给 X 行动」，
    服务器/客户端都拒绝继续行动。
- 悬浮条由 `dockSwitchBar()` 插在当前页 `.topbar` 之后，使用 `position: sticky`，
  不遮挡返回菜单和规则按钮。
- 换人流程：
  1. 玩家点「切换玩家」→ 弹出**不透明**全屏交接页（盖住上一位玩家的棋盘）；
  2. 对方点「我是 X，开始」→ 发 `passReady { seat }`；
  3. 服务器校验：座位必须是下一位、部署阶段已确认、战斗阶段
     `steps[next] <= steps[current]`；过期/非法请求返回 `error`；
  4. 校验通过后切换 `activeSeat = clientSeat = next`，发送 `reconnected` 风格快照
     （含 `myPlanes`、`myShotsReceived`、`enemyShotsReceived`、`sonarHistory`、
     `frozenCells`）；
  5. 客户端应用快照、重新渲染、关闭交接页。
- 部署阶段：当前玩家确认后只显示高亮悬浮条，不自动换人；双方确认后进入战斗，
  最后确认者先手。
- 再来一局：`activeSeat = clientSeat`，设备在谁手里谁先重新部署，不强制换人。
- 刷新页面会丢失本地房间（不写房间历史），回首页重新开局。

## 4. 本地 AI

- `local-ai.js` 是 [`ai.js`](../../../ai.js) 的副本：算法、常量一字不改；
  只替换文件头尾的 Node 包装：
  - `require('./public/shared.js')` → 使用已加载的全局 `shared` 函数；
  - `process.env.*` → 固定默认值；
  - `module.exports` → `window.LocalAI`（保留 Node 分支便于测试）。
- AI 走棋复用服务器逻辑：S+经典用 `chooseTargetLive`；其余组合用
  `buildProbField` + `chooseTargetProbField`，失败回退 `chooseTargetSimple`；
  道具模式用 `decideItem`。
- 思考延迟 800–1500ms；玩家操作后由 `scheduleAITurn` 推进。

## 5. 首页与文案

- 删除：创建房间、房间号输入、加入、最近房间、访客统计、受邀页入口、连接提示条。
- 保留：昵称、头像、经典/道具、地图规格、🤖 人机对战、👥 同屏双人、规则、主题。
- 顶栏在本地模式隐藏「房间 XXXX」和「复制房间号」。
- 文案明确「无需联网 · 数据只在本机」。

## 6. 校验与容错

- 坐标/阶段/步数/金币/冻结/重复揭示全部沿用服务器校验，非法操作回 `error` toast。
- `LocalServer.emit` 只在 `connected` 时处理，与 WSClient 行为一致。
- 交接页显示期间忽略棋盘点击（遮罩层本身挡住）。
- 本地房间不写 `bp_room_history`；启动时清掉旧联机历史，避免误触 rejoin。
- 部署草稿 `bp_draft` 在本地模式不落盘，切换座位时强制清空。

## 7. 回滚

全部改动集中在 `xiaoheihe/`；如需恢复联机版，回退该目录与 `package.json#heybox.permissions` 即可，
网页版与服务器完全不受影响。
