# 技术设计：AI 调强

## 总览

三个新模块全部放进 `ai.js`（保持 server.js 薄调度），服务器只改 `scheduleAITurn` 的分流与 `aiDeployAndConfirm` 的部署调用：

```
randomDeployment (旧，保留)  →  smartDeployment：随机 N 份 → 评分选最优
chooseTargetSimple (旧，保留) →  chooseTargetProbField：采样概率场 → 概率×信息量贪心
道具概率触发 (旧，删)          →  decideItem + chooseSonarAnchor：价值驱动
经典 S：chooseTargetLive（不变）
```

## 一、智能部署

```js
// 评分：越大越好。返回 [分数, 细节对象]
function deployScore(planes, spec) {
  // 1) 机头两两曼哈顿距离之和（拉远机头，避免一锅端）
  // 2) 机身贴边数（贴边/贴角少被人类中间优先的习惯波及）
  // 3) 机头贴边扣分（机头内缩）
  // 权重常量 DEPLOY_HEAD_SPREAD / DEPLOY_EDGE_BONUS / DEPLOY_HEAD_EDGE_PENALTY（初版固定）
}

// 随机生成 tries 份合法部署，返回评分最高的一份（用 smartDeployment）
function smartDeployment(spec, tries) // tries 默认 30，env AI_DEPLOY_TRIES 可调
```

- 对称性不做显式惩罚（评分会天然偏向不规则，且随机抽样本身打破对称）
- server.js `aiDeployAndConfirm`：`ai.randomDeployment(room.boardSize)` → `ai.smartDeployment(room.boardSize)`
- 经典 S 与所有规格统一生效

## 二、采样概率场（核心模块）

```js
// 一致性过滤：候选部署与已揭示信息矛盾即弃。返回每格 P(机头)/P(机身)
// opts: { samples: 采样份数（默认 AI_SAMPLES=120）, sonarCounts: 我方声呐计数列表 }
function buildProbField(shotsReceived, size, opts)

// 概率场选格：候选 = 未揭示、未被自己冻结的格；打分 = P(head)*W + P(body) + 熵项；
// 取前 K 名候选（沿用 HEAD_SET_K=4）→ 邻近多架机身优先 → 返回 [row, col]
function chooseTargetProbField(shotsReceived, size, frozenCells, opts)
```

### 一致性校验规则（采样部署 vs 已揭示信息）

| 信息 | 用法 |
|---|---|
| 空格（reveal 空） | 该格采样不得有飞机 → 弃 |
| 机身（reveal body） | 该格采样必须有机身（且非机头？机身格可以是某架的机身——不允许是机头） |
| 机头（reveal head） | 该格采样必须是某架机头 |
| 声呐计数（我方放的，探测对方棋盘） | 3×3 区域内采样非空格数必须等于 count → 弃 |
| 冻结格（owner=我） | 不约束内容，只从候选格排除 |
| 吞噬摧毁格 | 内容未知、无约束（初版：摧毁格不进候选） |
| 对方声呐（探测我的棋盘） | 我自己的布局已知，无约束价值，忽略 |

### 采样流程（候选池方案，⚠️ 不用「随机部署 + 全局过滤」的拒绝采样）

拒绝采样在 M/L 晚局会崩：已揭示空格 t 个时，随机部署命中的概率 ≈ (1−覆盖密度)^t，
15 步后就低于 1%，一步要等几秒。候选池方案把「空格约束」提前消化：

1. **候选池**：枚举所有不越界摆放（4 朝向 × (size−4)² 机头位），丢弃「10 格中任一格落在已揭示空格」的候选——空格约束自动满足
2. **组合**：Fisher–Yates 洗牌候选池 → 贪心取 planeCount 个互不重叠的候选 → 查机身/机头揭示约束 + 声呐计数约束 → 通过则记一份
3. 重复直到 samples 份（默认 120）或 20000 次尝试；不足下限 10 份；0 份 → 返回 alive=0 由调用方兜底（回退 chooseTargetSimple）
4. 统计每格机头/机身出现频率 → 概率场
5. 性能预算：早局池大命中率≈1（几十次尝试）；晚局池小每次尝试更便宜（几毫秒）；在 AI_THINK 延迟内完成

## 三、道具价值决策

### 声呐锚点选择

```js
// 枚举所有合法锚点（3×3 完整落盘、且 3×3 不覆盖自己冻结格）；
// 对每个锚点，从采样部署统计 3×3 非空格数的分布（9 桶）；
// 返回分布熵最大（= 期望信息增益最大）的锚点
function chooseSonarAnchor(shotsReceived, size, frozenCells, probField)
```

复杂度：~100 锚点 × 120 份采样 = 12,000 次 3×3 计数，毫秒级。

### 道具决策表（scheduleAITurn 内实现，调用上述函数）

| 道具 | 触发条件（依次判断，每步最多用一个道具） | 落点 |
|---|---|---|
| 无所遁形 | coins ≥ 5 且存在已揭示机头（未使用过） | 该机头格 |
| 毁灭菇 | coins ≥ 10 且未揭示格 ≤ 总格数×0.3（残局） | 3×3 概率和最大的十字中心（clamp [1,size-2]） |
| 双发 | coins ≥ 5 且概率场 top2 格分数都 ≥ 峰值×0.5 | top2 格（第二格 excludeKey） |
| 声呐 | coins ≥ 3 且锚点分布熵 ≥ 阈值（信息价值足够） | chooseSonarAnchor |
| 探测者 | 金币富余（coins ≥ 8）且概率峰值高 | 概率场最高格 |
| 吞噬者 | 永不用 | — |

- 顺序即优先级；都不满足 → 普通揭示（走选格）
- 道具行动失败（doUseItem 返回 false）→ 回退普通揭示（沿用现有 `acted = !doUseItem(...)` 模式）
- 冻结感知：所有落点/区域排除自己冻结格（复用现有 isFrozenCell 语义）

### 顺带修复：冻结 owner 过滤

现状 `chooseTargetSimple(shots, size, r.frozenCells)` 把对手施放的冻结也当禁区（对手的冻结只约束对手自己，不约束 AI）。修复：传给选格/道具前按 `f.owner === seat` 过滤（AI 只避开自己施放的冻结）。

## 四、server.js 改造

```js
// scheduleAITurn 内（替换现有 useSimple 一行）：
const useLive = (r.mode === 'classic' && r.boardSize === 'S'); // 经典 S 永远走熵贪心
target1 = useLive ? ai.chooseTargetLive(shots)
        : ai.chooseTargetProbField(shots, size, myFrozen, { samples: aiSamples });
// 道具决策：useLive 分支不参与（经典无道具）；否则跑决策表
// 开关：AI_PROB_FIELD=0 → 回退 chooseTargetSimple（现状）；AI_SAMPLES 调采样数
```

## 五、自对弈验证（新增 test/ai-selfplay-test.js）

不连服务器、不 spawn 进程：测试内自建两个 AI 的 `shotsReceived` + 一个随机合法棋盘 + 按服务器规则结算揭示，直接 require `ai.js` 跑完整对局。

| 对照实验 | 变量 | 断言 |
|---|---|---|
| 部署 | 同选格算法 × 智能部署 vs 随机部署（S，各 60 局） | 智能部署方「被命中步数」均值更大（更难打） |
| 选格 | M 棋盘 × 概率场 vs 简单贪心（各 50 局） | 概率场平均步数 ≤ 简单贪心 |
| 声呐 | M 棋盘 × 信息增益锚点 vs 随机锚点（各 30 局，只比「用声呐的回合」后的步数） | 增益版更短 |

- 自对弈内采样数降到 AI_SAMPLES=30，控制耗时（单文件 ≤ 30s）
- 统计断言用宽松阈值（防 flaky：只断言「不劣于」+ 报告均值）

## 六、开关与环境变量（汇总）

| 变量 | 默认 | 作用 |
|---|---|---|
| AI_PROB_FIELD | 1 | 0 = M/L+道具回退 chooseTargetSimple |
| AI_SAMPLES | 120 | 采样份数 |
| AI_DEPLOY_TRIES | 30 | 部署候选份数 |
| AI_HS_W / AI_HS_K 等 | 不变 | 经典 S 熵贪心参数不动 |
