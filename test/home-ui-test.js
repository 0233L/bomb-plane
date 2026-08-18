// ============================================
// test/home-ui-test.js —— 首页菜单 UI 交互测试（jsdom 实测）
// 验证：默认经典+S、地图规格点击切换、道具开关切换、按钮图标联动
// 用法：node test/home-ui-test.js
// ============================================
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const wsSrc = fs.readFileSync('public/ws.js', 'utf8');
const sharedSrc = fs.readFileSync('public/shared.js', 'utf8');
const clientSrc = fs.readFileSync('public/client.js', 'utf8');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;
win.WebSocket = require('ws').WebSocket; // 连本地服务器（init 里 WSClient 会真实连接）
win.matchMedia = function () { // jsdom 不提供 matchMedia，给个最小实现
  return { matches: false, addEventListener: function () {}, removeEventListener: function () {} };
};
win.eval(wsSrc);
win.eval(sharedSrc);
try {
  win.eval(clientSrc);
} catch (e) {
  console.error('client.js 执行异常:', e.message);
  console.error(e.stack.split('\n').slice(0, 5).join('\n'));
}

const doc = win.document;
const $ = function (sel) { return doc.querySelector(sel); };
const $$ = function (sel) { return doc.querySelectorAll(sel); };
const activeSpec = function () { return $('.spec-btn.active') && $('.spec-btn.active').dataset.spec; };
const gift = function () { return $('#btn-create').textContent.indexOf('🎁') !== -1; };

// ===== 1. 默认状态：经典 + S =====
console.log('1. 默认状态');
check('道具开关默认关闭', !$('#props-toggle').checked);
check('规格默认 S 高亮', activeSpec() === 'S');
check('帮助文字是经典', $('#mode-help').textContent.indexOf('经典') !== -1);
check('创建按钮无 🎁', !gift());

// ===== 2. 地图切换：点 M → M 高亮；点 L → L 高亮 =====
console.log('2. 地图规格切换');
$$('.spec-btn')[1].click(); // M
check('点击 12×12 后 M 高亮', activeSpec() === 'M');
check('帮助文字跟随 12×12', $('#mode-help').textContent.indexOf('12×12') !== -1);
$$('.spec-btn')[2].click(); // L
check('点击 14×14 后 L 高亮', activeSpec() === 'L');
check('帮助文字跟随 14×14', $('#mode-help').textContent.indexOf('14×14') !== -1);
$$('.spec-btn')[0].click(); // 回 S
check('点击 10×10 后 S 高亮', activeSpec() === 'S');

// ===== 3. 道具开关：开 → 道具样式；关 → 回经典 =====
console.log('3. 道具模式开关');
$('#props-toggle').click(); // 开
check('开关已勾选', $('#props-toggle').checked);
check('帮助文字是道具版', $('#mode-help').textContent.indexOf('道具版') !== -1);
check('创建按钮带 🎁', gift());
check('按钮有 props-on 样式', $('#btn-create').classList.contains('props-on'));
check('规格仍是 S（手动改过不强制跳）', activeSpec() === 'S');
$('#props-toggle').click(); // 关
check('开关已取消', !$('#props-toggle').checked);
check('帮助文字回经典', $('#mode-help').textContent.indexOf('经典') !== -1);
check('创建按钮无 🎁', !gift());

// ===== 4. 首次开道具（未手动改规格）→ 规格自动跳 M =====
console.log('4. 首次开道具规格联动');
win.localStorage.removeItem('bp_spec_manual');
$$('.spec-btn')[0].click(); // 手动改过 S → manual=1
win.localStorage.removeItem('bp_spec_manual'); // 模拟从未手动改过
$('#props-toggle').click(); // 开
check('首次开道具规格跳到 M', activeSpec() === 'M');

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exitCode = failed ? 1 : 0;
setTimeout(function () { process.exit(process.exitCode); }, 500); // 等 ws 连接回收
