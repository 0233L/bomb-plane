# 执行计划：AI 调强

实施顺序：部署 → 概率场 → 道具决策 → 回归部署。每步结束 `node --check` + 相关测试。

## Step A：智能部署（ai.js + server.js）

- [x] ai.js 新增 `deployScore(planes, spec)`（机头间距 + 贴边奖励 + 机头贴边惩罚，中文注释）
- [x] ai.js 新增 `smartDeployment(spec, tries)`（随机 tries 份合法部署 → 评分最高；tries 默认 30，env AI_DEPLOY_TRIES 覆盖）
- [x] ai.js 导出 `smartDeployment`
- [x] server.js `aiDeployAndConfirm`：`ai.randomDeployment(room.boardSize)` → `ai.smartDeployment(room.boardSize)`
- [x] 新增 test/ai-selfplay-test.js 的「部署对照实验」：智能部署 vs 随机部署（S，60 局，断言被命中步数不劣于随机）

验证：`node --check ai.js server.js` + `node test/ai-selfplay-test.js` + 现有 ai-combo 全绿

## Step B：采样概率场选格（ai.js + server.js）

- [x] ai.js 新增 `buildProbField(shotsReceived, size, opts)`（一致性过滤表见 design；采样失败兜底 ≥10 份；AI_SAMPLES 默认 120）
- [x] ai.js 新增 `chooseTargetProbField(shotsReceived, size, frozenCells, opts)`（概率×信息量打分，K=4 候选）
- [x] ai.js 导出两者
- [x] server.js `scheduleAITurn`：`useSimple` 一行改为分流——classic/S → chooseTargetLive；其余 → `AI_PROB_FIELD !== '0'` ? chooseTargetProbField : chooseTargetSimple
- [x] 自对弈「选格对照实验」：M 棋盘概率场 vs 简单贪心（50 局）

验证：`node --check` + 自对弈 + ai-combo（6 组合冒烟，确认道具模式 AI 仍能自动走棋）

## Step C：道具价值决策（ai.js + server.js）

- [x] ai.js 新增 `chooseSonarAnchor(shotsReceived, size, frozenCells, probField)`（锚点枚举 + 分布熵最大）
- [x] server.js `scheduleAITurn` 道具触发改为决策表（无所遁形即用 → 毁灭菇残局 → 双发 → 声呐 → 探测者；吞噬不用；失败回退揭示）
- [x] 冻结 owner 过滤修复：传给选格/道具的冻结列表按 `f.owner === seat` 过滤（顺带修现状：对手冻结误伤 AI 的 bug）
- [x] 自对弈「声呐对照实验」：信息增益锚点 vs 随机锚点（30 局）

验证：`node --check` + 自对弈三组全过 + ai-combo 全绿

## Step D：回归 + 部署

- [x] 全量本地回归 11 项（e2e 100 / mini-logic 30 / props-items 24 / doom-item 21 / ai-combo 24 / home-ui 54 / mini-logic 30 / props-smoke 11 / frozen-rejoin 3 / double-tap-confirm 23 / sonar-render 15 / slider-layout）
- [x] online-smoke + github-sync 冒烟
- [x] 自对弈统计结果整理进提交说明
- [x] 提交推送（用户已授权自动上线）；Render 自动部署

## 回滚点

- Step A 单独可回滚：`aiDeployAndConfirm` 换回 randomDeployment 一行
- Step B 可回滚：`AI_PROB_FIELD=0` 即回退 chooseTargetSimple（不动代码）
- Step C 可回滚：删 decision 表前两行即退回概率触发（或整体 AI_PROB_FIELD=0）
- 每次提交一个逻辑块
