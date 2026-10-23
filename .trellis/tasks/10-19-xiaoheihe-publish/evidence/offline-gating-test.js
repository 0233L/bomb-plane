// 首页「先进入界面、连上服务器后再开放联机」验收
//
// 覆盖这些情况：
//   A. 冷启动（WebSocket 一直连不上）：提示条显示、联机按钮置灰，规则/主题/昵称仍可用
//   A2. 首次反复连接失败：不弹「连接断开」toast，等待文案不重置、继续升级
//   B. 连接后中途断线（假 WebSocket）：按钮置灰 + 重连提示，自动重连后恢复
//   C. 真实服务器：连接后提示条隐藏、按钮可用，人机对战正常进入部署页（回归）
//   D. 受邀页：连接前「加入房间」置灰、等待提示可见
//
// 运行前置：
//   1. 另开终端：cd xiaoheihe && npm run dev（保持运行，5173/5174）
//   2. 在项目根目录执行：
//      NODE_PATH=d:/coding/project/bombPlane/node_modules \
//        node .trellis/tasks/10-19-xiaoheihe-publish/evidence/offline-gating-test.js
// 截图：offline-gating.png（A 的首页）
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_URL = 'http://127.0.0.1:5174/?mini_url=http%3A%2F%2F127.0.0.1%3A5173%2F';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findMiniFrame(page) {
  return page.frames().find((f) => f.url().includes('127.0.0.1:5173'));
}

async function miniEval(page, fn, arg) {
  const frame = findMiniFrame(page);
  if (!frame) return null;
  try {
    return await frame.evaluate(fn, arg);
  } catch (e) {
    if (String(e.message).includes('detached')) return null;
    throw e;
  }
}

async function waitFor(page, fn, timeoutMs, label, arg) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await miniEval(page, fn, arg);
    if (last) return last;
    await sleep(200);
  }
  throw new Error('等待超时: ' + (label || 'condition') + '（最后值: ' + JSON.stringify(last) + '）');
}

async function waitHome(page, timeoutMs = 45000) {
  return waitFor(
    page,
    () => {
      const el = document.querySelector('#view-home');
      if (!el) return false;
      const style = getComputedStyle(document.body);
      return style.visibility !== 'hidden' && document.body.innerText.includes('炸飞机');
    },
    timeoutMs,
    '首页渲染'
  );
}

// 在 5173 的小程序页面里替换 WebSocket（不影响 5174 调试台自己的连接）：
//   never = 永远停在 CONNECTING，模拟 Render 冷启动一直没响应
//   flaky = 50ms 后连上，之后可以手动 close() 模拟中途断线
//   retry = 每次都连不上、200ms 后触发 close，模拟冷启动期间反复失败
// 注意 Vite 热更新也会用 WebSocket，所以测试只操作 host 含 bomb-plane 的那个实例。
function installFakeWS(mode) {
  if (location.port !== '5173') return;
  class FakeWS {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      window.__fakeWS = window.__fakeWS || [];
      window.__fakeWS.push(this);
      if (mode === 'flaky') {
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          if (this.onopen) this.onopen({});
        }, 50);
      }
      if (mode === 'retry') {
        // 连不上 = 稍后 close：ws.js 会退避重连，然后再次失败
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 3;
          if (this.onclose) this.onclose({});
        }, 200);
      }
    }
    send() {}
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose({});
    }
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
}

// 首页联机控件的当前状态
function readGating() {
  const banner = document.querySelector('#server-status');
  const recentEnter = document.querySelector('#recent-list .recent-enter');
  const rematch = document.querySelector('#btn-rematch');
  return {
    bannerVisible: !!(banner && !banner.classList.contains('hidden')),
    bannerText: ((document.querySelector('#server-status-text') || {}).textContent || '').trim(),
    createDisabled: Array.from(document.querySelectorAll('.mode-create')).map((b) => b.disabled),
    aiDisabled: Array.from(document.querySelectorAll('.mode-ai')).map((b) => b.disabled),
    joinDisabled: !!(document.querySelector('#btn-join') || {}).disabled,
    recentEnter: recentEnter ? recentEnter.disabled : null,
    rematchDisabled: rematch ? rematch.disabled : null,
    rulesDisabled: !!(document.querySelector('#btn-rules') || {}).disabled,
    themeDisabled: !!(document.querySelector('#btn-theme') || {}).disabled,
    nameDisabled: !!(document.querySelector('#name-input') || {}).disabled,
    nameReadOnly: !!(document.querySelector('#name-input') || {}).readOnly,
    activeView: (document.querySelector('.view.active') || {}).id || '',
    toast: ((document.querySelector('#toast') || {}).textContent || '').trim(),
    theme: document.documentElement.getAttribute('data-theme'),
  };
}

async function openContext(browser, fakeMode, debugUrl) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (fakeMode) {
    await page.evaluateOnNewDocument(installFakeWS, fakeMode);
  }
  await page.goto(debugUrl || DEBUG_URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await waitHome(page);
  return { context, page };
}

// 受邀页（旧邀请链接）的调试地址：内层页面带 ?room=ABCD
const INVITE_URL = 'http://127.0.0.1:5174/?mini_url=' +
  encodeURIComponent('http://127.0.0.1:5173/?room=ABCD');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = {};
  try {
    // ===================== A. 冷启动（一直连不上） =====================
    console.log('\n===== A. 冷启动：先进入界面，联机按钮置灰 =====');
    const a = await openContext(browser, 'never');
    const pageA = a.page;

    // 塞一条「最近房间」记录后重载，检查动态生成的「进入」也会置灰（left=true 避免自动续局）
    await miniEval(pageA, () => {
      localStorage.setItem('bp_room_history', JSON.stringify([
        { roomId: 'TEST', token: 'fake-token', name: '旧房间', lastSeen: Date.now(), left: true },
      ]));
    });
    await pageA.reload({ waitUntil: 'networkidle2', timeout: 90000 });
    await waitHome(pageA);

    // 等 init 跑完（联机按钮被置灰）再读取状态
    await waitFor(
      pageA,
      () => {
        const btn = document.querySelector('.mode-create');
        return !!(btn && btn.disabled);
      },
      5000,
      '冷启动按钮置灰'
    );

    results.offlineStart = await miniEval(pageA, readGating);
    // 第一阶段的文案（8 秒内）
    results.offlineStart.bannerTextStage1 = results.offlineStart.bannerText;

    // 规则弹窗可用
    await miniEval(pageA, () => document.querySelector('#btn-rules').click());
    await sleep(300);
    results.rulesUsable = await miniEval(pageA, () => {
      const modal = document.querySelector('#rules-modal');
      return { open: !!(modal && !modal.classList.contains('hidden')) };
    });
    await miniEval(pageA, () => document.querySelector('#btn-rules-close').click());

    // 主题切换 + 昵称输入可用。
    // 主题按 跟随系统→浅色→深色 循环：headless 里系统是浅色，点一次可能看不出颜色变化，
    // 所以点两次，并检查保存的偏好确实在变化（按钮可用即可，不要求每次颜色都变）。
    const themeBefore = results.offlineStart.theme;
    const readTheme = () => ({
      dataTheme: document.documentElement.getAttribute('data-theme'),
      saved: localStorage.getItem('bp_theme'),
      title: (document.querySelector('#btn-theme') || {}).title || '',
    });
    await miniEval(pageA, () => document.querySelector('#btn-theme').click());
    await sleep(200);
    const themeFirst = await miniEval(pageA, readTheme);
    await miniEval(pageA, () => document.querySelector('#btn-theme').click());
    await sleep(200);
    const themeSecond = await miniEval(pageA, readTheme);
    await miniEval(pageA, () => {
      const input = document.querySelector('#name-input');
      input.value = '离线也能改名';
    });
    results.offlineUsable = await miniEval(pageA, () => ({
      nameValue: document.querySelector('#name-input').value,
    }));
    results.offlineUsable.themeBefore = themeBefore;
    results.offlineUsable.themeFirst = themeFirst;
    results.offlineUsable.themeSecond = themeSecond;

    // 等 9 秒，确认等待文案会升级（不是卡死）
    await sleep(9500);
    results.offlineAfterWait = await miniEval(pageA, readGating);
    await pageA.screenshot({
      path: path.join(__dirname, 'offline-gating.png'),
      fullPage: true,
    });

    console.log('[A] 初始状态:', JSON.stringify(results.offlineStart));
    console.log('[A] 规则/主题/昵称:', JSON.stringify(results.rulesUsable), JSON.stringify(results.offlineUsable));
    console.log('[A] 等待 9.5s 后:', JSON.stringify(results.offlineAfterWait));
    await a.context.close();

    // ===================== A2. 首次反复失败：不弹断线 toast，等待文案继续升级 =====================
    console.log('\n===== A2. 首次反复连接失败：不弹断线 toast，等待文案继续升级 =====');
    const a2 = await openContext(browser, 'retry');
    const pageA2 = a2.page;

    await waitFor(
      pageA2,
      () => {
        const btn = document.querySelector('.mode-create');
        return !!(btn && btn.disabled);
      },
      5000,
      '反复失败时按钮保持置灰'
    );
    results.retryStart = await miniEval(pageA2, readGating);
    await sleep(9500);
    results.retryAfterWait = await miniEval(pageA2, readGating);
    console.log('[A2] 开始:', JSON.stringify(results.retryStart));
    console.log('[A2] 9.5s 后:', JSON.stringify(results.retryAfterWait));
    await a2.context.close();

    // ===================== B. 中途断线 → 自动重连 =====================
    console.log('\n===== B. 连上后中途断线，自动重连恢复 =====');
    const b = await openContext(browser, 'flaky');
    const pageB = b.page;

    // 等假 WebSocket 连上：提示条隐藏、按钮可用
    await waitFor(
      pageB,
      () => {
        const banner = document.querySelector('#server-status');
        const btn = document.querySelector('.mode-create');
        return !!(banner && banner.classList.contains('hidden') && btn && !btn.disabled);
      },
      5000,
      '假连接建立'
    );
    results.flakyConnected = await miniEval(pageB, readGating);

    // 手动断掉游戏连接（不是 Vite 热更新的那条）
    await miniEval(pageB, () => {
      const ws = (window.__fakeWS || []).filter((w) => w.url.includes('bomb-plane')).pop();
      if (ws) ws.close();
      return !!ws;
    });
    await sleep(300);
    results.flakyDisconnected = await miniEval(pageB, readGating);

    // 等自动重连（0.5s 退避 + 随机抖动 + 50ms 打开）
    await waitFor(
      pageB,
      () => {
        const banner = document.querySelector('#server-status');
        const btn = document.querySelector('.mode-create');
        return !!(banner && banner.classList.contains('hidden') && btn && !btn.disabled);
      },
      6000,
      '自动重连恢复'
    );
    results.flakyReconnected = await miniEval(pageB, readGating);
    console.log('[B] 已连接:', JSON.stringify(results.flakyConnected));
    console.log('[B] 断线:', JSON.stringify(results.flakyDisconnected));
    console.log('[B] 重连恢复:', JSON.stringify(results.flakyReconnected));
    await b.context.close();

    // ===================== C. 真实服务器回归 =====================
    console.log('\n===== C. 真实服务器：连接后开放联机 =====');
    const c = await openContext(browser, null);
    const pageC = c.page;

    const t0 = Date.now();
    const visitor = await waitFor(
      pageC,
      () => {
        const el = document.querySelector('#visitor-count');
        const text = el ? el.textContent.trim() : '';
        return text && !text.includes('加载中') ? text : false;
      },
      120000,
      'WebSocket 连接（访客统计）'
    );
    results.onlineConnectMs = Date.now() - t0;
    results.online = await miniEval(pageC, readGating);
    console.log('[C] 连接耗时 ' + (results.onlineConnectMs / 1000).toFixed(1) + 's，' + visitor);
    console.log('[C] 状态:', JSON.stringify(results.online));

    // 人机对战回归：应能正常进入部署页
    await miniEval(pageC, () => {
      document.querySelector('#name-input').value = '门控回归';
      document.querySelector('.mode-ai').click();
    });
    await waitFor(
      pageC,
      () => {
        const el = document.querySelector('#view-deploy');
        return !!(el && el.classList.contains('active'));
      },
      20000,
      '人机对战进入部署页'
    );
    results.aiRoomId = await miniEval(pageC, () => {
      return (document.querySelector('#deploy-room-id') || {}).textContent || '';
    });
    console.log('[C] 人机房间号:', results.aiRoomId);
    await c.context.close();

    // ===================== D. 受邀页：连接前加入按钮置灰 =====================
    console.log('\n===== D. 受邀页：连接前「加入房间」置灰 =====');
    const d = await openContext(browser, 'never', INVITE_URL);
    const pageD = d.page;

    await waitFor(
      pageD,
      () => {
        const btn = document.querySelector('#btn-invite-join');
        return !!(btn && btn.disabled);
      },
      5000,
      '受邀页加入按钮置灰'
    );
    results.inviteOffline = await miniEval(pageD, () => {
      const hint = document.querySelector('#invite-server-hint');
      return {
        activeView: (document.querySelector('.view.active') || {}).id || '',
        roomId: ((document.querySelector('#invite-room-id') || {}).textContent || '').trim(),
        joinDisabled: !!(document.querySelector('#btn-invite-join') || {}).disabled,
        hintVisible: !!(hint && !hint.classList.contains('hidden')),
      };
    });
    console.log('[D] 受邀页:', JSON.stringify(results.inviteOffline));
    await d.context.close();

    // ===================== 汇总 =====================
    const checks = {
      'A 冷启动显示提示条': results.offlineStart.bannerVisible === true,
      'A 创建房间置灰': results.offlineStart.createDisabled.every(Boolean),
      'A 人机对战置灰': results.offlineStart.aiDisabled.every(Boolean),
      'A 加入房间置灰': results.offlineStart.joinDisabled === true,
      'A 最近房间「进入」置灰': results.offlineStart.recentEnter === true,
      'A 规则按钮可用': results.offlineStart.rulesDisabled === false,
      'A 规则弹窗能打开': results.rulesUsable.open === true,
      'A 主题按钮可用且能切换': results.offlineStart.themeDisabled === false &&
        !!results.offlineUsable.themeFirst.saved &&
        results.offlineUsable.themeSecond.saved !== results.offlineUsable.themeFirst.saved,
      'A 昵称可输入': results.offlineStart.nameDisabled === false &&
        results.offlineStart.nameReadOnly === false &&
        results.offlineUsable.nameValue === '离线也能改名',
      'A 等待文案会升级': results.offlineAfterWait.bannerText !== results.offlineStart.bannerTextStage1,
      'A2 首次反复失败不弹「连接断开」toast':
        !results.retryAfterWait.toast.includes('连接断开'),
      'A2 首次反复失败等待文案继续升级':
        results.retryAfterWait.bannerText.includes('唤醒'),
      'A2 首次反复失败按钮保持置灰':
        results.retryAfterWait.createDisabled.every(Boolean),
      'B 假连接后按钮可用': results.flakyConnected.bannerVisible === false &&
        results.flakyConnected.createDisabled.every((d) => d === false),
      'B 断线后提示条出现且按钮置灰': results.flakyDisconnected.bannerVisible === true &&
        results.flakyDisconnected.createDisabled.every(Boolean),
      'B 断线 toast': results.flakyDisconnected.toast.includes('重连'),
      'B 自动重连后恢复': results.flakyReconnected.bannerVisible === false &&
        results.flakyReconnected.createDisabled.every((d) => d === false),
      'C 连上后提示条隐藏': results.online.bannerVisible === false,
      'C 联机按钮全部可用': results.online.createDisabled.every((d) => d === false) &&
        results.online.aiDisabled.every((d) => d === false) &&
        results.online.joinDisabled === false &&
        results.online.rematchDisabled === false,
      'C 人机对战可进入部署页': /^[A-Z0-9]{4}$/.test(String(results.aiRoomId).trim()),
      'D 受邀页显示正确房间号': results.inviteOffline.activeView === 'view-invite' &&
        results.inviteOffline.roomId === 'ABCD',
      'D 受邀页加入按钮置灰且提示可见': results.inviteOffline.joinDisabled === true &&
        results.inviteOffline.hintVisible === true,
    };

    console.log('\n========== 门控验收 ==========');
    let failed = 0;
    Object.keys(checks).forEach((name) => {
      console.log((checks[name] ? 'PASS  ' : 'FAIL  ') + name);
      if (!checks[name]) failed++;
    });
    console.log(`\n${Object.keys(checks).length - failed}/${Object.keys(checks).length} 通过`);
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error('\n测试中断:', error);
    console.log('已收集结果:', JSON.stringify(results, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('脚本错误:', e);
  process.exitCode = 1;
});
