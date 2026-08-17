// ============================================
// test/e2e-test.js —— 自动化对局测试（可选）
//
// 用法：
//   1. 先以短回收计时启动服务器：
//      RECYCLE_SECONDS=3 node server.js
//   2. 再运行本测试：
//      node test/e2e-test.js
//
// 测试内容（模拟两名玩家 A/B 完整走一遍）：
//   建房 → 加入 → 部署 → 开战 → 步数规则 → 胜利 → 再来一局
//   → 断线重连 → 断线不判负 → 离开不判负 → 异常输入
// ============================================
'use strict';

// 原生 WebSocket 客户端：复用 public/ws.js（Node 里先提供一个全局 WebSocket）
global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const URL = 'http://localhost:3000';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 等待某个 socket 收到指定事件
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 4000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}

// 等待满足条件的指定事件（先注册再 emit 用；不满足条件的事件会被过滤继续等）
function waitForMatch(socket, event, predicate, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { socket.off(event, handler); reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 4000);
    function handler(d) {
      if (!predicate(d)) return; // 例如过滤掉玩家自己的 revealResult
      clearTimeout(t);
      socket.off(event, handler);
      resolve(d);
    }
    socket.on(event, handler);
  });
}

// 随机生成一份合法部署（复用 shared.js 的校验逻辑，和真实游戏一致）
function randomDeployment() {
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < shared.PLANE_COUNT; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * shared.BOARD_SIZE);
    const headCol = Math.floor(Math.random() * shared.BOARD_SIZE);
    const occupied = [];
    planes.forEach(function (p) {
      shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (c) { occupied.push(c); });
    });
    if (shared.canPlacePlane(occupied, headRow, headCol, dir)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes.length === shared.PLANE_COUNT ? planes : null;
}

async function main() {
  const A = new WSClient(URL);
  const B = new WSClient(URL);
  await Promise.all([waitFor(A, 'connect'), waitFor(B, 'connect')]);

  // 0. 访客统计（服务端匿名 ID 计数 + /stats 明细页 + stats.json 落盘）
  //    注意：ID 用 Date.now() 生成，stats.json 跨运行持久，断言必须相对（不能写死总数）
  console.log('— 访客统计 —');
  const fsx = require('fs');
  const pathx = require('path');
  const vidA = 'e2e-' + Date.now() + '-A';
  const vidB = 'e2e-' + Date.now() + '-B';
  A.emit('visit', { visitorId: vidA, platform: 'web' });
  const vrA = await waitFor(A, 'visitResult');
  check('首次访问被计数', vrA.total >= 1);
  B.emit('visit', { visitorId: vidB, platform: 'web' });
  const vrB = await waitFor(B, 'visitResult');
  check('第二个访客让总数 +1', vrB.total === vrA.total + 1);
  A.emit('visit', { visitorId: vidA, platform: 'web' }); // 5 分钟内重复连接
  const vrA2 = await waitFor(A, 'visitResult');
  check('重复连接不增加唯一总数', vrA2.total === vrB.total);

  // /stats 明细页（Node 18+ 自带 fetch）
  const STATS_KEY = process.env.STATS_KEY || 'bombplane-stats-2026';
  const okRes = await fetch('http://localhost:3000/stats?key=' + encodeURIComponent(STATS_KEY));
  check('/stats 正确钥匙返回 200', okRes.status === 200);
  const html = await okRes.text();
  check('/stats 列出两位访客记录', html.indexOf(vidA) !== -1 && html.indexOf(vidB) !== -1);
  check('/stats 不泄露任何飞机坐标', html.indexOf('headRow') === -1);
  const badRes = await fetch('http://localhost:3000/stats?key=wrong');
  const noKeyRes = await fetch('http://localhost:3000/stats');
  check('/stats 错误或缺失钥匙返回 403', badRes.status === 403 && noKeyRes.status === 403);

  // stats.json 落盘（等过 1 秒防抖再读）
  await sleep(1500);
  const saved = JSON.parse(fsx.readFileSync(pathx.join(__dirname, '..', 'stats.json'), 'utf8'));
  check('stats.json 已写入两位访客', !!(saved.visitors[vidA] && saved.visitors[vidB]));
  check('重复连接未增加该访客频次', saved.visitors[vidA].visits === 1);
  check('记录含平台与时间戳', saved.visitors[vidB].platform === 'web' &&
    typeof saved.visitors[vidB].firstVisit === 'number' && typeof saved.visitors[vidB].lastVisit === 'number');

  console.log('— 房间与部署 —');

  // 1. 建房 + 加入
  A.emit('createRoom', { name: '小明' });
  const created = await waitFor(A, 'roomCreated');
  check('创建房间并拿到 4 位房间号', /^[A-Z0-9]{4}$/.test(created.roomId) && created.seat === 0);

  B.emit('joinRoom', { roomId: created.roomId, name: '小红' });
  const joined = await waitFor(B, 'joinedRoom');
  check('加入房间成功', joined.roomId === created.roomId && joined.seat === 1);
  const oppJoined = await waitFor(A, 'opponentJoined');
  check('房主收到对手加入通知', oppJoined.names[1] === '小红');

  // 2. 双方部署并确认
  const deployA = randomDeployment();
  const deployB = randomDeployment();
  check('A 生成合法部署（用真实校验逻辑）', !!deployA && shared.validateDeployment(deployA) === null);
  check('B 生成合法部署（用真实校验逻辑）', !!deployB && shared.validateDeployment(deployB) === null);

  // 先试一份非法部署（3 架重叠），应被拒绝
  const badPlanes = JSON.parse(JSON.stringify(deployA));
  badPlanes[1] = { headRow: badPlanes[0].headRow, headCol: badPlanes[0].headCol, dir: badPlanes[0].dir };
  A.emit('deployConfirm', { planes: badPlanes });
  const badErr = await waitFor(A, 'error');
  check('重叠部署被服务器拒绝', badErr.message.indexOf('重叠') !== -1 || badErr.message.indexOf('越界') !== -1);

  A.emit('deployConfirm', { planes: deployA });
  const readyA = await waitFor(A, 'deployReady');
  check('A 确认部署', readyA.confirmed[0] === true && readyA.confirmed[1] === false);

  B.emit('deployConfirm', { planes: deployB });
  const battle = await waitFor(A, 'battleStart');
  check('双方确认后开战，步数归零', battle.steps[0] === 0 && battle.steps[1] === 0);
  check('第一局比分从 0:0 开始', battle.score[0] === 0 && battle.score[1] === 0);

  // 3. 步数规则
  console.log('— 步数规则 —');
  const errA = [], errB = [];
  A.on('error', function (d) { errA.push(d.message); });
  B.on('error', function (d) { errB.push(d.message); });

  let last = null;              // 最近一次 revealResult
  let gameOver = null;          // 最近一次 gameOver
  A.on('revealResult', function (d) { last = d; });
  B.on('revealResult', function (d) { last = d; });
  A.on('gameOver', function (d) { gameOver = d; });
  B.on('gameOver', function (d) { gameOver = d; });

  const headsA = deployA.map(function (p) { return [p.headRow, p.headCol]; });
  const revealed = new Set();
  const isHeadA = function (r, c) { return headsA.some(function (h) { return h[0] === r && h[1] === c; }); };
  // 找一个"垫步"格子：没揭示过、且不是 A 的机头（机头留给 B 打）
  function pickFiller() {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (!revealed.has(r + ',' + c) && !isHeadA(r, c)) return [r, c];
      }
    }
    return null;
  }
  async function reveal(sock, r, c) {
    sock.emit('reveal', { row: r, col: c });
    await sleep(150);
    revealed.add(r + ',' + c);
  }

  // 步数规则测试的垫步格子全部动态挑选：避开 A 的机头（机头留给后面的胜利测试打），
  // 而且每次揭示前重新挑选（revealed 集合在变化），这样随机部署也不影响测试结果
  const f1 = pickFiller();

  // 开局双方都是 0 步：A 可以下
  await reveal(A, f1[0], f1[1]);
  check('双方 0 步时 A 可下（无先手之分）', last && last.attacker === 0 && last.steps[0] === 1 && last.steps[1] === 0);

  // A 领先 1 步后不能再下
  const f2 = pickFiller();
  const errBefore = errA.length;
  await reveal(A, f2[0], f2[1]);
  check('A 领先后再下被拒绝', errA.length > errBefore && errA[errA.length - 1].indexOf('领先') !== -1);

  // B 落后，可以连下两步反超（补步 + 抢步）
  const f3 = pickFiller();
  await reveal(B, f3[0], f3[1]);
  const f4 = pickFiller();
  await reveal(B, f4[0], f4[1]);
  check('B 连下两步反超（步数 1:2）', last && last.steps[0] === 1 && last.steps[1] === 2);

  // B 领先 1 步后不能再下
  const f5 = pickFiller();
  const errB_Before = errB.length;
  await reveal(B, f5[0], f5[1]);
  check('B 领先后再下被拒绝', errB.length > errB_Before && errB[errB.length - 1].indexOf('领先') !== -1);

  // 重复揭示同一格被拒绝
  const errA2 = errA.length;
  await reveal(A, f1[0], f1[1]);
  check('重复揭示被拒绝', errA.length > errA2 && errA[errA.length - 1].indexOf('已经揭示') !== -1);

  // 4. 胜利：B 依次击中 A 的 3 个机头（每领先一次就让 A 垫一步）
  console.log('— 胜利判定 —');
  const remainingHeads = headsA.filter(function (h) { return !revealed.has(h[0] + ',' + h[1]); });
  check('规则测试后 A 的 3 个机头仍未被击中', remainingHeads.length === 3);
  for (let i = 0; i < remainingHeads.length; i++) {
    if (gameOver) break;
    if (last && last.steps[1] > last.steps[0]) {
      const filler = pickFiller();
      await reveal(A, filler[0], filler[1]);  // A 垫一步，让 B 恢复行动权
    }
    await reveal(B, remainingHeads[i][0], remainingHeads[i][1]);
  }
  await sleep(200);
  check('B 击中 3 个机头获胜', gameOver && gameOver.winner === 1 && gameOver.reason === 'allHeads');
  check('胜利时双方机头数正确', gameOver && gameOver.headsLeft[0] === 0);
  check('胜利后比分累计 0:1', gameOver && gameOver.score[0] === 0 && gameOver.score[1] === 1);

  // 结束后不能再攻击
  const errA3 = errA.length;
  A.emit('reveal', { row: 5, col: 5 });
  await sleep(150);
  check('结束后攻击被拒绝', errA.length > errA3);

  // 对局结束：服务器公开双方飞机坐标（前端据此暗色显示未探测格子）
  check('对局结束公开双方飞机坐标', gameOver && Array.isArray(gameOver.planes) &&
    shared.validateDeployment(gameOver.planes[0]) === null &&
    shared.validateDeployment(gameOver.planes[1]) === null);

  // 结束后才进入的观战者：快照也带双方飞机
  const G0 = new WSClient(URL);
  await waitFor(G0, 'connect');
  G0.emit('joinRoom', { roomId: created.roomId, name: '事后观众' });
  const specOver = await waitFor(G0, 'spectatorJoined');
  check('结束后进入的观战者拿到双方飞机', specOver.phase === 'over' &&
    Array.isArray(specOver.planes) &&
    shared.validateDeployment(specOver.planes[0]) === null &&
    shared.validateDeployment(specOver.planes[1]) === null);
  G0.disconnect();

  // 5. 再来一局（含投票数显示）
  console.log('— 再来一局 —');
  const voteB = waitFor(B, 'rematchVote');
  A.emit('rematch');
  const vote1 = await voteB;
  check('投票广播（1 票）', vote1.votes[0] === true && vote1.votes[1] === false);

  const restartP = Promise.all([waitFor(A, 'rematchStart'), waitFor(B, 'rematchStart')]);
  B.emit('rematch');
  await restartP;
  check('双方同意后重新开始', true);

  // 再来一局后步数已归零（重新部署、重新开战）
  const dA2 = randomDeployment();
  const dB2 = randomDeployment();
  A.emit('deployConfirm', { planes: dA2 });
  await waitFor(A, 'deployReady');
  B.emit('deployConfirm', { planes: dB2 });
  const battle2 = await waitFor(A, 'battleStart');
  check('第二局开战且步数归零', battle2.steps[0] === 0 && battle2.steps[1] === 0);
  check('第二局带着上一局比分 0:1 开战', battle2.score[0] === 0 && battle2.score[1] === 1);

  // 6. 断线重连
  console.log('— 断线重连 —');
  const disconnP = waitFor(B, 'playerStatus');
  A.disconnect();
  const disconn = await disconnP;
  check('A 断线后 B 收到离线状态通知', disconn.seat === 0 && disconn.connected === false);

  const A2 = new WSClient(URL);
  await waitFor(A2, 'connect');
  // 注意：B 端的监听要先注册好，再发 rejoin（事件发出得很快，先发后听会漏掉）
  const reconnB = waitFor(B, 'playerStatus');
  A2.emit('rejoin', { token: created.token, roomId: created.roomId });
  const restored = await waitFor(A2, 'reconnected');
  check('重连成功并恢复现场', restored.phase === 'battle' && restored.seat === 0 && restored.steps[0] === 0);
  const reconnB2 = await reconnB;
  check('B 收到 A 上线的状态通知', reconnB2.seat === 0 && reconnB2.connected === true);

  // 7. 断线不再判负：B 断线超过回收计时，游戏仍在进行；B 重连后还能继续下棋
  console.log('— 断线不再判负 —');
  let gameOver2 = null;
  A2.on('gameOver', function (d) { gameOver2 = d; });
  const disconnB2 = waitFor(A2, 'playerStatus');
  B.disconnect();
  const st = await disconnB2;
  check('B 断线后 A2 收到离线状态通知', st.seat === 1 && st.connected === false);
  await sleep(3500); // 等过 RECYCLE_SECONDS=3 的回收计时（对方在线，房间不应被回收）
  check('断线超过回收计时也没有判负', gameOver2 === null);

  // B 重连回来，对局还能继续
  const B2 = new WSClient(URL);
  await waitFor(B2, 'connect');
  B2.on('gameOver', function (d) { gameOver2 = d; });
  const reconnA2 = waitFor(A2, 'playerStatus');
  B2.emit('rejoin', { token: joined.token, roomId: created.roomId });
  const restoredB = await waitFor(B2, 'reconnected');
  check('断线方等待后重连成功', restoredB.phase === 'battle' && restoredB.seat === 1);
  const st2 = await reconnA2;
  check('A2 收到 B 上线的状态通知', st2.seat === 1 && st2.connected === true);

  // 重连后仍可下棋：B 走一步（挑一个不是 A 机头的格子，避免误触发胜利）
  const headsA2 = dA2.map(function (p) { return [p.headRow, p.headCol]; });
  let filler2 = null;
  for (let r = 0; r < 10 && !filler2; r++) {
    for (let c = 0; c < 10; c++) {
      if (!headsA2.some(function (h) { return h[0] === r && h[1] === c; })) { filler2 = [r, c]; break; }
    }
  }
  const rrP = waitFor(B2, 'revealResult');
  B2.emit('reveal', { row: filler2[0], col: filler2[1] });
  const rr = await rrP;
  check('重连后仍可继续对战', rr.attacker === 1 && rr.steps[0] === 0 && rr.steps[1] === 1);

  // 8. 主动离开也不判负：离开 = 暂停，随时可以回来继续
  console.log('— 离开不判负 —');
  const leftP = waitFor(A2, 'leftRoom');
  const statusP = waitFor(B2, 'playerStatus');
  A2.emit('leaveRoom');
  await leftP;
  const st3 = await statusP;
  check('A 离开后 B 收到离线状态通知', st3.seat === 0 && st3.connected === false);
  await sleep(200);
  check('A 主动离开也没有判负', gameOver2 === null);

  // A 从菜单回来继续
  const A3 = new WSClient(URL);
  await waitFor(A3, 'connect');
  const stP3 = waitFor(B2, 'playerStatus');
  A3.emit('rejoin', { token: created.token, roomId: created.roomId });
  const restoredA3 = await waitFor(A3, 'reconnected');
  check('离开后重连成功', restoredA3.phase === 'battle' && restoredA3.seat === 0);
  const st4 = await stP3;
  check('B 收到 A 上线的状态通知', st4.seat === 0 && st4.connected === true);

  // 离开前后步数保持，对局还能继续：A 走一步（避开机头和 B 打过的格子）
  let filler3 = null;
  for (let r = 0; r < 10 && !filler3; r++) {
    for (let c = 0; c < 10; c++) {
      const isHead = headsA2.some(function (h) { return h[0] === r && h[1] === c; });
      if (!isHead && !(r === filler2[0] && c === filler2[1])) { filler3 = [r, c]; break; }
    }
  }
  const rrP3 = waitFor(A3, 'revealResult');
  A3.emit('reveal', { row: filler3[0], col: filler3[1] });
  const rr3 = await rrP3;
  check('离开重连后仍可继续对战', rr3.attacker === 0 && rr3.steps[0] === 1 && rr3.steps[1] === 1);

  // 9. 异常输入
  console.log('— 异常输入 —');
  const C = new WSClient(URL);
  await waitFor(C, 'connect');
  C.emit('joinRoom', { roomId: 'ZZZZ', name: '路人' });
  const errRoom = await waitFor(C, 'error');
  check('加入不存在的房间被拒绝', errRoom.message.indexOf('不存在') !== -1);

  C.emit('createRoom', { name: '   ' });
  const errName = await waitFor(C, 'error');
  check('空昵称被拒绝', errName.message.indexOf('昵称') !== -1);

  C.emit('createRoom', { name: '小明' });
  const created2 = await waitFor(C, 'roomCreated');
  const D = new WSClient(URL);
  await waitFor(D, 'connect');
  D.emit('joinRoom', { roomId: created2.roomId, name: '小明' });
  const errDup = await waitFor(D, 'error');
  check('同房间重名被拒绝', errDup.message.indexOf('昵称') !== -1);

  // 10. 房间存活查询 + 失效提示（「最近加入的房间」列表自动清理用）
  const aliveP = waitFor(C, 'roomsAlive');
  C.emit('checkRooms', { roomIds: [created.roomId, created2.roomId, 'ZZZZ'] });
  const alive = await aliveP;
  check('checkRooms 只返回还活着的房间', alive.alive.indexOf(created.roomId) !== -1 &&
    alive.alive.indexOf(created2.roomId) !== -1 && alive.alive.indexOf('ZZZZ') === -1);

  C.emit('rejoin', { token: 'bad-token', roomId: 'ZZZZ' });
  const failRejoin = await waitFor(C, 'rejoinFailed');
  check('rejoinFailed 带上 roomId 便于客户端删除失效条目', failRejoin.roomId === 'ZZZZ' && failRejoin.message.length > 0);

  // 11. 观战：满员房间第三人进入观战席
  console.log('— 观战 —');
  // 房间2 现在只有 C 一人（D 之前重名被拒），先让 D 用别的名字加入凑满
  D.emit('joinRoom', { roomId: created2.roomId, name: '小刚' });
  await waitFor(D, 'joinedRoom');

  const E = new WSClient(URL);
  await waitFor(E, 'connect');
  const errE = [];
  E.on('error', function (d) { errE.push(d.message); });
  const countCP = waitFor(C, 'spectatorCount');
  E.emit('joinRoom', { roomId: created2.roomId, name: '小刚' }); // 观战者允许和玩家重名
  const spec = await waitFor(E, 'spectatorJoined');
  check('满员房间进入观战席（部署阶段）', spec.roomId === created2.roomId && spec.phase === 'deploy');
  check('观战快照含双方昵称和打击记录', spec.names[0] === '小明' && spec.names[1] === '小刚' && spec.shots.length === 2);
  const countC1 = await countCP;
  check('房主收到观战人数 1', countC1.count === 1);

  E.emit('reveal', { row: 0, col: 0 });
  await sleep(150);
  check('观战者不能下棋', errE.length === 1);

  // 双方部署开战，观战者自动同步进入对战
  const dC = randomDeployment(), dD = randomDeployment();
  C.emit('deployConfirm', { planes: dC });
  await waitFor(C, 'deployReady');
  D.emit('deployConfirm', { planes: dD });
  await Promise.all([waitFor(C, 'battleStart'), waitFor(D, 'battleStart'), waitFor(E, 'battleStart')]);
  check('观战者同步收到开战', true);

  // 对局中的揭示，观战者实时可见
  const rrEP = waitFor(E, 'revealResult');
  C.emit('reveal', { row: 0, col: 0 });
  const rrE = await rrEP;
  check('观战者实时收到揭示结果', rrE.attacker === 0 && rrE.steps[0] === 1);

  // 观战者不能确认部署
  const errE2 = errE.length;
  E.emit('deployConfirm', { planes: dC });
  await sleep(150);
  check('观战者不能确认部署', errE.length > errE2);

  // 第二个观战者在对局中进入：快照应带上已公开的揭示记录
  const F = new WSClient(URL);
  await waitFor(F, 'connect');
  const errF = [];
  F.on('error', function (d) { errF.push(d.message); });
  const countCP2 = waitFor(C, 'spectatorCount');
  F.emit('joinRoom', { roomId: created2.roomId, name: '观众乙' });
  const specF = await waitFor(F, 'spectatorJoined');
  check('对局中进入观战席', specF.phase === 'battle');
  check('观战快照包含已公开的揭示记录', specF.shots[1].length === 1);
  const countC2 = await countCP2;
  check('房主收到观战人数 2', countC2.count === 2);

  F.emit('reveal', { row: 0, col: 0 });
  await sleep(150);
  check('第二个观战者也不能下棋', errF.length === 1);

  // 观战者离开：人数广播递减到 0
  // 注意：两条 once 监听不能同时挂，否则 F 断开的 count=1 会同时喂给两个监听器
  const countCP3 = waitFor(C, 'spectatorCount');
  F.disconnect();
  const countC3 = await countCP3;
  check('观战者断开后人数降为 1', countC3.count === 1);

  const countCP4 = waitFor(C, 'spectatorCount');
  E.disconnect();
  const countC4 = await countCP4;
  check('观战者全部离开后人数归 0', countC4.count === 0);

  // 12. 房间回收通知观战者：双方都离开后房间回收，还挂着的观战者收到 roomClosed
  console.log('— 房间回收通知观战者 —');
  const G = new WSClient(URL);
  await waitFor(G, 'connect');
  G.emit('joinRoom', { roomId: created.roomId, name: '观众丙' });
  const specG = await waitFor(G, 'spectatorJoined');
  check('观战者可进入正在对战的房间', specG.phase === 'battle');

  const closedP = waitFor(G, 'roomClosed', 5000);
  A3.disconnect(); B2.disconnect(); // 双方都离开：回收计时开始，房间里只剩观战者 G
  const closed = await closedP;
  check('双方都离开后房间回收，观战者收到 roomClosed', closed.message.length > 0);
  G.disconnect();

  // 13. 人机对战
  console.log('— 人机对战 —');
  const aiMod = require('../ai.js');

  // A. ai.js 纯函数单测（不连服务器，确定性）
  let allDeployOk = true;
  for (let i = 0; i < 100; i++) {
    const d = aiMod.randomDeployment();
    if (!d || shared.validateDeployment(d) !== null) { allDeployOk = false; break; }
  }
  check('AI 随机部署 100 次全部合法', allDeployOk);

  const t1 = aiMod.chooseTarget([]);
  check('空信息时 AI 给出合法目标', !!t1 && t1.row >= 0 && t1.row < 10 && t1.col >= 0 && t1.col < 10);
  const tDup = aiMod.chooseTarget([{ row: 3, col: 4, result: 'empty' }]);
  check('已揭示的格子 AI 不会重复打', !(tDup.row === 3 && tDup.col === 4));
  let nearCount = 0;
  for (let i = 0; i < 40; i++) {
    const t = aiMod.chooseTargetGreedy([{ row: 5, col: 5, result: 'body' }]);
    if (Math.abs(t.row - 5) + Math.abs(t.col - 5) <= 3) nearCount++;
  }
  check('旧算法打中机身后顺着机身找头（40 次中 ' + nearCount + ' 次在附近）', nearCount >= 30);
  let nearCount2 = 0;
  for (let i = 0; i < 20; i++) {
    const t = aiMod.chooseTarget([{ row: 5, col: 5, result: 'body' }]);
    if (Math.abs(t.row - 5) + Math.abs(t.col - 5) <= 3) nearCount2++;
  }
  check('前瞻打分版（实验备用，实战未用）同样顺藤摸瓜（20 次中 ' + nearCount2 + ' 次在附近）', nearCount2 >= 15);

  // Rollout 版（实战在用，AI_ROLLOUT 开关控制）冒烟：小参数快速跑，只验基本合法性
  const tR1 = aiMod.chooseTargetRollout([], { K: 3, P: 100, M: 1 });
  check('rollout 空信息时给出合法目标', !!tR1 && tR1.row >= 0 && tR1.row < 10 && tR1.col >= 0 && tR1.col < 10);
  const tR2 = aiMod.chooseTargetRollout([{ row: 3, col: 4, result: 'empty' }], { K: 3, P: 100, M: 1 });
  check('rollout 已揭示的格子不会重复打', !(tR2.row === 3 && tR2.col === 4));
  let nearCount3 = 0;
  for (let i = 0; i < 10; i++) {
    const t = aiMod.chooseTargetRollout([{ row: 5, col: 5, result: 'body' }], { K: 4, P: 200, M: 2 });
    if (Math.abs(t.row - 5) + Math.abs(t.col - 5) <= 3) nearCount3++;
  }
  check('rollout 打中机身后也顺藤摸瓜（10 次中 ' + nearCount3 + ' 次在附近）', nearCount3 >= 6);

  // B. 人机房间完整流程
  const P = new WSClient(URL);
  await waitFor(P, 'connect');
  P.on('error', function () {}); // 领先时被拒等预期内的错误，吞掉即可

  const deployP = waitFor(P, 'deployReady');
  P.emit('createRoomAI', { name: '玩家甲' });
  const aiRoom = await waitFor(P, 'roomCreated');
  check('人机房间创建（对手是 🤖 电脑）', aiRoom.isAI === true && aiRoom.names[1] === '🤖 电脑');
  check('AI 永远在线（绿点恒亮）', aiRoom.online[1] === true);
  const aiDeploy = await deployP;
  check('AI 自动部署并确认', aiDeploy.seat === 1 && aiDeploy.confirmed[1] === true);

  // 真人确认部署 → 开战（AI 早已就绪）
  const battleAIP = waitFor(P, 'battleStart');
  P.emit('deployConfirm', { planes: randomDeployment() });
  const battleAI = await battleAIP;
  check('玩家确认后开战', battleAI.steps[0] === 0 && battleAI.steps[1] === 0);

  // 从开战起统一维护对局状态
  let overAI = null;
  let stepsP = 0, stepsAI = 0, aiMoves = 0;
  P.on('revealResult', function (d) {
    stepsP = d.steps[0]; stepsAI = d.steps[1];
    if (d.attacker === 1) aiMoves++;
  });
  P.on('gameOver', function (d) { overAI = d; });

  // AI 自动走棋（测试服务器上"思考"延迟被压到 80~200ms）
  const firstMove = await waitFor(P, 'revealResult', 5000);
  check('AI 自动走棋', firstMove.attacker === 1 && firstMove.steps[1] === 1);
  await sleep(1200);
  check('AI 领先 1 步后等待玩家（不连走）', aiMoves === 1);

  // 玩家垫一步 → AI 继续走（先注册监听再 emit，过滤掉玩家自己的 revealResult）
  const aiReplyP = waitForMatch(P, 'revealResult', function (d) { return d.attacker === 1; }, 5000);
  P.emit('reveal', { row: 0, col: 0 });
  const aiReply = await aiReplyP;
  check('玩家走后 AI 继续走', aiReply.attacker === 1 && aiReply.steps[1] === 2);

  // 打完整局：玩家和 AI 轮流行动直到分出胜负。
  // 不断言谁赢（AI 棋盘随机、玩家盲打无法保证先赢），只断言对局必然结束
  const revealedByP = new Set(['0,0']);
  function pickUnknown() {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (!revealedByP.has(r + ',' + c)) return [r, c];
      }
    }
    return null;
  }
  let guard = 0;
  while (!overAI && guard < 150) {
    guard++;
    if (stepsP <= stepsAI) {
      const cell = pickUnknown();
      P.emit('reveal', { row: cell[0], col: cell[1] });
      revealedByP.add(cell[0] + ',' + cell[1]);
    }
    await sleep(300); // 等自己或 AI 的 revealResult / error
  }
  check('对局必然结束（' + guard + ' 轮内）', overAI !== null);
  check('人机对局结束也公开双方飞机', overAI && Array.isArray(overAI.planes) &&
    shared.validateDeployment(overAI.planes[0]) === null &&
    shared.validateDeployment(overAI.planes[1]) === null);

  // AI 自动投「再来一局」（对局结束约 1.5 秒后）
  const voteAI = await waitFor(P, 'rematchVote', 5000);
  check('AI 自动想再来一局', voteAI.votes[1] === true && voteAI.votes[0] === false);

  // 玩家同意 → 重开 → AI 自动重新部署
  const restartAI = waitFor(P, 'rematchStart');
  const aiDeploy2P = waitFor(P, 'deployReady');
  P.emit('rematch');
  await restartAI;
  const aiDeploy2 = await aiDeploy2P;
  check('再来一局后 AI 自动重新部署', aiDeploy2.seat === 1 && aiDeploy2.confirmed[1] === true);

  const battleAI2P = waitFor(P, 'battleStart');
  P.emit('deployConfirm', { planes: randomDeployment() });
  const battleAI2 = await battleAI2P;
  check('第二局开战且累计比分正确', battleAI2.steps[0] === 0 && battleAI2.steps[1] === 0 &&
    battleAI2.score[0] + battleAI2.score[1] === 1);

  // 断线重连：AI 不掉线，玩家回来继续
  P.disconnect();
  await sleep(200);
  const P2 = new WSClient(URL);
  await waitFor(P2, 'connect');
  P2.on('error', function () {});
  P2.emit('rejoin', { token: aiRoom.token, roomId: aiRoom.roomId });
  const reAI = await waitFor(P2, 'reconnected');
  check('人机房间重连成功（AI 依旧在线）', reAI.phase === 'battle' && reAI.isAI === true && reAI.online[1] === true);

  // 玩家垫一步（若被拒则无碍），然后 AI 必然走一步（先注册监听再 emit）
  const afterRejoinP = waitForMatch(P2, 'revealResult', function (d) { return d.attacker === 1; }, 5000);
  P2.emit('reveal', { row: 1, col: 1 });
  const afterRejoin = await afterRejoinP;
  check('重连后 AI 继续走棋', afterRejoin.attacker === 1);

  // 观战兼容：第三人进入人机房间观战
  const S = new WSClient(URL);
  await waitFor(S, 'connect');
  const errS = [];
  S.on('error', function (d) { errS.push(d.message); });
  S.emit('joinRoom', { roomId: aiRoom.roomId, name: '观众丁' });
  const specAI = await waitFor(S, 'spectatorJoined');
  check('人机房间观战快照正常', specAI.names[1] === '🤖 电脑' && specAI.online[1] === true);
  S.emit('reveal', { row: 2, col: 2 });
  await sleep(150);
  check('人机房间观战者也不能下棋', errS.length === 1);
  let specSawAI = null;
  S.on('revealResult', function (d) { if (d.attacker === 1) specSawAI = d; });
  P2.emit('reveal', { row: 2, col: 2 }); // 垫步引发 AI 走棋
  await sleep(1500); // AI 思考延迟 80~200ms + 走棋计算（rollout 版可达数百 ms），留足余量
  check('观战者实时看到 AI 走棋', specSawAI !== null);

  // 真人离线后房间回收（AI 永不掉线也照样回收）
  const closedP2 = waitFor(S, 'roomClosed', 5000);
  P2.disconnect(); // 玩家离开且不再回来
  const closedAI = await closedP2;
  check('真人离线后房间回收，观战者收到 roomClosed', closedAI.message.length > 0);
  S.disconnect();

  // 回收后重连失败（房间已删除）
  const P3 = new WSClient(URL);
  await waitFor(P3, 'connect');
  P3.emit('rejoin', { token: aiRoom.token, roomId: aiRoom.roomId });
  const rejFail = await waitFor(P3, 'rejoinFailed');
  check('回收后无法重连（房间已删除）', rejFail.roomId === aiRoom.roomId);
  P3.disconnect();

  // 异常输入：空昵称被拒
  const P4 = new WSClient(URL);
  await waitFor(P4, 'connect');
  P4.emit('createRoomAI', { name: '   ' });
  const errAI = await waitFor(P4, 'error');
  check('人机房间空昵称被拒绝', errAI.message.indexOf('昵称') !== -1);
  P4.disconnect();

  // 容错：非法 JSON 会被服务器关闭连接（1003）
  {
    const raw = new WebSocket('ws://localhost:3000/ws');
    const badClosed = new Promise(function (resolve) {
      const t = setTimeout(function () { resolve(-1); }, 3000);
      raw.onopen = function () { raw.send('这不是JSON{{{'); };
      raw.onclose = function (e) { clearTimeout(t); resolve(e.code); };
    });
    const code = await badClosed;
    check('非法 JSON 会被服务器关闭连接（1003）', code === 1003);
  }

  // 容错：未知事件名被忽略，连接不被关闭，还能正常建房
  const Z = new WSClient(URL);
  await waitFor(Z, 'connect');
  Z.emit('noSuchEvent', { hello: 1 });
  Z.emit('createRoom', { name: '容错测试' });
  const zRoom = await waitFor(Z, 'roomCreated');
  check('未知事件名被忽略，连接不被关闭', /^[A-Z0-9]{4}$/.test(zRoom.roomId));
  Z.emit('leaveRoom', {});
  await waitFor(Z, 'leftRoom');
  Z.disconnect();

  C.disconnect(); D.disconnect();
  await sleep(200);

  console.log('');
  console.log('测试结果：' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常中断：', e.message);
  process.exit(1);
});
