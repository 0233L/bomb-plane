// ============================================
// client.js —— 炸飞机前端逻辑
// 负责：连接服务器、切换页面、渲染棋盘、处理点击、断线恢复
// 依赖：shared.js 里的全局函数（getPlaneCells、canPlacePlane 等）
// ============================================
'use strict';

// ---------- 小工具 ----------
function $(sel) { return document.querySelector(sel); }

// 底部弹出小提示，2 秒后消失
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2000);
}

// ---------- 自定义确认弹窗 ----------
// iOS 小黑盒 WebView 会屏蔽 window.confirm（直接返回 false），
// 所以「返回菜单」等确认操作改用页面里的 #confirm-modal。
// 点「确定」才执行 action；点「取消」或深色背景什么都不做。
let confirmAction = null;

function showConfirm(message, action) {
  confirmAction = action;
  $('#confirm-text').textContent = message;
  $('#confirm-modal').classList.remove('hidden');
}

function closeConfirm() {
  confirmAction = null;
  $('#confirm-modal').classList.add('hidden');
}

// ---------- 修改昵称弹窗 ----------
// window.prompt 在 iOS 沙箱里同样可能被屏蔽，改成页面里的输入弹窗。
function openNicknameModal() {
  $('#nickname-modal-input').value = state.names[state.seat] || '';
  $('#nickname-modal-error').textContent = '';
  $('#nickname-modal').classList.remove('hidden');
  $('#nickname-modal-input').focus();
}

function closeNicknameModal() {
  $('#nickname-modal').classList.add('hidden');
}

// ---------- 同屏双人：顶部换人悬浮条 ----------
// 不强制换人。规则：
//   - 步数落后：不显示悬浮条（必须先行动追平，否则对方接过去也不能行动）；
//   - 步数相等：半透明悬浮条，可以继续行动，也可以主动换人；
//   - 步数领先：悬浮条不透明度拉满，提示必须换人（领先方已经不能行动）。
// 只有玩家自己点「切换玩家」，才会弹出不透明的交接页，保护上一位玩家的布局。
let pendingPassSeat = null; // 等待接手的座位（null = 当前没有交接）
let pendingPassIsResume = false; // 这次交接是「继续上局」而不是正常换人

function currentViewId() {
  const el = document.querySelector('.view.active');
  return el ? el.id : '';
}

// 把悬浮条插到当前页顶部栏的下方。
// 不能直接 fixed 在屏幕最上方：那会盖住「返回菜单 / 规则」等按钮，玩家点不到。
// 对战页有 #switch-slot：悬浮条和信息栏一起放进吸顶容器，换人条始终在信息栏上方；
// 部署页没有插槽，仍插在顶部栏下方。
function dockSwitchBar(bar) {
  const view = document.querySelector('.view.active');
  if (!view) return;
  const slot = view.querySelector('#switch-slot');
  if (slot) {
    if (slot.firstElementChild !== bar) slot.appendChild(bar);
    return;
  }
  const topbar = view.querySelector('.topbar');
  if (topbar && topbar.nextElementSibling !== bar) {
    topbar.insertAdjacentElement('afterend', bar);
  }
}

function renderSwitchBar() {
  const bar = $('#switch-bar');
  if (!bar) return;
  if (!state.local2p || state.spectator || state.over) {
    bar.classList.add('hidden');
    return;
  }

  const nextName = state.names[1 - state.seat] || '对方';
  const view = currentViewId();
  let show = false;
  let urgent = false;
  let text = '';

  if (view === 'view-deploy') {
    // 自己已经确认、对方还没确认：当前玩家已经没事可做，提示换人
    if (state.deployConfirmed[state.seat] && !state.deployConfirmed[1 - state.seat]) {
      show = true;
      urgent = true;
      text = '你已部署完成，请切换给 ' + nextName;
    }
  } else if (view === 'view-battle') {
    const mine = state.steps[state.seat];
    const theirs = state.steps[1 - state.seat];
    if (mine >= theirs) {
      show = true;
      urgent = mine > theirs;
      text = urgent
        ? '你已领先，请切换给 ' + nextName + ' 行动'
        : '可以切换给 ' + nextName + ' 行动';
    }
  }

  if (!show) {
    bar.classList.add('hidden');
    return;
  }
  dockSwitchBar(bar);
  $('#switch-text').textContent = text;
  bar.classList.toggle('urgent', urgent);
  bar.classList.remove('hidden');
}

// 玩家主动点「切换玩家」后，才显示不透明的交接页。
// 不传参 = 正常换人（切到下一位玩家）；opts.isResume = 从首页继续上局，
// 此时 seat 是暂停时正在操作的玩家，必须由本人确认后才能恢复现场。
function showPassCover(seat, opts) {
  const o = opts || {};
  const isResume = !!o.isResume;
  const target = (seat == null) ? 1 - state.seat : seat;
  const names = o.names || state.names;
  const name = names[target] || '对方';
  const phase = o.phase || (currentViewId() === 'view-deploy' ? 'deploy' : 'battle');
  pendingPassSeat = target;
  pendingPassIsResume = isResume;
  $('#pass-name').textContent = name;
  $('#pass-hint').textContent = isResume
    ? (phase === 'deploy' ? '继续摆放你的飞机' : '继续刚才的对局')
    : (currentViewId() === 'view-deploy' ? '轮到你摆放自己的飞机' : '轮到你开火');
  $('#btn-pass-ready').textContent = isResume
    ? '我是 ' + name + '，继续'
    : '我是 ' + name + '，开始';
  $('#pass-modal').classList.remove('hidden');
}

function hidePassModal() {
  pendingPassSeat = null;
  pendingPassIsResume = false;
  $('#pass-modal').classList.add('hidden');
}

// 本地模式：隐藏「房间号 / 复制房间号」这类只有联机才用得上的元素
function updateRoomChrome() {
  const local = !!state.localMode;
  document.querySelectorAll('.room-tag, .btn-copy-link').forEach(function (el) {
    el.classList.toggle('hidden', local);
  });
}

// 切换显示哪一个页面（home / deploy / battle / over）
function showView(name) {
  // 服务端也可能主动切页（房间回收、离开、重连失败）：
  // 切页时收起残留的确认/昵称/历史弹窗，避免盖住新页面
  closeConfirm();
  closeNicknameModal();
  closeHistoryModal();
  hidePassModal();
  $('#switch-bar').classList.add('hidden');
  document.querySelectorAll('.view').forEach(function (v) {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
}

// 部署页/对战页顶部的玩法徽标：道具版才显示（含地图规格），经典模式隐藏
function renderModeBadge() {
  const spec = curSpec();
  const isProps = state.mode === 'props';
  document.querySelectorAll('.mode-badge').forEach(function (el) {
    el.textContent = '🎁 道具版 · ' + spec.size + '×' + spec.size + ' · ' + spec.planeCount + ' 架';
    el.classList.toggle('hidden', !isProps);
  });
}

// 按当前房间规格重建三张棋盘（进房/开战/重连时规格可能不同，10×10 老房间无感）
function rebuildBoards() {
  makeBoard($('#deploy-board'), onDeployCellClick);
  makeBoard($('#my-board'), null);
  makeBoard($('#enemy-board'), onEnemyCellClick);
}

// ---------- localStorage 安全读写 ----------
// 隐私模式 / 存储满 / 被禁用时 getItem/setItem/removeItem 会抛异常，
// 整个页面不该因此崩掉。小黑盒沙箱可能禁用 localStorage：
// 同一会话内退回内存存储，至少不影响当前对局（刷新后可能丢失）。
const memoryStore = Object.create(null);

// 这些 key 额外镜像一份到小黑盒宿主存储（hb-sdk storage）。
// 原因：iOS 小黑盒沙箱里 localStorage 刷新后可能丢失，
// 只靠它会导致刷新后「最近加入的房间」为空、无法自动续局。
const HOST_STORAGE_KEYS = [
  'bp_theme', 'bp_name', 'bp_avatar', 'bp_visitor_id', 'bp_room_history',
  'bp_draft', 'bp_spec_classic', 'bp_spec_props', 'bp_match_history',
  'bp_reveal_confirm', 'bp_reveal_confirm_p0', 'bp_reveal_confirm_p1'
];

// 宿主存储报错只提示一次，避免刷屏；真机排查时能看出是否降级了
let storageWarned = false;
function warnStorageOnce(err) {
  if (storageWarned) return;
  storageWarned = true;
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[hb-sdk] 宿主存储不可用，已降级为本地存储', err);
  }
}

function safeGet(key) {
  // 写失败的值只存在内存里，所以先查内存兜底；
  // 这样即使 localStorage 能读不能写（例如存储空间满），也能读到本次会话的值。
  // 内存里的 null 表示「已删除」：避免 localStorage 删不掉时又读回旧值。
  // 从宿主存储恢复的值也放在 memoryStore 里（见 hydrateHostStorage）。
  if (Object.prototype.hasOwnProperty.call(memoryStore, key)) {
    return memoryStore[key] === null ? null : memoryStore[key];
  }
  try { return localStorage.getItem(key); }
  catch (e) { return null; }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    delete memoryStore[key]; // 持久化成功后清掉旧的兜底值，避免读到过期内容
  } catch (e) {
    memoryStore[key] = String(value);
  }
  // 无论 localStorage 是否成功，都再往宿主存储写一份（刷新后靠它恢复）
  mirrorToHostStorage(key, value);
}

function safeRemove(key) {
  memoryStore[key] = null; // 先标记删除：即使 localStorage 删除失败，也不会再读到旧值
  try { localStorage.removeItem(key); } catch (e) { /* 内存已标记删除 */ }
  // SDK 没有删除接口：用 null 表示「已删除」，恢复时会跳过它
  mirrorToHostStorage(key, null);
}

// ---------- 小黑盒宿主存储（刷新恢复用） ----------
// 每个 key 一条 Promise 写入链：快速连续写入时按调用顺序落盘，不会被旧值覆盖。
const hostWriteChains = Object.create(null);

// 把白名单 key 镜像到宿主存储；宿主没实现（例如 Browser Mock）时静默跳过
function mirrorToHostStorage(key, value) {
  if (HOST_STORAGE_KEYS.indexOf(key) === -1) return;

  try {
    const sdk = window.__hbSDK;
    if (!sdk || !sdk.storage || typeof sdk.storage.setStorage !== 'function') return;

    const before = hostWriteChains[key] || Promise.resolve();
    hostWriteChains[key] = before.then(function () {
      // SDK 会把 data 做 JSON 序列化；这里统一存字符串，读回来再还原
      return sdk.storage.setStorage({ key: key, data: value == null ? null : String(value) });
    }).then(function () {
      // 写入成功：不需要额外处理
    }, function (err) {
      // 宿主存储不可用：不影响游戏，只记录一次方便真机排查
      warnStorageOnce(err);
    });
  } catch (e) {
    // 任何意外都不能影响游戏本身的存储流程
    warnStorageOnce(e);
  }
}

// 从宿主存储恢复白名单 key（启动时最多等 1 秒，见文件末尾）。
// localStorage 里已有值的 key 以 localStorage 为准（本地更新/可用）；
// 恢复结果放进 memoryStore，safeGet 会优先读它，所以旧代码不用改。
// 并行读取所有 key：只有一个来回的等待时间，避免逐个 await 拖到超时。
async function hydrateHostStorage() {
  const sdk = window.__hbSDK;
  if (!sdk || !sdk.storage || typeof sdk.storage.getStorage !== 'function') return;

  await Promise.all(HOST_STORAGE_KEYS.map(async function (key) {
    try {
      let localValue = null;
      try { localValue = localStorage.getItem(key); } catch (e) { localValue = null; }
      if (localValue !== null) return; // 本地有值：比宿主旧数据更新，直接用本地的

      const result = await sdk.storage.getStorage({ key: key });
      if (!result || result.data === undefined || result.data === null) return;

      // 等待期间用户可能已经改过这个 key（或 localStorage 已恢复）：
      // 以更新的值为准，不能用迟到的宿主旧值覆盖。
      if (Object.prototype.hasOwnProperty.call(memoryStore, key)) return;
      let localNow = null;
      try { localNow = localStorage.getItem(key); } catch (e) { localNow = null; }
      if (localNow !== null) return;

      // 正常情况存的是字符串；旧数据可能是别的类型，统一转成字符串
      memoryStore[key] = typeof result.data === 'string' ? result.data : String(result.data);
    } catch (e) {
      // 单个 key 读取失败不影响其他 key（宿主可能不支持存储）
      warnStorageOnce(e);
    }
  }));
}

// ---------- 昵称基础内容安全 ----------
// 昵称会展示给对手，提交审核前需要挡住明显的广告、联系方式和不雅内容。
// 注意：这里只是前端过滤，直接连 WebSocket 的客户端可以绕过；
// 更严格的方案是在服务器统一校验（本任务不修改 server.js）。
const NICKNAME_MAX = 12;
const BAD_NICKNAME_PATTERNS = [
  /https?:\/\//i,                                      // 网址
  /\bwww\./i,
  /\b[a-z0-9-]+\.(com|cn|net|org|xyz|top)\b/i,         // 裸域名
  /\d{7,}/,                                            // 连续长数字（手机号/QQ 号）
  /(加群|进群|扫码|代练|外挂|出售|卖号|博彩|赌博|色情|裸聊|毒品|冰毒|大麻)/i,
  /(微信|薇信|威信|qq|vx|wx)\s*[:：]?\s*[0-9a-z_-]{5,}/i, // 联系方式
  /(傻逼|操你|草你|妈的|fuck|shit|bitch)/i
];

// 返回 { ok: true, name } 或 { ok: false, reason }
// 留空返回 name=''，由调用方决定用随机昵称还是保持原昵称
function checkNickname(raw) {
  // NFKC 统一全角字符，去掉控制字符 / 零宽字符，避免用不可见字符伪装昵称
  // （极老的 WebView 没有 normalize 时跳过这一步，不能因此让昵称输入报错）
  const text = String(raw || '');
  const normalized = typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
  const name = normalized
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!name) return { ok: true, name: '' };
  if (Array.from(name).length > NICKNAME_MAX) {
    return { ok: false, reason: '昵称最长 12 个字符' };
  }
  for (let i = 0; i < BAD_NICKNAME_PATTERNS.length; i++) {
    if (BAD_NICKNAME_PATTERNS[i].test(name)) {
      return { ok: false, reason: '昵称包含不允许的内容，请换一个' };
    }
  }
  return { ok: true, name: name };
}

// ---------- 主题切换（右上角按钮） ----------
// 三种模式循环：跟随系统 → 浅色 → 深色。选择存在 localStorage 里，默认跟随系统
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_ICONS = { auto: '🌓', light: '☀️', dark: '🌙' };
const THEME_TITLES = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };

function savedTheme() {
  return safeGet('bp_theme') || 'auto';
}

// 「跟随系统」模式下实际显示哪种颜色
function resolvedTheme() {
  if (savedTheme() === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return savedTheme();
}

// 应用主题（给 <html> 加 data-theme，CSS 按它换色）+ 更新按钮图标和悬停提示
function applyTheme() {
  document.documentElement.setAttribute('data-theme', resolvedTheme());
  const btn = $('#btn-theme');
  btn.textContent = THEME_ICONS[savedTheme()];
  btn.title = THEME_TITLES[savedTheme()];
}

// 点按钮：切到下一个模式
function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(savedTheme()) + 1) % THEME_ORDER.length];
  safeSet('bp_theme', next);
  applyTheme();
}

// 系统深浅色变化时：只有「跟随系统」模式才跟着变
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
  if (savedTheme() === 'auto') applyTheme();
});

// ---------- 最近加入的房间（重连用） ----------
// 历史记录存在 localStorage 里，形如 [{roomId, token, name, lastSeen}]，最多 5 条
// lastSeen = 我最后一次在这个房间里在线的时间（毫秒时间戳），列表按它从新到旧排序
function loadRoomHistory() {
  try {
    return JSON.parse(safeGet('bp_room_history') || '[]');
  } catch (e) { return []; }
}

// 按最后在线时间从新到旧排序后写回 localStorage（旧数据没有 lastSeen，按 0 处理排最后）
function sortAndSaveHistory(list) {
  list.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  safeSet('bp_room_history', JSON.stringify(list.slice(0, 5)));
  return list;
}

// 创建/加入房间成功后记录到历史（同一房间只保留最新一条，时间戳更新为现在）
function saveRoomToHistory(roomId, token, name) {
  const list = sortAndSaveHistory(
    loadRoomHistory().filter(function (e) { return e.roomId !== roomId; })
      .concat([{ roomId: roomId, token: token, name: name, lastSeen: Date.now(), left: false }])
  );
  renderRecentRooms();
}

// 刷新某个房间的最后在线时间（重连成功、点「进入」时调用），并重新排序
function updateRoomLastSeen(roomId) {
  const list = loadRoomHistory();
  const entry = list.find(function (e) { return e.roomId === roomId; });
  if (!entry) return;
  entry.lastSeen = Date.now();
  sortAndSaveHistory(list);
  renderRecentRooms();
}
function removeRoomFromHistory(roomId) {
  safeSet('bp_room_history', JSON.stringify(
    loadRoomHistory().filter(function (e) { return e.roomId !== roomId; })
  ));
  renderRecentRooms();
}

// ---------- 我的头像（localStorage bp_avatar，首次访问随机分配） ----------
// 有就返回；没有/坏了（不在池里）就随机一个存起来——坏数据自动修复
function myAvatar() {
  const saved = safeGet('bp_avatar');
  if (saved && AVATAR_POOL.indexOf(saved) !== -1) return saved;
  const av = randomAvatar();
  safeSet('bp_avatar', av);
  return av;
}

// 换成新头像：存起来 + 更新 state + 刷新所有显示我的头像的位置。
// 在房间里时通知服务器，对方和观战者马上看到新头像（不在房间时服务器静默忽略）
function setMyAvatar(emoji) {
  // 同屏双人里 2 号位只是临时玩家：换头像不要覆盖设备主人的记忆
  if (!(state.local2p && state.seat !== 0)) safeSet('bp_avatar', emoji);
  state.avatar = emoji;
  state.socket.emit('setAvatar', { avatar: emoji });
  renderMyAvatar();
  updateBattlePanels(); // 对战页自己的面板可能正在显示头像
}

// 刷新首页（+邀请页）的我的头像显示
function renderMyAvatar() {
  const av = myAvatar();
  const home = $('#home-avatar'); if (home) home.textContent = av;
  const invite = $('#invite-avatar'); if (invite) invite.textContent = av;
}

// 比分牌 tooltip 文本：头像 + 昵称。
// 观战视角（seat 被借用为 0）全用广播的头像；玩家视角自己的座位用本地头像（对局中换了立刻生效）
function myAvatarLabel(seat) {
  const av = state.spectator
    ? (state.avatars[seat] || '')
    : (seat === state.seat ? state.avatar : (state.avatars[seat] || ''));
  return (av ? av + ' ' : '') + state.names[seat];
}

// 打开头像选择面板：把池子渲染成按钮网格 + 🎲 随机按钮
function openAvatarModal() {
  const pool = $('#avatar-pool');
  if (pool && !pool.children.length) {
    AVATAR_POOL.forEach(function (emoji) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', function () {
        setMyAvatar(emoji);
        $('#avatar-modal').classList.add('hidden');
      });
      pool.appendChild(btn);
    });
  }
  $('#avatar-modal').classList.remove('hidden');
}

// ---------- 匿名访客 ID（访客统计用，不存任何个人信息） ----------
// 首次访问生成一次，之后一直复用；清掉浏览器存储 = 算一个新访客（可接受）
function getVisitorId() {
  const id = safeGet('bp_visitor_id');
  if (id) return id;
  const gen = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  safeSet('bp_visitor_id', 'v' + gen);
  return 'v' + gen;
}

// ---------- 网址中的房间号（兼容旧的邀请链接） ----------
// 小黑盒沙箱里复制出的网页链接别人打不开，所以不再把房间号写进地址栏，
// 邀请统一改用 4 位房间号；刷新恢复依赖房间历史
//（localStorage + hb-sdk 宿主存储双份，见 hydrateHostStorage）。
// 读取 ?room=XXXX 的逻辑保留，旧链接在普通浏览器里仍能进入受邀页

// 空函数：保留调用点，避免大改业务逻辑（原先用于把 ?room=XXXX 写进地址栏）
function setRoomInUrl(roomId) {
  // 不再修改地址栏
}

// 空函数：保留调用点（原先用于清掉地址栏里的房间号参数）
function clearRoomFromUrl() {
  // 不再修改地址栏
}

// 渲染首页的「最近加入的房间」列表：点「进入」用保存的凭证重连该房间
function renderRecentRooms() {
  const card = $('#recent-card');
  const ul = $('#recent-list');
  // 离线版首页没有「最近加入的房间」卡片：没有元素就直接跳过
  if (!card || !ul) return;
  const list = loadRoomHistory();
  ul.innerHTML = '';
  if (!list.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  list.forEach(function (e) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    // 历史记录里的房间都是"我"进过的，头像统一显示当前的头像
    info.textContent = '房间 ' + e.roomId + ' · ' + myAvatar() + ' ' + e.name;
    const joinBtn = document.createElement('button');
    joinBtn.className = 'recent-enter';
    joinBtn.textContent = '进入';
    joinBtn.addEventListener('click', function () {
      // 手动点「进入」= 主动回来：清掉「已离开」标记，以后刷新还能自动回到这局
      userStarted = true;
      const list = loadRoomHistory();
      const entry = list.find(function (x) { return x.roomId === e.roomId; });
      if (entry) { entry.left = false; sortAndSaveHistory(list); }
      updateRoomLastSeen(e.roomId); // 即将进入该房间，刷新它的最后在线时间
      emitIfConnected('rejoin', { token: e.token, roomId: e.roomId });
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', function () { removeRoomFromHistory(e.roomId); });
    li.appendChild(info);
    li.appendChild(joinBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  });
  // 列表是动态生成的，建好后按当前连接状态同步「进入」按钮
  refreshOnlineControls();
}

// ---------- 全局状态 ----------
// 用户是否已经主动开局（创建/加入/人机/点最近房间）。
// 宿主存储恢复可能比 init 晚到：这时不能再把用户"拽回"上次的房间。
let userStarted = false;

const state = {
  token: null, roomId: null, seat: null, name: '',
  names: ['', ''],           // 双方昵称
  avatar: '',                // 我自己的头像 emoji（localStorage bp_avatar，首次访问随机）
  avatars: ['', ''],         // 双方头像（服务器广播，与 names 一一对应）
  online: [false, false],    // 双方是否在线（绿点/红点）
  mode: 'classic',           // 当前房间玩法：classic（经典）| props（道具版）
  boardSize: 'S',            // 当前房间地图规格：S=10×10/3架 | M=12×12/4架 | L=14×14/6架
  coins: [0, 0],             // 双方金币（道具版；经典版为 0）
  steps: [0, 0],             // 双方步数（各自揭示了多少格）
  score: [0, 0],             // 双方累计胜场（同一房间连续对局，第二局起显示）
  headsLeft: [3, 3],         // 双方还剩几个机头没被打中
  sonarResults: [],          // 声呐脉冲的历史结果 [{row, col, count, attacker}]（扫雷式推理用）
  frozenCells: [],           // 毁灭菇冻结的格子 [{row, col, owner, expiry}]（只约束施放者自己，渲染 ❄）
  marks: {},                 // 注释标记 {'r,c': 'body'}（右键/长按标注「机身」绿框，仅本机可见，按房间持久化）
  itemPick: null,            // 道具选区模式：null = 未选择 | {itemId}
  pickCells: [],             // 已固定的选区格子（'r,c' 字符串数组，金色高亮）
  pickAnchor: null,          // 3x3 道具的选区锚点（左上角，发给服务器）
  pickReady: false,          // 选区是否已完整（完整后显示「确认使用」按钮）
  pickFirstKey: null,        // 3×3 道具第一击的定位格（'r,c'；重复点击它 = 确认，不是锚点）
  pickHover: [],             // 鼠标悬停预览的格子（'r,c' 数组，仅区域型道具）
  deployConfirmed: [false, false],
  myPlanes: [],              // 自己已确认的 3 架飞机（battle 阶段必有）
  myShotsReceived: [],       // 对方打我的记录 [{row, col, result}]
  enemyShotsReceived: [],    // 我打对方的记录
  winner: null,
  rematchVotes: [false, false],
  curDir: 'up',              // 部署页当前选中的朝向
  draft: [],                 // 部署草稿 [{headRow, headCol, dir}]
  inviteRoomId: null,        // 从邀请链接读到的房间号（受邀加入页用）
  spectator: false,          // 我是不是观战者（房间满员时进入观战席）
  spectatorCount: 0,         // 本房间的观战人数（0 时不显示徽章）
  over: false,               // 本局是否已结束（结束后棋盘保留并公开飞机）
  revealedPlanes: null,      // 对局结束后服务器公开的双方飞机 [A 的, B 的]
  localMode: false,          // 是否本地对局（离线版：人机/同屏双人）
  local2p: false,            // 是否同屏双人（需要交接设备）
  historyRecorded: false,    // 本局是否已写入对战历史（每局只写一次）
  revealConfirm: false,      // 探测二次确认：开启后普通探测要连点同一格两次
  revealPending: null,       // 二次确认已选中的目标 {row, col}（尚未提交）
  suspended: null,           // 返回菜单后暂停的房间摘要（首页「继续上局」）
  resumeDraft: null          // 返回菜单前未确认的部署草稿（仅内存，不落盘）
};

// ---------- 对战历史（只存在本机，刷新后仍在） ----------
// 数据的校验 / 格式化在 match-history.js（window.MatchHistory）；
// 这里只负责读写存储、把记录渲染成弹窗里的列表。
// 注意：存储失败、坏 JSON 都不能影响对局结算和首页启动，所以全部包 try/catch。
function loadMatchHistory() {
  try {
    const MH = window.MatchHistory;
    if (!MH) return [];
    return MH.load(safeGet(MH.STORAGE_KEY));
  } catch (e) {
    return []; // 解析失败就当没有记录
  }
}

function saveMatchHistory(list) {
  try {
    const MH = window.MatchHistory;
    if (!MH) return;
    safeSet(MH.STORAGE_KEY, MH.serialize(list));
  } catch (e) {
    // 历史记录不是游戏必需功能：写入失败时静默忽略
  }
}

// 一局正常结束后写一条记录（只在 gameOver 处理器里调用，battleStart 时重置标记）
// winnerSeat：0 = 座位 0（人机对战里是玩家自己），1 = 座位 1（人机对战里是电脑）
// planes：服务器在 gameOver 里公开的双方飞机，用于「点历史记录回看棋盘」
function recordMatchResult(winnerSeat, planes) {
  try {
    if (!state.localMode || state.spectator) return; // 只记录本机对局
    const MH = window.MatchHistory;
    if (!MH) return;

    // 落子记录按「被攻击的座位」归档：
    //   myShotsReceived   = 打在当前视角座位上的记录
    //   enemyShotsReceived = 打在对手座位上的记录
    const mySeat = state.seat === 1 ? 1 : 0;
    const shots = [[], []];
    shots[mySeat] = (state.myShotsReceived || []).map(function (s) {
      return { row: s.row, col: s.col, result: s.result, destroyed: s.destroyed === true };
    });
    shots[1 - mySeat] = (state.enemyShotsReceived || []).map(function (s) {
      return { row: s.row, col: s.col, result: s.result, destroyed: s.destroyed === true };
    });

    const record = MH.createRecord({
      time: Date.now(),
      kind: state.local2p ? 'local2p' : 'ai',
      mode: state.mode,
      boardSize: state.boardSize,
      names: state.names,     // createRecord 内部会复制数组
      avatars: state.avatars,
      steps: state.steps,     // gameOver 前最后一次 revealResult/itemResult 已同步
      winnerSeat: winnerSeat,
      planes: planes || state.revealedPlanes, // 双方终局飞机布局
      shots: shots                           // 双方棋盘各自的落子结果
    });
    // 先读出旧列表 → 新记录放最前 → 最多保留 20 条
    const next = MH.append(safeGet(MH.STORAGE_KEY), record);
    saveMatchHistory(next);
  } catch (e) {
    // 写历史失败绝不能让结算页崩掉
  }
}

// 把历史记录渲染到弹窗列表里（全部用 createElement + textContent，昵称不会被当成 HTML）
function renderMatchHistory() {
  const listEl = $('#history-list');
  if (!listEl) return;

  const emptyEl = $('#history-empty');
  const clearBtn = $('#btn-history-clear');
  const MH = window.MatchHistory;
  const list = loadMatchHistory();

  listEl.innerHTML = ''; // 这个列表完全由本函数生成，清空后重新创建

  if (emptyEl) emptyEl.classList.toggle('hidden', list.length > 0);
  if (clearBtn) clearBtn.disabled = list.length === 0;

  list.forEach(function (record) {
    const li = document.createElement('li');

    // 第一行：头像+昵称 vs 头像+昵称 + 结果
    const title = document.createElement('div');
    title.className = 'history-title';
    [0, 1].forEach(function (seat) {
      if (seat === 1) {
        const vs = document.createElement('span');
        vs.className = 'history-vs';
        vs.textContent = 'vs';
        title.appendChild(vs);
      }
      const player = document.createElement('span');
      player.className = 'history-player';
      const avatar = record.avatars[seat] || '';
      const name = record.names[seat] || ('玩家' + (seat + 1));
      player.textContent = (avatar ? avatar + ' ' : '') + name;
      title.appendChild(player);
    });
    const result = document.createElement('span');
    result.className = 'history-result ' + (record.kind === 'local2p'
      ? 'history-local'
      : (record.winnerSeat === 0 ? 'history-win' : 'history-loss'));
    result.textContent = MH ? MH.formatResult(record) : '';
    title.appendChild(result);
    li.appendChild(title);

    // 第二行：时间 · 类型 · 玩法 · 地图 · 步数
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = MH ? MH.formatMeta(record) : '';
    li.appendChild(meta);

    // 有终局快照的记录可以点进去看双方棋盘；旧记录明确说明不能回看
    const hasBoard = MH ? MH.hasBoard(record) : false;
    const openHint = document.createElement('div');
    openHint.className = 'history-open' + (hasBoard ? '' : ' history-open-old');
    openHint.textContent = hasBoard ? '🛩️ 查看终局棋盘' : '旧记录未保存棋盘';
    li.appendChild(openHint);

    if (hasBoard) {
      li.classList.add('history-clickable');
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      const open = function () { openHistoryDetail(record); };
      li.addEventListener('click', open);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }

    listEl.appendChild(li);
  });
}

// 打开历史弹窗：每次都重新读存储，保证显示的是最新记录
function openHistoryModal() {
  closeHistoryDetail(); // 从详情返回时列表可能还开着，先收起详情
  renderMatchHistory();
  $('#history-modal').classList.remove('hidden');
}

function closeHistoryModal() {
  closeHistoryDetail();
  const modal = $('#history-modal');
  if (modal) modal.classList.add('hidden');
}

// 历史详情：用记录里的终局快照画双方棋盘（只读，不可点击）
// 记录格式由 match-history.js 校验：planes[座位] 是飞机坐标，shots[座位] 是打在该座位上的记录
function openHistoryDetail(record) {
  const MH = window.MatchHistory;
  if (!MH || !MH.hasBoard(record)) return;

  const resultEl = $('#history-detail-result');
  const metaEl = $('#history-detail-meta');
  const boardsEl = $('#history-detail-boards');
  if (!resultEl || !metaEl || !boardsEl) return;

  resultEl.className = 'history-detail-result';
  if (record.kind === 'ai') {
    resultEl.classList.add(record.winnerSeat === 0 ? 'history-win' : 'history-loss');
  } else if (record.kind === 'local2p') {
    resultEl.classList.add('history-local');
  }
  resultEl.textContent = MH.formatResult(record);
  metaEl.textContent = MH.formatMeta(record);

  boardsEl.textContent = ''; // 这个容器完全由本函数生成
  [0, 1].forEach(function (seat) {
    const col = document.createElement('div');
    col.className = 'history-board-col';

    const title = document.createElement('h3');
    const avatar = record.avatars[seat] || '';
    const name = record.names[seat] || ('玩家' + (seat + 1));
    title.textContent = (record.winnerSeat === seat ? '👑 ' : '') +
      (avatar ? avatar + ' ' : '') + name + ' 的棋盘';
    col.appendChild(title);

    const board = buildBoard(record.planes[seat] || [], record.boardSize);
    const size = board.length;
    const boardEl = document.createElement('div');
    boardEl.className = 'history-board';
    boardEl.style.setProperty('--n', String(size));
    boardEl.setAttribute('role', 'img');
    boardEl.setAttribute('aria-label', name + ' 的终局棋盘');

    // 同一格可能被多个道具/揭示记录覆盖：销毁标记优先级最高
    const marks = {};
    const shots = (record.shots && record.shots[seat]) || [];
    shots.forEach(function (s) {
      const key = s.row + ',' + s.col;
      const prev = marks[key];
      if (!prev || s.destroyed || s.result === 'destroyed') marks[key] = s;
    });

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const cell = document.createElement('div');
        cell.className = 'history-cell';
        const type = board[r][c];
        if (type === CELL_HEAD) cell.classList.add('hist-head');
        else if (type === CELL_BODY) cell.classList.add('hist-body');
        else cell.classList.add('hist-empty');

        const shot = marks[r + ',' + c];
        if (!shot) {
          // 这格从没被探测过：保留飞机颜色，但蒙一层暗色，和游戏结束页一致
          cell.classList.add('hist-dimmed');
        } else if (shot.destroyed || shot.result === 'destroyed') {
          cell.classList.add('hist-x'); // 被吞噬者摧毁的格子
        }
        boardEl.appendChild(cell);
      }
    }
    col.appendChild(boardEl);
    boardsEl.appendChild(col);
  });

  $('#history-detail-modal').classList.remove('hidden');
}

function closeHistoryDetail() {
  const modal = $('#history-detail-modal');
  if (modal) modal.classList.add('hidden');
}

// 清空历史：复用页面内的确认弹窗（iOS 不支持 window.confirm）
function clearMatchHistory() {
  showConfirm('确定要清空全部对战记录吗？清空后无法恢复。', function () {
    try {
      const MH = window.MatchHistory;
      if (MH) safeSet(MH.STORAGE_KEY, '[]');
      renderMatchHistory();
      toast('对战记录已清空');
    } catch (e) {
      toast('清空失败，请稍后再试');
    }
  });
}

// 所有「进房」入口共用：WebSocket 还没连上时给提示。
// 服务器（Render 免费实例）冷启动可能要几十秒，WSClient 未连接时会把消息丢掉，
// 用户会以为按钮没反应；这里明确提示，等首页底部访客数出现后再点即可。
function emitIfConnected(event, data) {
  if (!state.socket || !state.socket.connected) {
    toast('正在连接服务器，请稍候…');
    return;
  }
  state.socket.emit(event, data);
}

// ---------- 服务器就绪门控（先进入界面，连上后再开放联机） ----------
// Render 免费实例冷启动要 20–90 秒。与其让首页一直转圈，不如先把界面交给用户：
// 规则、主题、昵称、切换玩法和地图规格都能用；创建/加入/人机/再来一局这些
// 需要服务器的按钮先置灰，连接成功后自动恢复。
// 注意：人机对战也是服务器上的 AI（ai.js），所以同样要等连接。
let serverReady = false;           // 当前是否已连上服务器
let hasEverConnected = false;      // 是否成功连上过一次（区分「首次等待」和「中途断线」）
let serverWaitStart = Date.now();  // 本轮等待开始时间（首次从脚本加载算起）
let serverWaitTimer = null;        // 每秒刷新等待文案的定时器

// 等待文案随等待时间升级，让用户知道页面没卡死
function updateServerWaitText() {
  const el = $('#server-status-text');
  if (!el) return;
  const sec = Math.floor((Date.now() - serverWaitStart) / 1000);
  let text;
  if (sec < 8) {
    text = '正在连接服务器…';
  } else if (sec < 30) {
    text = '服务器正在唤醒，请稍候…（免费服务器首次启动较慢）';
  } else {
    // 不把「已等待 N 秒」写进文字：提示条是 aria-live 区域，
    // 每秒变一次会让读屏软件每秒重复播报
    text = '服务器唤醒中（已等待 30 秒以上）；可以先看看规则，连上后按钮会自动可用';
  }
  // 文案真的变了才写 DOM（同样是为了不打扰读屏软件）
  if (el.textContent !== text) el.textContent = text;
}

function startServerWaitTimer() {
  if (serverWaitTimer) return;
  updateServerWaitText();
  serverWaitTimer = setInterval(updateServerWaitText, 1000);
}

function stopServerWaitTimer() {
  if (!serverWaitTimer) return;
  clearInterval(serverWaitTimer);
  serverWaitTimer = null;
}

// 按连接状态同步按钮和提示（首页 + 受邀页）
function refreshOnlineControls() {
  const offline = !serverReady;

  // 需要服务器的操作：创建房间 / 人机对战 / 加入房间 / 再来一局 / 受邀加入
  document.querySelectorAll('.mode-create, .mode-ai').forEach(function (btn) {
    btn.disabled = offline;
  });
  ['#btn-join', '#btn-rematch', '#btn-invite-join'].forEach(function (sel) {
    const el = $(sel);
    if (el) el.disabled = offline;
  });

  // 「最近加入的房间」里的「进入」是动态生成的（删除按钮不需要服务器，始终可用）
  document.querySelectorAll('#recent-list .recent-enter').forEach(function (btn) {
    btn.disabled = offline;
  });

  // 首页顶部提示条 / 受邀页提示文字
  const banner = $('#server-status');
  if (banner) banner.classList.toggle('hidden', !offline);
  const hint = $('#invite-server-hint');
  if (hint) hint.classList.toggle('hidden', !offline);
}

// 连接状态变化的统一入口（connect / disconnect / 初始化都走这里）
function setServerReady(ready) {
  const wasReady = serverReady;
  serverReady = ready;

  if (ready) {
    const waited = Date.now() - serverWaitStart;
    hasEverConnected = true;
    stopServerWaitTimer();
    // 等待超过 3 秒才提示「已连接」：网络很快时不要多弹一个提示打扰用户
    if (!wasReady && waited >= 3000) toast('已连接服务器');
  } else if (wasReady) {
    // 只有「从已连接变为断开」才重新计时；
    // 首次连接时反复失败不重置，等待文案会按总时间继续升级
    serverWaitStart = Date.now();
  }

  // 先显示/收起提示条，再更新文案：断线时提示条刚从隐藏变为可见，
  // 之后发生的文字变化才能被读屏软件（aria-live）播报
  refreshOnlineControls();
  if (!ready) startServerWaitTimer();
}

// 当前房间的规格（未进房或未知规格 = 经典 10×10/3 架）
function curSpec() {
  return (BOARD_SPECS[state.boardSize] || BOARD_SPECS.S);
}

// 道具价格表（与服务器 server.js 的 ITEM_PRICES 保持一致，按钮置灰用；键序即道具栏显示顺序，按价格从低到高）
const ITEM_PRICES = { pro: 3, devour: 3, sonar: 4, expose: 4, burst: 4, doom: 6 };
// 道具的中文名 + 效果 + 操作指引（选区状态条显示：先讲效果，再讲怎么选）
const ITEM_NAMES = {
  pro: '探测者', devour: '吞噬者', sonar: '声呐脉冲', expose: '无所遁形', burst: '双发连射', doom: '毁灭菇'
};
// 选中道具后状态条的介绍：一句话自然描述（范围 + 作用）
const ITEM_TIPS = {
  pro: '· 在对方棋盘选 3×3 区域，按「机身→机头→空」优先揭示 1 格真实内容',
  devour: '· 摧毁对方棋盘 3×3 区域内的未揭示格，命中机头即发现飞机',
  sonar: '· 在对方棋盘选 3×3 区域，显示其中飞机格的数量',
  expose: '· 点已揭示的机头格，完整揭示整架飞机（10 格全显示）',
  burst: '· 点对方棋盘 2 个未知格，一次行动同时揭示',
  doom: '· 点对方棋盘任意格作十字中心：十字 5 格揭示，对角线 4 个角格被封锁（❄）——接下来 2 次行动你不能点它们'
};

// ---------- 棋盘渲染 ----------

// 格子尺寸按「规格 + 屏幕宽度」动态计算，让每张棋盘尽量占满页面：
//  手机（≤720px）：能并排就并排（每列上限 40px、下限 20px），放不下就堆叠占满整行（无上限）
//  桌面：两列并排，尽量饱满，上限 64px（14×14 大规格也不会溢出）
function boardCellSize() {
  const vw = document.documentElement.clientWidth;
  const size = curSpec().size;
  const pad = 24;  // body 左右 padding 合计
  const gap = 24;  // 两列间距
  if (vw <= 720) {
    const full = Math.floor((vw - pad - 1) / size);           // 上下堆叠：尽量占满整行
    const side = Math.floor((vw - pad - gap - 1) / 2 / size); // 左右并排：每列宽
    const sideB = side * size + 1;                            // 并排时每张棋盘的宽
    const canSide = sideB * 2 + gap + pad <= vw && side >= 20;
    return Math.max(canSide ? Math.min(side, 40) : full, 20);
  }
  const maxCol = (Math.min(vw, 1400) - pad - gap) / 2; // 桌面每列可用宽（.view max-width 1400）
  return Math.min(64, Math.floor((maxCol - 1) / size));
}

// 生成一个 size×size 的空棋盘表格；onCellClick 不为空时格子可点击
// 棋盘大小跟随当前房间规格（进房后按规格重建）
function makeBoard(tableEl, onCellClick) {
  const size = curSpec().size;
  const cellSize = boardCellSize();
  tableEl.innerHTML = '';
  let suppressNextClick = false; // 长按标注后抑制紧随的 click，防止误揭示/误选道具格
  for (let r = 0; r < size; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < size; c++) {
      const td = document.createElement('td');
      td.dataset.row = r;
      td.dataset.col = c;
      td.style.width = cellSize + 'px';
      td.style.height = cellSize + 'px';
      if (onCellClick) {
        td.addEventListener('click', function () {
          if (suppressNextClick) { suppressNextClick = false; return; }
          onCellClick(r, c);
        });
      }
      // 对方棋盘右键 = 标注机身（绿框，再右键取消）；纯本地标记；
      // 但如果正处于道具选区模式，右键优先「取消道具选中」（避免误标到棋盘上）
      if (tableEl.id === 'enemy-board') {
        td.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          if (state.itemPick) {
            clearItemPick();
            renderBattleBoards();
            updateItemButtons();
            return;
          }
          onEnemyMark(r, c);
        });
        // 手机端没有右键：长按 500ms = 标注（与右键同逻辑）。
        // iOS 长按弹系统菜单已用 CSS 禁掉（-webkit-touch-callout）
        let longPressTimer = null;
        let longPressed = false;
        td.addEventListener('touchstart', function () {
          longPressed = false;
          clearTimeout(longPressTimer);
          longPressTimer = setTimeout(function () {
            longPressed = true;
            if (state.itemPick) {
              clearItemPick();
              renderBattleBoards();
              updateItemButtons();
              return;
            }
            onEnemyMark(r, c);
          }, 500);
        });
        td.addEventListener('touchend', function () {
          clearTimeout(longPressTimer);
          if (longPressed) {
            suppressNextClick = true; // 长按已触发：别让随后的 click 造成揭示
            longPressed = false;
            // 保险：部分浏览器长按后不发 click，1 秒后自动恢复，免得吞掉后续所有点击
            setTimeout(function () { suppressNextClick = false; }, 1000);
          }
        });
        td.addEventListener('touchmove', function () {
          clearTimeout(longPressTimer); // 滑动手指 = 放弃长按（滚动时不误标）
        });
      }
      // 道具选区的悬停预览（只在对方棋盘 + 区域型道具选区模式时生效）
      td.addEventListener('mousemove', onBoardHover);
      td.addEventListener('mouseleave', function () { updatePickHover([]); });
      tr.appendChild(td);
    }
    tableEl.appendChild(tr);
  }
}

// 鼠标移到对方棋盘上：预览包含它的 3×3 区域（声呐/Pro/吞噬）或十字 5 格（毁灭菇）
function onBoardHover(e) {
  if (!state.itemPick || state.pickReady) return; // 点选固定选区后不再预览
  const id = state.itemPick.itemId;
  if (id !== 'sonar' && id !== 'pro' && id !== 'devour' && id !== 'doom') return;
  if (e.currentTarget.closest('#enemy-board') !== $('#enemy-board')) return;
  const r = +e.currentTarget.dataset.row, c = +e.currentTarget.dataset.col;
  if (id === 'doom') {
    // 毁灭菇：十字中心 = 点击的格子（靠边格点击会被拒，预览保持一致：靠边不显示）
    const size = curSpec().size;
    if (r < 1 || r > size - 2 || c < 1 || c > size - 2) { updatePickHover([]); return; }
    updatePickHover(crossKeys(r, c));
  } else {
    const anchor = hoverAnchor(r, c);
    updatePickHover(regionKeys(anchor.row, anchor.col));
  }
}

// 收集若干飞机占的所有格子（exceptIdx 表示跳过第几架，旋转时用）
function allPlaneCells(planes, exceptIdx) {
  const cells = [];
  planes.forEach(function (p, i) {
    if (i === exceptIdx) return;
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      cells.push(cell);
    });
  });
  return cells;
}

// 随机生成一份合法布局（点「随机布局」按钮时用，可反复点击换方案）
function randomDraft() {
  const spec = curSpec();
  const dirs = ['up', 'down', 'left', 'right'];
  const planes = [];
  for (let attempt = 0; attempt < 20000 && planes.length < spec.planeCount; attempt++) {
    const dir = dirs[Math.floor(Math.random() * 4)];
    const headRow = Math.floor(Math.random() * spec.size);
    const headCol = Math.floor(Math.random() * spec.size);
    if (canPlacePlane(allPlaneCells(planes), headRow, headCol, dir, state.boardSize)) {
      planes.push({ headRow: headRow, headCol: headCol, dir: dir });
    }
  }
  return planes.length === spec.planeCount ? planes : null;
}

// 给若干飞机计算轮廓：返回 map（'r,c' -> 'edge-t edge-l …'）
// 轮廓统一深黑色，只画在飞机的外边缘，同一架飞机内部相邻的格子之间不画线
function outlineClassesFor(planes) {
  // 先算出每架飞机占的格子集合
  const sets = planes.map(function (p) {
    const set = new Set();
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      set.add(cell[0] + ',' + cell[1]);
    });
    return set;
  });
  const result = {};
  planes.forEach(function (p, pi) {
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell) {
      const r = cell[0], c = cell[1];
      const set = sets[pi];
      const classes = [];
      // 四个方向：邻居不在同一架飞机里，就说明这条边是外边缘
      if (!set.has((r - 1) + ',' + c)) classes.push('edge-t');
      if (!set.has((r + 1) + ',' + c)) classes.push('edge-b');
      if (!set.has(r + ',' + (c - 1))) classes.push('edge-l');
      if (!set.has(r + ',' + (c + 1))) classes.push('edge-r');
      result[r + ',' + c] = classes.join(' ');
    });
  });
  return result;
}

// 渲染部署页棋盘：把草稿里的飞机画上去（带彩色轮廓）
function renderDeployBoard() {
  const cellType = {}; // 'r,c' -> 'head' | 'body'
  state.draft.forEach(function (p) {
    getPlaneCells(p.headRow, p.headCol, p.dir).forEach(function (cell, i) {
      cellType[cell[0] + ',' + cell[1]] = (i === 0) ? 'head' : 'body';
    });
  });
  const outlines = outlineClassesFor(state.draft);
  $('#deploy-board').querySelectorAll('td').forEach(function (td) {
    const key = td.dataset.row + ',' + td.dataset.col;
    td.className = (cellType[key] ? 'cell-' + cellType[key] : '') +
      (outlines[key] ? ' ' + outlines[key] : '');
  });
}

// 渲染对战页双棋盘
function renderBattleBoards() {
  const revealed = state.over ? state.revealedPlanes : null; // 对局结束后公开的双方飞机

  // ---- 己方棋盘：自己的飞机（对战阶段不画轮廓）+ 对方打过的位置高亮 ----
  // 观战者平时看不到任何飞机；对局结束后公开 1 号玩家的飞机
  const myPlanesSrc = (state.spectator && revealed) ? (revealed[0] || []) : state.myPlanes;
  const myBoard = buildBoard(myPlanesSrc, state.boardSize);
  const myMarks = {};
  state.myShotsReceived.forEach(function (s) { myMarks[s.row + ',' + s.col] = s; }); // 存对象：destroyed 要区分渲染

  // ---- 声呐数字 + 3x3 区域外框：画在「被探测方」的棋盘上 ----
  // 声呐探测的是对方的棋盘：我放的 → 对方棋盘；对方放的 → 我的棋盘。
  // 坐标都是相对被探测棋盘记录的，所以两块棋盘各画各的（观战者同样按被探测座位分）。
  // 声呐历史里 attacker = 施放者座位，被探测座位 = 1 - attacker
  const mySeat = state.spectator ? 0 : state.seat; // 我的棋盘显示的是哪个座位的飞机
  const sonarMaps = { mine: {}, enemy: {} };       // 'r,c' -> 中心格数字（金色小字）
  const sonarShadowMaps = { mine: {}, enemy: {} }; // 'r,c' -> 区域外圈 box-shadow（可多个叠加）
  state.sonarResults.forEach(function (sr) {
    const probedSeat = 1 - (sr.attacker === undefined ? state.seat : sr.attacker);
    const side = probedSeat === mySeat ? 'mine' : 'enemy';
    sonarMaps[side][(sr.row + 1) + ',' + (sr.col + 1)] = sr.count;
    const r0 = sr.row, c0 = sr.col;
    const addEdge = function (rr, cc, shadow) {
      const k = rr + ',' + cc;
      // 多个 box-shadow 之间用逗号分隔（角落格会有两条边叠加）；
      // shadow 传 h v 两个偏移量，拼接成「h v blur spread color」4 个长度值——语法必须合法，
      // 多了/少了长度值整条都会被 CSS 解析器丢弃（网页端和 jsdom 都一样）
      sonarShadowMaps[side][k] = (sonarShadowMaps[side][k] ? sonarShadowMaps[side][k] + ',inset ' : 'inset ') + shadow + ' 0 0 #f6c945';
    };
    // 注意：inset 阴影的可见区是「元素盒 − 偏移后的阴影盒」——偏移 -3px 的可见条带在元素
    // 的相反侧。所以上边行要向下偏移（0 3px 画顶部）、下边行要向上偏移（0 -3px 画底部）
    for (let c = c0; c <= c0 + 2; c++) { addEdge(r0, c, '0 3px'); addEdge(r0 + 2, c, '0 -3px'); } // 上下边
    for (let r = r0; r <= r0 + 2; r++) { addEdge(r, c0, '3px 0'); addEdge(r, c0 + 2, '-3px 0'); } // 左右边
  });

  $('#my-board').querySelectorAll('td').forEach(function (td) {
    const r = +td.dataset.row, c = +td.dataset.col;
    td.className = '';
    td.textContent = ''; // 清掉上次渲染留下的文字（如声呐数字）
    const cell = myBoard[r][c];
    const mk = myMarks[r + ',' + c]; // 对方打过/道具作用过的记录（对象）
    if (mk && mk.result === 'destroyed') {
      // 对方吞噬者摧毁我的格：保留原底色（绿=机身/红=机头/空色）+ ✕，己方飞机布局永远可见
      if (cell === CELL_HEAD) td.classList.add('cell-head');
      else if (cell === CELL_BODY) td.classList.add('cell-body');
      td.classList.add('cell-destroyed-mine');
    } else if (mk && mk.result === 'head' && mk.destroyed) {
      td.classList.add('cell-head');
      td.classList.add('cell-destroyed-mine'); // 机头被摧毁：红底 + ✕
    } else {
      if (cell === CELL_HEAD) td.classList.add('cell-head');
      else if (cell === CELL_BODY) td.classList.add('cell-body');
      if (!mk) {
        // 对方施放的毁灭菇冻结：❄ 显示在我的棋盘上（表示对方接下来 2 回合不能打这些格）
        const frozenEnemy = state.frozenCells.some(function (f) {
          return f.owner === 1 - state.seat && state.steps[f.owner] < f.expiry && f.row === r && f.col === c;
        });
        if (frozenEnemy) {
          td.classList.add('cell-unknown', 'cell-frozen');
          td.textContent = '❄';
        } else {
          // 没被打过的格子：蒙上深色遮罩调暗（被打过的保持原色高亮，不加额外标记）
          td.classList.add('dimmed');
        }
      }
    }
    // 对方放的声呐：数字 + 外框画在我的棋盘上（被探测方视角）
    const sonarCount = sonarMaps.mine[r + ',' + c];
    if (sonarCount !== undefined) {
      td.classList.add('cell-sonar');
      td.textContent = sonarCount;
    }
    td.style.boxShadow = sonarShadowMaps.mine[r + ',' + c] || '';
  });

  // ---- 对方棋盘：未知格 + 已揭示结果 ----
  // 对局结束后：没被探测到的格子按己方棋盘同款样式公开（暗色），探测过的保持结果颜色
  const enemySeat = state.spectator ? 1 : (1 - state.seat);
  const enemyPlanes = revealed ? (revealed[enemySeat] || []) : [];
  const enemyBoard = buildBoard(enemyPlanes, state.boardSize);
  // 注意：记录存整个对象（destroyed: true 的机头也是 head 结果，要区分渲染）
  const enemyMarks = {};
  state.enemyShotsReceived.forEach(function (s) { enemyMarks[s.row + ',' + s.col] = s; });
  $('#enemy-board').classList.toggle('revealed', !!revealed);
  // 选区模式：对方棋盘用十字光标提示正在选区域
  $('#enemy-board').classList.toggle('picking', !!state.itemPick);
  $('#enemy-board').querySelectorAll('td').forEach(function (td) {
    const r = +td.dataset.row, c = +td.dataset.col;
    td.className = '';
    td.textContent = '';
    const s = enemyMarks[r + ',' + c];
    if (revealed && s && (s.result === 'destroyed' || s.destroyed)) {
      // 对局结束：被摧毁格子的真实内容公开（和没探测过的格子一样暗色显示）
      const cell = enemyBoard[r][c];
      if (cell === CELL_HEAD) td.classList.add('cell-head');
      else if (cell === CELL_BODY) td.classList.add('cell-body');
      else td.classList.add('cell-empty');
      td.classList.add('dimmed');
    } else if (s && s.result === 'destroyed') {
      td.classList.add('cell-destroyed'); // 吞噬者摧毁的格子：深灰 + ✕（内容保密）
    } else if (s && s.result === 'head' && s.destroyed) {
      td.classList.add('cell-head-destroyed'); // 机头被摧毁：灰色机头（视为已发现）
    } else if (s && s.result === 'empty') td.classList.add('cell-empty');
    else if (s && s.result === 'body') td.classList.add('cell-body');
    else if (s && s.result === 'head') td.classList.add('cell-head');
    else if (revealed) {
      // 没探测过的格子：公开真实飞机（暗色遮罩，和己方棋盘同款显示方式）
      const cell = enemyBoard[r][c];
      if (cell === CELL_HEAD) td.classList.add('cell-head');
      else if (cell === CELL_BODY) td.classList.add('cell-body');
      else td.classList.add('cell-unknown');
      td.classList.add('dimmed');
    } else if (isFrozen(r, c)) {
      // 毁灭菇冻结的格子：中间仍是暗色，❄ 标记（施放者接下来 2 回合不能碰）
      td.classList.add('cell-unknown', 'cell-frozen');
      td.textContent = '❄';
    } else {
      td.classList.add('cell-unknown');
    }
    // 二次确认已选中的目标：虚线框提示「再点一次才探测」
    if (state.revealPending && state.revealPending.row === r && state.revealPending.col === c &&
        !state.itemPick && !state.spectator && !state.over) {
      td.classList.add('cell-probe-target');
    }
    // 注释标记：右键在未揭示格上标的预期内容（红=机头 绿=机身 灰=空，中间仍是暗色；
    // 格子被揭示后自动不显示——注释只是本地猜测，揭示即作废；观战视角不显示）
    if (!revealed && !state.spectator && state.marks[r + ',' + c] && (!s || s.result === 'destroyed')) {
      // 未揭示格可标：普通未知格 + 吞噬者摧毁的格（内容保密，仍可标注）；已揭示格不能标
      td.classList.add('cell-mark-' + state.marks[r + ',' + c]);
    }
    // 声呐数字（我放的声呐：探测对方棋盘；在已揭示格上也能显示；冻结格显示 ❄ 不显示数字）
    const count = sonarMaps.enemy[r + ',' + c];
    if (count !== undefined && !isFrozen(r, c)) {
      td.classList.add('cell-sonar');
      td.textContent = count;
    }
    // 声呐 3x3 区域外圈的金色细边框（内联样式优先于注释标记的 class 描边）。
    // 注意：标记绿框（cell-mark-body）也是 box-shadow——声呐框格的内联阴影会
    // 把它盖掉，有声呐框的格子上标记会看不见。这里把绿框拼进内联阴影里
    // （逗号叠加，与毁灭菇方框合并同手法）
    const sonarShadow = sonarShadowMaps.enemy[r + ',' + c];
    const markKey = r + ',' + c;
    const hasMark = !revealed && !state.spectator && state.marks[markKey] && (!s || s.result === 'destroyed');
    if (sonarShadow) {
      td.style.boxShadow = hasMark ? sonarShadow + ',inset 0 0 0 3px #66bb6a' : sonarShadow;
    } else {
      td.style.boxShadow = ''; // 无声呐框：清掉内联样式，class 标记正常生效
    }
    // 道具选区高亮：区域型道具（声呐/探测者/吞噬者/毁灭菇）只画区域「外部轮廓」——
    // 外缘线内联 box-shadow（3×3 = 外圈 12 条边、毁灭菇 = 十字外缘），区域内部无线条；
    // 高亮格（3×3 区域中心 / 毁灭菇十字中心）用浅金背景填充指示——高亮格若画完整方框，
    // 就形成「内部轮廓」（用户实测反馈过）。非区域型道具（双发/无所遁形）是单格或
    // 双格，没有内部线问题，保持每格独立 outline 描边。
    const isRegionPick = state.itemPick && (state.itemPick.itemId === 'sonar' ||
      state.itemPick.itemId === 'pro' || state.itemPick.itemId === 'devour' ||
      state.itemPick.itemId === 'doom');
    const pickKeys = isRegionPick && (state.pickCells.length ? state.pickCells : state.pickHover);
    const regionShadows = pickKeys && pickKeys.length ?
      regionPickShadows(state.itemPick.itemId, pickKeys) : null;
    const regionKey = r + ',' + c;
    const regionEdge = regionShadows && regionShadows[regionKey];
    if (regionEdge) {
      // 轮廓线格（与声呐外圈框、上一步蓝框等已有阴影逗号合并）。
      // 标记格（绿框）也拼进内联阴影：区域线是内联样式，会盖掉 class 的绿框——
      // 和上方声呐框同款处理，预览框不能把棋盘标记遮住
      td.style.boxShadow = td.style.boxShadow ? td.style.boxShadow + ',' + regionEdge : regionEdge;
      if (hasMark) td.style.boxShadow += ',inset 0 0 0 5px #66bb6a';
    } else if (!isRegionPick) {
      if (state.pickCells.indexOf(regionKey) !== -1) td.classList.add('cell-pick');
      if (state.pickHover.indexOf(regionKey) !== -1) td.classList.add('cell-pick-hover');
    }
    // 高亮格：浅金背景填充（无线条）。3×3 区域道具（声呐/探测者/吞噬者）的高亮格是
    // 区域**中心**（不是左上角锚点——用户反馈左上角浅黄会误导选区位置）；毁灭菇的
    // keys[0] 本身就是十字中心，不动。高亮格可能同时是轮廓格，两样都加：线 + 填充
    if (pickKeys && pickKeys.length) {
      let highlightKey = pickKeys[0];
      if (isRegionPick && state.itemPick.itemId !== 'doom') {
        const p = pickKeys[0].split(',');
        highlightKey = (+p[0] + 1) + ',' + (+p[1] + 1); // 3×3 区域中心 = 左上角右下移一格
      }
      if (regionKey === highlightKey) td.classList.add('cell-pick-anchor');
    }
  });

  // ---- 上一手揭示的格子：蓝色框框选 ----
  // 己方棋盘：框出对方上一手打的位置
  const lastTheirs = state.myShotsReceived[state.myShotsReceived.length - 1];
  if (lastTheirs) {
    const td = $('#my-board').querySelector(
      'td[data-row="' + lastTheirs.row + '"][data-col="' + lastTheirs.col + '"]');
    if (td) addLastReveal(td);
  }
  // 对方棋盘：框出我上一手打的位置
  const lastMine = state.enemyShotsReceived[state.enemyShotsReceived.length - 1];
  if (lastMine) {
    const td = $('#enemy-board').querySelector(
      'td[data-row="' + lastMine.row + '"][data-col="' + lastMine.col + '"]');
    if (td) addLastReveal(td);
  }
}

// 上一步格的蓝色方框（last-reveal）：方格内 inset 样式，与标记同款。
// 该格若已有内联 box-shadow（声呐外框 / 毁灭菇方框），内联会盖掉 class 的蓝框 →
// 逗号拼接进内联阴影里（与 cell-mark-body 的处理同理）
function addLastReveal(td) {
  td.classList.add('last-reveal');
  if (td.style.boxShadow) td.style.boxShadow += ',inset 0 0 0 3px var(--primary)';
}

// ---------- 各页面渲染 ----------

// 部署页：更新计数、按钮状态、双方确认状态
function updateDeployUI() {
  $('#deploy-count').textContent = '已放置 ' + state.draft.length + ' / ' + curSpec().planeCount + ' 架';
  const confirmed = state.deployConfirmed[state.seat];
  $('#btn-confirm').disabled = state.draft.length !== curSpec().planeCount || confirmed;
  $('#btn-clear').disabled = confirmed;
  $('#btn-random').disabled = confirmed;
  $('#btn-unconfirm').classList.toggle('hidden', !confirmed);

  $('#deploy-opponent-name').textContent = state.names[1 - state.seat] || '等待加入…';
  $('#deploy-opponent-avatar').textContent = state.avatars[1 - state.seat] || '';
  const hasOpp = !!state.names[1 - state.seat];
  $('#deploy-opponent-dot').classList.toggle('hidden', !hasOpp);
  if (hasOpp) setDot($('#deploy-opponent-dot'), state.online[1 - state.seat]);

  let txt = '';
  if (!state.names[1 - state.seat]) txt = '等待对方加入…';
  else if (confirmed && state.deployConfirmed[1 - state.seat]) txt = '双方已就绪，即将开战！';
  else if (confirmed) txt = '已确认，等待 ' + state.names[1 - state.seat] + ' 确认…';
  else if (state.deployConfirmed[1 - state.seat]) txt = '对方已确认，等你的部署';
  $('#deploy-ready-status').textContent = txt;

  renderSwitchBar();
}

// 进入部署页
function goDeploy() {
  updateRoomChrome(); // 本地对局隐藏房间号/复制按钮
  $('#deploy-room-id').textContent = state.roomId;
  rebuildBoards(); // 房间规格确定后重建棋盘（经典 10×10 无变化）
  renderModeBadge();
  if (state.myPlanes.length) {
    // 已确认过部署（比如刷新后重连回来）：直接用已确认的飞机
    state.draft = state.myPlanes.map(function (p) {
      return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
    });
  } else if (state.localMode) {
    // 本地对局（尤其是同屏双人交接后）：草稿绝不能从本机存储恢复，
    // 否则 2 号玩家会看到 1 号玩家摆了一半的飞机。
    state.draft = [];
  } else {
    // 恢复本地草稿（部署到一半刷新页面不丢）
    try {
      const draft = JSON.parse(safeGet('bp_draft') || '[]');
      // 宿主恢复或旧版本可能写进非数组内容：校验后再用，避免后续 .length 报错
      state.draft = Array.isArray(draft) ? draft : [];
    } catch (e) { state.draft = []; }
  }
  renderDeployBoard();
  updateDeployUI();
  showView('deploy');
  renderSwitchBar(); // 切换页面时 showView 会先隐藏悬浮条，这里按新页面重新判断
}

// 在线状态点：绿 = 在线，红 = 离线
function setDot(el, online) {
  el.classList.toggle('dot-on', online);
  el.classList.toggle('dot-off', !online);
}

// 渲染观战人数徽章（对战页 + 观战等待页各一个，无人观战时不显示）
function renderSpectatorBadge() {
  const show = state.spectatorCount > 0;
  $('#spectator-badge').classList.toggle('hidden', !show);
  $('#wait-spectator-badge').classList.toggle('hidden', !show);
  if (show) {
    $('#spectator-count').textContent = state.spectatorCount;
    $('#wait-spectator-count').textContent = state.spectatorCount;
  }
}

// 更新对战页左右两侧的玩家信息栏（昵称+在线状态点、步数、已找到机头数、行动提示）
function updateBattlePanels() {
  const mine = state.steps[state.seat], theirs = state.steps[1 - state.seat];

  const planeCount = curSpec().planeCount;
  if (state.spectator) {
    // 观战视角：固定按 1 号玩家（房主）在左、2 号玩家在右显示，昵称不加「（我）」
    $('#panel-my-name').textContent = state.names[0];
    $('#panel-my-avatar').textContent = state.avatars[0] || '';
    $('#panel-enemy-avatar').textContent = state.avatars[1] || '';
    setDot($('#panel-my-dot'), state.online[0]);
    $('#panel-my-steps').textContent = state.steps[0];
    $('#panel-my-heads').textContent = (planeCount - state.headsLeft[1]) + '/' + planeCount;
    $('#panel-enemy-name').textContent = state.names[1];
    setDot($('#panel-enemy-dot'), state.online[1]);
    $('#panel-enemy-steps').textContent = state.steps[1];
    $('#panel-enemy-heads').textContent = (planeCount - state.headsLeft[0]) + '/' + planeCount;
    $('#panel-my-turn').textContent = '👁 观战中';
    $('#panel-enemy-turn').textContent = '';
  } else {
    $('#panel-my-name').textContent = state.names[state.seat] + '（我）';
    // 我的头像用本地值（对局中换的头像立刻生效），对手用服务器广播的
    $('#panel-my-avatar').textContent = state.avatar;
    $('#panel-enemy-avatar').textContent = state.avatars[1 - state.seat] || '';
    setDot($('#panel-my-dot'), state.online[state.seat]);
    $('#panel-my-steps').textContent = mine;
    $('#panel-my-heads').textContent = (planeCount - state.headsLeft[1 - state.seat]) + '/' + planeCount;
    $('#panel-enemy-name').textContent = state.names[1 - state.seat];
    setDot($('#panel-enemy-dot'), state.online[1 - state.seat]);
    $('#panel-enemy-steps').textContent = theirs;
    $('#panel-enemy-heads').textContent = (planeCount - state.headsLeft[state.seat]) + '/' + planeCount;

    // 行动提示：步数少（或相等）的一方可以下棋。
    // 同屏双人没有「等对方上线」：领先方不能行动，应该点顶部悬浮条切换玩家。
    const myWait = state.local2p ? '🔄 请切换玩家' : '⏳ 等待对方';
    const theirWait = state.local2p ? '⏳ 等待切换' : '⏳ 等待对方';
    const myTurnText = mine <= theirs ? (mine === theirs ? '⚡ 双方抢步中' : '✓ 可行动') : myWait;
    const theirTurnText = theirs <= mine ? (theirs === mine ? '⚡ 双方抢步中' : '✓ 可行动') : theirWait;
    $('#panel-my-turn').textContent = myTurnText;
    $('#panel-enemy-turn').textContent = theirTurnText;
  }

  // 对局已结束：行动提示换成结束标志
  if (state.over) {
    $('#panel-my-turn').textContent = '🏁 对局结束';
    $('#panel-enemy-turn').textContent = '';
  }

  // 金币（道具版双方可见；经典版隐藏该行）。观战视角左 = 1 号玩家、右 = 2 号玩家
  const coinsVisible = state.mode === 'props';
  $('#panel-my-coins-row').classList.toggle('hidden', !coinsVisible); // 道具栏金币
  $('#panel-my-coins-info-row').classList.toggle('hidden', !coinsVisible); // 我方信息卡金币（与道具栏同值，观战看 0 号位）
  $('#panel-enemy-coins-row').classList.toggle('hidden', !coinsVisible);
  $('#panel-my-coins').textContent = state.coins[state.spectator ? 0 : state.seat];
  $('#panel-my-coins-info').textContent = state.coins[state.spectator ? 0 : state.seat];
  $('#panel-enemy-coins').textContent = state.coins[state.spectator ? 1 : (1 - state.seat)];
  updateItemButtons();

  // 双方累计比分：从第二局起显示，居中在棋盘上端（第一局 0:0 不显示）
  // 只显示数字，玩家视角左边永远是「我」的比分；观战视角按 1 号玩家在左、2 号在右
  // 昵称存在 data-name 里，悬停在数字上才显示
  const scoreEl = $('#battle-score');
  if (state.score[0] + state.score[1] > 0) {
    scoreEl.classList.remove('hidden');
    const a = state.spectator ? 0 : state.seat; // 观战者固定左 = 1 号玩家
    $('#score-a').textContent = state.score[a];
    $('#score-a').dataset.name = myAvatarLabel(a);
    $('#score-b').textContent = state.score[1 - a];
    $('#score-b').dataset.name = myAvatarLabel(1 - a);
  } else {
    scoreEl.classList.add('hidden');
  }

  renderSpectatorBadge();

  renderSwitchBar();
}

// ---------- 道具（道具版对战页） ----------

// 道具面板状态：道具版才显示；观战/结束/步数领先时全部禁用；金币不够的单个置灰
function updateItemButtons() {
  $('#items-panel').classList.toggle('hidden', state.mode !== 'props');
  const canAct = !state.spectator && !state.over &&
    state.steps[state.seat] <= state.steps[1 - state.seat];
  document.querySelectorAll('.item-btn').forEach(function (btn) {
    const id = btn.dataset.item;
    btn.classList.toggle('active', !!(state.itemPick && state.itemPick.itemId === id));
    btn.disabled = !canAct || state.coins[state.seat] < ITEM_PRICES[id];
    // 置灰原因写进 title：鼠标悬停（手机长按）能看到为什么点不了
    let why = '';
    if (state.spectator) why = '观战模式不能使用道具';
    else if (state.over) why = '对局已结束';
    else if (state.steps[state.seat] > state.steps[1 - state.seat]) {
      why = state.local2p ? '步数领先，请切换玩家' : '步数领先，等待对方';
    }
    else if (state.coins[state.seat] < ITEM_PRICES[id]) why = '金币不够（需要 ' + ITEM_PRICES[id] + '）';
    btn.title = why;
  });
  updateItemStatus();
}

// 选区状态条：选择道具后显示操作指引；选区完整后出现「确认使用」按钮
function updateItemStatus() {
  const bar = $('#item-status');
  const text = $('#item-status-text');
  if (!state.itemPick) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  text.textContent = ITEM_NAMES[state.itemPick.itemId] + ITEM_TIPS[state.itemPick.itemId];
  $('#item-confirm').classList.toggle('hidden', !state.pickReady);
  $('#item-cancel').classList.toggle('hidden', false);
}

// 结束道具选区（确认 / 取消 / 收到自己的道具结果 / 新局）
function clearItemPick() {
  state.itemPick = null;
  state.revealPending = null;
  state.pickCells = [];
  state.pickAnchor = null;
  state.pickReady = false;
  state.pickFirstKey = null;
  state.pickHover = [];
}

// 3x3 区域锚点（左上角）：让点击的格子落在区域里，同时保证区域完整在棋盘内
function hoverAnchor(r, c) {
  const size = curSpec().size;
  return { row: Math.max(0, Math.min(size - 3, r - 1)), col: Math.max(0, Math.min(size - 3, c - 1)) };
}

// 3x3 区域的 9 个格子的 'r,c' 键（区域型道具的选区）
function regionKeys(row, col) {
  const keys = [];
  for (let r = row; r < row + 3; r++) {
    for (let c = col; c < col + 3; c++) keys.push(r + ',' + c);
  }
  return keys;
}

// 毁灭菇十字 5 格的 'r,c' 键（中心 + 上下左右）
function crossKeys(row, col) {
  return [row + ',' + col, (row - 1) + ',' + col, (row + 1) + ',' + col, row + ',' + (col - 1), row + ',' + (col + 1)];
}

// 区域型道具（声呐/探测者/吞噬者 3×3、毁灭菇十字）选区的「外部轮廓」阴影地图。
// 只画区域最外缘的线（3×3 = 外圈 12 条边；十字 = 4 个臂格各 3 条边），区域内部
// 无线条——内部任何线条（含锚点格的完整方框）都会形成「内部轮廓」。
// 高亮格（3×3 区域中心 / 十字中心）不加框线，由调用方加 cell-pick-anchor
// 浅金填充指示。inset 阴影的可见区在偏移相反侧：0 3px 画顶部、0 -3px 画底部、
// 3px 0 画左侧、-3px 0 画右侧（与声呐外圈框同款差集模型），线画在方格内部。
// keys 是选区的 'r,c' 数组（固定选区 = pickCells，悬停预览 = pickHover，keys[0]
// 都是锚点）；返回 {'r,c': box-shadow}，与已有阴影逗号合并
function regionPickShadows(itemId, keys) {
  const c = keys[0].split(',');
  const r0 = +c[0], c0 = +c[1];
  const map = {};
  const addEdge = function (rr, cc, shadow) {
    const k = rr + ',' + cc;
    map[k] = (map[k] ? map[k] + ',inset ' : 'inset ') + shadow + ' 0 0 #f59e0b';
  };
  if (itemId === 'doom') {
    // 毁灭菇十字：上臂顶边 + 左右竖边；下臂底边 + 左右竖边；左臂顶底 + 左边；右臂顶底 + 右边
    addEdge(r0 - 1, c0, '0 3px'); addEdge(r0 - 1, c0, '3px 0'); addEdge(r0 - 1, c0, '-3px 0');
    addEdge(r0 + 1, c0, '0 -3px'); addEdge(r0 + 1, c0, '3px 0'); addEdge(r0 + 1, c0, '-3px 0');
    addEdge(r0, c0 - 1, '0 3px'); addEdge(r0, c0 - 1, '0 -3px'); addEdge(r0, c0 - 1, '3px 0');
    addEdge(r0, c0 + 1, '0 3px'); addEdge(r0, c0 + 1, '0 -3px'); addEdge(r0, c0 + 1, '-3px 0');
  } else {
    // 声呐 / 探测者 / 吞噬者：3×3 外圈 12 条边（与声呐释放后的外框完全同款差集模型）
    for (let c = c0; c <= c0 + 2; c++) { addEdge(r0, c, '0 3px'); addEdge(r0 + 2, c, '0 -3px'); } // 上下边
    for (let r = r0; r <= r0 + 2; r++) { addEdge(r, c0, '3px 0'); addEdge(r, c0 + 2, '-3px 0'); } // 左右边
  }
  return map;
}

// 这个格子是否还在毁灭菇冻结期（只查自己视角的对方棋盘；渲染 ❄ 与点击拦截共用）
function isFrozen(r, c) {
  return state.frozenCells.some(function (f) {
    return f.owner === state.seat && state.steps[state.seat] < f.expiry && f.row === r && f.col === c;
  });
}

// 在道具选区模式点对方棋盘：按道具类型记录选区，高亮预览，完整后由用户确认执行
function pickItemCell(r, c) {
  const id = state.itemPick.itemId;
  const key = r + ',' + c;
  // 二次确认：选区完整后，再点一次「定位格」视作确认（3×3 道具的定位格 = 锚点左上角；
  // 毁灭菇 = 十字中心；无所遁形 = 机头格；双发 = 任一已选格）。
  // 区域内其他格仍算重新定位，不会误触确认
  if (state.pickReady) {
    if (id === 'burst') {
      if (state.pickCells.indexOf(key) !== -1) { confirmItem(); return; }
      // 点新格重选第 1 格：已揭示的格同样要拒绝（ready 态容易漏掉这层校验）
      if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
        return toast('这格已经揭示过了，换一格');
      }
      state.pickCells = [key]; // 点新格：重新从第 1 格选起
      state.pickReady = false;
      renderBattleBoards();
      updateItemStatus();
      return;
    }
    if (id === 'sonar' || id === 'pro' || id === 'devour') {
      // 再点「第一击的定位格」= 确认（用户自然重复点自己刚点的格子）；
      // 点区域内其他格 = 重新定位（走下方逻辑）
      if (key === state.pickFirstKey) { confirmItem(); return; }
    } else {
      // 毁灭菇 / 无所遁形：定位格是 pickCells[0]（十字中心 / 机头格）
      if (key === state.pickCells[0]) { confirmItem(); return; }
    }
  }
  if (id === 'burst') {
    // 双发连射：先点第 1 格再点第 2 格（未满 2 格时点已选格 = 取消重选；点已揭示格被拒）
    if (state.pickCells.indexOf(key) !== -1) {
      state.pickCells = []; // 反悔：取消重选
    } else {
      if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
        return toast('这格已经揭示过了，换一格');
      }
      state.pickCells = state.pickCells.concat([key]);
    }
    state.pickReady = state.pickCells.length === 2;
    renderBattleBoards();
    updateItemStatus();
    return;
  }
  if (id === 'expose') {
    // 无所遁形：点已揭示的机头格（红色）
    const hit = state.enemyShotsReceived.find(function (s) {
      return s.row === r && s.col === c && s.result === 'head';
    });
    if (!hit) return toast('请点已揭示的机头（红色）格');
    state.pickCells = [r + ',' + c];
    state.pickAnchor = null;
    state.pickReady = true;
    renderBattleBoards();
    updateItemStatus();
    return;
  }
  if (id === 'doom') {
    // 毁灭菇：点任意格作为十字中心（中心距边至少 1 格，十字 5 格完整落盘）
    const size = curSpec().size;
    if (r < 1 || r > size - 2 || c < 1 || c > size - 2) {
      return toast('十字中心离棋盘边太近，换个格子');
    }
    if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
      return toast('这格已经揭示过了，换一格');
    }
    if (isFrozen(r, c)) return toast('这格被毁灭菇冻结，还不能选中');
    state.pickAnchor = null; // 毁灭菇用中心格，不用 3×3 锚点
    state.pickCells = crossKeys(r, c);
    state.pickReady = true;
    renderBattleBoards();
    updateItemStatus();
    return;
  }
  // 声呐 / 探测者 / 吞噬者：点任意格，选包含它的 3×3 区域
  const anchor = hoverAnchor(r, c);
  state.pickAnchor = anchor;
  state.pickCells = regionKeys(anchor.row, anchor.col);
  state.pickFirstKey = key; // 记录第一击的定位格：重复点击它 = 确认（点锚点不是用户直觉）
  state.pickReady = true;
  renderBattleBoards();
  updateItemStatus();
}

// 发送道具使用请求（点「确认使用」按钮 / 二次点击定位格共用；金币在服务器扣，这里只管发送）
function confirmItem() {
  if (!state.itemPick || !state.pickReady) return;
  const id = state.itemPick.itemId;
  const data = { itemId: id };
  if (id === 'burst') {
    // 双发连射：2 个格子坐标
    const a = state.pickCells[0].split(',');
    const b = state.pickCells[1].split(',');
    data.row = +a[0]; data.col = +a[1];
    data.row2 = +b[0]; data.col2 = +b[1];
  } else if (id === 'sonar' || id === 'pro' || id === 'devour') {
    // 区域型道具：3x3 锚点（左上角）
    data.row = state.pickAnchor.row;
    data.col = state.pickAnchor.col;
  } else if (id === 'doom') {
    // 毁灭菇：十字中心格（pickCells[0] 就是中心）
    const a = state.pickCells[0].split(',');
    data.row = +a[0]; data.col = +a[1];
  } else {
    // 无所遁形：已揭示的机头格
    const a = state.pickCells[0].split(',');
    data.row = +a[0]; data.col = +a[1];
  }
  clearItemPick();
  state.socket.emit('useItem', data);
}

// 悬停预览（仅区域型道具）：鼠标移到哪，预览包含它的 3×3 区域 / 十字选区。
// 区域轮廓的阴影每格不同（角格 2 条边 / 边格 1 条边 / 锚点格无线），单个 class
// 表达不了，所以整盘重渲染；用 rAF 合并高频 mousemove 事件，避免每帧全量渲染。
// 点选固定选区后渲染循环优先用 pickCells，悬停预览自然让位
let hoverFrame = null;
function updatePickHover(keys) {
  state.pickHover = keys;
  if (hoverFrame) return; // 上一帧还没渲染：合并本次移动，以最后位置为准
  hoverFrame = requestAnimationFrame(function () {
    hoverFrame = null;
    renderBattleBoards();
  });
}

// 进入对战页
function goBattle() {
  state.over = false;
  clearItemPick();      // 新一局：清掉上一局的选区状态
  // 注意：这里不清 state.sonarResults——同屏双人换人时要保留声呐历史，
  // 清空动作放在 battleStart（真正开新一局时）
  // 注意：这里也不清 state.frozenCells——重连恢复现场（reconnected）时冻结要保留，
  // 只有开新一局（battleStart）才清零
  loadMarks();          // 注释标记按房间持久化：再来一局 / 重连后恢复
  updateRoomChrome();   // 本地对局隐藏房间号/复制按钮
  $('#over-banner').classList.add('hidden');
  $('#battle-room-id').textContent = state.roomId;
  rebuildBoards(); // 房间规格确定后重建棋盘（经典 10×10 无变化）
  renderModeBadge();
  if (state.spectator) {
    // 观战视角：棋盘标题改成双方昵称，而不是「我的 / 对方的」
    $('#board-title-my').textContent = state.names[0] + ' 的棋盘';
    $('#board-title-enemy').textContent = state.names[1] + ' 的棋盘';
  } else {
    $('#board-title-my').textContent = '我的棋盘';
    $('#board-title-enemy').textContent = '对方棋盘';
  }
  $('#board-title-enemy-note').textContent = ENEMY_NOTE_DEFAULT;
  loadRevealConfirm(); // 换人/续局后按当前座位恢复各自的二次确认偏好
  renderBattleBoards();
  updateBattlePanels();
  showView('battle');
  renderSwitchBar(); // 切换页面时 showView 会先隐藏悬浮条，这里按新页面重新判断
}

// 观战等待页：双方还在部署（或等待对手加入），开战后自动进入对战页
function goWait() {
  $('#wait-room-id').textContent = state.roomId;
  renderSpectatorBadge();
  showView('wait');
}

// 对局结束：留在对战页（棋盘保留），顶部弹出结束横幅，
// 双方飞机公开——没被探测的格子用暗色显示（和己方棋盘同款样式）
// （只有击中 3 个机头一种结束方式，任何情况都不判负）
function goOver() {
  state.over = true;
  clearItemPick(); // 对局结束：清掉未执行的选区
  state.frozenCells = []; // 冻结随对局结束解除（服务器端 activeFrozenCells 也已置空）
  state.marks = {}; // 对局结束飞机全部公开，注释不再有意义；下一局从空注释开始
  try { safeRemove('bp_marks_' + state.roomId); } catch (e) { /* 忽略 */ }
  const planeCount = curSpec().planeCount;
  if (state.spectator) {
    // 观战视角：标题显示获胜者昵称，不参与再来一局投票
    $('#over-title').textContent = '🏁 ' + state.names[state.winner] + ' 获胜';
    const hitsA = planeCount - state.headsLeft[1]; // 1 号玩家打中对方的机头数
    const hitsB = planeCount - state.headsLeft[0];
    $('#over-detail').textContent =
      state.names[0] + ' 击中机头 ' + hitsA + '/' + planeCount + ' · ' + state.names[1] + ' 击中机头 ' + hitsB + '/' + planeCount;
    $('#btn-rematch').classList.add('hidden');
  } else {
    $('#over-title').textContent = state.winner === state.seat ? '🎉 你赢了！' : '你输了';

    const myHits = planeCount - state.headsLeft[1 - state.seat];
    const theirHits = planeCount - state.headsLeft[state.seat];
    $('#over-detail').textContent = '你击中机头 ' + myHits + '/' + planeCount + ' · 对方击中机头 ' + theirHits + '/' + planeCount;

    $('#btn-rematch').classList.remove('hidden');
  }
  $('#board-title-enemy-note').textContent = '（暗色 = 对方没被你探测过的格子）';
  updateRevealConfirmUI(); // 对局结束：隐藏「二次确认」勾选框
  renderBattleBoards();   // 公开渲染：探测过的保持结果颜色，没探测过的暗色公开
  updateBattlePanels();
  updateOverRematchStatus();
  showView('battle');     // 留在对战页，棋盘不消失
  $('#over-banner').classList.remove('hidden');
}

// 结束页的「再来一局」投票显示
function updateOverRematchStatus() {
  const votes = state.rematchVotes.filter(Boolean).length;
  if (state.spectator) {
    // 观战者不参与投票，只显示双方意愿
    $('#over-rematch-status').textContent = votes > 0 ? '双方想再来一局：' + votes + '/2' : '';
    return;
  }
  const mine = state.rematchVotes[state.seat];
  const btn = $('#btn-rematch');
  btn.textContent = mine ? '再来一局（' + votes + '/2）' : '再来一局';
  btn.disabled = mine;
  if (mine) $('#over-rematch-status').textContent = '已提交，等待对方（' + votes + '/2）';
  else if (votes > 0) $('#over-rematch-status').textContent = '对方想再来一局';
  else $('#over-rematch-status').textContent = '';
}

// ---------- 部署页交互 ----------

// 点部署棋盘：
//   空白格 → 放新飞机（以点击处为机头）
//   机头格 → 移除该架飞机
//   机身格 → 该架飞机顺次旋转（上→右→下→左）
function onDeployCellClick(r, c) {
  if (state.deployConfirmed[state.seat]) {
    return toast('已确认部署，点「取消确认」才能修改');
  }

  // 找点击位置属于哪架飞机
  let planeIdx = -1, isHead = false;
  for (let i = 0; i < state.draft.length; i++) {
    const p = state.draft[i];
    const cells = getPlaneCells(p.headRow, p.headCol, p.dir);
    for (let j = 0; j < cells.length; j++) {
      if (cells[j][0] === r && cells[j][1] === c) {
        planeIdx = i;
        isHead = (j === 0);
        break;
      }
    }
    if (planeIdx !== -1) break;
  }

  if (planeIdx === -1) {
    // 空白格：放新飞机
    if (state.draft.length >= curSpec().planeCount) return toast('已放满 ' + curSpec().planeCount + ' 架飞机');
    if (!canPlacePlane(allPlaneCells(state.draft), r, c, state.curDir, state.boardSize)) {
      return toast('这里放不下（越界或与其它飞机重叠）');
    }
    state.draft.push({ headRow: r, headCol: c, dir: state.curDir });
  } else if (isHead) {
    // 点机头：移除
    state.draft.splice(planeIdx, 1);
  } else {
    // 点机身：旋转到下一朝向（上→右→下→左）
    const p = state.draft[planeIdx];
    const dirs = ['up', 'right', 'down', 'left'];
    const next = dirs[(dirs.indexOf(p.dir) + 1) % 4];
    if (!canPlacePlane(allPlaneCells(state.draft, planeIdx), p.headRow, p.headCol, next, state.boardSize)) {
      return toast('转不过去（越界或与其它飞机重叠）');
    }
    p.dir = next;
  }

  saveDraft();
  renderDeployBoard();
  updateDeployUI();
}

function saveDraft() {
  // 本地对局不保存部署草稿：同屏双人交接后，下一位玩家不能看到上一位的布局
  if (state.localMode) return;
  safeSet('bp_draft', JSON.stringify(state.draft));
}

// ---------- 对战页交互 ----------

const ENEMY_NOTE_DEFAULT = '（点击未知格子揭示 · 右键/长按可标注机身）';

// 探测二次确认：设置存在本地（离线版还会镜像到宿主存储，iOS 刷新后也记得）。
// 同屏双人共用一台设备，两位玩家的偏好分开记（p0 / p1），换人时各用各的；
// 人机/联机仍然用设备级设置。
function revealConfirmKey() {
  return state.local2p ? 'bp_reveal_confirm_p' + state.seat : 'bp_reveal_confirm';
}

function loadRevealConfirm() {
  let raw = safeGet(revealConfirmKey());
  // 该座位还没有独立设置时，沿用设备级选择（老版本只存过一个 key）
  if (raw !== '0' && raw !== '1') raw = safeGet('bp_reveal_confirm');
  state.revealConfirm = raw === '1';
  updateRevealConfirmUI();
}

function updateRevealConfirmUI() {
  const box = $('#reveal-confirm');
  const wrap = $('#reveal-confirm-wrap');
  if (!box || !wrap) return;
  box.checked = !!state.revealConfirm;
  // 观战 / 对局结束时这个开关没有意义（点格子本来就不能探测）
  wrap.classList.toggle('hidden', !!(state.spectator || state.over));
  if (!state.over) {
    const note = $('#board-title-enemy-note');
    if (note) {
      note.textContent = (state.revealConfirm && !state.spectator)
        ? '（二次确认已开启：连点同一格两次才会探测）'
        : ENEMY_NOTE_DEFAULT;
    }
  }
}

function clearRevealPending() { state.revealPending = null; }

function onRevealConfirmChange(checked) {
  state.revealConfirm = !!checked;
  const value = checked ? '1' : '0';
  safeSet(revealConfirmKey(), value);
  // 同屏双人的 0 号位就是设备主人：顺手同步设备级设置，
  // 下次玩人机/联机时沿用主人的选择；1 号位只写自己的 key，不影响主人
  if (state.local2p && state.seat === 0) safeSet('bp_reveal_confirm', value);
  state.revealPending = null;
  renderBattleBoards();
  updateRevealConfirmUI();
  toast(checked ? '已开启二次确认：探测需连点同一格两次' : '已关闭二次确认');
}

// 点对方棋盘：道具选区模式优先（选区域而不是揭示），否则正常揭示
function onEnemyCellClick(r, c) {
  if (state.itemPick) return pickItemCell(r, c);
  if (state.spectator) {
    return toast('观战模式不能下棋');
  }
  if (state.over) {
    return toast('对局已结束，点「再来一局」继续');
  }
  if (isFrozen(r, c)) {
    return toast('这个格子被毁灭菇冻结，还不能揭示');
  }
  if (state.enemyShotsReceived.some(function (s) { return s.row === r && s.col === c; })) {
    return toast('这个格子已经揭示过了');
  }
  if (state.steps[state.seat] > state.steps[1 - state.seat]) {
    return toast(state.local2p ? '你的步数已领先，请切换玩家' : '你的步数已领先，等待对方');
  }
  // 二次确认：第一次点选目标（高亮），再点同一格才真正探测；点别的格子 = 改选
  if (state.revealConfirm) {
    const p = state.revealPending;
    if (!p || p.row !== r || p.col !== c) {
      state.revealPending = { row: r, col: c };
      renderBattleBoards();
      return toast('再点一次这个格子确认探测');
    }
    state.revealPending = null;
  }
  // 点击后立即给格子一个"处理中"样式：网络慢时也能看到响应，不觉得卡
  const td = $('#enemy-board').querySelector(
    'td[data-row="' + r + '"][data-col="' + c + '"]');
  if (td) td.classList.add('cell-pending');
  state.socket.emit('reveal', { row: r, col: c });
}

// ---------- 注释标记（纯本地功能，不进服务器） ----------
// 右键在对方棋盘的未揭示格上标注「机身」（绿框）：再标一次 = 取消。只保留机身一种
// 标注（机头/空标注会误导推理：机头标注和真实红格区分不开、空标注不如直接记在心里）。
// 标记画在格子四周一圈，中间保持未揭示的暗色；格子被揭示后标记自动不再显示。
// 按房间号持久化到 localStorage（重新进房 / 重连后标记还在，刷新页面也不丢）。

function saveMarks() {
  try {
    safeSet('bp_marks_' + state.roomId, JSON.stringify(state.marks));
  } catch (e) { /* 本地存储满 / 不可用时静默失败，标记只在本页有效 */ }
}

function loadMarks() {
  state.marks = {};
  try {
    const raw = safeGet('bp_marks_' + state.roomId);
    if (raw) state.marks = JSON.parse(raw) || {};
  } catch (e) { state.marks = {}; }
}

function onEnemyMark(r, c) {
  if (state.spectator || state.over) return; // 观战 / 对局结束不标注
  const key = r + ',' + c;
  // 已揭示格不标；吞噬者摧毁的格子（result === 'destroyed'，深灰 ✕ 内容保密）算未揭示，仍可标注。
  // 吞噬命中的机头（result 'head' + destroyed）已显示灰色机头，视为已发现，不能标
  if (state.enemyShotsReceived.some(function (s) {
    return s.row === r && s.col === c && s.result !== 'destroyed';
  })) return;
  if (state.marks[key] === 'body') delete state.marks[key]; // 已标机身 → 取消
  else state.marks[key] = 'body';                            // 无 → 标注机身
  saveMarks();
  renderBattleBoards();
}

// ---------- Socket 事件 ----------
function bindSocketEvents() {
  const s = state.socket;

  // 连接建立（原生 WebSocket 自动重连成功后也会触发）：
  // 如果之前正处在某个房间里（有 roomId + token），自动恢复现场——
  // 等价于刷新页面后按网址恢复，顺便修复网络闪断后页面僵住的问题
  s.on('connect', function () {
    setServerReady(true); // 服务器已就绪：收起等待提示，开放创建/加入/人机等按钮
    s.emit('visit', { visitorId: getVisitorId(), platform: 'web' }); // 访客统计：每次连上服务器上报一次
    if (state.spectator && state.roomId) {
      // 观战者没有 token：网络闪断后直接重新加入——房间仍满员时服务器自动转回观战席，
      // 若恰好空出座位则自动成为玩家（可以下棋，更灵活）
      s.emit('joinRoom', { roomId: state.roomId, name: (safeGet('bp_name') || '观众').trim(), avatar: myAvatar() });
      return;
    }
    if (state.roomId && state.token) {
      s.emit('rejoin', { token: state.token, roomId: state.roomId });
    }
  });

  // 访客统计：服务器回报当前唯一访客总数，显示在首页底部
  s.on('visitResult', function (d) {
    const el = $('#visitor-count');
    if (el) el.textContent = '👥 已有 ' + (d.total || 0) + ' 位玩家访问过';
  });

  // 连接断开：ws.js 会按指数退避自动重连。
  // 首次连接失败不弹 toast（顶部已有等待提示，反复弹会很吵）；
  // 只有已经成功连上过、中途断线时才提示。
  s.on('disconnect', function () {
    const hadConnected = hasEverConnected;
    setServerReady(false); // 先置灰联机按钮并显示等待提示
    if (hadConnected) toast('连接断开，正在重连…');
  });

  s.on('error', function (d) {
    toast(d.message);
    // 同屏换人被服务器拒绝时，收起交接页，回到棋盘重新判断顶部提示
    hidePassModal();
    renderSwitchBar();
    // 清除所有"处理中"格子的样式（比如领先方点击被拒绝，格子不会收到揭示结果）
    document.querySelectorAll('.cell-pending').forEach(function (td) {
      td.classList.remove('cell-pending');
    });
    // 观战者重连失败（房间已回收等）：退出观战状态回首页，下次刷新不会再自动重试
    if (state.spectator && state.roomId) {
      state.spectator = false;
      state.spectatorCount = 0;
      state.roomId = null;
      state.token = null;
      clearRoomFromUrl();
      showView('home');
      return;
    }
    // 自动加入房间失败（比如房间已满）：还没进入任何房间且网址带房间号时，
    // 清掉房间号参数，免得刷新页面反复重试
    if (!state.roomId && location.search.indexOf('room=') !== -1) clearRoomFromUrl();
  });

  // 创建/加入房间成功：保存凭证、记入最近房间，进入部署页
  s.on('roomCreated', function (d) {
    state.localMode = !!d.local;   // 离线版：人机/同屏双人
    state.local2p = !!d.local2p;   // 同屏双人：需要交接设备
    state.token = d.token;
    state.roomId = d.roomId;
    setRoomInUrl(d.roomId); // 小黑盒版不写地址栏（空函数，保留调用点）
    // 本地对局刷新后无法恢复，不写「最近加入的房间」，免得留下点不开的记录
    if (!state.localMode) saveRoomToHistory(d.roomId, d.token, d.name);
    state.seat = 0;
    state.name = d.name;
    state.names = d.names;
    state.avatars = d.avatars || ['', ''];
    state.online = d.online;
    state.myPlanes = [];
    state.deployConfirmed = d.deployConfirmed || [false, false]; // 人机房间：AI 已经确认
    state.spectator = false;
    state.inviteRoomId = null;
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = [0, 0];
    state.over = false;
    // 开了新局：暂停中的旧房间已被服务端清掉，续局卡和草稿一起作废
    state.suspended = null;
    state.resumeDraft = null;
    renderResumeCard();
    safeRemove('bp_draft');
    goDeploy();
  });
  s.on('joinedRoom', function (d) {
    state.token = d.token;
    state.roomId = d.roomId;
    setRoomInUrl(d.roomId); // 小黑盒版不写地址栏（空函数，保留调用点）
    saveRoomToHistory(d.roomId, d.token, d.name);
    state.seat = 1;
    state.name = d.name;
    state.names = d.names;
    state.avatars = d.avatars || ['', ''];
    state.online = d.online;
    state.myPlanes = [];
    state.deployConfirmed = [false, false];
    state.spectator = false;
    state.inviteRoomId = null;
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = [0, 0];
    safeRemove('bp_draft');
    goDeploy();
  });

  // 房间已满，我进入观战席：收到完整的对局快照（只含双方已公开的信息，绝不含飞机坐标）
  s.on('spectatorJoined', function (d) {
    state.spectator = true;
    state.roomId = d.roomId;
    setRoomInUrl(d.roomId); // 观战者不写历史；小黑盒版不写地址栏（空函数）
    state.inviteRoomId = null;
    state.seat = 0; // 借用 1 号玩家（房主）的视角：左 = 房主，右 = 2 号玩家
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = d.coins || [0, 0];
    state.names = d.names;
    state.avatars = d.avatars || ['', ''];
    state.online = d.online;
    state.steps = d.steps;
    state.score = d.score;
    state.headsLeft = d.headsLeft;
    state.winner = d.winner;
    state.rematchVotes = [false, false];
    state.myShotsReceived = d.shots[0] || [];   // 打在 1 号玩家棋盘上的记录
    state.enemyShotsReceived = d.shots[1] || []; // 打在 2 号玩家棋盘上的记录
    state.sonarResults = d.sonarHistory || [];  // 声呐数字历史（观战者也能看到）
    state.frozenCells = d.frozenCells || [];    // 毁灭菇冻结格（观战者也能看到 ❄）
    state.revealedPlanes = d.planes || null;    // 对局结束后才有的双方飞机
    if (d.phase === 'battle') goBattle();
    else if (d.phase === 'over') goOver();
    else goWait(); // deploy / waiting：双方还在部署，显示等待页
  });

  // 观战人数变化：更新徽章（0 人时隐藏）
  s.on('spectatorCount', function (d) {
    state.spectatorCount = d.count;
    renderSpectatorBadge();
  });

  // 房间被回收（双方都离线超时）：回首页，观战者和玩家都会收到
  s.on('roomClosed', function (d) {
    toast(d.message || '房间已回收');
    clearRoomFromUrl();
    showView('home');
  });

  // 对手加入（房主收到）
  s.on('opponentJoined', function (d) {
    state.names = d.names;
    state.avatars = d.avatars || ['', ''];
    updateDeployUI();
  });

  // 有人确认/取消确认部署
  s.on('deployReady', function (d) {
    state.deployConfirmed = d.confirmed;
    if (d.confirmed[state.seat]) {
      // 我的部署被服务器接受了：草稿变成正式飞机
      state.myPlanes = state.draft.map(function (p) {
        return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
      });
    } else {
      // 取消确认：服务器已清掉我的飞机，草稿重新生效
      // （不清的话刷新/重连后 goDeploy 会用旧的 myPlanes，回滚变成摆设）
      state.myPlanes = [];
    }
    updateDeployUI();
  });

  // 开战
  s.on('battleStart', function (d) {
    state.names = d.names;
    state.avatars = d.avatars || ['', ''];
    state.steps = d.steps;
    state.historyRecorded = false; // 新一局：允许结束时再写一条历史
    state.score = d.score;
    state.online = d.online;
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = d.coins || [0, 0];
    state.sonarResults = []; // 新一局：声呐历史清零（同屏双人换人不会走这里）
    state.frozenCells = []; // 新一局：毁灭菇冻结清零（服务器端 activeFrozenCells 也已清空）
    state.headsLeft = [curSpec().planeCount, curSpec().planeCount];
    state.myShotsReceived = [];
    state.enemyShotsReceived = [];
    state.revealedPlanes = null; // 新一局：上一局公开的飞机作废
    goBattle();
  });

  // 有人揭示了一个格子
  s.on('revealResult', function (d) {
    if (d.attacker === state.seat) {
      state.enemyShotsReceived.push({ row: d.row, col: d.col, result: d.result });
    } else {
      state.myShotsReceived.push({ row: d.row, col: d.col, result: d.result });
    }
    state.headsLeft = d.headsLeft;
    state.steps = d.steps;
    state.coins = d.coins || state.coins; // 道具版：金币随时同步
    renderBattleBoards();
    updateBattlePanels();
  });

  s.on('itemResult', handleItemResult);

  // 对局结束
  s.on('gameOver', function (d) {
    state.winner = d.winner;
    state.headsLeft = d.headsLeft;
    state.score = d.score;
    state.rematchVotes = [false, false];
    state.revealedPlanes = d.planes || null; // 服务器公开双方飞机，棋盘暗色显示
    goOver();
    // 对战历史：每局只写一次（服务器 phase 检查 + 这里的标记双重防重）
    // 必须写在 gameOver 里，不能写进 goOver：刷新恢复结束局面时可能重复调用。
    try {
      if (!state.historyRecorded) {
        state.historyRecorded = true;
        recordMatchResult(d.winner, d.planes);
      }
    } catch (e) {
      // 历史记录失败不能挡住结算界面
    }
  });

  // 双方在线状态变化（断线 / 重连 / 离开）：更新绿点/红点，不做其它反应
  s.on('playerStatus', function (d) {
    state.online[d.seat] = d.connected;
    updateBattlePanels();
    updateDeployUI();
  });

  // 对方（或观战视角的任一玩家）换了头像：更新面板上的头像
  s.on('avatarUpdated', function (d) {
    state.avatars[d.seat] = d.avatar;
    updateBattlePanels();
    updateDeployUI();
  });

  // 房内有人改昵称（可能是自己）：更新面板；自己改的顺便同步本地记忆和首页输入框
  s.on('nicknameUpdated', function (d) {
    state.names[d.seat] = d.name;
    // 同屏双人里两位玩家共用本机：改 2 号位昵称时不要把 1 号位的记忆覆盖掉
    if (state.seat === d.seat && !state.spectator && !state.local2p) {
      safeSet('bp_name', d.name);
      const input = $('#name-input');
      if (input) input.value = d.name;
    }
    updateBattlePanels();
    updateDeployUI();
  });

  // 再来一局投票
  s.on('rematchVote', function (d) {
    state.rematchVotes = d.votes;
    updateOverRematchStatus();
  });

  // 双方同意，重新开始
  s.on('rematchStart', function (d) {
    state.names = d.names;
    state.avatars = d.avatars || ['', ''];
    state.steps = [0, 0];
    state.coins = [0, 0]; // 每局金币在 battleStart 时由服务器下发
    state.headsLeft = [curSpec().planeCount, curSpec().planeCount];
    state.myPlanes = [];
    state.myShotsReceived = [];
    state.enemyShotsReceived = [];
    state.winner = null;
    state.over = false;
    state.revealedPlanes = null; // 新一局：上一局公开的飞机作废
    state.deployConfirmed = [false, false];
    if (state.spectator) {
      goWait(); // 观战者不参与部署，回等待页看双方重新部署
    } else {
      safeRemove('bp_draft');
      goDeploy();
    }
  });

  // 返回菜单：房间只暂停不销毁，首页显示「继续上局」卡（刷新仍会丢，房间只在内存里）
  s.on('roomSuspended', function (d) {
    state.suspended = d;
    renderResumeCard();
    showView('home');
  });

  // 继续上局失败：收起交接页并提示。fatal = 房间已经没了（比如刷新过），
  // 这时清掉续局卡；非 fatal（同屏双人点错玩家）保留卡片，可以重试。
  s.on('resumeFailed', function (d) {
    hidePassModal();
    toast(d.message || '继续失败，请重试');
    if (d.fatal) {
      state.suspended = null;
      state.resumeDraft = null;
      renderResumeCard();
      showView('home');
    }
  });

  // 我自己离开了房间：清空草稿回首页（房间记录保留，随时可以回来继续）
  // 观战者离开观战席也走这里（不写历史，回首页后身份恢复成普通玩家）
  s.on('leftRoom', function () {
    state.suspended = null;
    state.resumeDraft = null;
    renderResumeCard();
    safeRemove('bp_draft');
    // 主动离开：给历史记录打上标记，刷新后不再自动回到这个房间
    const list = loadRoomHistory();
    const entry = list.find(function (e) { return e.roomId === state.roomId; });
    if (entry) { entry.left = true; sortAndSaveHistory(list); }
    state.roomId = null;
    state.token = null; // 清掉现场：断线重连时 connect 事件不会自动 rejoin 回来
    state.spectator = false;
    state.spectatorCount = 0;
    clearRoomFromUrl(); // 地址栏回到干净的首页
    showView('home');
  });

  // 重连失败（房间没了 / 凭证无效）：从「最近加入的房间」列表里删掉这条，避免下次再点
  s.on('rejoinFailed', function (d) {
    if (d.roomId) removeRoomFromHistory(d.roomId);
    clearRoomFromUrl();
    toast(d.message);
    showView('home');
  });

  // 启动时批量校验历史房间是否还存在：不存在的自动从列表删除
  s.on('roomsAlive', function (d) {
    const alive = d.alive || [];
    const list = loadRoomHistory();
    const kept = list.filter(function (e) { return alive.indexOf(e.roomId) !== -1; });
    if (kept.length !== list.length) {
      safeSet('bp_room_history', JSON.stringify(kept));
      renderRecentRooms();
    }
  });

  // 重连成功：用服务器发来的完整现场恢复页面。
  // 离线版的同屏双人换人也复用这个事件（把当前座位换成下一位玩家）。
  s.on('reconnected', function (d) {
    // 这次快照是「继续上局」还是同屏双人的普通换人？
    // 只有首页点「继续」时 state.suspended 才有值；换人时没有。
    const resumeInfo = state.suspended;
    state.suspended = null;
    renderResumeCard();
    clearRevealPending(); // 换人/续局都不能把上一位玩家的待确认目标带过来
    state.roomId = d.roomId;
    state.seat = d.seat;
    state.name = d.name;
    // 同屏双人：每位玩家有自己的头像（人机/联机快照没有 avatar 字段，保持原值）
    if (d.avatar) state.avatar = d.avatar;
    state.names = d.names;
    state.avatars = d.avatars || ['', ''];
    state.online = d.online;
    state.steps = d.steps;
    state.score = d.score;
    state.mode = d.mode || 'classic';
    state.boardSize = d.boardSize || 'S';
    state.coins = d.coins || [0, 0];
    state.headsLeft = d.headsLeft;
    state.deployConfirmed = d.deployConfirmed;
    state.myPlanes = d.myPlanes || [];
    state.myShotsReceived = d.myShotsReceived || [];
    state.enemyShotsReceived = d.enemyShotsReceived || [];
    state.sonarResults = d.sonarHistory || []; // 声呐数字历史（重连/换人后还能看到）
    state.frozenCells = d.frozenCells || [];   // 毁灭菇冻结格（重连/换人后还能看到 ❄）
    state.winner = d.winner;
    state.rematchVotes = d.rematchVotes || [false, false];
    state.revealedPlanes = d.planes || null; // 对局结束后才有的双方飞机
    state.over = d.phase === 'over';

    if (d.local) { state.localMode = true; state.local2p = !!d.local2p; }
    updateRoomLastSeen(d.roomId); // 重连成功 = 又在这个房间在线过，列表顺序同步刷新
    setRoomInUrl(d.roomId);       // 小黑盒版不写地址栏（空函数，保留调用点）

    if (d.phase === 'deploy') goDeploy();
    else if (d.phase === 'battle') goBattle();
    else if (d.phase === 'over') goOver();
    else goDeploy(); // waiting 阶段（对手还没进来）：显示部署页等对手，而不是回首页

    // 继续上局且仍在部署：把返回菜单前未确认的草稿放回去。
    // 草稿只存在内存里（同屏双人不能落盘），房间/座位必须匹配。
    if (resumeInfo && d.phase === 'deploy' && state.resumeDraft) {
      const rd = state.resumeDraft;
      if (rd.roomId === d.roomId && rd.seat === d.seat &&
          !state.deployConfirmed[d.seat] && state.draft.length === 0) {
        state.draft = rd.planes.map(function (p) {
          return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
        });
        renderDeployBoard();
        updateDeployUI();
      }
    }
    state.resumeDraft = null;

    // 快照已经应用、界面也切好了，这时才收起交接页（避免对方布局一闪而过）
    hidePassModal();
  });
}

// ---------- 游戏规则弹窗 ----------

// 用真实飞机形状数据（getPlaneCells）画 4 张 5×5 小图，保证配图和实际玩法完全一致
// 机头坐标要让机身（从机头向反方向延伸 3 格）和翼展（5 格）恰好占满 5×5：
//   朝上/朝下：机头放第 1 / 第 3 行（机身纵向延伸 3 格，尾翼刚好顶到对边）
//   朝右/朝左：机头放第 3 / 第 1 列（机身横向延伸 3 格，尾翼刚好顶到对边）
function renderRulesDiagram() {
  const dirs = [
    { dir: 'up',    headRow: 1, headCol: 2, label: '朝上' },
    { dir: 'right', headRow: 2, headCol: 3, label: '朝右' },
    { dir: 'down',  headRow: 3, headCol: 2, label: '朝下' },
    { dir: 'left',  headRow: 2, headCol: 1, label: '朝左' },
  ];
  const box = $('#rules-diagram');
  box.innerHTML = '';
  dirs.forEach(function (item) {
    // 一张小图 = 一个 5×5 迷你棋盘 + 朝向文字
    const wrap = document.createElement('div');
    wrap.className = 'rules-plane';

    const table = document.createElement('table');
    table.className = 'board mini-board';
    const cellType = {}; // 'r,c' -> 'head' | 'body'
    getPlaneCells(item.headRow, item.headCol, item.dir).forEach(function (cell, i) {
      cellType[cell[0] + ',' + cell[1]] = (i === 0) ? 'head' : 'body';
    });
    for (let r = 0; r < 5; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < 5; c++) {
        const td = document.createElement('td');
        if (cellType[r + ',' + c]) td.className = 'cell-' + cellType[r + ',' + c];
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    wrap.appendChild(table);

    const p = document.createElement('p');
    p.textContent = item.label;
    wrap.appendChild(p);
    box.appendChild(wrap);
  });
}

// ---------- 首页玩法与规格选择（两栏：经典 / 道具） ----------
// 玩法两栏卡片 + 地图规格（S/M/L）自由组合。
// 每栏记住自己的规格（localStorage：bp_spec_classic / bp_spec_props），
// 经典默认 S、道具默认 M；切栏时规格自动换成该栏的选择。
state.homeMode = 'classic'; // 当前选中的玩法栏：classic / props

function savedSpecFor(mode) {
  const key = mode === 'props' ? 'bp_spec_props' : 'bp_spec_classic';
  const s = safeGet(key);
  return (s === 'S' || s === 'M' || s === 'L') ? s : (mode === 'props' ? 'M' : 'S');
}

// ---------- 首页：继续上局 ----------
// 摘要只显示玩法/规格/进度，不包含飞机和落子记录（暂停房间的布局不应出现在菜单里）
function renderResumeCard() {
  const card = $('#resume-card');
  if (!card) return;
  const s = state.suspended;
  if (!s) {
    card.classList.add('hidden');
    return;
  }
  const sp = BOARD_SPECS[s.boardSize] || BOARD_SPECS.S;
  const parts = [
    s.local2p ? '同屏双人' : '人机对战',
    (s.mode === 'props' ? '道具版' : '经典') + ' ' + sp.size + '×' + sp.size
  ];
  if (s.phase === 'deploy') {
    parts.push('部署中');
  } else {
    parts.push('对战中');
    parts.push('步数 ' + s.steps[0] + ':' + s.steps[1]);
  }
  if (s.local2p) parts.push('轮到 ' + (s.names[s.activeSeat] || '玩家'));
  $('#resume-summary').textContent = parts.join(' · ');
  card.classList.remove('hidden');
}

function resumeSuspendedGame() {
  const s = state.suspended;
  if (!s) return;
  if (s.local2p) {
    // 同屏双人：先出交接页，确认是暂停时那位玩家本人，再恢复现场
    showPassCover(s.activeSeat, { names: s.names, phase: s.phase, isResume: true });
    return;
  }
  emitIfConnected('resumeRoom', { seat: 0 });
}

function discardSuspendedGame() {
  showConfirm('确定放弃这局吗？放弃后无法恢复', function () {
    emitIfConnected('leaveRoom');
  });
}

// 首页当前选择的玩法/规格（创建、加入房间时读取）
function currentMode() { return state.homeMode; }
function currentSpec() { return savedSpecFor(state.homeMode); }

// 同步首页 UI：玩法卡片高亮、规格按钮高亮、模式提示文字
function renderHomeMode() {
  const mode = state.homeMode;
  const spec = savedSpecFor(mode);
  const sp = BOARD_SPECS[spec];
  document.querySelectorAll('.mode-card').forEach(function (c) {
    c.classList.toggle('active', c.dataset.mode === mode);
  });
  document.querySelectorAll('.spec-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.spec === spec);
  });
  $('#mode-help').textContent = mode === 'props'
    ? '🎁 道具版 · ' + sp.size + '×' + sp.size + ' · ' + sp.planeCount + ' 架 · 金币买道具更刺激'
    : '经典玩法 · ' + sp.size + '×' + sp.size + ' · ' + sp.planeCount + ' 架';
}

// ---------- 按钮事件 ----------
function bindUIEvents() {
  // 右上角主题切换：跟随系统 → 浅色 → 深色 循环
  $('#btn-theme').addEventListener('click', cycleTheme);

  // 敌方棋盘上方的「二次确认」勾选框（选择会记住）
  const revealConfirmBox = $('#reveal-confirm');
  if (revealConfirmBox) {
    revealConfirmBox.addEventListener('change', function () {
      onRevealConfirmChange(revealConfirmBox.checked);
    });
  }

  // 首页「继续上局」：继续 / 放弃
  const btnResume = $('#btn-resume');
  if (btnResume) btnResume.addEventListener('click', resumeSuspendedGame);
  const btnResumeDiscard = $('#btn-resume-discard');
  if (btnResumeDiscard) btnResumeDiscard.addEventListener('click', discardSuspendedGame);

  // 首页：玩法两栏卡片（点卡片任意处选中）+ 地图规格选择（S/M/L，每栏各自记忆）
  // 点卡片切换玩法栏：规格自动换成该栏记着的选择
  document.querySelectorAll('.mode-card').forEach(function (card) {
    card.addEventListener('click', function () {
      state.homeMode = card.dataset.mode;
      renderHomeMode();
    });
  });
  document.querySelectorAll('.spec-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // 规格保存到当前玩法栏自己的键（经典/道具互不影响）
      safeSet(state.homeMode === 'props' ? 'bp_spec_props' : 'bp_spec_classic', btn.dataset.spec);
      renderHomeMode();
    });
  });

  // 首页「创建房间」/「人机对战」按钮（在地图选择下方，不在卡片框里）：
  // 按当前选中的玩法栏（state.homeMode）+ 该栏记住的规格开局
  // 取昵称：输入框留空 → 随机生成一个英文名（新用户不用强制起名），并记住用过的名字
  function currentName() {
    const raw = $('#name-input').value.trim();
    // 留空 = 随机昵称；有输入则做基础内容安全检查，不合格时提示并中止本次开局
    const checked = checkNickname(raw);
    if (!checked.ok) {
      toast(checked.reason);
      return null;
    }
    const name = checked.name || randomName();
    safeSet('bp_name', name);
    return name;
  }
  document.querySelectorAll('.mode-create').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.mode) state.homeMode = btn.dataset.mode; // 兼容旧版 data-mode
      const name = currentName();
      if (!name) return;
      userStarted = true;
      emitIfConnected('createRoom', { name: name, avatar: myAvatar(), mode: currentMode(), boardSize: currentSpec() });
    });
  });
  document.querySelectorAll('.mode-ai').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.mode) state.homeMode = btn.dataset.mode; // 兼容旧版 data-mode
      const name = currentName();
      if (!name) return;
      userStarted = true;
      emitIfConnected('createRoomAI', { name: name, avatar: myAvatar(), mode: currentMode(), boardSize: currentSpec() });
    });
  });
  // 「同屏双人」：两人共用这台设备，服务器在每次行动后切换到下一位玩家
  document.querySelectorAll('.mode-local').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.mode) state.homeMode = btn.dataset.mode;
      const name = currentName();
      if (!name) return;
      userStarted = true;
      emitIfConnected('createRoomLocal', { name: name, avatar: myAvatar(), mode: currentMode(), boardSize: currentSpec() });
    });
  });
  // 兼容旧版首页的「加入房间」（离线版首页已移除该入口）
  if ($('#btn-join')) {
    $('#btn-join').addEventListener('click', function () {
      const name = currentName();
      if (!name) return;
      userStarted = true;
      emitIfConnected('joinRoom', { roomId: $('#room-input').value, name: name, avatar: myAvatar(), mode: currentMode(), boardSize: currentSpec() });
    });
  }
  // 对局中的「返回菜单」按钮（部署页 + 对战页 + 观战等待页各一个）
  document.querySelectorAll('.btn-back-menu').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // 观战者退出不影响对局，确认文案区分开
      // 离线版：返回菜单只暂停房间（内存里保留），首页可以继续上局；刷新仍会丢
      const msg = state.localMode
        ? (state.over
            ? '本局已结束，返回菜单后将关闭房间（战绩已保存）'
            : '确定要返回菜单吗？可从首页「继续上局」回来继续')
        : state.spectator
          ? '确定要退出观战、返回菜单吗？'
          : '确定要返回菜单吗？对局将暂停，之后可从「最近加入的房间」回来继续';
      // iOS 小黑盒 WebView 不支持 window.confirm，改用自己的确认弹窗
      showConfirm(msg, function () {
        if (state.localMode) {
          // 部署到一半且还没确认：草稿只放内存（同屏双人不能落盘，否则对方能看到）
          state.resumeDraft = null;
          if (!state.over && currentViewId() === 'view-deploy' &&
              state.draft.length && !state.deployConfirmed[state.seat]) {
            state.resumeDraft = {
              roomId: state.roomId,
              seat: state.seat,
              planes: state.draft.map(function (p) {
                return { headRow: p.headRow, headCol: p.headCol, dir: p.dir };
              })
            };
          }
          // 用 emitIfConnected：冷启动时 socket 还没连上也会有提示，不会点了没反应
          emitIfConnected('suspendRoom');
        } else {
          emitIfConnected('leaveRoom');
        }
      });
    });
  });

  // 确认弹窗：点「确定」执行暂存的操作；取消 / 点深色背景都不做任何事
  $('#btn-confirm-ok').addEventListener('click', function () {
    const action = confirmAction;
    closeConfirm();
    if (action) action();
  });
  $('#btn-confirm-cancel').addEventListener('click', closeConfirm);
  $('#confirm-modal').addEventListener('click', function (e) {
    if (e.target === this) closeConfirm();
  });

  // 同屏双人：顶部悬浮条。玩家主动点「切换玩家」才进入不透明的交接页，
  // 下一个玩家点「我是 X，开始」后服务器才切换座位并发送完整快照。
  $('#btn-switch-now').addEventListener('click', function () { showPassCover(); });
  $('#btn-pass-ready').addEventListener('click', function () {
    const seat = pendingPassSeat;
    if (seat == null) return hidePassModal();
    if (pendingPassIsResume) {
      // 继续上局：先收起交接页，失败时 resumeFailed 会把玩家留在首页续局卡
      emitIfConnected('resumeRoom', { seat: seat });
      return;
    }
    emitIfConnected('passReady', { seat: seat });
  });

  // 对战/部署页：点自己的昵称改昵称（和点头像换头像一样）
  // 观战者面板显示的是玩家的名字，不允许乱改
  $('#panel-my-name').addEventListener('click', function () {
    if (state.spectator) return;
    openNicknameModal();
  });

  // 昵称弹窗：校验不通过时把原因显示在弹窗里（不关闭，方便直接改）
  $('#btn-nickname-ok').addEventListener('click', function () {
    const checked = checkNickname($('#nickname-modal-input').value);
    if (!checked.ok) {
      $('#nickname-modal-error').textContent = checked.reason;
      return;
    }
    if (!checked.name) {
      $('#nickname-modal-error').textContent = '请输入 1~12 个字的昵称';
      return;
    }
    // 本地记住，下次开局直接带新昵称。
    // 同屏双人里 2 号位的昵称只属于这一局，不能覆盖设备主人（1 号位）的记忆
    if (!(state.local2p && state.seat !== 0)) safeSet('bp_name', checked.name);
    emitIfConnected('setNickname', { name: checked.name });
    closeNicknameModal();
  });
  $('#btn-nickname-cancel').addEventListener('click', closeNicknameModal);
  $('#nickname-modal').addEventListener('click', function (e) {
    if (e.target === this) closeNicknameModal();
  });

  // 部署页：朝向按钮
  document.querySelectorAll('.dir-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.curDir = btn.dataset.dir;
      document.querySelectorAll('.dir-btn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
    });
  });

  // 部署页：随机布局 / 清空 / 确认 / 取消确认
  $('#btn-random').addEventListener('click', function () {
    if (state.deployConfirmed[state.seat]) {
      return toast('已确认部署，点「取消确认」才能修改');
    }
    const planes = randomDraft();
    if (!planes) return toast('生成失败，再点一次试试');
    state.draft = planes;
    saveDraft();
    renderDeployBoard();
    updateDeployUI();
  });
  $('#btn-clear').addEventListener('click', function () {
    state.draft = [];
    saveDraft();
    renderDeployBoard();
    updateDeployUI();
  });
  $('#btn-confirm').addEventListener('click', function () {
    if (state.draft.length !== curSpec().planeCount) return toast('请先放满 ' + curSpec().planeCount + ' 架飞机');
    state.socket.emit('deployConfirm', { planes: state.draft });
  });
  $('#btn-unconfirm').addEventListener('click', function () {
    state.socket.emit('deployCancel');
  });

  // 结束横幅：再来一局（返回菜单用对战页顶部的「← 返回菜单」按钮）
  $('#btn-rematch').addEventListener('click', function () {
    // 和创建/加入一样走连接检查：按钮的 disabled 状态可能有一瞬间的滞后
    emitIfConnected('rematch');
  });

  // 道具面板：点道具进入选区模式（再点同一个 = 取消）。按钮 disabled 已挡掉
  // 金币不够/步数领先/观战/结束，这里再兜底校验一遍
  document.querySelectorAll('.item-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const id = btn.dataset.item;
      if (state.itemPick && state.itemPick.itemId === id) {
        clearItemPick();
        renderBattleBoards();
        updateItemButtons();
        return;
      }
      if (state.spectator) return toast('观战模式不能使用道具');
      if (state.over) return toast('对局已结束');
      if (state.steps[state.seat] > state.steps[1 - state.seat]) {
        return toast(state.local2p ? '你的步数已领先，请切换玩家' : '你的步数已领先，等待对方');
      }
      if (state.coins[state.seat] < ITEM_PRICES[id]) return toast('金币不够，买不起这个道具');
      state.revealPending = null; // 进入道具选区：取消普通探测的待确认目标
      state.itemPick = { itemId: id };
      state.pickCells = [];
      state.pickAnchor = null;
      state.pickReady = false;
      state.pickFirstKey = null;
      renderBattleBoards(); // 进入选区模式：棋盘十字光标 + 清掉旧的悬停预览
      updateItemButtons();
    });
  });

  // 道具确认执行：点「确认使用」按钮把选区发给服务器（二次点击定位格见 pickItemCell）
  $('#item-confirm').addEventListener('click', function () {
    confirmItem();
  });

  // 取消道具选择：清空选区，回到普通揭示模式
  $('#item-cancel').addEventListener('click', function () {
    clearItemPick();
    renderBattleBoards();
    updateItemButtons();
  });

  // 受邀加入页：确认加入 / 返回菜单
  // （离线版首页已移除邀请入口；元素不存在时跳过，旧代码路径保留不报错）
  if ($('#btn-invite-join')) {
    $('#btn-invite-join').addEventListener('click', function () {
      // 输入框留空 → 随机生成一个英文名（新用户不用强制起名），并记住用过的名字
      const raw = $('#invite-name-input').value.trim();
      const checked = checkNickname(raw);
      if (!checked.ok) { toast(checked.reason); return; }
      const name = checked.name || randomName();
      safeSet('bp_name', name);
      userStarted = true;
      // 房间号存在 state 里（而不是网址里），即使加入失败清掉了网址也能重试
      emitIfConnected('joinRoom', { roomId: state.inviteRoomId, name: name, avatar: myAvatar() });
    });
  }
  if ($('#btn-invite-back')) {
    $('#btn-invite-back').addEventListener('click', function () {
      userStarted = true; // 用户主动退出受邀页：晚到的存储恢复不要再把 ta 拽回旧房间
      state.inviteRoomId = null;
      clearRoomFromUrl();
      showView('home');
    });
  }

  // 首页「游戏规则」弹窗：打开 / 关闭（点深色背景也能关闭）
  // 弹窗内部分两栏：经典模式（基础规则）/ 道具模式（只讲道具特有规则）
  function showRulesTab(tab) {
    document.querySelectorAll('.rules-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    $('#rules-pane-classic').classList.toggle('hidden', tab !== 'classic');
    $('#rules-pane-props').classList.toggle('hidden', tab !== 'props');
  }
  document.querySelectorAll('.rules-tab').forEach(function (btn) {
    btn.addEventListener('click', function () { showRulesTab(btn.dataset.tab); });
  });
  $('#btn-rules').addEventListener('click', function () {
    showRulesTab('classic'); // 首页按钮：默认展示经典模式栏
    $('#rules-modal').classList.remove('hidden');
  });
  // 对战界面「规则」按钮：优先显示当前模式的规则栏（道具版→道具栏，经典版→经典栏）
  $('#btn-battle-rules').addEventListener('click', function () {
    showRulesTab(state.mode === 'props' ? 'props' : 'classic');
    $('#rules-modal').classList.remove('hidden');
  });
  $('#btn-rules-close').addEventListener('click', function () {
    $('#rules-modal').classList.add('hidden');
  });
  $('#btn-rules-x').addEventListener('click', function () {
    $('#rules-modal').classList.add('hidden');
  });
  $('#rules-modal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  });

  // 首页「对战历史」弹窗：打开 / 关闭（✕、底部按钮、点深色背景都行）/ 清空
  $('#btn-history').addEventListener('click', openHistoryModal);
  $('#btn-history-x').addEventListener('click', closeHistoryModal);
  $('#btn-history-close').addEventListener('click', closeHistoryModal);
  $('#history-modal').addEventListener('click', function (e) {
    if (e.target === this) closeHistoryModal();
  });
  $('#btn-history-clear').addEventListener('click', clearMatchHistory);

  // 历史详情弹窗：关闭后回到历史列表（列表一直留在下面）
  $('#btn-history-detail-x').addEventListener('click', closeHistoryDetail);
  $('#btn-history-detail-close').addEventListener('click', closeHistoryDetail);
  $('#history-detail-modal').addEventListener('click', function (e) {
    if (e.target === this) closeHistoryDetail();
  });
  // 道具折叠块：点头部展开/收起对应详情面板（箭头同步旋转）
  $('#rules-pane-props').addEventListener('click', function (e) {
    const head = e.target.closest('.props-fold-head');
    if (!head) return;
    const panel = document.getElementById('prop-detail-' + head.dataset.prop);
    if (!panel) return;
    const willShow = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    head.classList.toggle('open', willShow);
  });

  // 头像选择面板：点自己的头像（首页/邀请页/对战页面板）打开；🎲 随机 / 点背景关闭
  ['#home-avatar', '#invite-avatar', '#panel-my-avatar'].forEach(function (sel) {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('click', function () {
      // 对战面板的「我的头像」在观战时显示的是别人的头像：不弹自己的头像选择
      if (sel === '#panel-my-avatar' && state.spectator) return;
      openAvatarModal();
    });
  });
  $('#btn-avatar-random').addEventListener('click', function () {
    setMyAvatar(randomAvatar());
  });
  $('#btn-avatar-close').addEventListener('click', function () {
    $('#avatar-modal').classList.add('hidden');
  });
  $('#avatar-modal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  });

  // 「复制房间号」按钮（部署页 + 对战页）：小黑盒沙箱里网页链接不可分享，
  // 改为复制 4 位房间号，发给朋友后让 ta 在首页输入房间号加入
  document.querySelectorAll('.btn-copy-link').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const roomId = state.roomId || '';
      if (!roomId) return toast('还没有房间号');

      // 剪贴板不可用时直接把房间号显示在 toast 里，让用户手动记下
      // （不用 window.prompt：沙箱 WebView 可能不支持弹窗）
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(roomId).then(
          function () { toast('房间号已复制：' + roomId); },
          function () { toast('房间号：' + roomId + '（请手动记下）'); }
        );
      } else {
        toast('房间号：' + roomId + '（请手动记下）');
      }
    });
  });
}

// ---------- 启动 ----------
// 道具结果处理（顶层函数：sonar 数字 / 吞噬摧毁 / 无所遁形整机 / 毁灭菇揭示冻结）
// （探测者 和双发连射走 revealResult，不在这里）
// 提示：抽成顶层函数是为了 jsdom 渲染测试能直接调用（item-render-test）。
function handleItemResult(d) {
  if (d.attacker === state.seat) {
    // 自己用的道具：结果已出，选区模式结束
    state.itemPick = null;
    state.pickCells = [];
    state.pickAnchor = null;
    state.pickReady = false;
    state.pickHover = [];
    if (d.itemId === 'devour' && d.headHit) {
      toast('吞噬者命中机头！🎯 你找到了一架飞机');
    }
    if (d.itemId === 'sonar') {
      toast('声呐：区域内有 ' + d.count + ' 个非空格');
    }
  }
  if (d.itemId === 'sonar') {
    // 声呐数字：记入历史（attacker = 施放者座位，渲染时决定画在谁的棋盘上）
    state.sonarResults.push({ row: d.row, col: d.col, count: d.count, attacker: d.attacker });
  } else if (d.itemId === 'devour') {
    // 吞噬者：被摧毁的格子记入「已揭示」记录（灰色渲染；机头格单独记为灰色机头）。
    // ⚠️ 按施放者分流：自己用的 → 对方棋盘（enemy）；对方用的 → 我的棋盘（my）。
    // 之前无条件进 enemy，对方用道具会把我的格子画到对方棋盘上（渲染 bug）
    const target = d.attacker === state.seat ? state.enemyShotsReceived : state.myShotsReceived;
    (d.destroyed || []).forEach(function (cell) {
      if (d.headHit && cell[0] === d.headHit[0] && cell[1] === d.headHit[1]) return; // 机头格单独处理
      if (target.some(function (s) { return s.row === cell[0] && s.col === cell[1]; })) return;
      target.push({ row: cell[0], col: cell[1], result: 'destroyed' });
    });
    if (d.headHit && !target.some(function (s) { return s.row === d.headHit[0] && s.col === d.headHit[1]; })) {
      target.push({ row: d.headHit[0], col: d.headHit[1], result: 'head', destroyed: true });
    }
  } else if (d.itemId === 'expose') {
    // 无所遁形：整架飞机的 10 格补全揭示（都是机身，机头已揭示过）。分流同吞噬者
    const target = d.attacker === state.seat ? state.enemyShotsReceived : state.myShotsReceived;
    (d.cells || []).forEach(function (cell) {
      if (target.some(function (s) { return s.row === cell[0] && s.col === cell[1]; })) return;
      target.push({ row: cell[0], col: cell[1], result: 'body' });
    });
  } else if (d.itemId === 'doom') {
    // 毁灭菇：十字 5 格揭示 + 对角线 4 格冻结。揭示分流同吞噬者；
    // 冻结只记自己施放的（冻结只约束施放者自己，别把对方的也收进数组）
    const target = d.attacker === state.seat ? state.enemyShotsReceived : state.myShotsReceived;
    (d.cells || []).forEach(function (cell) {
      if (target.some(function (s) { return s.row === cell.row && s.col === cell.col; })) return;
      target.push({ row: cell.row, col: cell.col, result: cell.result });
    });
    if (d.attacker === state.seat) {
      state.frozenCells = state.frozenCells.concat(d.frozen || []);
    }
  }
  state.headsLeft = d.headsLeft;
  state.steps = d.steps;
  state.coins = d.coins || state.coins; // 道具版：金币随时同步
  renderBattleBoards();
  updateBattlePanels();
}

// ---------- 小黑盒安全区兜底 ----------
// 部分 iOS WebView 里 env(safe-area-inset-*) 会一直是 0，刘海/状态栏会挡住页面。
// 这时用 hb-sdk 的窗口信息算出安全区，写成 CSS 变量；
// CSS 里优先用变量，取不到再退回 env()。
async function applyHostSafeArea() {
  const sdk = window.__hbSDK;
  if (!sdk || !sdk.viewport || typeof sdk.viewport.getWindowInfo !== 'function') return;
  try {
    // getWindowInfo() 返回 Promise（不同宿主版本可能直接返回对象，await 都能处理）
    const info = await sdk.viewport.getWindowInfo();
    const safe = info && info.safeArea;
    if (!safe) return;

    // safeArea 用「左/上 + 右/下边界坐标」描述，需要换算成四边留白。
    // 宿主可能返回零宽/零高的退化安全区（right/bottom = 0），此时不能拿
    // 窗口宽高当留白，否则会给页面加上整屏 padding；这种情况按 0 处理。
    const width = Number(info.windowWidth) || 0;
    const height = Number(info.windowHeight) || 0;
    const safeRight = Number(safe.right) || 0;
    const safeBottom = Number(safe.bottom) || 0;
    const top = Math.max(0, Number(safe.top) || 0);
    const right = safeRight > 0 ? Math.max(0, width - safeRight) : 0;
    const bottom = safeBottom > 0 ? Math.max(0, height - safeBottom) : 0;
    const left = Math.max(0, Number(safe.left) || 0);

    const root = document.documentElement;
    root.style.setProperty('--hb-safe-top', top + 'px');
    root.style.setProperty('--hb-safe-right', right + 'px');
    root.style.setProperty('--hb-safe-bottom', bottom + 'px');
    root.style.setProperty('--hb-safe-left', left + 'px');
  } catch (e) {
    // 取不到窗口信息：继续用 CSS 的 env() 兜底，不能影响游戏
  }
}

function init() {
  // 离线版：没有网络连接。local-server.js 在浏览器里扮演服务器，
  // 接口与原来的 WSClient 完全一致（on/once/off/emit/connected），
  // 所以下面的连接事件、开局、战斗逻辑都不用改。
  state.socket = new window.LocalServer();
  bindSocketEvents();
  bindUIEvents();
  setServerReady(state.socket.connected); // 初始化联机按钮/等待提示（冷启动时先置灰）
  applyTheme(); // 按上次选择 / 系统偏好设置主题（含右上角按钮图标）
  loadRevealConfirm(); // 恢复「二次确认」开关（宿主存储此时已恢复）
  applyHostSafeArea(); // 用宿主窗口信息补上刘海/状态栏安全区（env() 为 0 时兜底）

  // 宿主窗口变化（横竖屏切换等）时安全区也可能变，重新读取一次
  try {
    const sdk = window.__hbSDK;
    if (sdk && typeof sdk.on === 'function') {
      sdk.on('viewport_change', function () { applyHostSafeArea(); });
    }
  } catch (e) { /* 宿主不支持该事件时忽略 */ }

  // 预生成三个棋盘
  makeBoard($('#deploy-board'), onDeployCellClick);
  makeBoard($('#my-board'), null);
  makeBoard($('#enemy-board'), onEnemyCellClick);

  // 屏幕尺寸变化（如手机横竖屏切换）时重算格子大小
  let resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      applyHostSafeArea(); // 横竖屏切换后重新计算刘海/状态栏留白
      const cs = boardCellSize();
      document.querySelectorAll('table.board:not(.mini-board) td').forEach(function (td) {
        td.style.width = cs + 'px';
        td.style.height = cs + 'px';
      });
    }, 150);
  });

  // 画规则弹窗里的 4 张飞机朝向配图
  renderRulesDiagram();

  // 记住上次用的昵称
  // 旧版本可能存了超过 12 字的随机名（如 MightyPenguin）：直接忽略并清掉，
  // 否则输入框里带着超长名字，每次开局都会被校验挡住。
  const savedName = (safeGet('bp_name') || '').trim();
  if (savedName && checkNickname(savedName).ok) {
    $('#name-input').value = savedName;
  } else if (savedName) {
    safeRemove('bp_name');
  }

  // 我的头像：首次访问自动随机分配，并在首页/邀请页显示
  state.avatar = myAvatar();
  renderMyAvatar();

  // 默认经典玩法 + S 规格（不恢复上次记忆：每次打开都从默认开始）
  state.homeMode = 'classic';
  renderHomeMode();
  renderResumeCard(); // 新会话没有暂停房间：默认隐藏续局卡

  // 离线版没有服务器房间可回：刷新后回首页，每次重新开局。
  // 清掉网页版时代留下的「最近加入的房间」记录，免得残留数据占存储。
  if (typeof safeRemove === 'function') safeRemove('bp_rooms');
}

// 先从小黑盒宿主存储恢复（最多等 1 秒），再初始化游戏。
// iOS 刷新后 localStorage 可能丢失，不先恢复会直接回首页、无法续局。
// 即使宿主存储不可用，1 秒后也会照常 init，不会卡住页面。
const hydration = hydrateHostStorage();
const hydrateTimeout = new Promise(function (resolve) { setTimeout(resolve, 1000); });

Promise.race([
  hydration.then(function () { return true; }),
  hydrateTimeout.then(function () { return false; })
]).then(function () {
  init();
}, init);
