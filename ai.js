// ============================================
// ai.js —— 人机对战的 AI 决策模块（服务器端）
//
// 算法：精确枚举 + 机头概率 × 信息量加权打分（一步贪心，实战在用）
//   服务器启动时一次性枚举出「3 架飞机互不重叠」的全部合法部署
//   （单架摆放 168 种 → 三架组合 66,816 种，枚举 + 建索引共约 100ms）。
//   每走一步时：
//     1. 筛掉与已揭示格子颜色矛盾的组合（空/机身/机头都要对得上）
//     2. 统计每个未知格在所有"仍然可能的部署"中：
//        headCount = 是机头的组合数
//        bodyCount = 是机身的组合数
//     3. 每个未知格算一个分数，打分数最高的格子：
//
//          分数 = 机头概率 + INFO_WEIGHT × 信息量
//            机头概率 = head / alive
//            信息量   = 打这格后期望排除的组合比例
//                     = 1 - (head² + body² + empty²) / alive²
//
//   〖信息量是什么意思〗打这格可能得到 空/机身/机头 三种结果，每种结果的
//   概率是 (empty|body|head)/alive，得到该结果后剩下的组合数是
//   (empty|body|head) 本身。加权平均就是"打完后还剩下多少组合"，
//   用 1 减掉它就得到"能排除多少"——越大越能缩小包围圈。
//
//   权重 INFO_WEIGHT 是两者之间的平衡杆。曾用自对弈模拟实测：
//   第 1 轮（200 盘粗扫）：w=0（纯追头）20.97 步、w=1 约 18.70 步（最优）、
//     w=1000（纯信息）20.00 步 → 信息量加一点最好，加太多反而拖慢。
//   第 2 轮（1500 盘加密扫 0.6~2.0）：w=1.3 平均 18.91 步最优，1.1~1.8 是平台区。
//   第 3 轮（4000 盘验证前 4 名）：w=1.3 再次最优（18.98 步）。
//   结论：取 1.3。
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
'use strict';

const shared = require('./public/shared.js');
const { BOARD_SIZE, PLANE_COUNT, getPlaneCells, canPlacePlane } = shared;

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

// 随机生成一份合法的 3 架部署（逐架从摆放表随机抽、不重叠即可）
function randomDeployment() {
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < PLANE_COUNT; attempt++) {
    const p = PLACEMENTS[Math.floor(Math.random() * PLACEMENTS.length)];
    const occupied = [];
    planes.forEach(function (q) {
      getPlaneCells(q.headRow, q.headCol, q.dir).forEach(function (cell) { occupied.push(cell); });
    });
    if (canPlacePlane(occupied, p.headRow, p.headCol, p.dir)) {
      planes.push({ headRow: p.headRow, headCol: p.headCol, dir: p.dir });
    }
  }
  return planes.length === PLANE_COUNT ? planes : null;
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
  return { alive: alive, headCount: headCount, bodyCount: bodyCount };
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
// weight = 信息量权重（可选，默认 INFO_WEIGHT，模拟调参用）
function chooseTargetGreedy(shotsReceived, weight) {
  const w = typeof weight === 'number' ? weight : INFO_WEIGHT;
  const shotTable = buildShotTable(shotsReceived);

  // 过滤 + 统计（约 5ms）
  const counted = filterAndCount(shotTable);
  const alive = counted.alive;

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
    const pos = unknown[Math.floor(Math.random() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }

  // 并列最高分随机选一个（避免被对手摸出固定套路）
  const pos = bestPositions[Math.floor(Math.random() * bestPositions.length)];
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

module.exports = {
  INFO_WEIGHT: INFO_WEIGHT,
  randomDeployment: randomDeployment,
  chooseTarget: chooseTarget,
  chooseTargetGreedy: chooseTargetGreedy,
  chooseTargetShots: chooseTargetShots,
  chooseTargetBlend: chooseTargetBlend
};
