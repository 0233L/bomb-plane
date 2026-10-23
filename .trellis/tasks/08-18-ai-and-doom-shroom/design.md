# 设计：AI 适配 + 毁灭菇

## 一、毁灭菇（经济与步数定案）

| 项 | 定案 | 理由 |
|---|---|---|
| 价格 | **10 金币** | 现有最贵 6；5 格揭示 + 冻结副作用，强度最高档 |
| 步数 | **steps +1**（一次行动，同其他道具） | 与「道具 = 标准行动」的既有模型一致 |
| 5 格揭示 | 按正常揭示结算金币（头5/身1/空0） | 与双发连射一致（揭示即结算） |
| 冻结范围 | 十字 5 格的 **8 邻域**（含对角）且未揭示的格 | 用户说「相邻」；已揭示格冻结无意义 |
| 冻结期限 | **施放者接下来的 2 次行动** | 用户「持续两回合」= 施放方两回合 |

**冻结模型（关键修正，用户 2026-08-18）**：冻结只约束**施放者自己**。对手（棋盘主人）的行为不受任何影响。即：毁灭菇 = 揭示 5 格 + 给自己「接下来 2 次行动」划出一小片禁区（不能打、不能选中）。是对称公开的信息（双方都看得到 ❄），不是隐藏机制。

**步数语义**：施放后 `steps[seat] = S+1`，冻结 expiry = S+3；检查条件 = 施放方行动时 `steps[seat] < expiry`：
- 施放后第 1 次行动（steps = S+1 < S+3）→ 受限 ✓
- 第 2 次行动（steps = S+2 < S+3）→ 受限 ✓
- 第 3 次行动（steps = S+3）→ 解除 ✓

## 二、服务器改动（server.js）

### 2.1 房间状态
- `createRoom()` 加 `frozenCells: []` —— `[{row, col, owner, expiry}]`（owner = 施放方 seat；expiry 按上面公式）
- `resetToDeploy()` 加 `room.frozenCells = [];`（每局清零）

### 2.2 冻结检查辅助函数
```js
// 施放方在 (row, col) 是否仍被冻结（对手永远 false：冻结只约束施放者）
function isFrozenCell(room, seat, row, col) {
  return room.frozenCells.some(function (f) {
    return f.owner === seat && room.steps[seat] < f.expiry && f.row === row && f.col === col;
  });
}
// 一组格子中是否含冻结格（区域型道具用）
function hasFrozenCell(room, seat, cells) {
  return cells.some(function (c) { return isFrozenCell(room, seat, c[0], c[1]); });
}
// 快照用：过滤掉已过期的冻结格
function activeFrozenCells(room) {
  return room.frozenCells.filter(function (f) {
    return room.phase === 'over' || room.steps[f.owner] < f.expiry;
  });
}
```

### 2.3 揭示路径（唯一执行点防线）
- `handleReveal`：坐标/已揭示校验后加 `if (isFrozenCell(room, seat, row, col)) return sendError(socket, '这个格子被毁灭菇冻结，你还不能揭示它');`
- `tryReveal` 开头加防御：`if (isFrozenCell(room, seat, row, col)) return false;`（AI 路径兜底；调用方忽略返回值）

### 2.4 handleUseItem 各分支加冻结检查
- `sonar` / `pro` / `devour` / `doom`（区域型）：`if (hasFrozenCell(room, seat, regionCells(row, col)))` → 拒绝「选区里包含冻结的格子」
- `burst`：两格任一 `isFrozenCell` → 拒绝
- `expose`：目标是**已揭示**机头，冻结只作用于未揭示格 → 无需检查（注释说明）

### 2.5 毁灭菇分支（itemId === 'doom'）
```
校验：mode/price/steps/coins 同现有流程；itemId 白名单
十字校验：Number.isInteger(row/col) && row ∈ [1, size-2] && col ∈ [1, size-2]（十字完整落盘）
冻结检查：hasFrozenCell(room, seat, crossCells(row, col))
执行：
  1. 5 格逐一揭示（记录 defender.shotsReceived + 金币结算，不走 tryReveal 以免步数 ×5）：
     revealCell(room, seat, r, c) —— 内部函数：push 记录 + coinGain 结算
  2. room.steps[seat] += 1
  3. room.coins[seat] -= price
  4. 生成冻结：对 5 格的 8 邻域去重、排除 5 格本身、排除已揭示格，
     push {row, col, owner: seat, expiry: room.steps[seat] + 2}
  5. 广播 itemResult：{itemId:'doom', attacker, row, col,
     cells: [{row,col,result}×5], frozen: [[r,c]×N], steps, coins, headsLeft}
  6. headsLeft 判胜 + AI 调度（复用 finishItem 的尾部逻辑）
```
- 注意：5 格揭示不广播 revealResult（避免 5 条事件的步数竞态），单条 itemResult 携带全部信息，客户端按 itemResult 渲染
- 辅助函数：
  - `crossCells(row, col)`：十字 5 格坐标（中心+上下左右）
  - `neighbor8(row, col, size)`：8 邻域内合法坐标（边界裁剪）
- `finishItem` 公共尾部（判胜 + AI 调度）抽成 `finishItemTail(room, seat, itemId, payload)` 供 doom 复用（doom 的扣费/步数在前面自管，只复用广播 + 判胜 + 调度）

### 2.6 观战 / 重连快照
- `spectatorJoined`、`reconnected` 数据加 `frozenCells: activeFrozenCells(room)`（客户端据此渲染 ❄ 并校验点击）

## 三、AI 适配（server.js + ai.js）

### 3.1 createRoomAI 放开规格
- 删掉「AI 决策模块只适配经典 10×10/3 架」注释与硬编码，改用 `parseMode(data)`；`roomCreated` 回显真实 mode/boardSize

### 3.2 ai.js 新增规格化能力（现有 S 算法不动）
- `randomDeployment(spec)`：加可选 spec 参数（默认 'S' 行为不变），用 `shared.getBoardSpec` + `canPlacePlane`/`getPlaneCells` 随机生成合法部署（与测试工具同构）
- 新增 `chooseTargetSimple(shotsReceived, size, frozenCells)`：任意规格的简单启发式：
  1. 排除已揭示格与冻结格得候选集
  2. 优先：与已揭示 `body` 格 4 邻域的候选（顺藤摸瓜）；并列时选相邻 body 数最多的
  3. 无则随机候选；候选为空返回 null
- `chooseTargetLive` 保持不变（经典/S 实战算法）

### 3.3 scheduleAITurn 分流 + 道具决策
- 抽取 `doUseItem(room, seat, itemId, data)`：从 handleUseItem 抽出「校验 + 执行」主体（不含 socket/错误发送），成功返回 null、失败返回错误消息字符串；handleUseItem 改为「locate + phase/mode 检查 → doUseItem → 有错 sendError」。AI 与真人共用同一校验（步数/金币/冻结/区域），不绕规则
- scheduleAITurn 的 setTimeout 回调里（轮到时）：
  ```
  if (room.mode === 'props') {
    if (room.coins[1] >= 5 && Math.random() < 0.3) → doUseItem(room, 1, 'burst',
        {row, col, row2, col2} = chooseTargetSimple 前两个候选（去重、未揭示、未冻结）)
      失败（金币不足等）→ 退回普通揭示
    else if (room.coins[1] >= 3 && Math.random() < 0.2) → doUseItem(room, 1, 'sonar',
        {row, col} = 随机合法 3×3 锚点，区域不含冻结格)
      失败 → 退回普通揭示
    else → tryReveal(chooseTargetSimple)
  } else {
    S/classic → chooseTargetLive（现有路径，行为不变）
    其他规格经典 → chooseTargetSimple
  }
  ```
- AI 道具决策初版只用 burst + sonar（无目标复杂推理）；不用 devour/expose/pro/毁灭菇（避免赌博与复杂选点），注释说明后续可加
- AI 是真人施放毁灭菇时的非 owner → 冻结检查恒 false，行为天然正确

### 3.4 前端放开（web + mini）
- web [client.js:1251](public/client.js#L1251) `btn-ai`：删除 props 拦截 toast，emit 带 `mode: currentMode(), boardSize: currentSpec()`
- mini [index.js:118](miniprogram/pages/index/index.js#L118) `onAITap`：删除拦截，emit 带 mode/boardSize

## 四、客户端（毁灭菇 UI，web + mini）

### 4.1 状态与渲染
- 新状态 `state.frozenCells`（web）/ `data.frozenCells`（mini）：从 itemResult(doom)、spectatorJoined、reconnected 同步
- 敌方棋盘渲染：格未揭示且坐标在冻结列表 → `❄`（textContent/text）+ `.cell-frozen` 类（冷色调）
- 冻结格**不可点击**（web onEnemyCellClick / mini onEnemyCellTap：`isFrozen(r,c)` → toast 提示「冻结中」）

### 4.2 选区交互（doom = 中心格单选）
- 点毁灭菇按钮 → 状态条「点击对方棋盘选择十字中心」
- hover 预览：中心格 clamp 到 `[1, size-2]`，预览十字 5 格（`.cell-pick-hover`）
- `pickItemCell(r, c)`：doom 分支 = 单选中心格（区别于 burst 双选 / expose 单格 / 区域型锚点）；确认按钮 emit `useItem {itemId:'doom', row, col}`
- itemResult 监听器加 doom 分支：按 cells 更新格子内容、frozen 列表更新冻结格、同步 steps/coins/headsLeft、清空选区

### 4.3 面板
- web [index.html](public/index.html) 道具面板加第 6 个按钮：`🌋 毁灭菇 <b>10</b>`；client.js ITEM_PRICES/ITEM_NAMES/ITEM_TIPS 加 doom
- mini battle.js 的 ITEM_PRICES 加 doom（items 数组自动渲染）

## 五、协议清单（无破坏性变更，全部增量）

| 事件 | 字段 |
|---|---|
| useItem | `{itemId:'doom', row, col}`（row/col = 十字中心） |
| itemResult(doom) | `{itemId, attacker, row, col, cells:[{row,col,result}], frozen:[[r,c]], steps, coins, headsLeft}` |
| spectatorJoined / reconnected | `+ frozenCells: [{row,col,owner,expiry}]`（仅未过期） |
| createRoomAI | 入参 data.mode/boardSize 生效（原来忽略） |

## 六、注释功能（纯客户端）

### 6.1 数据与存储
- 客户端状态：`marks = { 'r,c': 'head' | 'body' | 'empty' }`（web `state.marks`；mini `data.marks`）
- 持久化：web `localStorage['bp_marks_' + roomId]`；mini `wx.setStorageSync('bp_marks_' + roomId)`——按房间独立保存，刷新/重连后恢复
- 清空时机：`gameOver`（对局结束）与 `rematchStart`（再来一局，棋盘重置）清空该房间标记
- 服务器完全不知道注释存在（零协议改动）

### 6.2 交互
- web：敌人棋盘格 `contextmenu`（右键）→ `preventDefault()` 取消浏览器菜单 → 循环切换 `无 → head → body → empty → 无`；已揭示格 / 观战模式不响应
- mini：格子 `bindlongpress`（长按）循环切换（同顺序）；首次长按 toast 提示「长按标记猜测：机头红 / 机身绿 / 空灰」；已揭示格不响应

### 6.3 渲染
- 敌方棋盘渲染时：格**未揭示**且 `marks` 有值 → 加类 `cell-mark-head` / `cell-mark-body` / `cell-mark-empty`
- 样式 = 描边一圈（web `box-shadow: inset 0 0 0 3px <色>`；mini `box-shadow: inset 0 0 0 5rpx <色>`），**不改变格子背景**（中间仍是 `cell-unknown` 暗色）——与 `cell-pick`（金色选区）互不冲突，优先级低于选区高亮
- 已揭示格自然不显示（渲染条件含「未揭示」）→ 「被揭示的格子自动取消注释」自动满足
- 与冻结格叠加：冻结格未揭示 → 允许标记（注释是本地记号，不算「选中」，不受冻结限制）

## 七、已知权衡

- 毁灭菇揭示 5 格只广播 1 条 itemResult（非 5 条 revealResult）→ 客户端渲染走 itemResult 分支，协议与连射不同但更简洁
- AI 在 M/L 规格用简单贪心（无精确枚举，性能好、强度低）——符合「能用就行，后面再调整」；S/经典保留第 7 轮调校算法不变（行为零回归）
- AI 的 sonar 结果不参与其推理（随缘探测）——初版接受
- 冻结格如果正好是未揭示机头，施放者 2 回合不能打它（自我限制的代价），对手不受影响——这正是用户要的单边语义
