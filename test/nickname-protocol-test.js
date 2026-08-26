// ============================================
// test/nickname-protocol-test.js —— 随机昵称 + 改昵称协议测试
//
// 覆盖：建房/加入留空 → 服务器随机英文名；setNickname 改名广播；
//       同房重名（排除自己）；超长拒绝；12 字符边界。
//
// 用法：
//   1. 先以短回收计时启动服务器：
//      RECYCLE_SECONDS=3 node server.js
//   2. 再运行本测试：
//      node test/nickname-protocol-test.js
// ============================================
'use strict';

// 原生 WebSocket 客户端：复用 public/ws.js（Node 里先提供一个全局 WebSocket）
global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');

const URL = process.env.TEST_URL || 'http://localhost:3000'; // 默认连本机 3000；回归测试可注入 TEST_URL 换端口

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

// 随机名格式：形容词 + 名词（CamelCase，如 BraveFox）
function isRandomName(n) {
  return typeof n === 'string' && /^[A-Z][a-z]+[A-Z][a-z]+$/.test(n);
}

async function main() {
  const A = new WSClient(URL);
  const B = new WSClient(URL);
  const C = new WSClient(URL);
  const D = new WSClient(URL);
  await Promise.all([waitFor(A, 'connect'), waitFor(B, 'connect'), waitFor(C, 'connect'), waitFor(D, 'connect')]);

  // 1. 建房留空 → 服务器随机英文名
  console.log('— 建房留空昵称 → 服务器随机名 —');
  A.emit('createRoom', { name: '', avatar: '🦊', mode: 'classic', boardSize: 'S' });
  const rc = await waitFor(A, 'roomCreated');
  check('建房留空 → 返回非空昵称', !!rc.name && rc.name.length > 0);
  check('随机名格式 = 形容词+名词（如 BraveFox）', isRandomName(rc.name));
  check('随机名长度 ≤ 12', rc.name.length <= 12);
  check('回包 names[0] 与 name 一致', rc.names[0] === rc.name);

  // 2. 加入留空 → 服务器随机名（撞名时服务器拒绝，重试直到成功——每次请求都重新随机）
  console.log('— 加入留空昵称 → 服务器随机名 —');
  C.emit('createRoom', { name: 'Starter', avatar: '', mode: 'classic', boardSize: 'S' });
  const rc2 = await waitFor(C, 'roomCreated');
  let joined = null;
  for (let i = 0; i < 5 && !joined; i++) {
    D.emit('joinRoom', { roomId: rc2.roomId, name: '', avatar: '', mode: 'classic', boardSize: 'S' });
    const r = await Promise.race([
      waitFor(D, 'joinedRoom').then(function (d) { return { ok: true, d: d }; }),
      waitFor(D, 'error').then(function (d) { return { ok: false, d: d }; })
    ]);
    if (r.ok) joined = r.d;
    else if (r.d.message.indexOf('已被对方使用') === -1) break; // 不是撞名：停止重试
  }
  check('加入留空 → 返回非空昵称且入房成功', !!joined && !!joined.name && joined.name.length > 0);
  check('加入的随机名格式正确', isRandomName(joined.name));
  check('加入的随机名 ≠ 房主名（同房不重名）', joined.name !== rc2.names[0]);

  // 3. B 用固定名加入 A 的房间，准备测改昵称
  B.emit('joinRoom', { roomId: rc.roomId, name: 'Bee', avatar: '🐝', mode: 'classic', boardSize: 'S' });
  await waitFor(B, 'joinedRoom');
  const opp = await waitFor(A, 'opponentJoined');
  check('对手加入后 names = [随机名, Bee]', opp.names[0] === rc.name && opp.names[1] === 'Bee');

  // 4. 改昵称：合法名字 → 双方都收到 nicknameUpdated
  console.log('— 改昵称：广播 + 重名/超长校验 —');
  const myUpdP = waitFor(A, 'nicknameUpdated');
  const theirUpdP = waitFor(B, 'nicknameUpdated');
  A.emit('setNickname', { name: '新名字' });
  const myUpd = await myUpdP;
  const theirUpd = await theirUpdP;
  check('自己收到 nicknameUpdated(seat0, 新名字)', myUpd.seat === 0 && myUpd.name === '新名字');
  check('对手收到 nicknameUpdated(seat0, 新名字)', theirUpd.seat === 0 && theirUpd.name === '新名字');

  // 5. 改成和现在相同的名字 → 允许（同房重名检查排除自己）
  const againP = waitFor(A, 'nicknameUpdated');
  A.emit('setNickname', { name: '新名字' });
  const again = await againP;
  check('改成自己的当前名字 → 允许（重名检查排除自己）', again.name === '新名字');

  // 6. 改成对手的名字 → 拒绝
  const dupP = waitFor(B, 'error');
  B.emit('setNickname', { name: '新名字' });
  const dup = await dupP;
  check('改成对手的名字 → 拒绝并提示重名', dup.message.indexOf('已被对方使用') !== -1);

  // 7. 超长昵称 → 拒绝
  const longP = waitFor(B, 'error');
  B.emit('setNickname', { name: '1234567890123' });
  const longE = await longP;
  check('13 字符昵称 → 拒绝', longE.message.indexOf('12') !== -1);

  // 8. 12 字符边界 → 允许
  const bUpdP = waitFor(B, 'nicknameUpdated');
  B.emit('setNickname', { name: '123456789012' });
  const bUpd = await bUpdP;
  check('12 字符昵称 → 允许', bUpd.seat === 1 && bUpd.name === '123456789012');

  // 9. 建房超长昵称 → 拒绝（放最后：unbindRoom 会把 A 从房间解绑）
  console.log('— 建房超长昵称 → 拒绝 —');
  const createP = waitFor(A, 'error');
  A.emit('createRoom', { name: '1234567890123', avatar: '', mode: 'classic', boardSize: 'S' });
  const createE = await createP;
  check('建房超长昵称 → 拒绝', createE.message.indexOf('12') !== -1);

  await sleep(100);
  A.disconnect(); B.disconnect(); C.disconnect(); D.disconnect();

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) { console.error('测试崩溃:', e); process.exit(1); });
