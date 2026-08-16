// ============================================
// ai.js —— 人机对战的 AI 决策模块（服务器端）
//
// 算法：精确枚举 + 机头概率图
//   服务器启动时一次性枚举出「3 架飞机互不重叠」的全部合法部署
//   （单架摆放 168 种 → 三架组合 66,816 种，枚举只需约 55ms）。
//   每走一步时：
//     1. 筛掉与已揭示格子颜色矛盾的组合（空/机身/机头都要对得上）
//     2. 统计每个未知格在所有"仍然可能的部署"中是机头的次数
//     3. 打机头概率最高的那一格
//
// 为什么这样就能变聪明：
//   - 打中机身后，机头方向上的格子概率自动升高 → AI 自然"顺藤摸瓜"
//   - 所有摆不下的部署组合被自动排除 → 不需要手写任何战术规则
//   - 概率是精确值（不是随机采样的近似），单步计算约 5ms，无压力
//
// 难度分档 = 行为差异（不是计算量）：
//   easy   : 25% 概率乱走；否则打"飞机格（头+身）"概率最高的（不专门追头）
//   normal : 打"机头"概率最高的格子（平局随机）
//   hard   : 打"机头"概率最高的格子；平局时选"若是空格能排除最多组合"的
//            （更快锁定机头，比普通档略强）
// ============================================
'use strict';

const shared = require('./public/shared.js');
const { BOARD_SIZE, PLANE_COUNT, getPlaneCells, canPlacePlane } = shared;

// 三档难度配置
const LEVELS = {
  easy:   { randomChance: 0.25, useBody: true,  smartTiebreak: false },
  normal: { randomChance: 0,    useBody: false, smartTiebreak: false },
  hard:   { randomChance: 0,    useBody: false, smartTiebreak: true }
};

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

// 只数存活组合数（hard 档平局时"假设这格是空"做信息量评估用）
function countAlive(shotTable) {
  let alive = 0;
  for (let ci = 0; ci < COMBOS.length; ci += 3) {
    let ok = true;
    for (let pi = 0; pi < 3 && ok; pi++) {
      const cells = CELLS_OF[COMBOS[ci + pi]];
      for (let k = 0; k < cells.length; k++) {
        const enc = cells[k];
        const pos = enc >> 2;
        const kind = enc & 3;
        const hit = shotTable[pos];
        if (hit === 1 || (hit !== 0 && hit !== (kind === 0 ? 3 : 2))) { ok = false; break; }
      }
    }
    if (ok) alive++;
  }
  return alive;
}

// 核心决策：返回 {row, col} —— 打哪一格
// shotsReceived = AI 打对方（真人）的记录；level = 难度
function chooseTarget(shotsReceived, level) {
  const cfg = LEVELS[level] || LEVELS.normal; // 非法难度回退普通
  const shotTable = buildShotTable(shotsReceived);

  // 还没被揭示过的格子（可打的目标集合）
  const unknown = [];
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    if (shotTable[i] === 0) unknown.push(i);
  }

  // 简单难度：偶尔乱走一步
  if (cfg.randomChance > 0 && Math.random() < cfg.randomChance) {
    const pos = unknown[Math.floor(Math.random() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }

  // 过滤 + 统计（约 5ms）
  const counted = filterAndCount(shotTable);

  // 从计分表里挑最高分的格子：easy 档头+身都算（满足于打中飞机），normal/hard 只看机头
  function bestCells() {
    let best = 0;
    let cells = [];
    for (let i = 0; i < unknown.length; i++) {
      const pos = unknown[i];
      const v = counted.headCount[pos] + (cfg.useBody ? counted.bodyCount[pos] : 0);
      if (v > best) { best = v; cells = [pos]; }
      else if (v === best && best > 0) cells.push(pos);
    }
    return cells;
  }

  let top = bestCells();

  // hard 档：并列最高时，选"若是空格能排除最多组合"的那格（更快锁定机头）
  if (cfg.smartTiebreak && top.length > 1) {
    let bestPos = top[0];
    let minAlive = Infinity;
    top.forEach(function (pos) {
      const t2 = Uint8Array.from(shotTable);
      t2[pos] = 1; // 假设打它是空格
      const aliveIfEmpty = countAlive(t2);
      if (aliveIfEmpty < minAlive) { minAlive = aliveIfEmpty; bestPos = pos; }
    });
    top = [bestPos];
  }

  // 理论上不会出现"一个组合都不剩"（对方的部署一定是合法的），防御性兜底
  if (!top.length) {
    const pos = unknown[Math.floor(Math.random() * unknown.length)];
    return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
  }

  const pos = top[Math.floor(Math.random() * top.length)];
  return { row: Math.floor(pos / BOARD_SIZE), col: pos % BOARD_SIZE };
}

module.exports = { LEVELS: LEVELS, randomDeployment: randomDeployment, chooseTarget: chooseTarget };
