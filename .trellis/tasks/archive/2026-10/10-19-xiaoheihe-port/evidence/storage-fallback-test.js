// 抽取 client.js 的 safeGet/safeSet/safeRemove 做存储降级单元验证
// 运行：在项目根目录执行 node .trellis/tasks/10-19-xiaoheihe-port/evidence/storage-fallback-test.js
const fs = require('fs');
const path = require('path');
const clientPath = path.join(__dirname, '../../../../xiaoheihe/src/legacy/client.js');
const src = fs.readFileSync(clientPath, 'utf8');
const start = src.indexOf('// ---------- localStorage 安全读写 ----------');
const end = src.indexOf('// ---------- 昵称基础内容安全 ----------');
if (start === -1 || end === -1) throw new Error('找不到存储降级代码块');
const block = src.slice(start, end);
const makeApi = new Function('localStorage', block + '\nreturn { safeGet, safeSet, safeRemove };');

function makeStorage(initial, opts) {
  const data = new Map(Object.entries(initial || {}));
  const writable = opts && opts.writable !== false;
  const readable = opts && opts.readable !== false;
  return {
    data,
    getItem(k) {
      if (!readable) throw new Error('read blocked');
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      if (!writable) throw new Error('write blocked');
      data.set(k, String(v));
    },
    removeItem(k) {
      if (!writable) throw new Error('remove blocked');
      data.delete(k);
    },
  };
}

let failed = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' => ' + JSON.stringify(actual) + (ok ? '' : ' (期望 ' + JSON.stringify(expected) + ')'));
}

// 1. 能读不能写：已存在的值能读；写入后本次会话能读到
{
  const s = makeStorage({ d: '4' }, { writable: false });
  const api = makeApi(s);
  eq('只读存储读取旧值', api.safeGet('d'), '4');
  api.safeSet('d', '5');
  eq('只读存储写入后读内存值', api.safeGet('d'), '5');
  api.safeRemove('d');
  eq('只读存储删除后不能再读回旧值', api.safeGet('d'), null);
}

// 2. 正常读写
{
  const s = makeStorage({});
  const api = makeApi(s);
  api.safeSet('a', '1');
  eq('正常写入后读取', api.safeGet('a'), '1');
  api.safeRemove('a');
  eq('正常删除后读取', api.safeGet('a'), null);
  eq('正常删除底层数据', s.data.has('a'), false);
}

// 3. 先写失败、后写成功：内存旧值要让位给持久化值
{
  const s = makeStorage({}, { writable: false });
  const api = makeApi(s);
  api.safeSet('b', '2');
  eq('写入失败走内存', api.safeGet('b'), '2');
  s.setItem = function (k, v) { this.data.set(k, String(v)); };
  api.safeSet('b', '3');
  eq('恢复可写后读到新值', api.safeGet('b'), '3');
  eq('恢复可写后底层已持久化', s.data.get('b'), '3');
}

// 4. localStorage 完全不可用
{
  const s = makeStorage({}, { writable: false, readable: false });
  const api = makeApi(s);
  api.safeSet('e', '5');
  eq('完全不可用时读内存', api.safeGet('e'), '5');
  api.safeRemove('e');
  eq('完全不可用时删除后为 null', api.safeGet('e'), null);
}

// 5. 不存在的 key
{
  const api = makeApi(makeStorage({}));
  eq('不存在的 key', api.safeGet('nope'), null);
}

console.log(failed ? '\n' + failed + ' 个失败' : '\n全部通过');
process.exitCode = failed ? 1 : 0;
