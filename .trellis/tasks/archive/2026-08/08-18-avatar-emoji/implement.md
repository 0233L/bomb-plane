# emoji 头像系统 · 实施计划

## 实施顺序（依赖关系）

1. `public/shared.js` + `miniprogram/utils/shared.js`：AVATAR_POOL + randomAvatar + api 导出（先决）
2. `server.js`：avatar 字段 + avatarsOf + 8 个广播点（可独立验证）
3. `public/client.js` + `public/index.html` + `public/style.css`：state、工具区、弹窗、4 处渲染
4. `miniprogram/app.js` + index/deploy/battle 三页
5. 测试：改 e2e/mini-logic，新建 avatar-protocol / avatar-ui
6. 全量测试 + `diff public/shared.js miniprogram/utils/shared.js` + 手工回归
7. 更新 spec、提交

## 1. shared.js ×2（同步修改）

- `CELL_EMPTY` 区块后加：
  ```js
  // ---------- 头像 emoji 池（动物 + 表情为主，跨平台显示最稳的单码点 emoji） ----------
  const AVATAR_POOL = ['😀','😄','😊','😎','🤩','😜','🤔','🥰','🐱','🐶','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🍀','🌟'];
  // 随机抽一个头像（首次进入 / 面板里的「🎲 随机」按钮用）
  function randomAvatar() { return AVATAR_POOL[Math.floor(Math.random() * AVATAR_POOL.length)]; }
  ```
- api 导出加 `AVATAR_POOL`、`randomAvatar`

## 2. server.js（约 +20 行）

- L124 `emitToRoom` 后新增 `avatarsOf(room)` 辅助函数
- 3 处真人玩家对象（L292-297、L332-337、L521-526）加 `avatar: String(data.avatar || '').slice(0, 8)`
- AI 玩家对象（L339-344）加 `avatar: '🤖'`
- 8 个广播点数据加 `avatars: avatarsOf(room)`：rematchStart(L195)、roomCreated(L308、L356)、joinedRoom(L538)、opponentJoined(L544)、spectatorJoined(L562)、reconnected(L637)、battleStart(L690)

## 3. public 前端

### client.js
- state（L180 names 旁）加 `avatar: ''`、`avatars: ['', '']`
- `saveRoomToHistory` 后新增工具区：`myAvatar()` / `setMyAvatar(emoji)` / `renderMyAvatar()` + 弹窗函数（渲染 `#avatar-pool` 按钮网格、🎲 随机）
- 渲染：L580 部署页对手名带头像；L638/L642 观战、L649/L653 玩家分支（`#panel-my-avatar`/`#panel-enemy-avatar`）；L688-690 比分 tooltip `dataset.name = state.avatar + ' ' + state.names[a]`（观战用 `state.avatars[0]`）；L160 `renderRecentRooms` 显示 `myAvatar() + ' ' + e.name`；可选：棋盘标题/结算标题带头像
- 7 处 `state.names = d.names` 后加 `state.avatars = d.avatars || ['', '']`（L1152、L1172、L1196、L1229、L1247、L1304、L1358）
- 4 处入房 emit data 加 `avatar: myAvatar()`（L1492、L1500、L1506、L1603）
- `init()` 加 `state.avatar = myAvatar(); renderMyAvatar();`；`bindUIEvents` 绑 `#home-avatar`/`#invite-avatar`/`#panel-my-avatar` 点击开面板

### index.html（约 +25 行）
- 首页昵称 label 前 `<span id="home-avatar" class="avatar avatar-click" title="点我换头像"></span>`；邀请页同款 `#invite-avatar`
- 部署页对手名前 `#deploy-opponent-avatar`；对战页两面板 h3 名前 `#panel-my-avatar`/`#panel-enemy-avatar`
- 规则弹窗后新增 `#avatar-modal`（.modal/.modal-box 骨架 + `#avatar-pool` 网格 + 🎲 随机按钮）

### style.css（约 +40 行）
- `.avatar`（emoji 字体回退链）、`.avatar-click`、`.avatar-pool` 网格（6 列）+ 按钮样式、窄屏媒体查询字号微调

## 4. 小程序

### app.js
- state 加 `avatar: ''`、`avatars: ['', '']`
- `getVisitorId` 后新增 `loadAvatar()`（读 bp_avatar，坏值/缺失随机）+ `setMyAvatar(emoji)`（写 storage + state.avatar + `emitLocal('avatar')`）
- 7 个事件处理器加 `state.avatars = d.avatars || ['','']`（roomCreated/joinedRoom/spectatorJoined/opponentJoined/battleStart/rematchStart/reconnected）
- App 导出加 `myAvatar`、`setMyAvatar`、`AVATAR_POOL`

### 三页
- index：data 加 myAvatar/avatarPool/showAvatarPicker；昵称卡加"点我换头像"行；新增头像选择弹窗（wx:for + wx:key="*this"）；房间列表带头像
- deploy：data 加 oppAvatar，render 从 `s.avatars[1 - s.seat]` 取，wxml 对手名带头像（wx:if 空则隐藏）
- battle：data 加 myAvatar（自己 `app.myAvatar()`，观战 `s.avatars[0]`）/enemyAvatar；两侧面板带头像
- app.wxss 加全局 `.avatar` 样式

## 5. 测试

- 改 `test/e2e-test.js`：入房 data 加 avatar；断言 roomCreated/opponentJoined/battleStart/reconnected/rematchStart/观战快照 avatars；AI 房间 `avatars[1] === '🤖'`
- 新建 `test/avatar-protocol-test.js`（仿 online-smoke-test.js）：回显、空 avatar→''、重连保留、超长截断不报错
- 新建 `test/avatar-ui-test.js`（jsdom，仿 home-ui-test.js）：myAvatar 缺失/坏值修复；面板交互（开/选/随机）；按钮数===20；battleStart 渲染（含观战）；比分 tooltip；部署页；房间列表
- 改 `test/mini-logic-test.js`：建房带头像 → state.avatars[0]；app.myAvatar/setMyAvatar；battle render 后 data 正确

## 6. 验证命令

- `node test/xxx.js` 逐个跑 15+ 个测试（无统一 runner），服务器 `RECYCLE_SECONDS=3 node server.js`
- `diff public/shared.js miniprogram/utils/shared.js` 应为 IDENTICAL
- 手工：两浏览器对战（含人机）、重连、再来一局、观战、换头像刷新

## 7. 提交

- 更新 spec（前端/后端协议文档如有 names 广播的记载）+ README 可选补一句头像说明
- commit（含 .trellis 任务归档：`python ./.trellis/scripts/task.py archive` 或按项目惯例走完 Phase 3）
