// ============================================
// test/github-sync-test.js —— GitHub 保险柜同步测试（可选）
//
// 不依赖真实 GitHub：起一个本地「假 GitHub 服务器」验证两件事：
//   1. 访客数据会自动上传到 GitHub
//   2. 服务器本地文件丢失（模拟 Render 休眠/重启清盘）后，
//      重启能从 GitHub 拉回统计继续累计
//
// 用法：node test/github-sync-test.js（不需要真实 GitHub token）
// ============================================
'use strict';

global.WebSocket = require('ws').WebSocket;
const WSClient = require('../public/ws.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MOCK_PORT = 4100; // 假 GitHub 端口
const SRV_PORT = 3100;  // 被测服务器端口（避开 3000 开发端口）
const STATS_FILE = path.join(__dirname, '..', 'stats.json');
const STATS_BAK = STATS_FILE + '.bak'; // 测试期间临时挪走的本地统计

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function once(sock, event, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('等待超时: ' + event)); }, timeoutMs || 5000);
    sock.once(event, function (d) { clearTimeout(t); resolve(d); });
  });
}

// ---------- 假 GitHub 服务器（模拟 Contents API 的 GET/PUT 单文件） ----------
let store = null;       // 仓库里保存的文件内容（null = 还没有这个文件）
let storeSha = 'sha-1'; // 文件当前版本号（GitHub 更新时必须带上）
let badAuth = 0;        // 令牌不对的次数

const mock = http.createServer(function (req, res) {
  const full = '/repos/owner/repo/contents/stats.json';
  const authOk = req.headers.authorization === 'Bearer fake-token';
  if (!authOk) badAuth++;

  if (req.method === 'GET' && req.url.indexOf(full) === 0) {
    if (!store) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sha: storeSha, content: Buffer.from(store).toString('base64') }));
    return;
  }
  if (req.method === 'PUT' && req.url.indexOf(full) === 0) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      const parsed = JSON.parse(body);
      if (parsed.sha && parsed.sha !== storeSha) { res.writeHead(409); res.end('{}'); return; } // sha 过期
      store = Buffer.from(parsed.content, 'base64').toString('utf8');
      storeSha = 'sha-' + (parseInt(storeSha.slice(4), 10) + 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: { sha: storeSha } }));
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

// ---------- 启动被测服务器（带假 GitHub 配置） ----------
function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      GITHUB_TOKEN: 'fake-token',
      GITHUB_REPO: 'owner/repo',
      GITHUB_API_URL: 'http://localhost:' + MOCK_PORT
    })
  });
  child.stdout.on('data', function () { /* 日志只做调试用 */ });
  child.stderr.on('data', function () { /* 同上 */ });
  return child;
}

// 轮询等待服务器就绪
async function waitServerUp() {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch('http://localhost:' + SRV_PORT + '/'); if (r.ok) return; } catch (e) { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('被测服务器启动超时');
}

// 连上被测服务器并上报一位访客，返回 visitResult 里的总数
async function visitAndWait(vid, platform) {
  const s = new WSClient('http://localhost:' + SRV_PORT);
  await once(s, 'connect');
  s.emit('visit', { visitorId: vid, platform: platform });
  const d = await once(s, 'visitResult');
  s.disconnect();
  return d.total;
}

async function main() {
  await new Promise(function (r) { mock.listen(MOCK_PORT, r); });

  // 保护本地真实的 stats.json（如果有），测试结束后恢复
  const hadLocal = fs.existsSync(STATS_FILE);
  if (hadLocal) fs.renameSync(STATS_FILE, STATS_BAK);
  if (fs.existsSync(STATS_FILE + '.tmp')) fs.unlinkSync(STATS_FILE + '.tmp');

  let child = null;
  try {
    // --- 第一次启动：新访客应自动上传到 GitHub ---
    let server = startServer();
    await waitServerUp();
    await visitAndWait('gh-test-1', 'web');
    await sleep(1800); // 等 1 秒防抖落盘 + 上传完成
    check('访客数据自动上传到 GitHub', store !== null && store.indexOf('gh-test-1') !== -1);
    check('上传时带的是正确的令牌', badAuth === 0);
    server.kill();
    server = null;
    await sleep(300);

    // --- 模拟 Render 清盘：删掉本地 stats.json，重启 ---
    if (fs.existsSync(STATS_FILE)) fs.unlinkSync(STATS_FILE);
    server = startServer();
    await waitServerUp();
    await sleep(2500); // 等启动时从 GitHub 拉回 + 合并回写

    const res = await fetch('http://localhost:' + SRV_PORT + '/stats.json?key=bombplane-stats-2026');
    const data = await res.json();
    check('本地文件丢失后，重启从 GitHub 恢复了访客',
      data.total >= 1 && data.visitors.some(function (v) { return v.id === 'gh-test-1'; }));

    // --- 恢复后继续累计：再来一位小程序访客 ---
    await visitAndWait('gh-test-2', 'mini');
    await sleep(1800);
    check('恢复后新访客也上传到 GitHub', store !== null && store.indexOf('gh-test-2') !== -1);
    const res2 = await fetch('http://localhost:' + SRV_PORT + '/stats.json?key=bombplane-stats-2026');
    const data2 = await res2.json();
    check('恢复后两位访客都在且平台正确',
      data2.visitors.some(function (v) { return v.id === 'gh-test-1' && v.platform === 'web'; }) &&
      data2.visitors.some(function (v) { return v.id === 'gh-test-2' && v.platform === 'mini'; }));
  } finally {
    if (child) child.kill();
    if (fs.existsSync(STATS_FILE + '.tmp')) fs.unlinkSync(STATS_FILE + '.tmp');
    if (hadLocal) fs.renameSync(STATS_BAK, STATS_FILE); // 恢复用户本地的统计
    else if (fs.existsSync(STATS_FILE)) fs.unlinkSync(STATS_FILE); // 本来没有：清理测试残留
    mock.close();
  }

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.log('✗ 测试中断: ' + e.message);
  process.exit(1);
});
