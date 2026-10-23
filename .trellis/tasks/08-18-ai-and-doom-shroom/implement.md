# 执行计划：AI 适配 + 毁灭菇

实施顺序：先服务器（冻结模型 → 毁灭菇 → AI），再客户端，再测试，最后回归部署。每步结束 `node --check` 语法检查 + 手动测试服务器跑相关测试。

## Step 1：服务器冻结模型（server.js）

- [ ] `createRoom()` 加 `frozenCells: []`
- [ ] `resetToDeploy()` 加 `room.frozenCells = [];`
- [ ] 新增 `isFrozenCell(room, seat, row, col)` / `hasFrozenCell(room, seat, cells)` / `activeFrozenCells(room)` 三个辅助函数（注释中文，语义 = 只约束施放者）
- [ ] `handleReveal` 校验链加冻结检查（错误文案「这个格子被毁灭菇冻结，你还不能揭示它」）
- [ ] `tryReveal` 开头防御性 `if (isFrozenCell(...)) return false;`
- [ ] 观战/重连快照（spectatorJoined、reconnected）加 `frozenCells: activeFrozenCells(room)`

验证：`node --check server.js`；现有测试全绿（冻结未启用时不改变行为）

## Step 2：毁灭菇道具（server.js）

- [ ] `ITEM_PRICES` 加 `doom: 10`（ITEM_PRICES 位置：handleUseItem 之前）
- [ ] 辅助函数 `crossCells(row, col)`（十字 5 格）、`neighbor8(row, col, size)`（8 邻域、边界裁剪）
- [ ] `revealCell(room, seat, r, c)`：记录 + 金币结算（无步数），供 doom 复用
- [ ] `finishItem` 尾部（广播 + 判胜 + AI 调度）抽为 `finishItemTail(room, seat, itemId, payload)`
- [ ] `handleUseItem` 加 `doom` 分支（校验顺序：价格→步数→金币→十字落盘→冻结→执行）；sonar/pro/devour 分支加 `hasFrozenCell` 检查；burst 两格加 `isFrozenCell`；expose 注释说明无需检查
- [ ] 客户端白名单同步（见 Step 4）

验证：`node --check server.js` + 新增 `test/doom-item-test.js`（见 Step 6）

## Step 3：AI 适配（ai.js + server.js）

- [ ] ai.js `randomDeployment(spec)`：加可选 spec 参数（默认 'S' 行为不变）
- [ ] ai.js 新增 `chooseTargetSimple(shotsReceived, size, frozenCells)`（简单启发式：顺藤摸瓜 → 随机；避开冻结格；候选空返回 null）
- [ ] ai.js 导出 `randomDeployment`、`chooseTargetSimple`
- [ ] server.js `createRoomAI`：改用 `parseMode(data)`，roomCreated 回显真实 mode/boardSize，删除硬编码注释
- [ ] server.js 抽 `doUseItem(room, seat, itemId, data)`（校验+执行主体，无 socket；handleUseItem 调用它并 sendError）
- [ ] server.js `scheduleAITurn`：按 mode 分流——classic/S 走 `chooseTargetLive`（原路径）；其余组合走 `chooseTargetSimple`；props 模式加道具决策（burst 30% @≥5 金币、sonar 20% @≥3 金币，失败退回揭示）
- [ ] `aiDeployAndConfirm` 改传 spec（`ai.randomDeployment(room.boardSize)`）

验证：`node --check ai.js server.js`；AI 组合冒烟测试（Step 6）

## Step 4：客户端（web）

- [ ] client.js：`ITEM_PRICES/ITEM_NAMES/ITEM_TIPS` 加 doom
- [ ] client.js：`state.frozenCells` + itemResult(doom) 分支（cells 更新格子、frozen 更新冻结、同步 steps/coins/headsLeft、清选区）+ spectatorJoined/reconnected 同步
- [ ] client.js：敌方棋盘渲染冻结格（❄ + `.cell-frozen`）；`onEnemyCellClick` 冻结格拦截提示
- [ ] client.js：`pickItemCell` doom 分支（中心格单选 clamp [1,size-2]、十字预览、确认 emit）
- [ ] client.js：`btn-ai` 删除 props 拦截，emit 带 mode/boardSize
- [ ] index.html：道具面板加 `<button class="item-btn" data-item="doom">🌋 毁灭菇<b>10</b></button>`
- [ ] style.css：`.cell-frozen` 样式

验证：`node --check public/client.js`；浏览器手测（可选，测试覆盖为主）

## Step 5：客户端（mini）

- [ ] app.js：`frozenCells` 状态 + itemResult doom 分支 + 快照同步 + 敌方棋盘 ❄ 渲染（`cell-frozen` 类）
- [ ] app.wxss：`.cell-frozen` 样式
- [ ] battle.js：ITEM_PRICES 加 doom、`pickItemCell` doom 分支、冻结格点击拦截、items 数组自动含 doom
- [ ] battle.wxml：无需改（items 渲染循环自动出第 6 个按钮）
- [ ] index.js：`onAITap` 删除拦截，emit 带 mode/boardSize

验证：所有改动文件 `node --check`

## Step 6：测试

- [ ] 更新 props-smoke-test.js 第三节：人机房间改为「支持 props/L」（回显检查 `mode==='props' && boardSize==='L'`）
- [ ] 新增 `test/doom-item-test.js`（连接手动服务器，pre-register 模式）：
  - 价格：金币 8 买不起（被拒）；揭示 2 格凑 10 金币后买成功
  - 十字揭示 5 格正确（内容 / 金币结算 / steps+1）
  - 冻结生成：8 邻域未揭示格入 frozen（itemResult 带 frozen 数组）
  - 施放者 2 回合不能揭示冻结格（被拒）；第 3 回合解除
  - 冻结格不能被 sonar/burst 选中（被拒）
  - 对手不受冻结影响（对手可正常行动）
  - 越界十字（中心在边缘）被拒
  - 机头命中：5 格含机头 → headsLeft 变化 + 判胜路径
  - 重连/观战带 frozenCells（可选简化：断言 itemResult 即可）
- [ ] 新增 `test/ai-combo-test.js`：
  - 6 种组合 × 创建 → battleStart（mode/boardSize 回显正确）
  - props/M：真人揭示几格后 AI 自动走一步（等待 revealResult attacker=1，限时 5s）；若 AI 用道具则收到 itemResult attacker=1
  - 经典/S：AI 行为不变（attacker=1 正常走棋）
- [ ] 经典回归：`node test/e2e-test.js`（100 条）+ `node test/mini-logic-test.js`（30 条）全绿
- [ ] 道具回归：props-items-test（24）+ props-smoke-test（更新后）+ doom + ai-combo 全绿

## Step 7：注释功能（web + mini，纯客户端）

- [ ] web client.js：`state.marks` + 本地存储读写（按房间）+ `contextmenu` 循环切换 + 渲染三色描边类
- [ ] web style.css：`.cell-mark-head/body/empty` 描边样式（inset box-shadow，不覆盖背景）
- [ ] web：gameOver/rematchStart 清空 marks；观战模式禁用
- [ ] mini battle.js：`marks` 数据 + 本地存储 + `bindlongpress` 循环切换 + 渲染类
- [ ] mini app.wxss：`.cell-mark-*` 描边样式
- [ ] mini battle.wxml：enemy board-cell 加 `bindlongpress="onCellMark"` + 动态类

验证：`node --check`；浏览器手测右键循环 + 刷新恢复 + mini 手测长按

## Step 8：部署

- [ ] 提交推送（用户确认后）；Render 自动部署
- [ ] 线上快速手测：人机 + 道具/L + 毁灭菇流程

## 回滚点

- Step 1/2 完成后即回归（冻结与毁灭菇是纯增量，经典路径不受影响）
- 若 AI 道具决策影响稳定性：删 scheduleAITurn 的 props 分支即退回纯揭示 AI
- 每次提交一个逻辑块，便于定位
