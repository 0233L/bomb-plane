// ============================================
// test/avatar-protocol-test.js —— 头像协议测试（连本地服务器实测）
// 验证服务器对 avatar 字段的转发/限长/缺省处理：
//   建房带头像 → roomCreated 回显；加入带头像 → joinedRoom/opponentJoined 同步；
//   部署后 battleStart 带头像；断线重连 reconnected 保留原头像；
//   不传 avatar → ''（而不是 undefined）；怪异内容原样透传；超长内容按码点截 4 个（每 emoji 1 码点）；
//   AI 房间 2 号位固定 '🤖'
// 用法（先起服务器）：
//   RECYCLE_SECONDS=3 node server.js
//   node test/avatar-protocol-test.js
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const shared = require('../public/shared.js');

const SPEC = 'S';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function waitFor(socket, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待事件超时: ' + event)); }, timeoutMs || 10000);
    socket.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}

function randomDeployment(spec) {
  const sp = shared.getBoardSpec(spec);
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < sp.planeCount; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * sp.size);
    const headCol = Math.floor(Math.random() * sp.size);
    const occupied = [];
    planes.forEach(function (p) {
      shared.getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (c) { occupied.push(c); });
    });
    if (shared.canPlacePlane(occupied, headRow, headCol, dir, spec)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes;
}

async function main() {
  console.log('— 房间 1：正常头像全流程 —');
  const a = new WSClient('http://localhost:3000');
  await waitFor(a, 'connect');
  a.emit('createRoom', { name: '头像A', avatar: '🐱', mode: 'classic', boardSize: SPEC });
  const created = await waitFor(a, 'roomCreated');
  check('roomCreated 回显我的头像', created.avatars[0] === '🐱');
  check('roomCreated 对方位是空串（非 undefined）', created.avatars[1] === '' && created.avatars.length === 2);

  const b = new WSClient('http://localhost:3000');
  await waitFor(b, 'connect');
  const oppJoinedP = waitFor(a, 'opponentJoined'); // 先注册再发，防漏
  b.emit('joinRoom', { roomId: created.roomId, name: '头像B', avatar: '🦊' });
  const joined = await waitFor(b, 'joinedRoom');
  const oppJoined = await oppJoinedP;
  check('joinedRoom 双方头像正确', joined.avatars[0] === '🐱' && joined.avatars[1] === '🦊');
  check('opponentJoined 双方头像正确', oppJoined.avatars[0] === '🐱' && oppJoined.avatars[1] === '🦊');

  const pA = waitFor(a, 'battleStart');
  const pB = waitFor(b, 'battleStart');
  a.emit('deployConfirm', { planes: randomDeployment(SPEC) });
  b.emit('deployConfirm', { planes: randomDeployment(SPEC) });
  const battle = await pA;
  await pB;
  check('battleStart 双方头像正确', battle.avatars[0] === '🐱' && battle.avatars[1] === '🦊');

  // 断线重连：先注册监听再发 rejoin（事件发得很快，先发后听会漏）
  a.disconnect();
  const a2 = new WSClient('http://localhost:3000');
  await waitFor(a2, 'connect');
  const recP = waitFor(a2, 'reconnected');
  a2.emit('rejoin', { token: created.token, roomId: created.roomId });
  const rec = await recP;
  check('重连 reconnected 保留原头像', rec.avatars[0] === '🐱' && rec.avatars[1] === '🦊');

  console.log('— 房间 2：不传 avatar（缺省） —');
  const c = new WSClient('http://localhost:3000');
  await waitFor(c, 'connect');
  c.emit('createRoom', { name: '无头像', mode: 'classic', boardSize: SPEC });
  const created2 = await waitFor(c, 'roomCreated');
  check('缺省 avatar → 空串而非 undefined', created2.avatars[0] === '' && created2.avatars[0] !== undefined);

  console.log('— 房间 3：怪异内容原样透传 —');
  const d = new WSClient('http://localhost:3000');
  await waitFor(d, 'connect');
  d.emit('createRoom', { name: '怪头像', avatar: '👾🎃👽', mode: 'classic', boardSize: SPEC });
  const created3 = await waitFor(d, 'roomCreated');
  check('怪异 emoji 串原样透传', created3.avatars[0] === '👾🎃👽');

  console.log('— 房间 4：超长内容截断（按码点截 4 个） —');
  const e = new WSClient('http://localhost:3000');
  await waitFor(e, 'connect');
  e.emit('createRoom', { name: '超长头像', avatar: '😀'.repeat(9), mode: 'classic', boardSize: SPEC });
  const created4 = await waitFor(e, 'roomCreated');
  check('9 个 emoji 被截断为 4 个', created4.avatars[0] === '😀'.repeat(4));

  console.log('— 人机房间：AI 不用头像（昵称自带 🤖） —');
  const f = new WSClient('http://localhost:3000');
  await waitFor(f, 'connect');
  f.emit('createRoomAI', { name: '打AI', avatar: '🐻', mode: 'classic', boardSize: SPEC });
  const aiRoom = await waitFor(f, 'roomCreated');
  check('真人头像回显', aiRoom.avatars[0] === '🐻');
  check('AI 位置无头像（昵称「🤖 电脑」自带图标）', aiRoom.avatars[1] === '');

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exitCode = failed ? 1 : 0;
  setTimeout(function () { process.exit(process.exitCode); }, 500);
}

main().catch(function (e) {
  console.error('测试异常:', e.message);
  process.exitCode = 1;
  setTimeout(function () { process.exit(1); }, 500);
});
