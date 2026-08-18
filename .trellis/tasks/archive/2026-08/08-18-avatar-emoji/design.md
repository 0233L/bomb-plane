# emoji 头像系统 · 设计

## 协议设计：`names` 旁挂 `avatars` 数组

服务器所有带 `names` 的广播事件，旁挂同长度同下标的 `avatars` 数组（emoji 字符串，空位 `''`）。选旁挂数组而非 `names` 改对象数组的原因：`names` 在 8 个服务器广播点 + 两端约 14 个事件处理点 + 各自约 10 处渲染点被直接读写，改对象数组要动全部 `state.names[i]` 处、易漏改；旁挂数组只加字段、现有代码零修改。

## 数据流

```
本地(网页 localStorage / 小程序 wx storage) bp_avatar ──随机初始化──▶ 加入房间时 emit 给服务器
                                                                      │
玩家对象 avatar 字段 ◀────(createRoom / createRoomAI / joinRoom data.avatar)
      │
8 个广播点: avatars: avatarsOf(room)  ──▶ 两端 client 存 state.avatars ──▶ 渲染 4 处
AI 玩家固定 avatar: '🤖'
```

- 入房事件（3 个）data 携带 `avatar`；服务器存 `String(data.avatar || '').slice(0, 8)`（纯转发、限长防超大 payload）
- 8 个广播点：`rematchStart`、`roomCreated`×2（普通/人机）、`joinedRoom`、`opponentJoined`、`spectatorJoined`、`reconnected`、`battleStart` 各加 `avatars: avatarsOf(room)`
- 服务器辅助函数 `avatarsOf(room) = room.players.map(p => p ? p.avatar || '' : '')`
- 重连/再来一局/观战快照均从服务器已存值广播 → 中途换头像只影响本地显示，对手下一局才看到（零新事件，v1 简化）

## emoji 池（20 个）

表情 8 + 动物 10 + 其他 2，全部单码点（`slice` 按码元计，8 码元 = 最多 4 个 emoji，足够），避开 ZWJ 连字/肤色修饰符保证跨平台彩色渲染：

```js
const AVATAR_POOL = ['😀','😄','😊','😎','🤩','😜','🤔','🥰','🐱','🐶','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🍀','🌟'];
```

放 `public/shared.js` 与 `miniprogram/utils/shared.js` 各一份（两份必须同步，当前 diff IDENTICAL，小程序不能 require 包外文件——项目惯例）。随机函数 `randomAvatar()` 同放。

## 前端状态

- 网页 `state`：`avatar: ''`（本地我的头像）+ `avatars: ['', '']`（广播的双方头像）
- 工具函数（client.js）：`myAvatar()`（读 `bp_avatar`，坏值/缺失 → 随机并写入）、`setMyAvatar(emoji)`（写 storage + 更新 state + 刷新所有显示处）、`renderMyAvatar()`
- 观战视角：头像取 `state.avatars[0]/[1]`（固定左=房主），与 names 同规则，不用 `state.seat`

## 显示位置与取值规则

| 位置 | 我的头像 | 对手头像 |
|---|---|---|
| 对战面板（玩家分支） | 本地 `state.avatar`（对局中换立刻生效） | `state.avatars[1-state.seat]` |
| 对战面板（观战分支） | `state.avatars[0]` | `state.avatars[1]` |
| 部署页对手名 | — | `state.avatars[1-state.seat]`（空则不带） |
| 比分 tooltip | 本地 `state.avatar`（观战 `state.avatars[0]`） | 同上 |
| 首页最近房间列表 | 当前 `myAvatar()`（历史记录都是"我"） | — |

## 换头像交互

- 网页：点自己头像（首页/邀请页/对战页自己面板，`.avatar-click`）→ 弹 `#avatar-modal`（复用规则弹窗 `.modal` 骨架）→ 20 个 emoji 网格点选即换 +「🎲 随机」按钮 → 立即持久化并刷新
- 小程序：换头像只在首页做（昵称卡里的头像行 → 弹 grid 面板，复用规则弹窗 modal-mask/modal 骨架）；部署页/对战页只显示
- CSS：`.avatar` 用跨平台 emoji 字体回退链（Apple Color Emoji / Segoe UI Emoji / Noto Color Emoji）

## 风险与边界

1. 跨平台 emoji 渲染差异：池子全部选人脸+动物类最稳的单码点，CSS 字体回退链兜底
2. 昵称里已有 emoji + 头像同款：仅观感重复，接受，不做去重
3. 历史记录不存头像 → 老记录零迁移
4. 对局中换头像对手看不到：v1 简化，将来可加 `setAvatar` 事件 + `avatarChanged` 广播独立接入
5. 旧客户端（未升级前端）不发 avatar → `''`，新前端显示空头像不崩
