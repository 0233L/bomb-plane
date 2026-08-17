// ============================================
// backup-stats.js —— 访客统计本地备份脚本
//
// 背景：线上（Render 免费版）的访客统计文件在服务器休眠/重启后会清零。
// 这个脚本把线上的统计数据定期拉到你自己电脑里：
//   每次运行，把当时的统计快照「追加」进 stats-backup.jsonl（每行一个 JSON），
//   同时打印本地历史累计去重后的访客数。就算线上清零了，本地还留着历史。
//
// 用法（在项目文件夹里打开终端）：
//   node backup-stats.js                          # 备份线上 https://bomb-plane.onrender.com
//   node backup-stats.js http://localhost:3000    # 也可以备份本地服务器
//
// 想每天自动备份：Windows 搜索「任务计划程序」→「创建基本任务」→ 触发器选每天 →
// 操作选「启动程序」，程序填 node，添加参数填脚本的完整路径（如 D:\coding\project\bombPlane\backup-stats.js）。
// ============================================
'use strict';

// 钥匙：和服务器上的 STATS_KEY 一致（见 README「访客统计」一节；
// 如果你在 Render 后台改过 STATS_KEY，请把它写进这里或设成环境变量 STATS_KEY）
const STATS_KEY = process.env.STATS_KEY || 'bombplane-stats-2026';

// 要备份的服务器地址：第二个命令行参数可覆盖（默认线上）
const URL = (process.argv[2] || 'https://bomb-plane.onrender.com').replace(/\/$/, '');
const BACKUP_FILE = __dirname + '/stats-backup.jsonl'; // 备份文件：和本脚本同目录

async function main() {
  // 1. 拉取线上统计（Node 18+ 自带 fetch，无需安装任何东西）
  const res = await fetch(URL + '/stats.json?key=' + encodeURIComponent(STATS_KEY));
  if (res.status === 403) {
    console.log('✗ 钥匙不对：服务器拒绝访问。');
    console.log('  如果服务器改过 STATS_KEY，请先设置环境变量：set STATS_KEY=你的钥匙 再运行本脚本。');
    process.exitCode = 1; // 用 exitCode 而不是 exit()：Windows 上 exit() 偶发崩溃提示
    return;
  }
  if (!res.ok) {
    console.log('✗ 拉取失败：HTTP ' + res.status + '（服务器可能是旧版，还没有 /stats.json 接口，重新部署后再试）');
    process.exitCode = 1;
    return;
  }
  const data = await res.json();

  // 2. 把本次快照「追加」进备份文件（JSONL = 每行一个 JSON，追加/按行读取都方便）
  const snapshot = {
    time: new Date().toISOString(),
    total: data.total, web: data.web, mini: data.mini, totalVisits: data.totalVisits,
    visitors: data.visitors
  };
  const fs = require('fs');
  fs.appendFileSync(BACKUP_FILE, JSON.stringify(snapshot) + '\n');

  // 3. 把备份文件里所有快照按访客 ID 合并，得到本地历史累计（防线上清零后没记录）
  const merged = new Map();
  fs.readFileSync(BACKUP_FILE, 'utf8').split('\n').forEach(function (line) {
    if (!line.trim()) return;
    try {
      const snap = JSON.parse(line);
      (snap.visitors || []).forEach(function (v) {
        if (!v || typeof v.id !== 'string' || !v.id) return;
        const old = merged.get(v.id);
        merged.set(v.id, {
          platform: v.platform,                          // 平台取最新一次
          firstVisit: old ? Math.min(old.firstVisit, v.firstVisit) : v.firstVisit,
          lastVisit: old ? Math.max(old.lastVisit, v.lastVisit) : v.lastVisit,
          visits: old ? Math.max(old.visits, v.visits) : v.visits // visits 是累计值，取最大
        });
      });
    } catch (e) { /* 个别坏行跳过，不影响其它行 */ }
  });

  // 4. 打印结果
  console.log('✓ 已备份到 ' + BACKUP_FILE);
  console.log('  当前线上：' + data.total + ' 位访客（网页 ' + data.web + ' / 小程序 ' + data.mini + '），累计访问 ' + data.totalVisits + ' 次');
  console.log('  本地历史累计去重：' + merged.size + ' 位访客');
}

main().catch(function (e) {
  console.log('✗ 备份失败：' + e.message);
  process.exitCode = 1;
});
