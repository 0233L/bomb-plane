// ============================================
// tools/tune-ai.js —— AI 参数迭代调参（基准 vs 扰动，直到饱和）
//
// 流程：
//   1. 每轮：对扰动池里每个候选（基准的单参数 ± 小扰动，一次只动一个）
//      与当前基准对战 N 局（M 12×12 和 L 14×14 各一半），统计胜率
//   2. 胜率最高且超过阈值（默认 55%）的候选 → 成为新基准
//   3. 一轮下来没有任何候选胜出 → 连续两轮无提升 → 停止（饱和）
//   4. 输出每轮采纳记录、双方道具使用率、最终最优参数
//
// 用法：先启动服务器，再：
//   node tools/tune-ai.js            # 默认最多 6 轮
//   node tools/tune-ai.js 8          # 最多 8 轮
// 环境变量：TUNE_GAMES_PER_CAND（每候选局数，默认 10：M 5 + L 5）
//          TUNE_PARALLEL（并行房间数，默认 4）、TUNE_WINRATE（采纳阈值，默认 0.55）
//
// 说明：AI 决策（概率场采样/选格）跑在本脚本进程里，服务器只做规则校验，
// 因此并行开多个房间互不拖累（服务器瓶颈是消息处理，不是 AI 计算）。
// ============================================
'use strict';

const SELF = require('./selfplay-props.js');

const WS_URL = SELF.WS_URL;
const GAMES = parseInt(process.env.TUNE_GAMES_PER_CAND || '10', 10);
const PARALLEL = parseInt(process.env.TUNE_PARALLEL || '4', 10);
const WINRATE = parseFloat(process.env.TUNE_WINRATE || '0.55');
const MAX_ROUNDS = parseInt(process.argv[2] || '6', 10);
const STALE_ROUNDS = 2; // 连续几轮无采纳视为饱和

// 生产基准参数（与 ai.js 的 DECIDE_DEFAULTS + INFO_WEIGHT 一致；价格第 4 版联动）
// 2026-08 自对弈迭代最终采纳：exposeCoins=5、devourRatio=0.45（均 88% 胜出）；
// infoWeight 在 1.15↔1.3 间两轮震荡（88% vs 75%，8 局样本下等价），回生产值 1.3
const BASE = {
  infoWeight: 1.3,
  samples: 120,
  decide: {
    exposeCoins: 5, doomCoins: 6, doomRatio: 0.35,
    devourCoins: 3, devourRatio: 0.45, devourSum: 0.6,
    burstCoins: 4, burstV: 0.30,
    sonarCoins: 4, sonarEntropy: 0.4,
    proCoins: 4, proV: 0.5
  }
};

// 扰动表：每个参数 ± 的幅度（金币类 ±1，比率类 ±0.05，信息权重 ±0.15）
const PERTURB = {
  infoWeight: 0.15,
  exposeCoins: 1, doomCoins: 1, doomRatio: 0.05,
  devourCoins: 1, devourRatio: 0.05, devourSum: 0.1,
  burstCoins: 1, burstV: 0.05,
  sonarCoins: 1, sonarEntropy: 0.05,
  proCoins: 1, proV: 0.05
};

// 从基准克隆出一个候选：只改 key 为 value（统一四舍五入，避免浮点误差如 1.1500000000000001）
function candidate(base, key, value) {
  const v = Math.round(value * 100) / 100;
  const c = JSON.parse(JSON.stringify(base));
  if (key === 'infoWeight' || key === 'samples') c[key] = v;
  else c.decide[key] = v;
  return c;
}

// 参数变更描述（打印用）
function describe(key, value) {
  return key + '=' + value;
}

// 两个 cfg 对战 GAMES 局（M/L 各半、先后手交替，抵消先手优势），
// 返回 {winA, winB, usageA, usageB}（A 指 cfgA）
async function battle(cfgA, cfgB) {
  let winA = 0, winB = 0;
  const usageA = {}, usageB = {};
  const specs = [];
  for (let i = 0; i < GAMES / 2; i++) specs.push('M');
  for (let i = 0; i < GAMES / 2; i++) specs.push('L');
  const jobs = specs.map(function (spec, i) {
    // 交替先后手：cfgA 先手 ↔ cfgB 先手（runBattle 中 seat0 先走）
    const swapped = (i % 2 === 1);
    return function () {
      return SELF.runBattle(WS_URL, spec, swapped ? cfgB : cfgA, swapped ? cfgA : cfgB)
        .then(function (r) {
          if (!r) return null;
          const aWon = r.winner === (swapped ? 1 : 0);
          const bWon = r.winner === (swapped ? 0 : 1);
          if (aWon) winA++;
          else if (bWon) winB++;
          ['sonar', 'pro', 'expose', 'burst', 'devour', 'doom'].forEach(function (id) {
            usageA[id] = (usageA[id] || 0) + (r.usage[swapped ? 1 : 0][id] || 0);
            usageB[id] = (usageB[id] || 0) + (r.usage[swapped ? 0 : 1][id] || 0);
          });
          return null;
        });
    };
  });
  // 小并发池跑完所有局
  await pool(PARALLEL, jobs);
  return { winA: winA, winB: winB, usageA: usageA, usageB: usageB };
}

// 简单并发池：最多 n 个同时跑，全部完成后 resolve
function pool(n, fns) {
  return new Promise(function (resolve) {
    const out = new Array(fns.length);
    let next = 0;
    let done = 0;
    function worker() {
      if (next >= fns.length) return; // 没有新任务了（但进行中的任务仍会回来补位）
      const i = next++;
      Promise.resolve(fns[i]()).then(function (v) {
        out[i] = v;
        done++;
        if (done >= fns.length) { resolve(out); return; }
        worker(); // 完成一个，补一个
      }).catch(function (e) {
        // 单局失败（如偶发连接超时）不致命：记为空局继续跑，避免整个进程崩溃
        console.error('  ⚠️ 单局失败（' + (e && e.message || e) + '），按平局跳过');
        out[i] = null;
        done++;
        if (done >= fns.length) { resolve(out); return; }
        worker();
      });
    }
    const k = Math.min(n, fns.length);
    for (let i = 0; i < k; i++) worker();
  });
}

// 打印一张道具使用率表（每局平均）
function printUsage(title, usageA, usageB, games) {
  console.log('  [' + title + '] 道具使用率（次/局）：');
  ['sonar', 'pro', 'expose', 'burst', 'devour', 'doom'].forEach(function (id) {
    const a = ((usageA[id] || 0) / games).toFixed(2);
    const b = ((usageB[id] || 0) / games).toFixed(2);
    console.log('    ' + id + ': 基准 ' + a + ' / 候选 ' + b);
  });
}

async function main() {
  console.log('==== AI 参数迭代（最多 ' + MAX_ROUNDS + ' 轮，每候选 ' + GAMES + ' 局 M+L，采纳阈值 ' + WINRATE + '）====');
  let base = JSON.parse(JSON.stringify(BASE));
  let stale = 0;
  const history = [];

  for (let round = 1; round <= MAX_ROUNDS && stale < STALE_ROUNDS; round++) {
    console.log('\n—— 第 ' + round + ' 轮（基准：infoWeight=' + base.infoWeight +
      ', burstV=' + base.decide.burstV + ', burstCoins=' + base.decide.burstCoins + '…）——');
    // 构建扰动池：每个参数 ± 各一个候选
    const cands = [];
    Object.keys(PERTURB).forEach(function (key) {
      const cur = key === 'infoWeight' ? base.infoWeight : base.decide[key];
      [cur - PERTURB[key], cur + PERTURB[key]].forEach(function (val) {
        if (val <= 0) return;            // 阈值不能为负/零
        if (key.indexOf('Coins') !== -1 && val < 1) return; // 道具价至少 1
        if (key === 'infoWeight' && (val < 0.5 || val > 2.5)) return;
        cands.push({ key: key, value: Math.round(val * 100) / 100, cfg: candidate(base, key, val) });
      });
    });

    // 逐个候选 vs 基准
    let best = null;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const r = await battle(c.cfg, base, c.key);
      const games = GAMES;
      const winrate = r.winA / games;
      const flag = winrate >= WINRATE ? ' ★' : '';
      console.log('    ' + describe(c.key, c.value) + '：' + r.winA + '/' + games + '（' +
        (winrate * 100).toFixed(0) + '%）' + flag);
      if (winrate >= WINRATE && (!best || winrate > best.winrate)) {
        best = { cand: c, winrate: winrate, r: r };
      }
    }

    if (best) {
      console.log('  ✅ 采纳：' + describe(best.cand.key, best.cand.value) +
        '（胜率 ' + (best.winrate * 100).toFixed(0) + '%）');
      printUsage('采纳轮', best.r.usageA, best.r.usageB, GAMES);
      history.push({ round: round, key: best.cand.key, value: best.cand.value, winrate: best.winrate });
      base = best.cand.cfg;
      stale = 0;
    } else {
      console.log('  本轮无候选胜出');
      stale++;
      if (stale < STALE_ROUNDS) console.log('  连续 ' + stale + ' 轮无提升，再试 1 轮');
    }
  }

  console.log('\n==== 迭代结束 ====');
  if (history.length === 0) {
    console.log('无任何参数被采纳——当前基准已是局部最优（饱和）');
  } else {
    history.forEach(function (h) {
      console.log('第 ' + h.round + ' 轮采纳：' + h.key + ' → ' + h.value + '（胜率 ' + (h.winrate * 100).toFixed(0) + '%）');
    });
  }
  console.log('\n最终最优参数（与生产默认的差异）：');
  let diff = 0;
  if (base.infoWeight !== BASE.infoWeight) { console.log('  infoWeight: ' + BASE.infoWeight + ' → ' + base.infoWeight); diff++; }
  Object.keys(BASE.decide).forEach(function (key) {
    if (base.decide[key] !== BASE.decide[key]) { console.log('  ' + key + ': ' + BASE.decide[key] + ' → ' + base.decide[key]); diff++; }
  });
  if (diff === 0) console.log('  （无差异，与生产默认完全一致）');
  process.exit(0);
}

main().catch(function (e) {
  console.error('调参异常:', e && e.stack || e);
  process.exit(1);
});
