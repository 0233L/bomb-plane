// ============================================
// ai.js —— 人机对战的 AI 决策模块（服务器端）
//
// 算法：精确枚举 + 机头概率 × 信息量加权打分
//   服务器启动时一次性枚举出「3 架飞机互不重叠」的全部合法部署
//   （单架摆放 168 种 → 三架组合 66,816 种，枚举只需约 55ms）。
//   每走一步时：
//     1. 筛掉与已揭示格子颜色矛盾的组合（空/机身/机头都要对得上）
//     2. 统计每个未知格在所有"仍然可能的部署"中：
//        headCount = 是机头的组合数
//        bodyCount = 是机身的组合数
//     3. 每个未知格算一个分数，打分数最高的格子：
//
//          分数 = 机头概率 + INFO_WEIGHT × 信息量
//
//        其中（设存活组合数 alive，空格组合数 empty = alive - head - body）：
//          机头概率 = head / alive
//          信息量   = 打这格后期望排除的组合比例
//                   = 1 - (head² + body² + empty²) / alive²
//
//   〖信息量是什么意思〗打这格可能得到 空/机身/机头 三种结果，每种结果的
//   概率是 (empty|body|head)/alive，得到该结果后剩下的组合数是
//   (empty|body|head) 本身。加权平均就是"打完后还剩下多少组合"，
//   用 1 减掉它就得到"能排除多少"——越大越能缩小包围圈。
//
//   权重 INFO_WEIGHT 是两者之间的平衡杆。曾用自对弈模拟（200 个随机棋盘）
//   实测候选值：w=0（纯追头）平均 20.97 步；w=0.5 平均 19.30 步；
//   w=1 平均 18.70 步（最优）；w=2 平均 18.86 步；w=1000（纯信息）平均 20.00 步。
//   结论：信息量加一点最好，加太多反而拖慢——所以取 1。
//
// 为什么这样就能变聪明：
//   - 打中机身后，机头方向上的格子概率自动升高 → AI 自然"顺藤摸瓜"
//   - 所有摆不下的部署组合被自动排除 → 不需要手写任何战术规则
//   - 概率是精确值（不是随机采样的近似），单步计算约 5ms，无压力
// ============================================
'use strict';

const shared = require('./public/shared.js');
const { BOARD_SIZE, PLANE_COUNT, getPlaneCells, canPlacePlane } = shared;

// 机头概率与信息量的平衡权重（自对弈模拟实测最优值，见上方注释）
const INFO_WEIGHT = 1;

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

// 已揭示记录 → 数字查找表（下标 = 格子号 0~99；0 = 未知，1 = 空，2 = 机身，3 = 机头）
function buildShotTable(shotsReceived) {
  const t = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  shotsReceived.forEach(function (s) {
    t[s.row * BOARD_SIZE + s.col] = s.result === 'head' ? 3 : s.result === 'body' ? 2 : 1;
  });
  return t;
}

// 过滤一遍组合：筛掉与 shotTable 矛盾的，统计每个未知格的头/身次数
function filterAndCount(shotTable) {
  const headCount = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  const bodyCount = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  let alive = 0;
  for (let ci = 0; ci < COMBOS.length; ci += 3) {
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

// 核心决策：返回 {row, col} —— 打哪一格
// shotsReceived = AI 打对方（真人）的记录
// weight = 信息量权重（可选，默认 INFO_WEIGHT，模拟调参用）
function chooseTarget(shotsReceived, weight) {
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

module.exports = { INFO_WEIGHT: INFO_WEIGHT, randomDeployment: randomDeployment, chooseTarget: chooseTarget };
