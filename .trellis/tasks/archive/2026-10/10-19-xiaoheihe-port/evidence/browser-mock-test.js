// 小黑盒移植版 Browser Mock 自动化验收
// 覆盖：首页、昵称内容安全、人机对战、复制房间号、localStorage、双人加入、观战、刷新重连
//
// 运行前置：
//   1. 另开终端：cd xiaoheihe && npm run dev（保持运行，5173/5174）
//   2. 在项目根目录执行：
//      NODE_PATH=d:/coding/project/bombPlane/node_modules node .trellis/tasks/10-19-xiaoheihe-port/evidence/browser-mock-test.js
// 结果截图会写在本文件同目录的 browser-mock-ai.png / browser-mock-pvp.png
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_URL = 'http://127.0.0.1:5174/?mini_url=http%3A%2F%2F127.0.0.1%3A5173%2F';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findMiniFrame(page) {
  // 小程序 iframe 的 URL 带 5173 和 bridge nonce
  return page.frames().find((f) => f.url().includes('127.0.0.1:5173'));
}

async function safeEval(page, fn, arg) {
  const frame = findMiniFrame(page);
  if (!frame) return null;
  try {
    return await frame.evaluate(fn, arg);
  } catch (error) {
    if (String(error.message).includes('detached')) return null;
    throw error;
  }
}

async function waitFor(page, fn, timeoutMs, label, arg) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await safeEval(page, fn, arg);
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`等待超时: ${label || 'condition'}`);
}

async function waitView(page, view, timeoutMs = 20000) {
  return waitFor(
    page,
    (v) => {
      const el = document.querySelector('#view-' + v);
      return !!(el && el.classList.contains('active'));
    },
    timeoutMs,
    'view-' + view,
    view
  );
}

async function getText(page, selector) {
  return safeEval(page, (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() : '';
  }, selector);
}

async function click(page, selector) {
  const ok = await safeEval(page, (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!ok) throw new Error('点击失败，元素不存在: ' + selector);
  return ok;
}

async function openGame(browser, name) {
  // 调试台偶尔会卡在 iframe 加载/握手阶段，重开一个新上下文即可恢复。
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 每个玩家用独立的浏览器上下文：同一浏览器里 5173 的 localStorage 是共享的，
    // 不隔离的话 B/C/D 会读到 A 的房间历史并自动重连到同一局。
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

    try {
      await page.goto(DEBUG_URL, { waitUntil: 'networkidle2', timeout: 90000 });

      // 等 iframe 出现、SDK 握手完成、首页渲染
      await waitFor(
        page,
        () => {
          const el = document.querySelector('#view-home');
          if (!el) return false;
          const style = getComputedStyle(document.body);
          return style.visibility !== 'hidden' && document.body.innerText.includes('炸飞机');
        },
        45000,
        '首页渲染'
      );
      console.log(`[${name}] 首页已加载`);

      // 等 WebSocket 真正连上：访客统计从「加载中」变成具体数字。
      // Render 免费实例冷启动可能几十秒，固定 sleep 不够。
      const t0 = Date.now();
      const visitor = await waitFor(
        page,
        () => {
          const el = document.querySelector('#visitor-count');
          const text = el ? el.textContent.trim() : '';
          return text && !text.includes('加载中') ? text : false;
        },
        120000,
        'WebSocket 连接（访客统计）'
      );
      console.log(`[${name}] WebSocket 已连接（${((Date.now() - t0) / 1000).toFixed(1)}s）: ${visitor}`);
      return { page, errors };
    } catch (e) {
      console.log(`[${name}] 第 ${attempt} 次打开失败: ${e.message}`);
      await context.close().catch(() => {});
    }
  }
  throw new Error(`[${name}] 调试台打开失败（已重试 3 次）`);
}

async function createClassicRoom(page) {
  await waitView(page, 'home');
  await safeEval(page, () => {
    const input = document.querySelector('#name-input');
    if (input) input.value = '测试玩家' + Math.floor(Math.random() * 100);
  });
  await click(page, '.mode-create');
  await waitView(page, 'deploy');
  const roomId = (await getText(page, '#deploy-room-id')).trim();
  if (!/^[A-Z0-9]{4}$/.test(roomId)) throw new Error('房间号异常: ' + roomId);
  return roomId;
}

async function deployAndConfirm(page) {
  await click(page, '#btn-random');
  await waitFor(
    page,
    () => {
      const b = document.querySelector('#btn-confirm');
      return !!(b && !b.disabled);
    },
    5000,
    '确认部署按钮可用'
  );
  await click(page, '#btn-confirm');
}

async function joinRoom(page, roomId) {
  await waitView(page, 'home');
  await sleep(1000);
  await safeEval(page, (rid) => {
    const input = document.querySelector('#room-input');
    if (input) input.value = rid;
  }, roomId);
  await click(page, '#btn-join');
  await waitView(page, 'deploy');
}

// 房间可能已满（观战）：点加入后等任意结果页面
async function joinRoomAny(page, roomId) {
  await waitView(page, 'home');
  await sleep(1000);
  await safeEval(page, (rid) => {
    const input = document.querySelector('#room-input');
    if (input) input.value = rid;
  }, roomId);
  await click(page, '#btn-join');
  await waitFor(
    page,
    () =>
      ['view-deploy', 'view-wait', 'view-battle'].some((id) => {
        const el = document.getElementById(id);
        return el && el.classList.contains('active');
      }),
    20000,
    '加入结果页面'
  );
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = {};
  try {
    // ===================== A. 人机对战 =====================
    console.log('\n===== A. 人机对战 =====');
    const a = await openGame(browser, 'A');
    const pageA = a.page;

    // localStorage 探测
    results.storage = await safeEval(pageA, () => {
      try {
        localStorage.setItem('__bp_probe', '1');
        return localStorage.getItem('__bp_probe') === '1' ? 'available' : 'unexpected';
      } catch (e) {
        return 'blocked: ' + e.name + ': ' + e.message;
      }
    });
    console.log('[A] localStorage:', results.storage);

    // 昵称基础内容安全：广告/联系方式昵称应被拒绝，页面停在首页并提示
    await safeEval(pageA, () => {
      const input = document.querySelector('#name-input');
      if (input) input.value = '加群123456';
    });
    await click(pageA, '.mode-ai');
    await sleep(800);
    results.badNickname = await safeEval(pageA, () => ({
      active: (document.querySelector('.view.active') || {}).id || '',
      toast: (document.querySelector('#toast') || {}).textContent || '',
    }));
    console.log('[A] 非法昵称结果:', JSON.stringify(results.badNickname));

    await safeEval(pageA, () => {
      const input = document.querySelector('#name-input');
      if (input) input.value = '人机测试';
    });
    await click(pageA, '.mode-ai');
    // 诊断：点击后逐秒打印页面状态（连接中断时守卫会弹提示）
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      const st = await safeEval(pageA, () => ({
        active: (document.querySelector('.view.active') || {}).id || '',
        toast: (document.querySelector('#toast') || {}).textContent || '',
        toastShown: !!(document.querySelector('#toast') || {}).classList?.contains('show'),
        visitor: (document.querySelector('#visitor-count') || {}).textContent || '',
      }));
      console.log('[A] 点击后 +' + ((i + 1) * 0.5).toFixed(1) + 's:', JSON.stringify(st));
      if (st && st.active === 'view-deploy') break;
    }
    await waitView(pageA, 'deploy');
    const aiRoomId = (await getText(pageA, '#deploy-room-id')).trim();
    results.aiRoomId = aiRoomId;
    console.log('[A] 人机房间号:', aiRoomId);

    await deployAndConfirm(pageA);
    await waitView(pageA, 'battle', 20000);
    console.log('[A] 已进入对战页');

    // 点一个未知格开火
    const shot = await safeEval(pageA, () => {
      const td = document.querySelector('#enemy-board td.cell-unknown');
      if (!td) return null;
      const row = td.parentElement.rowIndex;
      const col = td.cellIndex;
      td.click();
      return { row, col };
    });
    results.aiShot = shot;
    await sleep(2500);
    results.aiAfterShot = await safeEval(pageA, (s) => {
      if (!s) return null;
      const table = document.querySelector('#enemy-board');
      const td = table.rows[s.row] && table.rows[s.row].cells[s.col];
      return {
        cellClass: td ? td.className : '',
        steps: (document.querySelector('#battle-steps') || {}).textContent || '',
        bodyText: document.body.innerText.slice(0, 300),
      };
    }, shot);
    console.log('[A] 开火后:', JSON.stringify(results.aiAfterShot));

    // 复制房间号
    await safeEval(pageA, () => {
      const btn = document.querySelector('.btn-copy-link');
      if (btn) btn.click();
    });
    await sleep(500);
    results.copyToast = await getText(pageA, '#toast');
    console.log('[A] 复制房间号 toast:', results.copyToast);

    // iPhone 真机修复 1：改昵称弹窗（window.prompt 在 iOS 沙箱会被屏蔽）
    await click(pageA, '#panel-my-name');
    await sleep(300);
    results.nicknameModal = await safeEval(pageA, () => {
      const modal = document.querySelector('#nickname-modal');
      const input = document.querySelector('#nickname-modal-input');
      return {
        open: !!(modal && !modal.classList.contains('hidden')),
        value: input ? input.value : '',
      };
    });
    await safeEval(pageA, () => {
      document.querySelector('#nickname-modal-input').value = '加群123456';
    });
    await click(pageA, '#btn-nickname-ok');
    await sleep(300);
    results.nicknameRejected = await getText(pageA, '#nickname-modal-error');
    await safeEval(pageA, () => {
      document.querySelector('#nickname-modal-input').value = '改名成功';
    });
    await click(pageA, '#btn-nickname-ok');
    await sleep(800);
    results.nicknameAccepted = await safeEval(pageA, () => ({
      modalHidden: document.querySelector('#nickname-modal').classList.contains('hidden'),
      panel: document.querySelector('#panel-my-name').textContent,
    }));
    console.log('[A] 改昵称弹窗:', JSON.stringify({
      open: results.nicknameModal,
      rejected: results.nicknameRejected,
      accepted: results.nicknameAccepted,
    }));

    results.errorsA = a.errors.filter((e) => !e.includes('favicon.ico'));
    await pageA.screenshot({
      path: require('path').join(__dirname, 'browser-mock-ai.png'),
      fullPage: true,
    });

    // iPhone 真机修复 2：返回菜单确认弹窗（window.confirm 在 iOS 沙箱会被屏蔽）
    await click(pageA, '.btn-back-menu');
    await sleep(300);
    results.confirmModal = await safeEval(pageA, () => ({
      open: !document.querySelector('#confirm-modal').classList.contains('hidden'),
      text: document.querySelector('#confirm-text').textContent,
    }));
    // 先点「取消」：应留在对战页
    await click(pageA, '#btn-confirm-cancel');
    await sleep(300);
    results.cancelStaysBattle = await safeEval(pageA, () => ({
      view: (document.querySelector('.view.active') || {}).id || '',
      modalHidden: document.querySelector('#confirm-modal').classList.contains('hidden'),
    }));
    // 再点「返回菜单」→「确定」：应回到首页
    await click(pageA, '.btn-back-menu');
    await sleep(200);
    await click(pageA, '#btn-confirm-ok');
    await waitView(pageA, 'home', 10000);
    results.backHome = await safeEval(pageA, () => ({
      view: (document.querySelector('.view.active') || {}).id || '',
      recent: (document.querySelector('#recent-list') || {}).innerText || '',
    }));
    console.log('[A] 返回菜单弹窗:', JSON.stringify({
      modal: results.confirmModal,
      cancel: results.cancelStaysBattle,
      backHome: results.backHome,
    }));

    // ===================== B. 双人加入 =====================
    console.log('\n===== B. 双人加入 =====');
    const b = await openGame(browser, 'B');
    const c = await openGame(browser, 'C');
    const pageB = b.page;
    const pageC = c.page;

    const roomId = await createClassicRoom(pageB);
    results.pvpRoomId = roomId;
    console.log('[B] 创建房间:', roomId);

    await joinRoom(pageC, roomId);
    console.log('[C] 已加入房间，进入部署页');

    await deployAndConfirm(pageB);
    await deployAndConfirm(pageC);
    await waitView(pageB, 'battle', 20000);
    await waitView(pageC, 'battle', 20000);
    console.log('[B/C] 双方进入对战页');

    // B 开火，检查 C 的己方棋盘是否出现结果
    const pvpShot = await safeEval(pageB, () => {
      const td = document.querySelector('#enemy-board td.cell-unknown');
      if (!td) return null;
      const row = td.parentElement.rowIndex;
      const col = td.cellIndex;
      td.click();
      return { row, col };
    });
    results.pvpShot = pvpShot;
    await sleep(2500);
    results.pvpTarget = await safeEval(pageC, (s) => {
      if (!s) return null;
      const table = document.querySelector('#my-board');
      const td = table.rows[s.row] && table.rows[s.row].cells[s.col];
      return td ? td.className : '';
    }, pvpShot);
    console.log('[B] 开火坐标:', JSON.stringify(pvpShot), '=> C 己方格子 class:', results.pvpTarget);

    // 观战：第三/第四个客户端加入同一房间（房间已满）
    console.log('\n===== B2. 观战 =====');
    // 这里复用 C 之外的另一个页面加入；C 已经在房间里，另开 D
    const d = await openGame(browser, 'D');
    const pageD = d.page;
    await joinRoomAny(pageD, roomId).catch(async (e) => {
      console.log('[D] 加入结果等待失败:', e.message);
      await sleep(1500);
    });
    await sleep(2000);
    results.spectator = await safeEval(pageD, () => {
      const active = document.querySelector('.view.active');
      return {
        view: active ? active.id : '',
        text: document.body.innerText.slice(0, 400),
      };
    });
    console.log('[D] 观战状态:', JSON.stringify(results.spectator));

    // 刷新 C，测试重连（localStorage 可用时应该能回到房间）
    console.log('\n===== B3. 刷新重连 =====');
    await pageC.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    // 等它要么回到房间（deploy/battle/wait），要么停在首页
    await waitFor(
      pageC,
      () => {
        const el = document.querySelector('.view.active');
        return !!(el && ['view-home', 'view-deploy', 'view-wait', 'view-battle'].includes(el.id));
      },
      25000,
      '刷新后页面'
    ).catch(() => null);
    await sleep(2000);
    results.reload = await safeEval(pageC, () => {
      const active = document.querySelector('.view.active');
      return {
        view: active ? active.id : '',
        text: document.body.innerText.slice(0, 300),
      };
    }).catch((e) => ({ error: e.message }));
    console.log('[C] 刷新后:', JSON.stringify(results.reload));

    results.errorsB = b.errors.filter((e) => !e.includes('favicon.ico'));
    results.errorsC = c.errors.filter((e) => !e.includes('favicon.ico'));
    results.errorsD = d.errors.filter((e) => !e.includes('favicon.ico'));

    await pageB.screenshot({
      path: require('path').join(__dirname, 'browser-mock-pvp.png'),
      fullPage: true,
    });

    console.log('\n========== 汇总 ==========');
    console.log(JSON.stringify(results, null, 2));
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
