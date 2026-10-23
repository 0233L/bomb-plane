// 从 client.js 抽出昵称过滤函数做单元验证（不依赖 DOM）
// 运行：在项目根目录执行 node .trellis/tasks/10-19-xiaoheihe-port/evidence/nickname-filter-test.js
const fs = require('fs');
const nodePath = require('path');
const clientPath = nodePath.join(__dirname, '../../../../xiaoheihe/src/legacy/client.js');
const src = fs.readFileSync(clientPath, 'utf8');
const start = src.indexOf('// ---------- 昵称基础内容安全 ----------');
const end = src.indexOf('// ---------- 主题切换');
if (start === -1 || end === -1) throw new Error('找不到昵称过滤代码块');
const block = src.slice(start, end);
const factory = new Function(block + '\nreturn checkNickname;');
const checkNickname = factory();

const cases = [
  ['你好', true, '你好'],
  ['', true, ''],
  ['   ', true, ''],
  ['  abc  ', true, 'abc'],
  ['https://x.com', false],
  ['a.cn', false],
  ['www.test.cn', false],
  ['加群123456', false],
  ['wx123456', false],
  ['QQ:12345678', false],
  ['13800138000', false],
  ['傻逼', false],
  ['fuck you', false],
  ['abc\u200Bdef', true, 'abcdef'],
  ['ａｂｃ', true, 'abc'],
  ['一二三四五六七八九十十一', true, '一二三四五六七八九十十一'],
  ['一二三四五六七八九十十一二', false],
  ['🐯🐯', true, '🐯🐯'],
  ['小明 123', true, '小明 123']
];

let failed = 0;
for (const [input, ok, expected] of cases) {
  const r = checkNickname(input);
  const pass = r.ok === ok && (expected === undefined || r.name === expected);
  if (!pass) {
    failed++;
    console.log('FAIL', JSON.stringify(input), '=>', JSON.stringify(r), '期望 ok=' + ok, expected === undefined ? '' : 'name=' + JSON.stringify(expected));
  } else {
    console.log('PASS', JSON.stringify(input), '=>', JSON.stringify(r));
  }
}
console.log(failed ? `\n${failed} 个失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
