// ============================================
// shared.js —— 前后端共用的游戏逻辑（网页版 public/shared.js 的复制品）
// 小程序用 CommonJS require 加载，走 module.exports 分支。
// 飞机形状、摆放校验和服务器完全一致，保证两边玩法完全相同。
// ============================================
(function (root) {
  'use strict';

  // ---------- 棋盘常量 ----------
  const BOARD_SIZE = 10;    // 棋盘是 10×10
  const PLANE_COUNT = 3;    // 每方部署 3 架飞机

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
  function canPlacePlane(existingCells, headRow, headCol, dir) {
    if (!PLANE_SHAPES[dir]) return false; // 朝向不合法
    const cells = getPlaneCells(headRow, headCol, dir);
    // 把 [行, 列] 压成一个数字，放进 Set 里快速查重
    const used = new Set();
    existingCells.forEach(function (cell) {
      used.add(cell[0] * BOARD_SIZE + cell[1]);
    });
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i][0];
      const c = cells[i][1];
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return false; // 越界
      if (used.has(r * BOARD_SIZE + c)) return false;                         // 重叠
    }
    return true;
  }

  // 把飞机们画进 10×10 数组：0=空 1=机身 2=机头
  // 服务器用它"查表"判断揭示结果。这个数组只存在服务器内存里，绝不发给客户端。
  function buildBoard(planes) {
    const board = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      board.push(new Array(BOARD_SIZE).fill(CELL_EMPTY));
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
  function validateDeployment(planes) {
    if (!Array.isArray(planes) || planes.length !== PLANE_COUNT) {
      return '必须正好放满 ' + PLANE_COUNT + ' 架飞机';
    }
    const allCells = [];
    for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      if (!p || !PLANE_SHAPES[p.dir]) return '第 ' + (i + 1) + ' 架飞机的朝向无效';
      if (!Number.isInteger(p.headRow) || !Number.isInteger(p.headCol)) {
        return '第 ' + (i + 1) + ' 架飞机的机头坐标无效';
      }
      // canPlacePlane 同时检查越界 + 与前面所有飞机的重叠
      if (!canPlacePlane(allCells, p.headRow, p.headCol, p.dir)) {
        return '第 ' + (i + 1) + ' 架飞机越界或与其它飞机重叠';
      }
      getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
        allCells.push(cell);
      });
    }
    return null; // 校验通过
  }

  // ---------- 导出（小程序走 CommonJS） ----------
  const api = {
    BOARD_SIZE: BOARD_SIZE,
    PLANE_COUNT: PLANE_COUNT,
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
    module.exports = api;   // Node / 小程序：require('./utils/shared.js')
  } else {
    Object.assign(root, api); // 浏览器：直接变成全局函数
  }
})(typeof window !== 'undefined' ? window : globalThis);
