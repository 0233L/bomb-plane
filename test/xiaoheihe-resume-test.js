// ============================================
// test/xiaoheihe-resume-test.js —— 离线版「继续上局」服务端行为测试（Node vm）
// 验证：
//   1. 人机房间暂停后摘要不含飞机/落子；暂停期间 AI 不行动；
//   2. 恢复后人机继续走棋，快照 local2p = false；
//   3. 同屏双人快照 local2p = true，错误座位恢复返回非 fatal 失败，正确座位恢复；
//   4. 已结束的对局返回菜单 = 直接清房（leftRoom），不会留下续局卡。
// 用法：node test/xiaoheihe-resume-test.js
// 说明：离线版脚本是浏览器 IIFE（挂 window），这里用 vm 建一个 window = global
//       的沙箱，按 shared → local-ai → local-server 的顺序加载。
// ============================================
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'xiaoheihe', 'src', 'legacy');
const sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
const context = vm.createContext(sandbox);
vm.runInContext('globalThis.window = globalThis;', context);
['shared.js', 'local-ai.js', 'local-server.js'].forEach(function (name) {
  vm.runInContext(fs.readFileSync(path.join(base, name), 'utf8'), context, { filename: name });
});

const LocalServer = sandbox.LocalServer;
const LocalAI = sandbox.LocalAI;

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function track(server) {
  const events = [];
  ['roomCreated', 'battleStart', 'roomSuspended', 'resumeFailed', 'reconnected',
    'leftRoom', 'revealResult', 'deployReady', 'error'].forEach(function (name) {
    server.on(name, function (d) { events.push({ name: name, data: d }); });
  });
  return {
    events: events,
    last: function (name) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].name === name) return events[i].data;
      }
      return null;
    },
    count: function (name) {
      return events.filter(function (e) { return e.name === name; }).length;
    }
  };
}

(async function () {
  let passed = 0, failed = 0;
  function check(name, cond) {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name); }
  }

  const server = new LocalServer();
  const ev = track(server);

  // ===== 1. 人机：暂停 / 恢复 =====
  console.log('1. 人机对战暂停与恢复');
  server.emit('createRoomAI', { name: '我', avatar: '🐱', mode: 'classic', boardSize: 'S' });
  await sleep(30);
  const created = ev.last('roomCreated');
  check('创建人机房间', !!created && created.isAI === true && created.local2p === false);
  check('人机自动确认部署', !!server.room && server.room.players[1].deployConfirmed === true);

  const myPlanes = LocalAI.smartDeployment('S');
  check('测试用玩家布局生成成功', Array.isArray(myPlanes) && myPlanes.length === 3);
  server.emit('deployConfirm', { planes: myPlanes });
  check('双方确认后进入对战', !!server.room && server.room.phase === 'battle');
  check('开战后已安排 AI 思考', !!server.room.aiTimer);

  server.emit('suspendRoom');
  const summary = ev.last('roomSuspended');
  check('返回菜单发出 roomSuspended', !!summary);
  check('摘要含阶段/玩法/规格', summary && summary.phase === 'battle' &&
    summary.mode === 'classic' && summary.boardSize === 'S');
  check('摘要含双方昵称', summary && Array.isArray(summary.names) && summary.names.length === 2);
  check('摘要不含飞机', summary && !('planes' in summary) && !('myPlanes' in summary));
  check('摘要不含落子记录', summary && !('myShotsReceived' in summary) &&
    !('enemyShotsReceived' in summary) && !('shots' in summary));
  check('人机摘要 local2p = false', summary && summary.local2p === false);
  check('房间已标记暂停', !!server.room && server.room.suspended === true);
  check('AI 定时器已清空', server.room.aiTimer === null);

  const pausedSteps = server.room.steps.slice();
  server.emit('reveal', { row: 0, col: 0 });
  const pausedErr = ev.last('error');
  check('暂停期间揭示请求无效', ev.count('revealResult') === 0 &&
    !!pausedErr && pausedErr.message.indexOf('不在任何房间') !== -1);
  await sleep(2500);
  check('暂停期间 AI 不行动', server.room.steps[0] === pausedSteps[0] &&
    server.room.steps[1] === pausedSteps[1]);

  server.emit('resumeRoom', { seat: 0 });
  const snap = ev.last('reconnected');
  check('恢复成功并收到快照', !!snap && snap.phase === 'battle' && snap.seat === 0);
  check('人机快照 local2p = false', snap && snap.local2p === false);
  check('房间已取消暂停', server.room && server.room.suspended === false);

  let waited = 0;
  while (server.room && server.room.steps[1] === 0 && waited < 8000) {
    await sleep(250);
    waited += 250;
  }
  check('恢复后 AI 继续走棋', !!server.room && server.room.steps[1] > 0);
  check('恢复后有揭示结果', ev.count('revealResult') > 0);
  server.emit('leaveRoom');
  await sleep(20);

  // ===== 2. 同屏双人：暂停 / 错误座位 / 正确座位 =====
  console.log('2. 同屏双人暂停与交接');
  server.emit('createRoomLocal', { name: '小明', avatar: '🐱', mode: 'classic', boardSize: 'S' });
  await sleep(20);
  const created2 = ev.last('roomCreated');
  check('创建同屏房间', !!created2 && created2.local2p === true);

  server.emit('deployConfirm', { planes: LocalAI.smartDeployment('S') });
  server.emit('passReady', { seat: 1 });
  check('换到 1 号位部署', !!server.room && server.room.activeSeat === 1 &&
    server.room.clientSeat === 1);
  server.emit('deployConfirm', { planes: LocalAI.smartDeployment('S') });
  check('同屏双方确认后开战', !!server.room && server.room.phase === 'battle');
  const activeSeat = server.room.activeSeat;

  server.emit('suspendRoom');
  const summary2 = ev.last('roomSuspended');
  check('同屏摘要 local2p = true', summary2 && summary2.local2p === true);
  check('同屏摘要 activeSeat 正确', summary2 && summary2.activeSeat === activeSeat);

  const failsBefore = ev.count('resumeFailed');
  server.emit('resumeRoom', { seat: 1 - activeSeat });
  const wrong = ev.last('resumeFailed');
  check('错误座位恢复失败', ev.count('resumeFailed') === failsBefore + 1 && !!wrong);
  check('错误座位是非 fatal 失败', wrong && wrong.fatal === false);
  check('错误座位不破坏暂停房间', !!server.room && server.room.suspended === true);

  server.emit('resumeRoom', { seat: activeSeat });
  const snap2 = ev.last('reconnected');
  check('正确座位恢复成功', !!snap2 && snap2.seat === activeSeat);
  check('同屏快照 local2p = true', snap2 && snap2.local2p === true);
  check('恢复后取消暂停', server.room && server.room.suspended === false);

  // ===== 3. 已结束的对局：返回菜单直接清房 =====
  console.log('3. 已结束的对局不再续局');
  server._endGame(activeSeat, 'allHeads');
  check('对局进入结束状态', server.room && server.room.phase === 'over');
  const suspendedBefore = ev.count('roomSuspended');
  server.emit('suspendRoom');
  check('结束后返回菜单不产生续局摘要', ev.count('roomSuspended') === suspendedBefore);
  check('结束后返回菜单发出 leftRoom', ev.count('leftRoom') > 0);
  check('结束后房间已清空', server.room === null);

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('FAIL', e);
  process.exit(1);
});
