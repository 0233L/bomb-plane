// ============================================
// match-history.js —— 对战历史的数据与格式化
//
// 只负责「记录怎么校验、怎么排序、怎么显示」：
//   - 不读写 localStorage（由 client.js 的 safeGet / safeSet 负责）
//   - 不操作页面 DOM（同样在 client.js 里渲染）
// 对外暴露 window.MatchHistory，写法和 shared.js 保持一致。
// ============================================
(function (root) {
  'use strict';

  // 本机存储 key（已加入 client.js 的 HOST_STORAGE_KEYS，刷新后能恢复）
  const STORAGE_KEY = 'bp_match_history';
  const MAX_RECORDS = 20;  // 最多保留最近 20 局
  const NAME_MAX = 12;     // 昵称最长 12 字（和游戏里的规则一致）
  const AVATAR_MAX = 4;    // 头像最多 4 个字符（emoji 在 JS 里可能占 2 个字符）
  const MAX_SHOTS = 400;   // 每方最多保存 400 条落子记录（14×14 棋盘也足够）

  // 合法朝向 / 落子结果（防止损坏的历史数据把非法值带进渲染）
  const PLANE_DIRS = { up: true, down: true, left: true, right: true };
  const SHOT_RESULTS = { empty: true, body: true, head: true, destroyed: true };

  // 把任意值变成安全字符串，并限制长度（emoji 按「字」截断，不会截成半个）
  function safeString(value, maxLen) {
    if (typeof value !== 'string') return '';
    return Array.from(value).slice(0, maxLen).join('');
  }

  // 步数一定是两个非负整数；缺失或坏数据按 0 处理
  function safeSteps(value) {
    const list = Array.isArray(value) ? value : [];
    return [0, 1].map(function (i) {
      const n = Number(list[i]);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.floor(n);
    });
  }

  // 取棋盘规格；shared.js 不可用时退回经典 S 的默认值
  function boardInfo(boardSize) {
    let spec = null;
    try {
      if (typeof root.getBoardSpec === 'function') spec = root.getBoardSpec(boardSize);
    } catch (e) {
      spec = null;
    }
    return {
      size: spec && Number(spec.size) > 0 ? Number(spec.size) : 10,
      planeCount: spec && Number(spec.planeCount) > 0 ? Number(spec.planeCount) : 3
    };
  }

  // 校验并复制双方飞机坐标：每方必须是本规格要求的架数，坐标不能越界。
  // 任何一方不合法就返回 null（整局不提供棋盘回看，但记录本身仍保留）。
  function normalizePlanes(value, boardSize) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const spec = boardInfo(boardSize);
    const out = [];
    for (let seat = 0; seat < 2; seat++) {
      const list = value[seat];
      if (!Array.isArray(list) || list.length !== spec.planeCount) return null;
      const planes = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p || typeof p !== 'object') return null;
        const headRow = Number(p.headRow);
        const headCol = Number(p.headCol);
        if (!Number.isInteger(headRow) || !Number.isInteger(headCol) ||
            headRow < 0 || headRow >= spec.size || headCol < 0 || headCol >= spec.size ||
            !PLANE_DIRS[p.dir]) return null;
        // getPlaneCells 会算出机身/机翼，顺便确认整架飞机没有越界
        let cells = null;
        try {
          if (typeof root.getPlaneCells === 'function') {
            cells = root.getPlaneCells(headRow, headCol, p.dir);
          }
        } catch (e) {
          cells = null;
        }
        if (!Array.isArray(cells) || !cells.length) return null;
        for (let j = 0; j < cells.length; j++) {
          const r = cells[j][0], c = cells[j][1];
          if (r < 0 || r >= spec.size || c < 0 || c >= spec.size) return null;
        }
        planes.push({ headRow: headRow, headCol: headCol, dir: p.dir });
      }
      out.push(planes);
    }
    return out;
  }

  // 校验并复制双方落子记录；坏单条直接跳过，最多保留 MAX_SHOTS 条
  function normalizeShots(value, boardSize) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const size = boardInfo(boardSize).size;
    const out = [];
    for (let seat = 0; seat < 2; seat++) {
      const list = value[seat];
      if (!Array.isArray(list)) return null;
      const shots = [];
      for (let i = 0; i < list.length && shots.length < MAX_SHOTS; i++) {
        const s = list[i];
        if (!s || typeof s !== 'object' || !SHOT_RESULTS[s.result]) continue;
        const row = Number(s.row);
        const col = Number(s.col);
        if (!Number.isInteger(row) || !Number.isInteger(col) ||
            row < 0 || row >= size || col < 0 || col >= size) continue;
        shots.push({
          row: row,
          col: col,
          result: s.result,
          destroyed: s.destroyed === true
        });
      }
      out.push(shots);
    }
    return out;
  }

  // 校验并整理一条记录：
  //   - 不是对象 / 时间无效 / winnerSeat 不是 0 或 1 → 返回 null（丢弃）
  //   - 其它字段有不认识的值时，退回到安全默认值（不会丢整条记录）
  function normalizeRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const time = Number(value.time);
    if (!Number.isFinite(time) || time <= 0) return null;

    // 一局一定有一方获胜，没有平局；只接受 0 或 1
    if (value.winnerSeat !== 0 && value.winnerSeat !== 1) return null;

    const names = Array.isArray(value.names) ? value.names : [];
    const avatars = Array.isArray(value.avatars) ? value.avatars : [];
    const boardSize = (value.boardSize === 'M' || value.boardSize === 'L') ? value.boardSize : 'S';

    const record = {
      time: Math.floor(time),
      kind: value.kind === 'local2p' ? 'local2p' : 'ai',
      mode: value.mode === 'props' ? 'props' : 'classic',
      boardSize: boardSize,
      // 数组全部复制一份新值，绝不保存 state 里的引用
      names: [
        safeString(names[0], NAME_MAX) || '玩家1',
        safeString(names[1], NAME_MAX) || '玩家2'
      ],
      avatars: [
        safeString(avatars[0], AVATAR_MAX),
        safeString(avatars[1], AVATAR_MAX)
      ],
      steps: safeSteps(value.steps),
      winnerSeat: value.winnerSeat
    };

    // 只有飞机布局合法时才保存终局快照；旧记录/坏数据仍然可以正常显示在列表里
    const planes = normalizePlanes(value.planes, boardSize);
    if (planes) {
      record.planes = planes;
      record.shots = normalizeShots(value.shots, boardSize) || [[], []];
    }
    return record;
  }

  // 从传入字段构造一条新记录，永远返回合法记录（坏字段用默认值兜底）
  function createRecord(input) {
    input = input || {};
    const time = Number(input.time);
    const record = {
      time: (Number.isFinite(time) && time > 0) ? time : Date.now(),
      kind: input.kind,
      mode: input.mode,
      boardSize: input.boardSize,
      names: input.names,
      avatars: input.avatars,
      steps: input.steps,
      winnerSeat: input.winnerSeat === 1 ? 1 : 0,
      planes: input.planes,
      shots: input.shots
    };
    return normalizeRecord(record);
  }

  // 这条记录是否保存了可回看的棋盘
  function hasBoard(record) {
    return !!(record && Array.isArray(record.planes) && record.planes.length === 2);
  }

  // 解析存储里的字符串：坏 JSON / 非数组都返回空列表；过滤坏记录后按时间从新到旧排
  function load(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return []; // 没有记录、坏 JSON、存储不可用：都按空列表处理
    }
    if (!Array.isArray(parsed)) return [];

    const list = [];
    parsed.forEach(function (item) {
      const record = normalizeRecord(item);
      if (record) list.push(record);
    });
    // 时间倒序：最近打的排最前面
    list.sort(function (a, b) { return b.time - a.time; });
    return list.slice(0, MAX_RECORDS);
  }

  // 追加一条记录：新记录放最前，最多保留 20 条（返回新的数组）
  function append(raw, record) {
    const list = load(raw);
    const normalized = normalizeRecord(record);
    if (!normalized) return list;
    list.unshift(normalized);
    list.sort(function (a, b) { return b.time - a.time; });
    return list.slice(0, MAX_RECORDS);
  }

  // 转成要存进本机存储的字符串，顺便丢弃坏记录 + 截断到 20 条
  function serialize(list) {
    const safe = [];
    if (Array.isArray(list)) {
      list.forEach(function (item) {
        const record = normalizeRecord(item);
        if (record) safe.push(record);
      });
    }
    return JSON.stringify(safe.slice(0, MAX_RECORDS));
  }

  // 补零：把 9 显示成 09
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // 时间戳 → YYYY-MM-DD HH:mm（用设备本地时间）；无效值返回空串
  function formatTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // 对局类型
  function formatKind(kind) {
    if (kind === 'ai') return '人机对战';
    if (kind === 'local2p') return '同屏双人';
    return '';
  }

  // 玩法
  function formatMode(mode) {
    if (mode === 'props') return '道具';
    if (mode === 'classic') return '经典';
    return '';
  }

  // 地图规格 → 10×10 / 12×12 / 14×14（复用 shared.js 的 getBoardSpec，未知按 S）
  function formatBoardSize(boardSize) {
    let size = 0;
    try {
      if (typeof root.getBoardSpec === 'function') {
        size = Number(root.getBoardSpec(boardSize).size) || 0;
      }
    } catch (e) {
      size = 0;
    }
    if (!size) size = 10; // 拿不到规格表时按经典 10×10 显示
    return size + '×' + size;
  }

  // 结果文字：人机对战按「我（座位 0）」显示胜/负；同屏双人显示赢家昵称
  function formatResult(record) {
    if (!record) return '';
    if (record.kind === 'local2p') {
      const names = Array.isArray(record.names) ? record.names : [];
      const winnerName = names[record.winnerSeat] || ('玩家' + (record.winnerSeat + 1));
      return winnerName + ' 获胜';
    }
    return record.winnerSeat === 0 ? '胜' : '负';
  }

  // 双方步数：步数 12 : 9
  function formatSteps(record) {
    if (!record || !Array.isArray(record.steps)) return '';
    return '步数 ' + record.steps[0] + ' : ' + record.steps[1];
  }

  // 列表里那一行灰色小字：时间 · 类型 · 玩法 · 地图 · 步数（缺失字段自动省略）
  function formatMeta(record) {
    if (!record) return '';
    return [
      formatTime(record.time),
      formatKind(record.kind),
      formatMode(record.mode),
      formatBoardSize(record.boardSize),
      formatSteps(record)
    ].filter(function (part) { return !!part; }).join(' · ');
  }

  const api = {
    STORAGE_KEY: STORAGE_KEY,
    MAX_RECORDS: MAX_RECORDS,
    createRecord: createRecord,
    normalizeRecord: normalizeRecord,
    hasBoard: hasBoard,
    load: load,
    append: append,
    serialize: serialize,
    formatTime: formatTime,
    formatKind: formatKind,
    formatMode: formatMode,
    formatBoardSize: formatBoardSize,
    formatResult: formatResult,
    formatSteps: formatSteps,
    formatMeta: formatMeta
  };

  // 浏览器里挂到 window；Node 环境（临时测试脚本）也能拿到
  if (typeof window !== 'undefined') {
    root.MatchHistory = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MatchHistory = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
