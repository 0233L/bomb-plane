// ============================================
// stats-github.js —— 访客统计的 GitHub 保险柜
//
// 背景：Render 免费版的服务器文件系统是临时的——休眠、重启、重新部署后，
// stats.json 会丢。为了让统计不丢，把数据也同步到你的 GitHub 私有仓库：
//   - 服务器启动时：从 GitHub 拉回上次的统计，与本地合并后继续累计
//   - 数据每次落盘后：把统计上传到 GitHub 覆盖更新
// 这样就算服务器文件丢了，GitHub 上还有一份，启动时自动恢复。
//
// 配置（环境变量，见 README「GitHub 保险柜」一节）：
//   GITHUB_TOKEN  你在 GitHub 生成的个人访问令牌（只有你看到，别写进代码）
//   GITHUB_REPO   仓库，形如  你的用户名/仓库名
// 没配置这两个变量时，本模块自动跳过，服务器行为完全不变。
// 测试时可设 GITHUB_API_URL 指向本地假服务器（默认 GitHub 官方地址）。
// ============================================
'use strict';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const FILE_PATH = 'stats.json'; // 仓库里保存统计的文件名

const enabled = !!(GITHUB_TOKEN && GITHUB_REPO);

let lastSha = null;     // 仓库里文件当前的 sha（GitHub 要求更新时必须带上）
let uploading = false;  // 正在上传中（防并发上传导致 sha 冲突）

// 从 GitHub 下载统计文件，返回 { records: [...], ok: true }；
// 仓库里还没有这个文件返回 { records: [], ok: true }；出错返回 { records: null }
async function download() {
  if (!enabled) return { records: null };
  try {
    const res = await fetch(GITHUB_API + '/repos/' + GITHUB_REPO + '/contents/' + FILE_PATH, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) return { records: [], sha: null }; // 还没有：当空处理
    if (!res.ok) {
      console.error('GitHub 保险柜拉取失败（' + res.status + '）：' + (await res.text()).slice(0, 200));
      return { records: null };
    }
    const meta = await res.json();
    lastSha = meta.sha;
    const file = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
    const visitors = (file && file.visitors) || {};
    const records = Object.keys(visitors).map(function (id) {
      const v = visitors[id];
      return { id: id, platform: v.platform, firstVisit: v.firstVisit, lastVisit: v.lastVisit, visits: v.visits };
    });
    return { records: records, sha: lastSha };
  } catch (e) {
    console.error('GitHub 保险柜拉取失败：' + e.message);
    return { records: null };
  }
}

// 把统计上传到 GitHub（覆盖更新；进行中时跳过本次，等下次落盘再传）
async function upload(visitors) {
  if (!enabled || uploading) return false;
  uploading = true;
  try {
    const payload = { version: 1, visitors: {} };
    visitors.forEach(function (v, id) { payload.visitors[id] = v; });
    const body = { message: 'sync stats', content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64') };
    if (lastSha) body.sha = lastSha; // 更新已有文件时必须带 sha
    const res = await fetch(GITHUB_API + '/repos/' + GITHUB_REPO + '/contents/' + FILE_PATH, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + GITHUB_TOKEN,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      console.error('GitHub 保险柜上传失败（' + res.status + '）：' + (await res.text()).slice(0, 200));
      return false;
    }
    const meta = await res.json();
    lastSha = meta.content && meta.content.sha; // 记住新 sha，下次更新用
    return true;
  } catch (e) {
    console.error('GitHub 保险柜上传失败：' + e.message);
    return false;
  } finally {
    uploading = false;
  }
}

module.exports = { enabled: enabled, download: download, upload: upload };
