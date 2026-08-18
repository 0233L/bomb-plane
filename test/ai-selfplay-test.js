// ============================================
// test/ai-selfplay-test.js —— AI 自对弈统计测试（不连服务器、不 spawn 进程）
// 用途：AI 加强的分步对照实验。测试自己生成合法棋盘、按服务器同款规则
//       结算揭示，直接 require ai.js 跑完整对局，比较平均步数 / 胜率。
// 用法：node test/ai-selfplay-test.js
//
// 实验 A（智能部署）：同一射手（经典 S 熵贪心）分别打「智能部署」和
//   「随机部署」的棋盘，记录打到全部机头所需的步数。步数更高 = 部署更难打。
//   断言：智能部署不劣于随机（胜率 ≥ 50%），并报告平均差。
//
// 实验 B（采样概率场选格）：M 棋盘，概率场 vs 简单贪心，比平均步数
// 实验 C（声呐锚点价值）：M 棋盘，每 4 步放一次声呐，「信息增益锚点」vs「随机锚点」，
//   比找到全部机头的步数。每个实验独立小节，输出均值 + 判定。
// ============================================
'use strict';
const ai = require('../ai.js');
const shared = require('../public/shared.js');
const { buildBoard, CELL_HEAD, CELL_BODY, CELL_EMPTY } = shared;

const GAMES_A = 40;  // 实验 A 局数（每局打智能/随机各一张棋盘）
const GAMES_B = 20;  // 实验 B 局数（每局打概率场/简单贪心各一张棋盘）
const GAMES_C = 20;  // 实验 C 局数（每局打增益锚点/随机锚点各一张棋盘）

// 打完整局：给定部署生成函数 + 选格函数，模拟揭示直到找齐全部机头。
// 返回所需步数。选格函数签名：(shots, size) => {row, col}
function playGame(spec, deployFn, chooseFn) {
  const planes = deployFn(spec);
  if (!planes) throw new Error('部署生成失败');
  const board = buildBoard(planes, spec);
  const size = shared.getBoardSpec(spec).size;
  const shots = [];
  let headsLeft = planes.length;
  while (headsLeft > 0) {
    const t = chooseFn(shots, size);
    if (!t || t.row === undefined) throw new Error('AI 无候选格');
    const v = board[t.row][t.col];
    shots.push({
      row: t.row, col: t.col,
      result: v === CELL_HEAD ? 'head' : v === CELL_BODY ? 'body' : 'empty'
    });
    if (v === CELL_HEAD) headsLeft--;
  }
  return shots.length;
}

// ===== 实验 A：智能部署 vs 随机部署（经典 S，射手 = 熵贪心 chooseTargetLive） =====
function experimentA() {
  const shooter = function (shots, size) {
    return ai.chooseTargetLive(shots); // 经典 S 实战算法，行为不变
  };
  let smartWins = 0;
  let totalDiff = 0;
  const times = [];
  for (let g = 0; g < GAMES_A; g++) {
    const t0 = Date.now();
    const shotsSmart = playGame('S', ai.smartDeployment, shooter);
    const shotsRandom = playGame('S', ai.randomDeployment, shooter);
    times.push(Date.now() - t0);
    if (shotsSmart > shotsRandom) smartWins += 1;
    else if (shotsSmart === shotsRandom) smartWins += 0.5;
    totalDiff += shotsSmart - shotsRandom;
  }
  const winRate = smartWins / GAMES_A;
  console.log('  [A] 智能部署 vs 随机部署（' + GAMES_A + ' 局，射手 = 熵贪心）');
  console.log('  [A] 胜率（步数更多 = 更难打）: ' + (winRate * 100).toFixed(1) + '%');
  console.log('  [A] 平均步数差（智能 − 随机）: ' + (totalDiff / GAMES_A).toFixed(2) + ' 步');
  console.log('  [A] 耗时合计: ' + times.reduce(function (a, b) { return a + b; }) + 'ms');
  return winRate >= 0.5;
}

// ===== 实验 B：采样概率场 vs 简单贪心（M 棋盘，射手都用随机部署） =====
// 两个射手打各自的棋盘，步数更少的 = 选格更强
function experimentB() {
  const probShooter = function (shots, size) {
    return ai.chooseTargetProbField(shots, size, [], { samples: 24 });
  };
  const simpleShooter = function (shots, size) {
    return ai.chooseTargetSimple(shots, size);
  };
  let probWins = 0;
  let totalDiff = 0;
  const t0 = Date.now();
  for (let g = 0; g < GAMES_B; g++) {
    const shotsProb = playGame('M', ai.randomDeployment, probShooter);
    const shotsSimple = playGame('M', ai.randomDeployment, simpleShooter);
    if (shotsProb < shotsSimple) probWins += 1;
    else if (shotsProb === shotsSimple) probWins += 0.5;
    totalDiff += shotsProb - shotsSimple;
  }
  const winRate = probWins / GAMES_B;
  console.log('  [B] 概率场 vs 简单贪心（' + GAMES_B + ' 局，M 棋盘）');
  console.log('  [B] 胜率（步数更少 = 更强）: ' + (winRate * 100).toFixed(1) + '%');
  console.log('  [B] 平均步数差（概率场 − 简单）: ' + (totalDiff / GAMES_B).toFixed(2) + ' 步');
  console.log('  [B] 耗时: ' + (Date.now() - t0) + 'ms');
  return winRate >= 0.5;
}

// ===== 实验 C：声呐锚点「信息增益」vs「随机」（M 棋盘，选格都用概率场） =====
// 带声呐的完整对局：每 sonarEvery 步用一次声呐（sonarPicker 决定锚点），
// 声呐计数进概率场约束（和真实对局一致）。返回找到全部机头的步数。
function playGameWithSonar(spec, chooseFn, sonarPicker, sonarEvery) {
  const planes = ai.randomDeployment(spec);
  const board = buildBoard(planes, spec);
  const size = shared.getBoardSpec(spec).size;
  const shots = [];
  const sonarCounts = [];
  let headsLeft = planes.length;
  let step = 0;
  while (headsLeft > 0) {
    if (sonarPicker && step % sonarEvery === 0) {
      const anchor = sonarPicker(shots, sonarCounts, size);
      if (anchor) {
        let n = 0;
        for (let r = anchor.row; r < anchor.row + 3; r++) {
          for (let c = anchor.col; c < anchor.col + 3; c++) {
            if (board[r][c] !== CELL_EMPTY) n++;
          }
        }
        sonarCounts.push({ row: anchor.row, col: anchor.col, count: n });
      }
    }
    const t = chooseFn(shots, size, sonarCounts);
    if (!t || t.row === undefined) throw new Error('AI 无候选格');
    const v = board[t.row][t.col];
    shots.push({
      row: t.row, col: t.col,
      result: v === CELL_HEAD ? 'head' : v === CELL_BODY ? 'body' : 'empty'
    });
    if (v === CELL_HEAD) headsLeft--;
    step++;
  }
  return shots.length;
}

function experimentC() {
  // 选格统一用概率场（带声呐约束）
  const chooser = function (shots, size, sonarCounts) {
    return ai.chooseTargetProbField(shots, size, [], { samples: 24, sonarCounts: sonarCounts || [] });
  };
  // 增益锚点：分布熵最大；随机锚点：均匀随机
  const gainPicker = function (shots, sonarCounts, size) {
    const pf = ai.buildProbField(shots, size, { samples: 24, sonarCounts: sonarCounts || [] });
    return ai.chooseSonarAnchor(pf, size, []);
  };
  const randPicker = function () {
    return { row: Math.floor(Math.random() * 10), col: Math.floor(Math.random() * 10) }; // 12×12 → 锚点 0..9
  };
  let gainWins = 0;
  let totalDiff = 0;
  const t0 = Date.now();
  for (let g = 0; g < GAMES_C; g++) {
    const shotsGain = playGameWithSonar('M', chooser, gainPicker, 4);
    const shotsRand = playGameWithSonar('M', chooser, randPicker, 4);
    if (shotsGain < shotsRand) gainWins += 1;
    else if (shotsGain === shotsRand) gainWins += 0.5;
    totalDiff += shotsGain - shotsRand;
  }
  const winRate = gainWins / GAMES_C;
  console.log('  [C] 信息增益锚点 vs 随机锚点（' + GAMES_C + ' 局，M 棋盘，每 4 步一声呐）');
  console.log('  [C] 胜率（步数更少 = 更强）: ' + (winRate * 100).toFixed(1) + '%');
  console.log('  [C] 平均步数差（增益 − 随机）: ' + (totalDiff / GAMES_C).toFixed(2) + ' 步');
  console.log('  [C] 耗时: ' + (Date.now() - t0) + 'ms');
  return winRate >= 0.5;
}

// ===== 主流程 =====
const results = [experimentA(), experimentB(), experimentC()];
console.log('\n结果: ' + results.filter(Boolean).length + '/' + results.length + ' 个实验通过');
process.exitCode = results.every(Boolean) ? 0 : 1;
