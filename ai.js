// ============================================
// ai.js —— 人机对战的 AI 决策模块（服务器端）
//
// 算法：精确枚举 + 打分选格（一步贪心，实战在用）
//   服务器启动时一次性枚举出「3 架飞机互不重叠」的全部合法部署
//   （单架摆放 168 种 → 三架组合 66,816 种，枚举 + 建索引共约 100ms）。
//   每走一步时：
//     1. 筛掉与已揭示格子颜色矛盾的组合（空/机身/机头都要对得上）
//     2. 统计每个未知格在所有"仍然可能的部署"中：
//        headCount = 是机头的组合数
//        bodyCount = 是机身的组合数
//     3. 每个未知格算一个分数，打分数最高的格子。实战默认公式是
//        「机头组熵贪心」（第 7 轮引入，函数 chooseTargetHeadSet）：
//
//          分数 = 机头概率 + w × ΔH头组
//            机头概率 = head / alive
//            ΔH头组 = H(当前"机头三元组"分布) − Σ_o p_o·H(结果 o 桶内的机头组分布)
//
//   〖机头组熵是什么意思〗胜负只取决于机头在哪——排除 1000 个机身摆法
//   不同、但机头位置相同的组合，对获胜毫无帮助。所以信息量要对着
//   "机头三元组"（3 个机头分别在哪些格，打包成一个 id）的分布量，
//   而不是对着整套机身布局量——旧的 1−Σp² 把两种信息混在一起，
//   这正是它的盲区。灵感来自 Wordle 求解器文献（见下）。
//
//   旧公式（chooseTargetGreedy，仍作候选预排和兜底用）：
//
//          分数 = 机头概率 + INFO_WEIGHT × 信息量
//            信息量 = 打这格后期望排除的组合比例
//                   = 1 - (head² + body² + empty²) / alive²
//
//   〖信息量是什么意思〗打这格可能得到 空/机身/机头 三种结果，每种结果的
//   概率是 (empty|body|head)/alive，得到该结果后剩下的组合数是
//   (empty|body|head) 本身。加权平均就是"打完后还剩下多少组合"，
//   用 1 减掉它就得到"能排除多少"——越大越能缩小包围圈。
//
//   权重调校史（自对弈模拟，公共随机数配对）：
//   第 1 轮（200 盘粗扫）：w=0（纯追头）20.97 步、w=1 约 18.70 步（最优）、
//     w=1000（纯信息）20.00 步 → 信息量加一点最好，加太多反而拖慢。
//   第 2 轮（1500 盘加密扫 0.6~2.0）：w=1.3 平均 18.91 步最优，1.1~1.8 是平台区。
//   第 3 轮（4000 盘验证前 4 名）：w=1.3 再次最优（18.98 步）。
//   第 5 轮（8000 盘精细扫 1.2~1.4，步长 0.025，公共随机数配对）：
//     1.25~1.4 是平台区（与 1.3 的配对差 −0.018~+0.020 步，SE 仅 ±0.005~0.017），
//     w=1.2 显著更差（+0.038±0.017）→ 旧公式固定权重已收敛。
//   第 6 轮（6000 盘配对，"自适应权重"实验）：按剩余方案数 alive 让权重
//     随对数斜坡 wHi→wLo 变化（开局重信息、残局重机头的直觉方案），以及
//     按剩余机头数分段的变体，共 10 组 vs 固定 1.3——全部不优于基准
//     （+0.007~+0.236 步），且残局权重降得越低越差。原因：残局方案数少时
//     机头概率并列很常见，信息量项正好打破并列、选"打空了也最能缩小包围圈"
//     的格子——残局同样需要信息量。
//   第 7 轮（Wordle/Mastermind 求解器文献对照实验，三组独立种子共 3.5 万盘）
//     - 香农熵贪心（信息项换成香农熵 H(p空,p身,p头)）：w=1.0 时
//       −0.109±0.040 步（6000 盘，勉强过线），w≥1.3 变差 → 不采用；
//     - Knuth minimax（最小化最坏情况剩余方案数）：+1.1~1.4 步，明显更差；
//     - 探测优先硬切换（开局先打纯信息格直到首次命中）：打平（±0.003 步）；
//     - 贪心 1.3 + 香农熵并列打破：打平（+0.003±0.003 步）；
//     - 机头组熵贪心【采纳】：Wordle 最优解（Olson 3.421 步）"对答案本身
//       取熵"的映射。三组种子（1000/1000/1500 盘）w∈{0.5,0.7,1.0} 配对差
//       −0.26~−0.70 步、全部 ≥2.4σ——七轮里第一个真实提升。w=0.7 加权
//       平均 −0.448 步（w=0.5 是 −0.387、w=1.0 是 −0.406，三者在一个平台
//       区内，取平均最优的 0.7）；w=1.3 无效果（−0.016±0.109）。候选数 K
//       扫 {2,4,8}：K=4 与 K=8 打平（K=2 明显差），取 4 更快。
//   理论分析（500 盘逐枪实测熵，信息论视角）："11 枪下界"假设每枪 3 种结果
//     等概率（1.585 比特/枪），实际开局最优一枪也只有 1.289 比特（结果严重
//     不均：空/身/头 ≈ 60%/35%/5%）；且获胜 ≠ 识别布局——贪心获胜时平均
//     还剩 56 种方案未排除（差 2.35 比特），仅 21% 的局在获胜前完全识别。
//     贪心每枪熵 1.285 vs 全局最大 1.339（≈96% 效率），每枪机头概率 0.197
//     （比纯追头的 0.184 还高——先缩圈、机头概率才"变浓"）。三策略夹逼估计
//     理论最优在 18~19 步，贪心差距约 0.2~0.5 步。
//   结论：实战默认机头组熵 w=0.7（AI_HS_W/AI_HS_K 可覆盖）；旧公式
//   权重取 1.3 留作候选预排与兜底。
//
// 为什么这样就能变聪明：
//   - 打中机身后，机头方向上的格子概率自动升高 → AI 自然"顺藤摸瓜"
//   - 所有摆不下的部署组合被自动排除 → 不需要手写任何战术规则
//   - 概率是精确值（不是随机采样的近似）
//
// ============================================
// 一步前瞻实验（未采用，代码保留备用）
//
//   曾尝试给贪心加"一步前瞻"（下棋看两步：打这格之后下一枪还能打得好）。
//   共实现 4 种变体，用 300 盘自对弈与贪心配对对比（同一批部署各打一遍）：
//
//     变体                               平均步数   vs 贪心(18.72)
//     贪心（基准）                       18.72      —
//     前瞻打分版·三种结果全算            32.88      +13.3 步 ✗
//     前瞻打分版·只算头/身命中           22.28      +3.6 步 ✗
//     前瞻步数版（按"还需几枪"估计）     30.19      +11.5 步 ✗
//     混合版（本枪分 − 0.05×剩余步数）   19.72      +1.0 步 ✗
//
//   失败原因（都在模拟里定位到了）：
//   - "打空"分支的前瞻值对所有候选格几乎一样，只起稀释排序的作用，
//     还会在残局让全部分数并列、随机乱打（单盘最多多花 80+ 步）；
//   - "命中机身"分支会高估打机身格的价值——AI 宁可沿着机身一格格走
//     到最后，也不直接打概率更高的机头格；
//   - 步数版高估了"剩下几个机头"的代价，机身格走得更过分。
//   结论：权重 1.3 经过三轮调校后就是局部最优，简单两步扩展都会破坏它。
//   相关代码保留在 chooseTarget（打分版）、chooseTargetShots（步数版）、
//   chooseTargetBlend（混合版）里，供未来实验参考——若想再试，建议
//   先解决"前瞻值如何与调校好的本枪分共用一套刻度"这个根本问题。
//
//   性能备注：前瞻版每步要多花 50~150ms（预计算索引约 7.7MB），
//   这本身不是问题，问题只是它没有更准。若未来启用前瞻版，注意
//   首枪最坏约 1s，仍需藏在 AI 的随机思考延迟里。
// ============================================
// Rollout 一步前瞻（第二轮方案，AI_ROLLOUT=1 开启，默认关）
//
//   思路来自机器学习文献：Bertsekas Rollout 算法（用基础策略从后继状态
//   模拟到终局的真实代价代替价值函数，有"不差于基础策略"的数学保证）
//   + POMCP 粒子信念（Silver & Veness 2010, NIPS；POMCP 论文的测试域
//   恰好包含 10×10 战舰，与本游戏同族）。
//
//   打分不再是"下一枪能拿多少分"，而是直接估计
//   「打 x 之后按贪心打完一整局还要几步」的真实步数：
//
//     V(x) = 1 + Σ_{o∈{空,身,头}} p_o × R(A_o)          ← 越小越好
//       p_o   = 该格得到结果 o 的精确概率（= n_o / alive，无抽样误差）
//       A_o   = 存活组合中「x 处结果 = o」的子集
//       R(A_o)= 从 A_o 出发按贪心打到底的期望剩余步数（蒙特卡洛估计）
//
//   R 的估计：从 A_o 采 ≤P 个组合当「粒子池」，每步在池上按与实战完全
//   相同的贪心公式选格 → 对真相（从池里抽）揭示 → 筛掉矛盾的粒子，
//   直到 3 个机头全中记步数；每分支独立采 M 次取平均。
//   与上一轮失败的前瞻相比：价值单位就是真实步数（无度量不一致），
//   残局"分数并列该打谁"由模拟自然涌现——上一轮的两个病根都不存在。
//
//   第 4 轮模拟实测（500 盘配对，同一批部署两算法各打一遍）：
//     配置                                 平均步数   vs 贪心(18.94)
//     K=8  P=300 M=4 （默认）               19.53      +0.60 步 ✗
//     K=4  P=300 M=8                        19.25      +0.32 步 ✗
//     K=2  P=300 M=16                       19.14      +0.21 步 ✗
//     K=8  P=300 M=4  竞速两阶段            19.91      +0.97 步 ✗
//     K=8  P=600 M=4                        19.57      +0.64 步 ✗
//     K=16 P=300 M=4                        21.26      +2.33 步 ✗
//     K=2  P=300 M=64                       18.94      +0.01 步 ✗（≈持平）
//   结论：rollout 未优于贪心，保持贪心为实战算法（AI_ROLLOUT=1 可手动开启）。
//   原因分析：候选格之间真实的期望步数差只有 0.1~0.5 步，而每步的时间预算
//   （数百 ms）只够把蒙特卡洛噪声压到 ±0.5~1 步——噪声淹没了真实差异，
//   rollout 的选择 ≈ 在几乎等价的格子里掷硬币（K=16 输得更惨正是噪声证据：
//   候选越多越容易选到"靠运气分数好看"的格子；K=2/M=64 把噪声压小后
//   收敛到与贪心持平，说明顶端候选格确实没有真实差异可挖）。文献的
//   "不差于贪心"保证需要精确估值，实际做不到。与上一轮结论一致：
//   一步贪心（w=1.3）就是当前时间预算下的局部最优。代码保留，供未来参考。
// ============================================
'use strict';

const shared = require('./public/shared.js');
const { BOARD_SIZE, PLANE_COUNT, getPlaneCells, canPlacePlane, buildBoard, CELL_EMPTY, CELL_BODY, CELL_HEAD } = shared;

// 机头概率与信息量的平衡权重（自对弈模拟实测最优值，见上方注释）
const INFO_WEIGHT = 1.3;

// ---------- 预计算（模块加载时执行一次，约 55ms） ----------

// 全部单架飞机的合法摆放（4 个朝向 × 全棋盘），共 168 种
const PLACEMENTS = buildPlacementTable();

// 每架的 10 个格子编码：格子号 pos*4 + 类型（0 = 机头，1 = 机身）
const CELLS_OF = PLACEMENTS.map(function (p) {
  return getPlaneCells(p.headRow, p.headCol, p.dir).map(function (cell, i) {
    return (cell[0] * BOARD_SIZE + cell[1]) * 4 + (i === 0 ? 0 : 1);
  });
});

// 全部合法三架组合（互不重叠），共 66,816 种。
// 存成 Int16Array：每 3 个数是一组（三个 PLACEMENTS 下标）
const COMBOS = enumerateCombos();

function buildPlacementTable() {
  const table = [];
  const dirs = ['up', 'right', 'down', 'left'];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      dirs.forEach(function (dir) {
        if (canPlacePlane([], r, c, dir)) {
          table.push({ headRow: r, headCol: c, dir: dir });
        }
      });
    }
  }
  return table;
}

// 枚举全部 3 架互不重叠的组合：先建"两架相容"表，再组合出三架
function enumerateCombos() {
  const n = PLACEMENTS.length;
  // 每架的占用格子集合（下标化），两架相容检查用
  const cellSets = PLACEMENTS.map(function (p) {
    return new Set(getPlaneCells(p.headRow, p.headCol, p.dir)
      .map(function (cell) { return cell[0] * BOARD_SIZE + cell[1]; }));
  });
  // compat[i] = 和 i 号摆放不重叠的所有摆放下标
  const compat = [];
  for (let i = 0; i < n; i++) {
    const list = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let overlap = false;
      cellSets[j].forEach(function (pos) {
        if (cellSets[i].has(pos)) overlap = true;
      });
      if (!overlap) list.push(j);
    }
    compat.push(list);
  }
  // 三架组合：i < j < k 且两两相容
  const combos = [];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < compat[i].length; a++) {
      const j = compat[i][a];
      if (j <= i) continue;
      for (let b = 0; b < compat[j].length; b++) {
        const k = compat[j][b];
        if (k <= j) continue;
        if (compat[i].indexOf(k) !== -1) combos.push(i, j, k);
      }
    }
  }
  return Int16Array.from(combos);
}

// ---------- 预计算 2：每格的"机头/机身组合下标表"（一步前瞻用，约 40ms） ----------

// 每架摆放的机头格子号、9 个机身格子号（预先解码，前瞻内层循环直接用格子号）
const HEAD_POS = new Int16Array(PLACEMENTS.length);
const BODY_CELLS = CELLS_OF.map(function (cells) {
  const body = new Int16Array(cells.length - 1);
  for (let k = 1; k < cells.length; k++) body[k - 1] = cells[k] >> 2;
  return body;
});
for (let p = 0; p < PLACEMENTS.length; p++) HEAD_POS[p] = CELLS_OF[p][0] >> 2;

// 每个组合的「机头三元组」打包 id（3 个机头位置排序后各占 7 位拼成，≤2²¹ 装进 Int32）。
// 分析用（机头组熵实验）：胜负只取决于机头在哪——机头位置相同的组合是同一个"获胜假设"。
const HEAD_SET_IDS = new Int32Array(COMBOS.length / 3);
for (let c = 0; c < HEAD_SET_IDS.length; c++) {
  const base = c * 3;
  let a = HEAD_POS[COMBOS[base]];
  let b = HEAD_POS[COMBOS[base + 1]];
  let cc = HEAD_POS[COMBOS[base + 2]];
  if (a > b) { const t = a; a = b; b = t; }
  if (b > cc) { const t = b; b = cc; cc = t; }
  if (a > b) { const t = a; a = b; b = t; }
  HEAD_SET_IDS[c] = a | (b << 7) | (cc << 14);
}

// POS_INDEX.heads[pos] = 以 pos 为机头的组合下标列表（平均约 2000 个）
// POS_INDEX.bodies[pos] = 以 pos 为机身的组合下标列表（平均约 18000 个）
// 组合下标 comboIdx = COMBOS 里的位置 ÷ 3（0 ~ 66815），与 ALIVE_MAP 下标一致。
// 两遍扫描构建（先数每格有多少个组合，再第二遍填），总规模约 200 万 int ≈ 7.7MB
function buildPosIndex() {
  const n = COMBOS.length / 3;
  const headCount = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  const bodyCount = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  for (let c = 0; c < n; c++) {
    const base = c * 3;
    for (let pi = 0; pi < 3; pi++) {
      const p = COMBOS[base + pi];
      headCount[HEAD_POS[p]]++;
      for (let k = 0; k < BODY_CELLS[p].length; k++) bodyCount[BODY_CELLS[p][k]]++;
    }
  }
  const heads = [];
  const bodies = [];
  const headFill = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  const bodyFill = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  for (let pos = 0; pos < BOARD_SIZE * BOARD_SIZE; pos++) {
    heads.push(new Int32Array(headCount[pos]));
    bodies.push(new Int32Array(bodyCount[pos]));
  }
  for (let c = 0; c < n; c++) {
    const base = c * 3;
    for (let pi = 0; pi < 3; pi++) {
      const p = COMBOS[base + pi];
      heads[HEAD_POS[p]][headFill[HEAD_POS[p]]++] = c;
      for (let k = 0; k < BODY_CELLS[p].length; k++) {
        const pos = BODY_CELLS[p][k];
        bodies[pos][bodyFill[pos]++] = c;
      }
    }
  }
  return { heads: heads, bodies: bodies };
}
const POS_INDEX = buildPosIndex();

// ---------- 部署生成（AI 自己布置飞机用） ----------

// 随机生成一份合法部署。spec = 'S'|'M'|'L'（默认 S，与旧行为一致）：
// 全棋盘随机位置 + 摆放校验，对任意规格都成立（旧版只从 10×10 摆放表抽样，功能等价）
function randomDeployment(spec) {
  const sp = shared.getBoardSpec(spec);
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < sp.planeCount; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * sp.size);
    const headCol = Math.floor(Math.random() * sp.size);
    const occupied = [];
    planes.forEach(function (q) {
      getPlaneCells(q.headRow, q.headCol, q.dir).forEach(function (cell) { occupied.push(cell); });
    });
    if (shared.canPlacePlane(occupied, headRow, headCol, dir, spec)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes.length === sp.planeCount ? planes : null;
}

// ---------- 部署策略（AI 加强第 1 步：不再纯随机摆） ----------

// 给一份合法部署打分（越大越好）。评分项：
//   1) 机头两两拉远：机头是决胜点（找到机头才减分），离得越远越难被一锅端
//   2) 机身远离边缘：边缘的机身格被命中时，机头位置会被迅速钉死
//      （边线格能配的机头位置很少），对会推理的对手是送分——自对弈实测
//      「机身贴边 +2 分」让熵贪心 AI 快了 1.23 步，改成远离边缘才变难打
//   3) 机头贴边扣分：同上，机头暴露在边线上容易被顺边扫描发现，尽量内缩
// 权重是经验常数（DEPLOY_*），先固定，后续可再调
const DEPLOY_HEAD_SPREAD = 1.0; // 每单位机头间距的得分
const DEPLOY_EDGE_PENALTY = 3.0; // 每个贴边机身格的扣分（远离边缘 = 制造歧义）
const DEPLOY_HEAD_EDGE = 8.0;   // 每个贴边机头格的扣分

function deployScore(planes, spec) {
  const size = shared.getBoardSpec(spec).size;
  const onEdge = function (r, c) {
    return r === 0 || r === size - 1 || c === 0 || c === size - 1;
  };
  // 机头两两曼哈顿距离之和
  let headSpread = 0;
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      headSpread += Math.abs(planes[i].headRow - planes[j].headRow)
        + Math.abs(planes[i].headCol - planes[j].headCol);
    }
  }
  // 贴边机身格数 / 贴边机头格数
  let edgeBodies = 0;
  let edgeHeads = 0;
  planes.forEach(function (p) {
    if (onEdge(p.headRow, p.headCol)) edgeHeads++;
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell, i) {
      if (i !== 0 && onEdge(cell[0], cell[1])) edgeBodies++; // 第 0 格是机头，其余 9 格是机身
    });
  });
  return headSpread * DEPLOY_HEAD_SPREAD
    - edgeBodies * DEPLOY_EDGE_PENALTY
    - edgeHeads * DEPLOY_HEAD_EDGE;
}

// 智能部署：随机生成 tries 份合法部署，返回评分最高的一份。
// tries 默认 30，env AI_DEPLOY_TRIES 可调；极端情况下全部生成失败则退回随机部署
function smartDeployment(spec, tries) {
  const count = tries || 30;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < count; i++) {
    const planes = randomDeployment(spec);
    if (!planes) continue;
    const score = deployScore(planes, spec);
    if (score > bestScore) { bestScore = score; best = planes; }
  }
  return best || randomDeployment(spec);
}

// ---------- 采样概率场（AI 加强第 2 步：M/L 经典 + 全部道具模式的选格大脑） ----------

// size → 规格名反查（shared.js 只有 规格名 → 尺寸 的映射）
const SPEC_BY_SIZE = { 10: 'S', 12: 'M', 14: 'L' };

// 把已揭示记录压成查表（下标 = 格子号；0=未知 1=空 2=机身 3=机头）。
// 旧 buildShotTable 只支持 10×10，这个是任意规格通用版
function buildShotTableAny(shotsReceived, size) {
  const t = new Uint8Array(size * size);
  shotsReceived.forEach(function (s) {
    t[s.row * size + s.col] = s.result === 'head' ? 3 : s.result === 'body' ? 2 : 1;
  });
  return t;
}

// 一组随机选出的飞机是否与「机身/机头揭示 + 声呐计数」一致
// （空格约束已被候选池消化，这里不用再查）
// 声呐检查用「未知格形式」：区域内已揭示非空数 a 从 shotTable 推（揭示内容
// 与真实棋盘一致，声呐数字 ≥ a 恒成立）；采样部署在「区域未知格」里的非空数
// 必须 == count − a。区域大部分已揭示时约束自然变轻，采样不崩。
function consistentWithReveals(chosen, shotTable, size, sonarCounts, spec) {
  const planes = chosen.map(function (p) {
    return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
  });
  const board = buildBoard(planes, spec);
  for (let i = 0; i < shotTable.length; i++) {
    const v = shotTable[i];
    if (v === 0) continue;
    const bv = board[Math.floor(i / size)][i % size];
    if (v === 3 && bv !== CELL_HEAD) return false; // 揭示机头：必须是某架机头
    if (v === 2 && bv !== CELL_BODY) return false; // 揭示机身：必须是某架机身
  }
  for (let s = 0; s < sonarCounts.length; s++) {
    const sr = sonarCounts[s];
    let knownNonEmpty = 0; // 区域内已揭示的非空格数（从揭示记录推）
    let unknownNonEmpty = 0; // 区域内未知格里，采样部署的非空格数
    for (let r = sr.row; r < sr.row + 3; r++) {
      for (let c = sr.col; c < sr.col + 3; c++) {
        const st = shotTable[r * size + c];
        if (st !== 0) {
          if (st === 2 || st === 3) knownNonEmpty++;
        } else if (board[r][c] !== CELL_EMPTY) {
          unknownNonEmpty++;
        }
      }
    }
    if (unknownNonEmpty !== sr.count - knownNonEmpty) return false;
  }
  return true;
}

// Fisher–Yates 洗牌（原地打乱，随机组合前用）
function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}

// 采样概率场：随机生成 samples 份「与所有已揭示信息一致」的合法部署，
// 统计每格是机头/机身的概率。
// opts: { samples: 采样份数（默认 120）, sonarCounts: 我方声呐计数 [{row,col,count}] }
// 返回 { head: Float64Array(概率), body: Float64Array(概率), alive: 有效份数, size }
// ⚠️ 为什么不用「随机部署 + 全局过滤」：晚局已揭示空格多了以后，随机部署碰巧
// 一致的概率指数下降（约 0.72^15 < 1%），一步要等几秒。候选池先把「空格约束」
// 消化掉：每个候选本身就不落在已揭示空格上，组合时只剩重叠/机身/机头/声呐检查。
function buildProbField(shotsReceived, size, opts) {
  const spec = SPEC_BY_SIZE[size] || 'S';
  const samples = (opts && opts.samples) || 120;
  const sonarCounts = (opts && opts.sonarCounts) || [];
  const planeCount = shared.getBoardSpec(spec).planeCount;
  const shotTable = buildShotTableAny(shotsReceived, size);

  // 1) 候选池：不越界、且 10 格不落在任何「已揭示空格」的摆放。
  // 「声呐数字 = 0」（区域全空）也是强约束：区域格视同已揭示空，候选池直接排除
  const emptyTable = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) emptyTable[i] = shotTable[i] === 1 ? 1 : 0;
  sonarCounts.forEach(function (sr) {
    if (sr.count !== 0) return; // 非零计数在组合时精确检查（见 consistentWithReveals）
    for (let r = sr.row; r < sr.row + 3; r++) {
      for (let c = sr.col; c < sr.col + 3; c++) emptyTable[r * size + c] = 1;
    }
  });
  const dirs = ['up', 'down', 'left', 'right'];
  const pool = [];
  for (let headRow = 0; headRow < size; headRow++) {
    for (let headCol = 0; headCol < size; headCol++) {
      dirs.forEach(function (dir) {
        const cells = getPlaneCells(headRow, headCol, dir);
        for (let i = 0; i < cells.length; i++) {
          const r = cells[i][0], c = cells[i][1];
          if (r < 0 || r >= size || c < 0 || c >= size) return; // 越界
          if (emptyTable[r * size + c] === 1) return;           // 落在已知空区域
        }
        pool.push({ headRow: headRow, headCol: headCol, dir: dir });
      });
    }
  }
  if (pool.length < planeCount) {
    return { head: null, body: null, alive: 0, size: size }; // 候选不足：调用方兜底
  }

  // 2) 采样：洗牌 → 贪心取 planeCount 个互不重叠 → 一致性检查 → 统计
  // ⚠️ 终局陷阱：机头全找到后，随机组合「恰好让每个已揭示机头格都是机头」的
  // 概率极低（20000 次尝试经常凑不齐 1 份）。所以组合时先把已揭示机头格钉住：
  // 每个已揭示机头格必须选一架「以它为机头」的候选，剩余飞机再随机补。
  const MAX_ATTEMPTS = 20000;
  const MIN_SAMPLES = 10;
  // 候选池按「机头格是否已揭示」分组：headCand[格号] = 以该格为机头的候选
  const revealedHeadKeys = [];
  for (let i = 0; i < shotTable.length; i++) {
    if (shotTable[i] === 3) revealedHeadKeys.push(i);
  }
  const headCand = {};
  const freeCand = [];
  pool.forEach(function (p) {
    const hk = p.headRow * size + p.headCol;
    if (revealedHeadKeys.indexOf(hk) !== -1) {
      if (!headCand[hk]) headCand[hk] = [];
      headCand[hk].push(p);
    } else {
      freeCand.push(p);
    }
  });
  // 判断候选是否与已占格子重叠（不重叠则顺手标记占用）
  const tryTake = function (p, occupied) {
    const cells = getPlaneCells(p.headRow, p.headCol, p.dir);
    for (let k = 0; k < cells.length; k++) {
      if (occupied.has(cells[k][0] * size + cells[k][1])) return false;
    }
    cells.forEach(function (cell) { occupied.add(cell[0] * size + cell[1]); });
    return true;
  };
  // 一轮采样：返回累计的机头/机身计数与有效份数
  const sampleRound = function (sonarList, target) {
    const hc = new Float64Array(size * size);
    const bc = new Float64Array(size * size);
    let n = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && n < target; attempt++) {
      const chosen = [];
      const occupied = new Set();
      let ok = true;
      // 先钉住已揭示机头格
      for (let h = 0; h < revealedHeadKeys.length; h++) {
        const list = headCand[revealedHeadKeys[h]] || [];
        shuffleArr(list);
        let picked = false;
        for (let i = 0; i < list.length && !picked; i++) {
          if (tryTake(list[i], occupied)) { chosen.push(list[i]); picked = true; }
        }
        if (!picked) { ok = false; break; } // 该机头格没有可放候选（重叠）：本轮作废
      }
      if (!ok) continue;
      // 剩余飞机从自由池贪心补（洗牌后）
      shuffleArr(freeCand);
      for (let i = 0; i < freeCand.length && chosen.length < planeCount; i++) {
        if (tryTake(freeCand[i], occupied)) chosen.push(freeCand[i]);
      }
      if (chosen.length < planeCount) continue; // 这轮组合失败
      if (!consistentWithReveals(chosen, shotTable, size, sonarList, spec)) continue;
      chosen.forEach(function (p) {
        const cells = getPlaneCells(p.headRow, p.headCol, p.dir);
        cells.forEach(function (cell, i) {
          const key = cell[0] * size + cell[1];
          if (i === 0) hc[key]++;
          else bc[key]++;
        });
      });
      n++;
    }
    return { hc: hc, bc: bc, n: n };
  };
  // 先带全部声呐约束采样；不足时放松（丢弃计数>0 的声呐）重采，保证永不失败
  const activeSonar = sonarCounts.filter(function (sr) { return sr.count > 0; });
  const first = sampleRound(activeSonar, samples);
  let headCount = first.hc;
  let bodyCount = first.bc;
  let alive = first.n;
  let relaxed = false;
  if (alive < MIN_SAMPLES && activeSonar.length) {
    const second = sampleRound([], samples - alive);
    for (let i = 0; i < size * size; i++) {
      headCount[i] += second.hc[i];
      bodyCount[i] += second.bc[i];
    }
    alive += second.n;
    relaxed = true;
  }
  if (alive === 0) {
    return { head: null, body: null, alive: 0, size: size };
  }
  for (let i = 0; i < headCount.length; i++) {
    headCount[i] /= alive;
    bodyCount[i] /= alive;
  }
  return { head: headCount, body: bodyCount, alive: alive, size: size, sonarRelaxed: relaxed };
}

// 概率场选格（M/L 经典 + 全部道具模式；AI 加强第 2 步）：
//   候选 = 未揭示且未冻结的格子
//   打分 = 5×P(机头) + P(机身) + INFO_WEIGHT×信息量（1−Σp²，越大越有区分度）
//   返回 {row, col}；概率场采样失败（alive=0）返回 null 由调用方兜底
//   opts.probField 可复用已建好的概率场（服务器道具决策与选格共用一次采样）
function chooseTargetProbField(shotsReceived, size, frozenCells, opts) {
  const o = opts || {};
  const pf = o.probField || buildProbField(shotsReceived, size, o);
  if (!pf.head) return null;
  const shotTable = buildShotTableAny(shotsReceived, size);
  const frozen = new Set();
  (frozenCells || []).forEach(function (f) { frozen.add(f.row * size + f.col); });
  let best = null;
  let bestScore = -Infinity;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const key = r * size + c;
      if (shotTable[key] !== 0 || frozen.has(key)) continue;
      const pHead = pf.head[key];
      const pBody = pf.body[key];
      const pEmpty = 1 - pHead - pBody;
      const score = pHead * 5 + pBody
        + INFO_WEIGHT * (1 - pHead * pHead - pBody * pBody - pEmpty * pEmpty);
      if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
    }
  }
  return best;
}

// ---------- 道具决策（AI 加强第 3 步：价值驱动，不再是瞎概率） ----------

// 信息增益最大的声呐锚点：枚举所有合法锚点（3×3 完整落盘、且 3×3 不含冻结格），
// 用概率场把 9 格视为独立，算出「3×3 非空格数」的概率分布（泊松二项），
// 选分布熵最大（= 期望信息增益最大）的锚点。返回 {row, col, entropy}（3×3 左上角）。
// entropy 供调用方做「信息价值够不够」的阈值判断。
// 分布熵近似：忽略格间相关性，但足够给锚点排序。
function chooseSonarAnchor(probField, size, frozenCells) {
  if (!probField.head) return null;
  const frozen = new Set();
  (frozenCells || []).forEach(function (f) { frozen.add(f.row * size + f.col); });
  let best = null;
  let bestEntropy = 0;
  for (let r = 0; r <= size - 3; r++) {
    for (let c = 0; c <= size - 3; c++) {
      // 区域含冻结格：跳过（冻结格不能被任何技能选中）
      let frozenHit = false;
      for (let rr = r; rr < r + 3 && !frozenHit; rr++) {
        for (let cc = c; cc < c + 3; cc++) {
          if (frozen.has(rr * size + cc)) { frozenHit = true; break; }
        }
      }
      if (frozenHit) continue;
      // 泊松二项：dp[k] = 恰好 k 个格子非空的概率（9 个独立伯努利卷积）
      const dp = [1];
      for (let rr = r; rr < r + 3; rr++) {
        for (let cc = c; cc < c + 3; cc++) {
          const p = probField.head[rr * size + cc] + probField.body[rr * size + cc];
          if (p <= 0 || p >= 1) continue; // 全空或全占的格不贡献不确定性
          for (let k = dp.length; k >= 1; k--) {
            dp[k] = (dp[k] || 0) * (1 - p) + dp[k - 1] * p;
          }
          dp[0] = dp[0] * (1 - p);
        }
      }
      let entropy = 0;
      for (let k = 0; k < dp.length; k++) {
        if (dp[k] > 0) entropy -= dp[k] * Math.log(dp[k]);
      }
      if (entropy > bestEntropy) { bestEntropy = entropy; best = { row: r, col: c, entropy: entropy }; }
    }
  }
  return best;
}

// 找「机头已揭示但整架飞机还没被完整揭示」的机头格（无所遁形用）。
// 判定：该机头 4 个朝向里，「合法朝向」≥2 且仍有未揭示格（信息不足，值得用无所遁形）。
// 合法朝向 = 10 格全在棋盘内、且不含已揭示空格（空格会排除该朝向）。
// 只剩 1 个合法朝向 → 飞机位置已确定，普通揭示即可，花 5 金币是浪费。
// 返回 {row, col}；没有则返回 null。
function findExposeHead(shotsReceived, size) {
  const shotTable = buildShotTableAny(shotsReceived, size);
  const dirs = ['up', 'down', 'left', 'right'];
  for (let i = 0; i < shotTable.length; i++) {
    if (shotTable[i] !== 3) continue; // 只看已揭示机头格
    const r = Math.floor(i / size), c = i % size;
    let legalCount = 0;  // 合法朝向数（排除出界与已揭示空格冲突）
    let hasUnknown = false;
    for (let d = 0; d < dirs.length; d++) {
      const cells = getPlaneCells(r, c, dirs[d]);
      let inBoard = true;
      let emptyHit = false;  // 朝向内出现已揭示空格 → 该朝向不可能
      let unknownHit = false;
      for (let k = 0; k < cells.length; k++) {
        const rr = cells[k][0], cc = cells[k][1];
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) { inBoard = false; break; }
        const st = shotTable[rr * size + cc];
        if (st === 1) emptyHit = true;
        if (st === 0) unknownHit = true;
      }
      if (inBoard && !emptyHit) {
        legalCount++;
        if (unknownHit) hasUnknown = true;
      }
    }
    if (legalCount >= 2 && hasUnknown) return { row: r, col: c };
  }
  return null;
}

// 毁灭菇中心：选「十字 5 格概率和」最大的中心（clamp [1, size-2]），
// 且十字 5 格不含冻结格。返回 {row, col}；没有可用中心返回 null。
function bestDoomCenter(probField, size, frozenCells) {
  if (!probField.head) return null;
  const frozen = new Set();
  (frozenCells || []).forEach(function (f) { frozen.add(f.row * size + f.col); });
  const cross = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
  let best = null;
  let bestSum = -1;
  for (let r = 1; r < size - 1; r++) {
    for (let c = 1; c < size - 1; c++) {
      let frozenHit = false;
      let sum = 0;
      for (let k = 0; k < cross.length; k++) {
        const rr = r + cross[k][0], cc = c + cross[k][1];
        if (frozen.has(rr * size + cc)) { frozenHit = true; break; }
        sum += probField.head[rr * size + cc] + probField.body[rr * size + cc];
      }
      if (frozenHit) continue;
      if (sum > bestSum) { bestSum = sum; best = { row: r, col: c }; }
    }
  }
  return best;
}

// ---------- 决策 ----------

// 存活位图（模块级单例，每步 filterAndCount 时重建）：
// ALIVE_MAP[comboIdx] = 1 表示该组合与已揭示记录一致（一步前瞻按"列表 × 位图"求子集）
const ALIVE_MAP = new Uint8Array(COMBOS.length / 3);

// 前瞻用的 4 个临时计数数组（候选格之间复用，用完 fill(0) 清零）：
// A 组 = "x 是机头"的子集，B 组 = "x 是机身"的子集（前瞻只看两种命中结果）
const SCRATCH_HEAD_A = new Int32Array(BOARD_SIZE * BOARD_SIZE);
const SCRATCH_BODY_A = new Int32Array(BOARD_SIZE * BOARD_SIZE);
const SCRATCH_HEAD_B = new Int32Array(BOARD_SIZE * BOARD_SIZE);
const SCRATCH_BODY_B = new Int32Array(BOARD_SIZE * BOARD_SIZE);

// 已揭示记录 → 数字查找表（下标 = 格子号 0~99；0 = 未知，1 = 空，2 = 机身，3 = 机头）
function buildShotTable(shotsReceived) {
  const t = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  shotsReceived.forEach(function (s) {
    t[s.row * BOARD_SIZE + s.col] = s.result === 'head' ? 3 : s.result === 'body' ? 2 : 1;
  });
  return t;
}

// 过滤一遍组合：筛掉与 shotTable 矛盾的，统计每个未知格的头/身次数；
// 顺带重建 ALIVE_MAP（供一步前瞻求"某格取值 = 空/身/头"的子集用）
function filterAndCount(shotTable) {
  const headCount = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  const bodyCount = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  let alive = 0;
  ALIVE_MAP.fill(0);
  for (let ci = 0, comboIdx = 0; ci < COMBOS.length; ci += 3, comboIdx++) {
    let ok = true;
    // 第 1 遍：检查这套组合与已揭示记录是否矛盾
    for (let pi = 0; pi < 3 && ok; pi++) {
      const cells = CELLS_OF[COMBOS[ci + pi]];
      for (let k = 0; k < cells.length; k++) {
        const enc = cells[k];
        const pos = enc >> 2;      // 格子号
        const kind = enc & 3;      // 0 = 头，1 = 身
        const hit = shotTable[pos];
        if (hit === 1 || (hit !== 0 && hit !== (kind === 0 ? 3 : 2))) { ok = false; break; }
      }
    }
    if (!ok) continue;
    alive++;
    ALIVE_MAP[comboIdx] = 1;
    ALIVE_LIST[alive - 1] = comboIdx;   // 顺带记入存活列表（rollout 的抽样域）
    // 第 2 遍：这套部署成立，给它的头/身格子各记一分
    for (let pi = 0; pi < 3; pi++) {
      const cells = CELLS_OF[COMBOS[ci + pi]];
      for (let k = 0; k < cells.length; k++) {
        const enc = cells[k];
        if ((enc & 3) === 0) headCount[enc >> 2]++;
        else bodyCount[enc >> 2]++;
      }
    }
  }
  return { alive: alive, aliveLen: alive, headCount: headCount, bodyCount: bodyCount };
}

// 把「存活组合中 x 处 = kind 的子集」里每格的头/身次数累加进 scratch。
// kind 0 = 机头子集（遍历 POS_INDEX.heads[x]），1 = 机身子集（遍历 POS_INDEX.bodies[x]）
function countSubset(x, kind, headScratch, bodyScratch) {
  const list = kind === 0 ? POS_INDEX.heads[x] : POS_INDEX.bodies[x];
  for (let i = 0; i < list.length; i++) {
    const comboIdx = list[i];
    if (ALIVE_MAP[comboIdx] === 0) continue; // 列表 × 位图：只统计还活着的组合
    const c = comboIdx * 3;
    // 每套组合 3 个头 + 27 个身：直接按格子号自增，无分支
    headScratch[HEAD_POS[COMBOS[c]]]++;
    headScratch[HEAD_POS[COMBOS[c + 1]]]++;
    headScratch[HEAD_POS[COMBOS[c + 2]]]++;
    const b0 = BODY_CELLS[COMBOS[c]];
    const b1 = BODY_CELLS[COMBOS[c + 1]];
    const b2 = BODY_CELLS[COMBOS[c + 2]];
    for (let k = 0; k < b0.length; k++) {
      bodyScratch[b0[k]]++;
      bodyScratch[b1[k]]++;
      bodyScratch[b2[k]]++;
    }
  }
}

// 子集大小为 n，scratch 里是该子集内每格的头/身计数。
// 求这个子集里"下一枪能拿到的最好分数"（和本枪同一套公式：机头概率 + w × 信息量）
function maxFollow(x, n, w, headScratch, bodyScratch, shotTable) {
  let best = -1;
  for (let y = 0; y < BOARD_SIZE * BOARD_SIZE; y++) {
    if (y === x || shotTable[y] !== 0) continue; // 排除 x 自己（这一枪已打）和已揭示格
    const H = headScratch[y];
    const B = bodyScratch[y];
    const E = n - H - B;
    const s = (H + w * (n - (H * H + B * B + E * E) / n)) / n;
    if (s > best) best = s;
  }
  return best;
}

// 旧版核心决策（一步贪心，只算本枪分）。保留用于模拟对比和测试回归
// shotsReceived = AI 打对方（真人）的记录
// weight = 信息量权重（可选，默认 INFO_WEIGHT，模拟调参用）。
//   也可以是 function(aliveLen) → 数字：按当前剩余方案数自适应调权
//   （比如方案多时加大信息量权重、方案少时专心找机头，模拟实验用）
function chooseTargetGreedy(shotsReceived, weight, rng) {
  const rand = typeof rng === 'function' ? rng : Math.random; // 可选随机源（模拟配对对比用）
  const shotTable = buildShotTable(shotsReceived);

  // 过滤 + 统计（约 5ms）
  const counted = filterAndCount(shotTable);
  const alive = counted.alive;
  const w = typeof weight === 'number' ? weight
    : (typeof weight === 'function' ? weight(counted.aliveLen) : INFO_WEIGHT);

  // 每个未知格算分：机头概率 + 权重 × 信息量，取最高分
  let bestScore = -1;
  let bestPositions = [];
  for (let pos = 0; pos < BOARD_SIZE * BOARD_SIZE; pos++) {
    if (shotTable[pos] !== 0) continue;
    const h = counted.headCount[pos];
    const b = counted.bodyCount[pos];
    const e = alive - h - b;
    const pHead = h / alive;                       // 机头概率
    const info = 1 - (h * h + b * b + e * e) / (alive * alive); // 期望排除比例
    const score = pHead + w * info;
    if (score > bestScore) { bestScore = score; bestPositions = [pos]; }
    else if (score === bestScore) bestPositions.push(pos);
  }

  // 理论上不会出现"一个组合都不剩"（对方的部署一定是合法的），防御性兜底
  if (!bestPositions.length) {
    const unknown = [];
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      if (shotTable[i] === 0) unknown.push(i);
    }
    const pos = unknown[Math.floor(rand() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }

  // 并列最高分随机选一个（避免被对手摸出固定套路）
  const pos = bestPositions[Math.floor(rand() * bestPositions.length)];
  return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
}

// 【实验备用，实战未用】一步前瞻·打分版：返回 {row, col} —— 打哪一格
// shotsReceived = AI 打对方（真人）的记录
// weight = 信息量权重（可选，默认 INFO_WEIGHT，模拟调参用）
//
// 分数 = 本枪分 + 前瞻分：
//   本枪分 = 机头概率 + w × 信息量（与 chooseTargetGreedy 完全一致）
//   前瞻分 = 只算「机头」「机身」两种命中结果，各自子集里"下一枪的最好
//            分数"按概率加权（不算打空，原因见下方注释）
// 自对弈 300 盘实测平均 22.28 步，不如贪心（18.72），原因见文件头注释
function chooseTarget(shotsReceived, weight) {
  const w = typeof weight === 'number' ? weight : INFO_WEIGHT;
  const shotTable = buildShotTable(shotsReceived);

  // 过滤 + 统计（约 5ms），顺带重建 ALIVE_MAP
  const counted = filterAndCount(shotTable);
  const alive = counted.alive;
  const headCount = counted.headCount;
  const bodyCount = counted.bodyCount;

  let bestScore = -1;
  let bestPositions = [];
  for (let x = 0; x < BOARD_SIZE * BOARD_SIZE; x++) {
    if (shotTable[x] !== 0) continue;
    const h = headCount[x];
    const b = bodyCount[x];
    const e = alive - h - b;
    // 本枪分
    let score = h / alive + w * (1 - (h * h + b * b + e * e) / (alive * alive));

    // 一步前瞻：只算「打中头」「打中身」两种命中结果的下一枪最好分，按概率加权。
    // 为什么不算「打空」：
    //   - 打空的价值已由本枪分里的信息量涵盖（信息量 = 三种结果排除量的加权平均）；
    //   - 空子集 ≈ 全量组合，它的"下一枪最好分"对所有候选格几乎一样，
    //     只会稀释真实差异，还让低价值格追平高价值格（自对弈实测：带空分支
    //     32.88 步且有随机乱打的灾难盘；去掉后 22.28 步，仍不如贪心）
    let followHead = 0;
    let followBody = 0;
    if (h > 0) {
      countSubset(x, 0, SCRATCH_HEAD_A, SCRATCH_BODY_A);
      followHead = maxFollow(x, h, w, SCRATCH_HEAD_A, SCRATCH_BODY_A, shotTable);
    }
    if (b > 0) {
      countSubset(x, 1, SCRATCH_HEAD_B, SCRATCH_BODY_B);
      followBody = maxFollow(x, b, w, SCRATCH_HEAD_B, SCRATCH_BODY_B, shotTable);
    }
    score += (h / alive) * followHead + (b / alive) * followBody;

    // scratch 清零，供下一个候选格复用（跳过未填的分支时本就是 0，减法仍正确）
    SCRATCH_HEAD_A.fill(0); SCRATCH_BODY_A.fill(0);
    SCRATCH_HEAD_B.fill(0); SCRATCH_BODY_B.fill(0);

    if (score > bestScore) { bestScore = score; bestPositions = [x]; }
    else if (score === bestScore) bestPositions.push(x);
  }

  // 理论上不会出现"一个组合都不剩"（对方的部署一定是合法的），防御性兜底
  if (!bestPositions.length) {
    const unknown = [];
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      if (shotTable[i] === 0) unknown.push(i);
    }
    const pos = unknown[Math.floor(Math.random() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }

  // 并列最高分随机选一个（避免被对手摸出固定套路）
  const pos = bestPositions[Math.floor(Math.random() * bestPositions.length)];
  return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
}

// ---------- 一步前瞻·步数版与混合版（实验备用，实战未用） ----------
//
// 把"下一步能拿多少分"换成"打完这枪后还需要多少枪"：
//   V(x) = 本枪 1 枪 + Σ 三种结果的概率 × 该结果子集里的期望剩余步数
//   期望剩余步数 ≈ 剩余机头数 ÷ 子集内最大机头概率
//  V 越小越好。
// 这样"这一枪直接命中机头、当场结束"的价值自然大于"打中机身、下一枪才
// 找到机头"——打分版区分不了这两种情况（两者两枪内的总分一样）。
// 但实测这个"剩余机头数 ÷ 最大机头概率"的估计高估了后续机头的代价，
// AI 会沿着机身一格格走到底：步数版 30.19 步，更差。见文件头注释。
//
// 两个变体：
//   chooseTargetShots：纯步数版（完全按 V 走）
//   chooseTargetBlend：混合版（本枪分 − λ × 期望剩余步数，λ 权衡两者，
//     实测 λ=0.05 平均 19.72 步、λ=0.1 平均 20.37 步，仍不如贪心）

// 子集内最大机头概率 = max_y 头计数[y] / n（排除 x 自己和已揭示格）
function maxPHeadIn(headScratch, n, x, shotTable) {
  let best = 0;
  for (let y = 0; y < BOARD_SIZE * BOARD_SIZE; y++) {
    if (y === x || shotTable[y] !== 0) continue;
    const p = headScratch[y] / n;
    if (p > best) best = p;
  }
  return best;
}

// "x 是空"子集的最大机头概率（头计数 = 全量 − 头子集 − 身子集，零迭代）。
// 注意必须在 scratch 清零之前调用
function maxPHeadEmpty(headCount, n, x, shotTable) {
  let best = 0;
  for (let y = 0; y < BOARD_SIZE * BOARD_SIZE; y++) {
    if (y === x || shotTable[y] !== 0) continue;
    const p = (headCount[y] - SCRATCH_HEAD_A[y] - SCRATCH_HEAD_B[y]) / n;
    if (p > best) best = p;
  }
  return best;
}

// 对单个候选格 x 求「打完这枪后的期望剩余步数」（三种结果加权，不含本枪）。
// 调用前 SCRATCH 数组须承载 x 的头/身子集计数；调用后由调用方清零
function expectedRemainingAfter(x, h, b, e, alive, remainHeads, headCount, shotTable) {
  let sum = 0;
  if (h > 0 && remainHeads - 1 > 0) { // 命中机头：剩余机头 −1；若这是最后一颗则后续 0 枪
    const mp = maxPHeadIn(SCRATCH_HEAD_A, h, x, shotTable);
    sum += (h / alive) * ((remainHeads - 1) / mp);
  }
  if (b > 0) { // 命中机身：剩余机头不变
    const mp = maxPHeadIn(SCRATCH_HEAD_B, b, x, shotTable);
    sum += (b / alive) * (remainHeads / mp);
  }
  if (e > 0) { // 打空：剩余机头不变
    const mp = maxPHeadEmpty(headCount, e, x, shotTable);
    sum += (e / alive) * (remainHeads / mp);
  }
  return sum;
}

// 变体 A：纯步数版。V(x) = 1 + 期望剩余步数，取 V 最小的格子
function chooseTargetShots(shotsReceived) {
  const shotTable = buildShotTable(shotsReceived);
  const counted = filterAndCount(shotTable);
  const alive = counted.alive;
  const headCount = counted.headCount;
  const remainHeads = 3 - shotsReceived.filter(function (s) { return s.result === 'head'; }).length;

  let bestScore = Infinity;
  let bestPositions = [];
  for (let x = 0; x < BOARD_SIZE * BOARD_SIZE; x++) {
    if (shotTable[x] !== 0) continue;
    const h = headCount[x];
    const b = counted.bodyCount[x];
    const e = alive - h - b;
    if (h > 0) countSubset(x, 0, SCRATCH_HEAD_A, SCRATCH_BODY_A);
    if (b > 0) countSubset(x, 1, SCRATCH_HEAD_B, SCRATCH_BODY_B);
    const v = 1 + expectedRemainingAfter(x, h, b, e, alive, remainHeads, headCount, shotTable);
    SCRATCH_HEAD_A.fill(0); SCRATCH_BODY_A.fill(0);
    SCRATCH_HEAD_B.fill(0); SCRATCH_BODY_B.fill(0);
    if (v < bestScore) { bestScore = v; bestPositions = [x]; }
    else if (v === bestScore) bestPositions.push(x);
  }

  if (!bestPositions.length) {
    const unknown = [];
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      if (shotTable[i] === 0) unknown.push(i);
    }
    const pos = unknown[Math.floor(Math.random() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }
  const pos = bestPositions[Math.floor(Math.random() * bestPositions.length)];
  return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
}

// 变体 B：混合版。分数 = 本枪分 − λ × 期望剩余步数，取最高分。
// λ = 0 时退化为旧版贪心；λ 由模拟实测选定
function chooseTargetBlend(shotsReceived, weight, lambda) {
  const w = typeof weight === 'number' ? weight : INFO_WEIGHT;
  const lam = typeof lambda === 'number' ? lambda : 0.05;
  const shotTable = buildShotTable(shotsReceived);
  const counted = filterAndCount(shotTable);
  const alive = counted.alive;
  const headCount = counted.headCount;
  const bodyCount = counted.bodyCount;
  const remainHeads = 3 - shotsReceived.filter(function (s) { return s.result === 'head'; }).length;

  let bestScore = -Infinity;
  let bestPositions = [];
  for (let x = 0; x < BOARD_SIZE * BOARD_SIZE; x++) {
    if (shotTable[x] !== 0) continue;
    const h = headCount[x];
    const b = bodyCount[x];
    const e = alive - h - b;
    const one = h / alive + w * (1 - (h * h + b * b + e * e) / (alive * alive));
    if (h > 0) countSubset(x, 0, SCRATCH_HEAD_A, SCRATCH_BODY_A);
    if (b > 0) countSubset(x, 1, SCRATCH_HEAD_B, SCRATCH_BODY_B);
    const remain = expectedRemainingAfter(x, h, b, e, alive, remainHeads, headCount, shotTable);
    const score = one - lam * remain;
    SCRATCH_HEAD_A.fill(0); SCRATCH_BODY_A.fill(0);
    SCRATCH_HEAD_B.fill(0); SCRATCH_BODY_B.fill(0);
    if (score > bestScore) { bestScore = score; bestPositions = [x]; }
    else if (score === bestScore) bestPositions.push(x);
  }

  if (!bestPositions.length) {
    const unknown = [];
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      if (shotTable[i] === 0) unknown.push(i);
    }
    const pos = unknown[Math.floor(Math.random() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }
  const pos = bestPositions[Math.floor(Math.random() * bestPositions.length)];
  return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
}

// ---------- Rollout 一步前瞻（第二轮方案，思路见文件头） ----------

// ALIVE_LIST[0..aliveLen)：本步存活组合列表（filterAndCount 顺带填好，空分支的抽样域）
const ALIVE_LIST = new Int32Array(COMBOS.length / 3);

// Rollout 专用缓冲区（与旧实验变体的 SCRATCH_* 互不干扰）：
// 三个候选子集的暂存区（H = x 是机头，B = 机身，E = 空；候选格之间复用）
const ROLL_SUBSET_H = new Int32Array(COMBOS.length / 3);
const ROLL_SUBSET_B = new Int32Array(COMBOS.length / 3);
const ROLL_SUBSET_E = new Int32Array(COMBOS.length / 3);
// 粒子池：ROLL_POOL0 = 分支的基础池（每次 rollout 复制进 ROLL_POOL 再演化），≤1024 个组合下标
const ROLL_POOL0 = new Int32Array(1024);
const ROLL_POOL = new Int32Array(1024);
// rollout 内部：粒子池的头/身计数（随筛选增量维护，不用每步重算）与局部揭示表
const ROLL_HEAD = new Int32Array(BOARD_SIZE * BOARD_SIZE);
const ROLL_BODY = new Int32Array(BOARD_SIZE * BOARD_SIZE);
const ROLL_SHOT = new Uint8Array(BOARD_SIZE * BOARD_SIZE);

// 组合 comboIdx 在格子 pos 处的取值：0 = 空，1 = 机身，2 = 机头
// （先比 3 个机头、再扫 27 个机身，命中早退）
function comboKindAt(comboIdx, pos) {
  const c = comboIdx * 3;
  for (let pi = 0; pi < 3; pi++) {
    if (HEAD_POS[COMBOS[c + pi]] === pos) return 2;
  }
  for (let pi = 0; pi < 3; pi++) {
    const cells = BODY_CELLS[COMBOS[c + pi]];
    for (let k = 0; k < cells.length; k++) {
      if (cells[k] === pos) return 1;
    }
  }
  return 0;
}

// 把组合的头/身格子各加（或减）一分——rollout 里维护粒子池计数用
function addComboTo(comboIdx, headScratch, bodyScratch, sign) {
  const c = comboIdx * 3;
  const p0 = COMBOS[c], p1 = COMBOS[c + 1], p2 = COMBOS[c + 2];
  headScratch[HEAD_POS[p0]] += sign;
  headScratch[HEAD_POS[p1]] += sign;
  headScratch[HEAD_POS[p2]] += sign;
  const b0 = BODY_CELLS[p0], b1 = BODY_CELLS[p1], b2 = BODY_CELLS[p2];
  for (let k = 0; k < b0.length; k++) {
    bodyScratch[b0[k]] += sign;
    bodyScratch[b1[k]] += sign;
    bodyScratch[b2[k]] += sign;
  }
}

// 从 exactList[0..n) 均匀采粒子池写进 ROLL_POOL0，返回池大小。
// n ≤ P 时整表入池（无抽样）；n > P 时放回抽样 P 个（重复无害，信念是多重集）
function samplePool(exactList, n, P, rng) {
  if (n <= P) {
    for (let i = 0; i < n; i++) ROLL_POOL0[i] = exactList[i];
    return n;
  }
  for (let i = 0; i < P; i++) ROLL_POOL0[i] = exactList[Math.floor(rng() * n)];
  return P;
}

// 空分支（x 处为空）的粒子池，返回池大小（0 = 跳过该分支）：
//   alive 不大时：全量精确分类（无偏）；
//   alive 大时：从 ALIVE_LIST 拒绝采样（预算 P×64 抽；一次都没中说明分支
//     概率 e/alive 小于 1/(64P) ≈ 万分之五，对 V 的影响可忽略，整个分支跳过）
function buildEmptyPool(x, aliveLen, P, rng, rscan) {
  if (aliveLen <= rscan) {
    let len = 0;
    for (let i = 0; i < aliveLen; i++) {
      const ci = ALIVE_LIST[i];
      if (comboKindAt(ci, x) === 0) ROLL_SUBSET_E[len++] = ci;
    }
    return samplePool(ROLL_SUBSET_E, len, P, rng);
  }
  let len = 0;
  const budget = P * 64;
  for (let d = 0; d < budget && len < P; d++) {
    const ci = ALIVE_LIST[Math.floor(rng() * aliveLen)];
    if (comboKindAt(ci, x) === 0) ROLL_POOL0[len++] = ci;
  }
  return len;
}

// 单次 rollout：复制一份粒子池，随机取一个当「真相」，在池上按与实战
// 完全相同的贪心公式打真相，直到 3 个机头全中，返回步数（封顶 200 防病态）。
//   localBase = 揭示表副本（x 已标记为本次结果），每次 rollout 复制后独立演化
//   headsDone = 开局前（含 x 自己）已经命中的机头数
//   不变式：真相从池里抽 → 筛粒子时池永不筛空
function rolloutOnce(localBase, pool0, pool0Len, headsDone, w, rng) {
  const pool = ROLL_POOL;
  for (let i = 0; i < pool0Len; i++) pool[i] = pool0[i];
  const shot = ROLL_SHOT;
  shot.set(localBase);
  const head = ROLL_HEAD;
  const body = ROLL_BODY;
  head.fill(0);
  body.fill(0);

  const truth = pool[Math.floor(rng() * pool0Len)];
  let poolLen = pool0Len;
  for (let i = 0; i < poolLen; i++) addComboTo(pool[i], head, body, 1);

  let headsLeft = 3 - headsDone;   // 打完 x 之后还剩几颗头要打
  let steps = 0;
  while (headsLeft > 0 && steps < 200) {
    // 第 1 步：在粒子池上按与实战相同的公式（机头概率 + w × 信息量）选格；
    // 并列时按水库抽样随机选一个
    let bestScore = -1;
    let bestY = -1;
    let ties = 0;
    for (let y = 0; y < BOARD_SIZE * BOARD_SIZE; y++) {
      if (shot[y] !== 0) continue;
      const H = head[y];
      const B = body[y];
      const E = poolLen - H - B;
      const score = (H + w * (poolLen - (H * H + B * B + E * E) / poolLen)) / poolLen;
      if (score > bestScore) { bestScore = score; bestY = y; ties = 1; }
      else if (score === bestScore) { ties++; if (rng() < 1 / ties) bestY = y; }
    }
    if (bestY < 0) break; // 没有可打的格子（防御，正常到不了这里）
    steps++;
    // 第 2 步：对真相揭示这一枪
    const obs = comboKindAt(truth, bestY);
    shot[bestY] = obs === 0 ? 1 : obs === 1 ? 2 : 3;
    if (obs === 2) {
      headsLeft--;
      if (headsLeft === 0) break; // 最后一颗头：结束（这一枪已计入 steps）
    }
    // 第 3 步：筛掉与揭示结果矛盾的粒子（真相在池里，池不会空）
    let keep = 0;
    for (let i = 0; i < poolLen; i++) {
      const ci = pool[i];
      if (comboKindAt(ci, bestY) === obs) pool[keep++] = ci;
      else addComboTo(ci, head, body, -1); // 出池的粒子：从计数里减掉
    }
    poolLen = keep;
  }
  return steps;
}

// 候选格 x 的期望总步数：V(x) = 1 + Σ_{o∈{空,身,头}} p_o × R̄_o
//   p_o 用精确概率 n_o / alive；R̄_o = M 次 rollout 的平均剩余步数
//   localBase 会被临时改成三种结果（x 处标记），用完即弃，调用方无需还原
function evaluateCandidate(x, localBase, counted, cfg, rng) {
  const alive = counted.alive;
  const aliveLen = counted.aliveLen;
  // 1) 头/身子集：POS_INDEX 列表 × 存活位图，精确
  let hLen = 0;
  const hList = POS_INDEX.heads[x];
  for (let i = 0; i < hList.length; i++) {
    const ci = hList[i];
    if (ALIVE_MAP[ci]) ROLL_SUBSET_H[hLen++] = ci;
  }
  let bLen = 0;
  const bList = POS_INDEX.bodies[x];
  for (let i = 0; i < bList.length; i++) {
    const ci = bList[i];
    if (ALIVE_MAP[ci]) ROLL_SUBSET_B[bLen++] = ci;
  }
  const h = hLen;
  const b = bLen;
  const e = alive - h - b;
  let V = 1;
  // 2) 机头分支：x 是头。若这是最后一颗头则后续 0 步，直接跳过 rollout
  localBase[x] = 3;
  let headsDone = cfg.headsRevealed + 1;
  if (h > 0 && headsDone < 3) {
    let sum = 0;
    const poolLen = samplePool(ROLL_SUBSET_H, h, cfg.P, rng);
    for (let m = 0; m < cfg.M; m++) sum += rolloutOnce(localBase, ROLL_POOL0, poolLen, headsDone, cfg.w, rng);
    V += (h / alive) * (sum / cfg.M);
  }
  // 3) 机身分支
  localBase[x] = 2;
  headsDone = cfg.headsRevealed;
  if (b > 0) {
    let sum = 0;
    const poolLen = samplePool(ROLL_SUBSET_B, b, cfg.P, rng);
    for (let m = 0; m < cfg.M; m++) sum += rolloutOnce(localBase, ROLL_POOL0, poolLen, headsDone, cfg.w, rng);
    V += (b / alive) * (sum / cfg.M);
  }
  // 4) 空分支（poolLen = 0 表示分支概率小到可忽略，跳过）
  localBase[x] = 1;
  if (e > 0) {
    const poolLen = buildEmptyPool(x, aliveLen, cfg.P, rng, cfg.rscan);
    if (poolLen > 0) {
      let sum = 0;
      for (let m = 0; m < cfg.M; m++) sum += rolloutOnce(localBase, ROLL_POOL0, poolLen, headsDone, cfg.w, rng);
      V += (e / alive) * (sum / cfg.M);
    }
  }
  return V;
}

// Rollout 版核心决策：对贪心分最高的 K 个候选格，用「打 x 之后按贪心
// 打完一整局还要几步」的模拟步数 V(x) 决胜负，返回 {row, col}
// opts = { K, P, M, w, rscan, race, rng }（模拟调参用，实战参数走 env）
function chooseTargetRollout(shotsReceived, opts) {
  const o = opts || {};
  const K = typeof o.K === 'number' ? o.K : 8;
  const P = Math.min(typeof o.P === 'number' ? o.P : 300, 1024); // 池缓冲上限 1024
  const M = typeof o.M === 'number' ? o.M : 4;
  const w = typeof o.w === 'number' ? o.w : INFO_WEIGHT;
  const rscan = typeof o.rscan === 'number' ? o.rscan : 1024;
  const rng = typeof o.rng === 'function' ? o.rng : Math.random;
  const shotTable = buildShotTable(shotsReceived);
  const counted = filterAndCount(shotTable);     // 重建 ALIVE_MAP / ALIVE_LIST（约 5ms）
  const alive = counted.alive;
  const aliveLen = counted.aliveLen;

  // 理论上不会出现"一个组合都不剩"，防御性兜底（与贪心一致）
  if (!alive) {
    const unknown = [];
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      if (shotTable[i] === 0) unknown.push(i);
    }
    const pos = unknown[Math.floor(rng() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }

  // 1) 全部未知格按贪心分排序，取 top-K（含与第 K 名同分的并列，封顶 24 个）
  const scored = [];
  for (let pos = 0; pos < BOARD_SIZE * BOARD_SIZE; pos++) {
    if (shotTable[pos] !== 0) continue;
    const h = counted.headCount[pos];
    const b = counted.bodyCount[pos];
    const e = alive - h - b;
    scored.push({ pos: pos, score: h / alive + w * (1 - (h * h + b * b + e * e) / (alive * alive)) });
  }
  scored.sort(function (a, b2) { return b2.score - a.score; });
  const cutoff = scored[Math.min(K, scored.length) - 1].score;
  const candidates = [];
  for (let i = 0; i < scored.length && candidates.length < 24; i++) {
    if (scored[i].score >= cutoff) candidates.push(scored[i].pos);
  }

  const cfg = {
    P: P, w: w, rscan: rscan,
    headsRevealed: shotsReceived.filter(function (s) { return s.result === 'head'; }).length
  };
  let contenders = candidates;
  let finalM = M;
  // 2) 两阶段竞速（可选）：先用小样本粗筛出 T 个，再用大样本定胜负，抑制噪声选错
  if (o.race) {
    const M0 = typeof o.raceM0 === 'number' ? o.raceM0 : 2;
    const T = typeof o.raceT === 'number' ? o.raceT : 2;
    finalM = typeof o.raceM1 === 'number' ? o.raceM1 : 8;
    cfg.M = M0;
    let bestV = Infinity;
    const best = [];
    for (let i = 0; i < contenders.length; i++) {
      const v = evaluateCandidate(contenders[i], Uint8Array.from(shotTable), counted, cfg, rng);
      if (v < bestV) { bestV = v; best.length = 0; best.push(contenders[i]); }
      else if (v === bestV) best.push(contenders[i]);
    }
    // 超过 T 个并列时随机淘汰（避免固定保留前 T 个的偏向）
    while (best.length > T) best.splice(Math.floor(rng() * best.length), 1);
    contenders = best;
  }
  // 3) 决赛：V(x) 最小的格子获胜（并列随机选，避免被对手摸出固定套路）
  cfg.M = finalM;
  let bestV = Infinity;
  const bestPos = [];
  for (let i = 0; i < contenders.length; i++) {
    const x = contenders[i];
    const v = evaluateCandidate(x, Uint8Array.from(shotTable), counted, cfg, rng);
    if (v < bestV) { bestV = v; bestPos.length = 0; bestPos.push(x); }
    else if (v === bestV) bestPos.push(x);
  }
  const pos = bestPos[Math.floor(rng() * bestPos.length)];
  return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
}

// ---------- 机头组熵贪心（第 7 轮，Wordle 文献启发，实战默认） ----------
// 打分 = 机头概率 + w × ΔH头组，其中
//   ΔH头组 = H(当前"机头三元组"分布) − Σ_o p_o · H(结果 o 桶内的机头组分布)
// 直觉：胜负只取决于机头在哪——排除 1000 个机身摆法不同、但机头位置相同的
// 组合，对获胜毫无帮助。所以信息量要对着"机头组"量，而不是对着整套机身
// 布局量（旧的 1−Σp² 把两种信息混在一起，这是它的盲区）。Wordle 文献的
// 最优解（Olson 3.421 步）也是这个思路：对"答案本身"的状态取熵。
// 实测（第 7 轮三组独立种子共 3500 盘配对）：w∈{0.5,0.7,1.0} 全部显著快于
// 旧贪心（各 −0.26~−0.70 步，全部 ≥2.4σ），w=0.7 加权平均 −0.448 步最优；
// w=1.3 无效果（−0.016±0.109）。是七轮实验里第一个真实提升，采纳为默认。
//
// 实现：只在贪心 1.3 预排的 top-K 候选格里重新算 ΔH头组（候选过滤，和
// rollout 同法）。每格三张 Map 统计 空/身/头 桶内的机头组 id 分布。
// 性能：AI 每步有 0.8~1.5s 思考预算，最坏（开局 alive=66,816）约 100~200ms，
// 藏在思考延迟内。
function chooseTargetHeadSet(shotsReceived, weight, rng, K) {
  const w = typeof weight === 'number' ? weight : HEAD_SET_WEIGHT;
  const k = typeof K === 'number' ? K : HEAD_SET_K;
  const rand = typeof rng === 'function' ? rng : Math.random; // 可选随机源（模拟配对对比用）
  const shotTable = buildShotTable(shotsReceived);
  const counted = filterAndCount(shotTable);
  const alive = counted.alive;
  const aliveLen = counted.aliveLen;

  // 1) 当前机头组分布熵
  const mapNow = new Map();
  for (let i = 0; i < aliveLen; i++) {
    const id = HEAD_SET_IDS[ALIVE_LIST[i]];
    mapNow.set(id, (mapNow.get(id) || 0) + 1);
  }
  let hNow = 0;
  mapNow.forEach(function (cnt) {
    const p = cnt / aliveLen;
    hNow -= p * Math.log2(p);
  });

  // 2) 贪心 1.3 预排 top-K 候选
  const scored = [];
  for (let pos = 0; pos < BOARD_SIZE * BOARD_SIZE; pos++) {
    if (shotTable[pos] !== 0) continue;
    const h = counted.headCount[pos];
    const b = counted.bodyCount[pos];
    const e = alive - h - b;
    scored.push({
      pos: pos,
      pHead: h / alive,
      s: h / alive + INFO_WEIGHT * (1 - (h * h + b * b + e * e) / (alive * alive))
    });
  }
  scored.sort(function (x, y) { return y.s - x.s; });
  const top = scored.slice(0, Math.min(k, scored.length));

  // 3) 每个候选格算 ΔH头组，打分 = 机头概率 + w × ΔH头组
  let bestScore = -Infinity;
  let bestPositions = [];
  top.forEach(function (entry) {
    const pos = entry.pos;
    const maps = [new Map(), new Map(), new Map()]; // 空 / 身 / 头 三桶的 id→数量 表
    for (let i = 0; i < aliveLen; i++) {
      const combo = ALIVE_LIST[i];
      const kind = comboKindAt(combo, pos); // 2=头 1=身 0=空
      const id = HEAD_SET_IDS[combo];
      const m = maps[kind];
      m.set(id, (m.get(id) || 0) + 1);
    }
    let hExp = 0;
    for (let kind = 0; kind < 3; kind++) {
      const m = maps[kind];
      let n = 0;
      m.forEach(function (cnt) { n += cnt; });
      if (n === 0) continue;
      let hSum = 0;
      m.forEach(function (cnt) {
        const p = cnt / n;
        hSum -= p * Math.log2(p);
      });
      hExp += (n / aliveLen) * hSum;
    }
    const score = entry.pHead + w * (hNow - hExp);
    if (score > bestScore) { bestScore = score; bestPositions = [pos]; }
    else if (score === bestScore) bestPositions.push(pos);
  });

  // 理论上不会一个候选都不剩（对方部署一定合法），防御性兜底走旧贪心
  if (!bestPositions.length) return chooseTargetGreedy(shotsReceived, w, rand);
  const pos = bestPositions[Math.floor(rand() * bestPositions.length)];
  return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
}

// 实战入口：按环境变量分发。默认机头组熵贪心（第 7 轮实测快约 0.45 步）；
// AI_ROLLOUT=1 显式切换 rollout（自对弈 500 盘实测未优于旧贪心，见文件头）。
// 其余参数可用 env 覆盖：AI_HS_W（头组熵权重，默认 0.5）、AI_HS_K（候选数，
// 默认 4）、AI_RK/AI_RP/AI_RM/AI_RW/AI_RRACE（rollout 参数）
const HEAD_SET_WEIGHT = parseFloat(process.env.AI_HS_W || '0.7');
const HEAD_SET_K = parseInt(process.env.AI_HS_K || '4', 10);
const AI_USE_ROLLOUT = process.env.AI_ROLLOUT === '1';
const LIVE_OPTS = {
  K: parseInt(process.env.AI_RK || '8', 10),
  P: parseInt(process.env.AI_RP || '300', 10),
  M: parseInt(process.env.AI_RM || '4', 10),
  w: parseFloat(process.env.AI_RW || String(INFO_WEIGHT)),
  race: process.env.AI_RRACE === '1'
};
// 简单贪心（任意规格通用；M/L 规格和道具模式下的 AI 用，「能用就行」档）：
//   1. 候选 = 未揭示且未冻结的格子
//   2. 优先打与已揭示机身相邻（4 邻域）的格子，相邻机身越多越优先（顺藤摸瓜）
//   3. 没有就随机打一个未揭示格
// 返回 {row, col}；无可走格子返回 null。excludeKey（可选）= 要排除的格子号
// （双发连射选第二格时排除第一格用）
function chooseTargetSimple(shotsReceived, size, frozenCells, excludeKey) {
  const revealed = new Set();
  shotsReceived.forEach(function (s) { revealed.add(s.row * size + s.col); });
  const frozen = new Set();
  (frozenCells || []).forEach(function (f) { frozen.add(f.row * size + f.col); });

  let bestAdj = 0;
  const bests = [];   // 相邻机身最多的候选（并列时随机挑一个）
  const randoms = []; // 无相邻机身的候选（随机扫射用）
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const key = r * size + c;
      if (key === excludeKey) continue;
      if (revealed.has(key) || frozen.has(key)) continue;
      let adj = 0;
      [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].forEach(function (n) {
        const nr = n[0], nc = n[1];
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) return;
        if (shotsReceived.some(function (s) { return s.row === nr && s.col === nc && s.result === 'body'; })) adj++;
      });
      if (adj > 0) {
        if (adj > bestAdj) { bestAdj = adj; bests.length = 0; }
        if (adj === bestAdj) bests.push([r, c]);
      } else {
        randoms.push([r, c]);
      }
    }
  }
  if (bests.length) {
    const pick = bests[Math.floor(Math.random() * bests.length)];
    return { row: pick[0], col: pick[1] };
  }
  if (randoms.length) {
    const pick = randoms[Math.floor(Math.random() * randoms.length)];
    return { row: pick[0], col: pick[1] };
  }
  return null; // 全揭示/全冻结：AI 无子可走
}

function chooseTargetLive(shotsReceived) {
  if (AI_USE_ROLLOUT) return chooseTargetRollout(shotsReceived, LIVE_OPTS);
  return chooseTargetHeadSet(shotsReceived);
}

module.exports = {
  INFO_WEIGHT: INFO_WEIGHT,
  TOTAL_COMBOS: COMBOS.length / 3,       // 全部合法布局数 = 66,816（理论分析用）
  buildShotTable: buildShotTable,        // 揭示记录 → 棋盘表（理论分析用）
  filterAndCount: filterAndCount,        // 过滤 + 每格统计（理论分析用）
  ALIVE_LIST: ALIVE_LIST,                // filterAndCount 后 [0..aliveLen) 为存活组合下标（分析用）
  HEAD_SET_IDS: HEAD_SET_IDS,            // 每组合的机头三元组打包 id（分析用）
  comboKindAt: comboKindAt,              // 组合在格子处的取值：0 空 / 1 身 / 2 头（分析用）
  randomDeployment: randomDeployment,
  deployScore: deployScore,            // 部署评分（分析/测试用）
  smartDeployment: smartDeployment,    // 智能部署（AI 加强第 1 步）
  buildProbField: buildProbField,      // 采样概率场（AI 加强第 2 步）
  chooseTargetProbField: chooseTargetProbField, // 概率场选格（AI 加强第 2 步）
  chooseSonarAnchor: chooseSonarAnchor, // 信息增益声呐锚点（AI 加强第 3 步）
  findExposeHead: findExposeHead,      // 无所遁形目标（AI 加强第 3 步）
  bestDoomCenter: bestDoomCenter,      // 毁灭菇中心（AI 加强第 3 步）
  chooseTargetSimple: chooseTargetSimple,
  chooseTarget: chooseTarget,
  chooseTargetGreedy: chooseTargetGreedy,
  chooseTargetShots: chooseTargetShots,
  chooseTargetBlend: chooseTargetBlend,
  chooseTargetRollout: chooseTargetRollout,
  chooseTargetHeadSet: chooseTargetHeadSet,
  chooseTargetLive: chooseTargetLive
};
