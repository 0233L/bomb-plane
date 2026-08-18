// ============================================
// shared.js —— 前后端共用的游戏逻辑
// 这个文件既在浏览器里当普通 <script> 加载，
// 也被 Node 服务器 require，保证两边的飞机算法完全一致。
// ============================================
(function (root) {
  'use strict';

  // ---------- 棋盘常量 ----------
  const BOARD_SIZE = 10;    // 棋盘是 10×10（经典默认）
  const PLANE_COUNT = 3;    // 每方部署 3 架飞机（经典默认）

  // ---------- 规格表 ----------
  // 玩法与地图规格自由组合：每个规格 = 棋盘边长 + 飞机数量。
  // 'S' 是经典默认（10×10 / 3 架），老代码不传规格时行为完全不变。
  const BOARD_SPECS = {
    S: { size: 10, planeCount: 3 },
    M: { size: 12, planeCount: 4 },
    L: { size: 14, planeCount: 6 }
  };

  // 按规格名字取 {size, planeCount}；未知规格一律按经典
  function getBoardSpec(spec) {
    return BOARD_SPECS[spec] || BOARD_SPECS.S;
  }

  // 格子类型（数字形式，服务器内部查表用）
  const CELL_EMPTY = 0;     // 空（白色）
  const CELL_BODY = 1;      // 机身（绿色）
  const CELL_HEAD = 2;      // 机头（红色）

  // ---------- 飞机形状 ----------
  // 每架飞机由 10 个格子组成，用「机头所在格」作为原点 (0,0)，
  // 其余格子用相对偏移 [行偏移, 列偏移] 表示（行向下增长、列向右增长）。
  // 形状（机头→机尾）：机头行 1 格 → 翅膀行 5 格 → 机身行 1 格 → 机尾行 3 格（均居中）。
  // 第 0 项永远是机头（红色），其余 9 格是机身（绿色）。
  // 4 种朝向按机头指向命名：up 表示机头朝上、身体向下延伸。
  const PLANE_SHAPES = {
    up:    [[0, 0], [ 1, -2], [ 1, -1], [ 1, 0], [ 1, 1], [ 1, 2], [ 2, 0], [ 3, -1], [ 3, 0], [ 3, 1]],
    down:  [[0, 0], [-1, -2], [-1, -1], [-1, 0], [-1, 1], [-1, 2], [-2, 0], [-3, -1], [-3, 0], [-3, 1]],
    left:  [[0, 0], [-2,  1], [-1,  1], [ 0, 1], [ 1, 1], [ 2, 1], [ 0, 2], [-1,  3], [ 0, 3], [ 1, 3]],
    right: [[0, 0], [-2, -1], [-1, -1], [ 0, -1], [ 1, -1], [ 2, -1], [ 0, -2], [-1, -3], [ 0, -3], [ 1, -3]]
  };

  // 根据机头位置和朝向，算出整架飞机 10 个格子的绝对坐标
  function getPlaneCells(headRow, headCol, dir) {
    return PLANE_SHAPES[dir].map(function (off) {
      return [headRow + off[0], headCol + off[1]];
    });
  }

  // 判断能否把机头放在 (headRow, headCol)、朝向 dir：
  // 不能越界、不能与已占格子（existingCells）重叠。
  // 注意：允许飞机互相"挨着"（接壤），只禁止占用同一个格子。
  // spec 是规格名（'S'/'M'/'L'），缺省为经典 10×10。
  function canPlacePlane(existingCells, headRow, headCol, dir, spec) {
    if (!PLANE_SHAPES[dir]) return false; // 朝向不合法
    const size = getBoardSpec(spec).size;
    const cells = getPlaneCells(headRow, headCol, dir);
    // 把 [行, 列] 压成一个数字，放进 Set 里快速查重
    const used = new Set();
    existingCells.forEach(function (cell) {
      used.add(cell[0] * size + cell[1]);
    });
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i][0];
      const c = cells[i][1];
      if (r < 0 || r >= size || c < 0 || c >= size) return false; // 越界
      if (used.has(r * size + c)) return false;                   // 重叠
    }
    return true;
  }

  // 把飞机们画进 size×size 数组：0=空 1=机身 2=机头
  // 服务器用它"查表"判断揭示结果。这个数组只存在服务器内存里，绝不发给客户端。
  function buildBoard(planes, spec) {
    const size = getBoardSpec(spec).size;
    const board = [];
    for (let r = 0; r < size; r++) {
      board.push(new Array(size).fill(CELL_EMPTY));
    }
    planes.forEach(function (p) {
      getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell, i) {
        board[cell[0]][cell[1]] = (i === 0) ? CELL_HEAD : CELL_BODY;
      });
    });
    return board;
  }

  // 完整校验一次部署（服务器收到"确认部署"时调用）：
  // 通过返回 null；不通过返回中文错误提示。
  function validateDeployment(planes, spec) {
    const planeCount = getBoardSpec(spec).planeCount;
    if (!Array.isArray(planes) || planes.length !== planeCount) {
      return '必须正好放满 ' + planeCount + ' 架飞机';
    }
    const allCells = [];
    for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      if (!p || !PLANE_SHAPES[p.dir]) return '第 ' + (i + 1) + ' 架飞机的朝向无效';
      if (!Number.isInteger(p.headRow) || !Number.isInteger(p.headCol)) {
        return '第 ' + (i + 1) + ' 架飞机的机头坐标无效';
      }
      // canPlacePlane 同时检查越界 + 与前面所有飞机的重叠（spec 必须透传，否则固定按 10×10 检查）
      if (!canPlacePlane(allCells, p.headRow, p.headCol, p.dir, spec)) {
        return '第 ' + (i + 1) + ' 架飞机越界或与其它飞机重叠';
      }
      getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
        allCells.push(cell);
      });
    }
    return null; // 校验通过
  }

  // ---------- 导出（兼容浏览器和 Node） ----------
  const api = {
    BOARD_SIZE: BOARD_SIZE,
    PLANE_COUNT: PLANE_COUNT,
    BOARD_SPECS: BOARD_SPECS,
    getBoardSpec: getBoardSpec,
    CELL_EMPTY: CELL_EMPTY,
    CELL_BODY: CELL_BODY,
    CELL_HEAD: CELL_HEAD,
    PLANE_SHAPES: PLANE_SHAPES,
    getPlaneCells: getPlaneCells,
    canPlacePlane: canPlacePlane,
    buildBoard: buildBoard,
    validateDeployment: validateDeployment
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;   // Node 服务器：require('./public/shared.js')
  } else {
    Object.assign(root, api); // 浏览器：直接变成全局函数
  }
})(typeof window !== 'undefined' ? window : global);
