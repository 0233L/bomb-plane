// Delta proof for xiaoheihe port:
// 1) host-storage-only reload -> auto rejoin + recent list
// 2) late hydration (>1s) -> init first, then re-render recent + auto rejoin
// 3) late hydration does not hijack an active session
// 4) showView (server phase change) closes the confirm modal
// 5) host storage failures warn exactly once
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_URL = 'http://127.0.0.1:5174/?mini_url=http%3A%2F%2F127.0.0.1%3A5173%2F';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}

function frameOf(page) {
  return page.frames().find((f) => f.url().includes('127.0.0.1:5173'));
}

let evalErrLogged = 0;
const EVAL_LOG_MAX = 30;
async function evalIn(page, fn, arg) {
  const all = page.frames();
  const frames = all.filter((f) => f.url().includes('127.0.0.1:5173'));
  const frame = frames[frames.length - 1];
  if (!frame) {
    if (evalErrLogged < EVAL_LOG_MAX) {
      evalErrLogged++;
      console.log('[eval] NO FRAME; page.frames=' + JSON.stringify(all.map((f) => f.url())));
    }
    return undefined;
  }
  try { return await frame.evaluate(fn, arg); }
  catch (e) {
    if (evalErrLogged < EVAL_LOG_MAX) {
      evalErrLogged++;
      console.log('[eval] frame count=' + frames.length + ' url=' + frame.url() + ' error=' + e.message);
    }
    if (String(e.message).includes('detached') || String(e.message).includes('Execution context') || String(e.message).includes('Could not find')) return undefined;
    throw e;
  }
}

async function waitIn(page, fn, timeoutMs, label, arg) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evalIn(page, fn, arg);
    if (last) return last;
    await sleep(200);
  }
  throw new Error('等待超时: ' + label + ' (last=' + JSON.stringify(last) + ')');
}

async function waitView(page, view, timeoutMs) {
  return waitIn(page, (v) => {
    const el = document.querySelector('#view-' + v);
    return !!(el && el.classList.contains('active'));
  }, timeoutMs || 45000, 'view-' + view, view);
}

async function click(page, sel) {
  const ok = await evalIn(page, (s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
  if (!ok) throw new Error('点击失败: ' + sel);
}

let lastPage = null;
async function openPage(browser, label, inject) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  lastPage = page;
  const consoleLines = [];
  const pageErrors = [];
  page.on('console', (m) => {
    const text = m.text();
    consoleLines.push({ type: m.type(), text });
  });
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  if (inject) await page.evaluateOnNewDocument(inject);
  await page.goto(DEBUG_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitIn(page, () => {
    const el = document.querySelector('#view-home');
    return !!(el && document.body.innerText.includes('炸飞机'));
  }, 45000, label + ' 首页渲染');
  await waitIn(page, () => {
    const el = document.querySelector('#visitor-count');
    const t = el ? el.textContent.trim() : '';
    return t && !t.includes('加载中') ? t : false;
  }, 120000, label + ' WebSocket 连接');
  // The debug host may recreate the iframe once after the first Vite deps scan;
  // require the game DOM to stay alive for two consecutive checks.
  for (let i = 0; i < 2; i++) {
    await waitIn(page, () => {
      const active = document.querySelector('.view.active');
      return !!active && !!document.querySelector('#view-home');
    }, 60000, label + ' iframe 稳定');
    await sleep(700);
  }
  return { context, page, consoleLines, pageErrors };
}

async function waitFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (frameOf(page)) return frameOf(page);
    await sleep(200);
  }
  throw new Error('iframe 未出现');
}

async function hostGet(page, key) {
  return evalIn(page, async (k) => {
    try { return await window.__hbSDK.storage.getStorage({ key: k }); }
    catch (e) { return { error: String(e && (e.message || e)) }; }
  }, key);
}

async function clearFrameLocalStorage(page) {
  return evalIn(page, () => {
    try { localStorage.clear(); return localStorage.length; }
    catch (e) { return -1; }
  });
}

async function createAIRoom(page, name) {
  await waitView(page, 'home');
  await evalIn(page, (n) => {
    const input = document.querySelector('#name-input');
    if (input) input.value = n;
  }, name);
  await click(page, '.mode-ai');
  await waitView(page, 'deploy');
  return (await evalIn(page, () => (document.querySelector('#deploy-room-id') || {}).textContent || '')).trim();
}

async function createPvpRoom(page, name) {
  await waitView(page, 'home');
  await evalIn(page, (n) => {
    const input = document.querySelector('#name-input');
    if (input) input.value = n;
  }, name);
  await click(page, '.mode-create');
  await waitView(page, 'deploy');
  return (await evalIn(page, () => (document.querySelector('#deploy-room-id') || {}).textContent || '')).trim();
}

async function joinPvpRoom(page, roomId, name) {
  await waitView(page, 'home');
  await evalIn(page, (x) => {
    const n = document.querySelector('#name-input');
    if (n) n.value = x.name;
    const r = document.querySelector('#room-input');
    if (r) r.value = x.roomId;
  }, { name, roomId });
  await click(page, '#btn-join');
  await waitView(page, 'deploy');
}

async function deployConfirm(page) {
  await click(page, '#btn-random');
  await waitIn(page, () => {
    const b = document.querySelector('#btn-confirm');
    return !!(b && !b.disabled);
  }, 5000, '确认部署按钮可用');
  await click(page, '#btn-confirm');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // ============================================================
    // Test 1: host-storage-only reload (warm hydration path)
    // ============================================================
    console.log('\n===== Test 1: host-storage-only reload =====');
    const t1 = await openPage(browser, '[T1]');
    const room1 = await createAIRoom(t1.page, '存储恢复');
    console.log('[T1] AI room:', room1);
    await sleep(1800); // let host mirror chains flush
    const hostHistory = await hostGet(t1.page, 'bp_room_history');
    const hostName = await hostGet(t1.page, 'bp_name');
    console.log('[T1] host bp_room_history:', JSON.stringify(hostHistory));
    console.log('[T1] host bp_name:', JSON.stringify(hostName));
    let hostList = [];
    try { hostList = JSON.parse(hostHistory.data || '[]'); } catch (e) {}
    record('T1.1 host storage contains room history with room', hostList.some((e) => e.roomId === room1), hostList);
    record('T1.2 host storage contains mirrored nickname', hostName && hostName.data === '存储恢复', hostName);

    const clearedLen = await clearFrameLocalStorage(t1.page);
    record('T1.3 frame localStorage cleared before reload', clearedLen === 0, { length: clearedLen });
    await t1.page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitFrame(t1.page, 45000);
    await waitIn(t1.page, () => !!(document.querySelector('#view-home') && document.body.innerText.includes('炸飞机')), 45000, '[T1] reload home render');
    await waitView(t1.page, 'deploy', 120000);
    const roomAfter = (await evalIn(t1.page, () => (document.querySelector('#deploy-room-id') || {}).textContent || '')).trim();
    const recentText = await evalIn(t1.page, () => (document.querySelector('#recent-list') || {}).textContent || '');
    const recentHidden = await evalIn(t1.page, () => document.querySelector('#recent-card').classList.contains('hidden'));
    console.log('[T1] after reload room:', roomAfter, '| recent hidden:', recentHidden, '| recent:', JSON.stringify(recentText));
    record('T1.4 reload auto-rejoined the same room using host storage only', roomAfter === room1, { expected: room1, actual: roomAfter });
    record('T1.5 recent list rendered from hydrated history', recentText.includes(room1) && !recentHidden, { recentText, recentHidden });
    const warns1 = t1.consoleLines.filter((l) => l.text.includes('宿主存储不可用'));
    record('T1.6 no host storage failure warning on healthy host', warns1.length === 0, warns1);
    record('T1.7 no page errors', t1.pageErrors.length === 0, t1.pageErrors);
    await t1.context.close().catch(() => {});

    // ============================================================
    // Test 2: late hydration (>1s) re-renders recent + resumes
    // ============================================================
    console.log('\n===== Test 2: late hydration path =====');
    const DELAY_MS = 6000;
    const delayGetStorage = `(() => {
      window.__hbDelayMarker = true;
      let realSdk;
      try {
        Object.defineProperty(window, '__hbSDK', {
          configurable: true,
          enumerable: true,
          get() { return realSdk; },
          set(v) {
            try {
              const st = v && v.storage;
              if (st && typeof st.getStorage === 'function') {
                const orig = st.getStorage.bind(st);
                const wrapped = function (args) {
                  return new Promise(function (resolve, reject) {
                    setTimeout(function () {
                      Promise.resolve(orig(args)).then(resolve, reject);
                    }, ${DELAY_MS});
                  });
                };
                st.getStorage = wrapped;
                window.__hbWrapOk = st.getStorage === wrapped;
              } else {
                window.__hbWrapError = 'no getStorage';
              }
            } catch (e) { window.__hbWrapError = String(e); }
            realSdk = v;
          }
        });
      } catch (e) { window.__hbWrapError = 'defineProperty: ' + String(e); }
    })();`;
    const t2 = await openPage(browser, '[T2]', delayGetStorage);
    const wrapInfo = await evalIn(t2.page, () => ({
      marker: window.__hbDelayMarker === true,
      ok: window.__hbWrapOk === true,
      error: window.__hbWrapError || null,
      sdk: !!window.__hbSDK,
    }));
    console.log('[T2] injection:', JSON.stringify(wrapInfo));
    record('T2.0 delay wrapper active in mini frame', wrapInfo.marker && wrapInfo.ok && !wrapInfo.error, wrapInfo);

    const room2 = await createAIRoom(t2.page, '延迟恢复');
    console.log('[T2] AI room:', room2);
    await sleep(1500);
    const cleared2 = await clearFrameLocalStorage(t2.page);
    record('T2.1 frame localStorage cleared', cleared2 === 0, { length: cleared2 });

    const t0 = Date.now();
    await t2.page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitFrame(t2.page, 45000);
    await waitIn(t2.page, () => !!(document.querySelector('#view-home') && document.body.innerText.includes('炸飞机')), 45000, '[T2] reload home render');

    let initSeenAt = null;
    let recentAtInit = null;
    let deploySeenAt = null;
    let roomLate = '';
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const st = await evalIn(t2.page, () => {
        const visitor = document.querySelector('#visitor-count');
        const vt = visitor ? visitor.textContent.trim() : '';
        const active = document.querySelector('.view.active');
        const recentCard = document.querySelector('#recent-card');
        const recentList = document.querySelector('#recent-list');
        const deployRoom = document.querySelector('#deploy-room-id');
        return {
          visitor: vt,
          view: active ? active.id : '',
          recentHidden: !!(recentCard && recentCard.classList.contains('hidden')),
          recentText: recentList ? recentList.textContent : '',
          deployRoom: deployRoom ? deployRoom.textContent.trim() : '',
        };
      });
      if (!st) { await sleep(200); continue; }
      if (!initSeenAt && st.visitor && !st.visitor.includes('加载中')) {
        initSeenAt = Date.now();
        recentAtInit = { hidden: st.recentHidden, text: st.recentText, view: st.view };
        console.log('[T2] init observed at +' + (initSeenAt - t0) + 'ms:', JSON.stringify(recentAtInit));
      }
      if (st.view === 'view-deploy' && st.deployRoom) {
        deploySeenAt = Date.now();
        roomLate = st.deployRoom;
        break;
      }
      await sleep(150);
    }
    console.log('[T2] late resume at +' + (deploySeenAt ? deploySeenAt - t0 : 'n/a') + 'ms, room:', roomLate);
    record('T2.2 init ran before hydration completed (timeout path taken)', !!initSeenAt && initSeenAt - t0 < DELAY_MS, { initSeenAt: initSeenAt && initSeenAt - t0, delay: DELAY_MS });
    record('T2.3 at init time recent card still empty (hydration pending)', !!recentAtInit && recentAtInit.hidden && !recentAtInit.text.includes(room2), recentAtInit);
    record('T2.4 late hydration rendered recent rooms', !!deploySeenAt && !!(await evalIn(t2.page, (rid) => {
      const t = (document.querySelector('#recent-list') || {}).textContent || '';
      const card = document.querySelector('#recent-card');
      return t.includes(rid) && card && !card.classList.contains('hidden');
    }, room2)), { room2 });
    record('T2.5 late hydration resumed the last room', roomLate === room2, { expected: room2, actual: roomLate });
    record('T2.6 resume happened after hydration delay, not at init', !!deploySeenAt && deploySeenAt - t0 >= DELAY_MS - 500, { deployAt: deploySeenAt && deploySeenAt - t0, delay: DELAY_MS });
    record('T2.7 no page errors', t2.pageErrors.length === 0, t2.pageErrors);

    // -------- Test 2b: late hydration must not hijack an active session --------
    console.log('\n===== Test 2b: no hijack of active session =====');
    const cleared2b = await clearFrameLocalStorage(t2.page);
    record('T2b.0 frame localStorage cleared again', cleared2b === 0, { length: cleared2b });
    const t0b = Date.now();
    await t2.page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitFrame(t2.page, 45000);
    await waitIn(t2.page, () => !!(document.querySelector('#view-home') && document.body.innerText.includes('炸飞机')), 45000, '[T2b] reload home render');
    await waitIn(t2.page, () => {
      const el = document.querySelector('#visitor-count');
      const t = el ? el.textContent.trim() : '';
      return t && !t.includes('加载中');
    }, 120000, '[T2b] init + WS connected');
    const startedAt = Date.now();
    const room2b = await createAIRoom(t2.page, '主动开局');
    console.log('[T2b] new AI room:', room2b, 'at +' + (startedAt - t0b) + 'ms');
    // Wait until well after the delayed hydration completed.
    const waitUntil = t0b + DELAY_MS + 2500;
    if (Date.now() < waitUntil) await sleep(waitUntil - Date.now());
    const finalState = await evalIn(t2.page, () => {
      const active = document.querySelector('.view.active');
      return {
        view: active ? active.id : '',
        room: (document.querySelector('#deploy-room-id') || {}).textContent.trim(),
        toast: (document.querySelector('#toast') || {}).textContent || '',
      };
    });
    console.log('[T2b] final state:', JSON.stringify(finalState));
    record('T2b.1 late hydration did not switch away from the room the user just started', finalState.view === 'view-deploy' && finalState.room === room2b && room2b !== room2, { finalState, room2, room2b });
    await t2.context.close().catch(() => {});

    // ============================================================
    // Test 3: showView closes the confirm modal on phase change
    // ============================================================
    console.log('\n===== Test 3: confirm modal + server view change =====');
    const ta = await openPage(browser, '[T3A]');
    const tb = await openPage(browser, '[T3B]');
    const room3 = await createPvpRoom(ta.page, '房主');
    console.log('[T3] PVP room:', room3);
    // Room starts in "waiting"; join first so the phase becomes "deploy".
    await joinPvpRoom(tb.page, room3, '挑战者');
    await deployConfirm(ta.page);
    await sleep(1200); // let deployReady land
    await click(ta.page, '.view.active .btn-back-menu');
    await waitIn(ta.page, () => {
      const m = document.querySelector('#confirm-modal');
      return !!(m && !m.classList.contains('hidden'));
    }, 3000, '[T3] confirm modal visible');
    record('T3.1 back-menu opens the in-page confirm modal', true);
    await deployConfirm(tb.page);
    await waitView(ta.page, 'battle', 30000);
    await sleep(300);
    const modalAfter = await evalIn(ta.page, () => {
      const m = document.querySelector('#confirm-modal');
      return !!(m && m.classList.contains('hidden'));
    });
    const activeAfter = await evalIn(ta.page, () => ((document.querySelector('.view.active') || {}).id || ''));
    record('T3.2 battleStart view change closed the pending confirm modal', modalAfter && activeAfter === 'view-battle', { modalHidden: modalAfter, activeAfter });
    record('T3.3 no page errors on A/B', ta.pageErrors.length === 0 && tb.pageErrors.length === 0, { a: ta.pageErrors, b: tb.pageErrors });
    await ta.context.close().catch(() => {});
    await tb.context.close().catch(() => {});

    // ============================================================
    // Test 4: host storage failure warns once
    // ============================================================
    console.log('\n===== Test 4: one-time storage warning =====');
    const failSetStorage = `(() => {
      let realSdk;
      try {
        Object.defineProperty(window, '__hbSDK', {
          configurable: true,
          enumerable: true,
          get() { return realSdk; },
          set(v) {
            try {
              const st = v && v.storage;
              if (st && typeof st.setStorage === 'function') {
                st.setStorage = function () { return Promise.reject(new Error('mock: host storage down')); };
              } else { window.__hbWrapError = 'no setStorage'; }
            } catch (e) { window.__hbWrapError = String(e); }
            realSdk = v;
          }
        });
      } catch (e) { window.__hbWrapError = 'defineProperty: ' + String(e); }
    })();`;
    const t4 = await openPage(browser, '[T4]', failSetStorage);
    const wrap4 = await evalIn(t4.page, () => ({ error: window.__hbWrapError || null }));
    if (wrap4.error) {
      record('T4.0 setStorage failure wrapper installed', false, wrap4);
    } else {
      record('T4.0 setStorage failure wrapper installed', true);
      // Force several failed host writes: theme cycling twice + avatar write on load.
      await click(t4.page, '#btn-theme');
      await sleep(150);
      await click(t4.page, '#btn-theme');
      await sleep(1200);
      const warns = t4.consoleLines.filter((l) => l.text.includes('宿主存储不可用'));
      record('T4.1 host storage failures warn exactly once', warns.length === 1, { count: warns.length, warns: warns.map((w) => w.text) });
      const unhandled = t4.pageErrors.filter((e) => /unhandled|rejection/i.test(e));
      record('T4.2 no unhandled rejection from mirror chain', unhandled.length === 0, unhandled);
    }
    await t4.context.close().catch(() => {});

    console.log('\n========== SUMMARY ==========');
    const failed = results.filter((r) => !r.ok);
    console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }, null, 2));
    if (failed.length) {
      console.log('FAILED:', JSON.stringify(failed, null, 2));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('\n测试中断:', error);
    console.log('已收集结果:', JSON.stringify(results, null, 2));
    if (lastPage) {
      try {
        console.log('frames:', JSON.stringify(lastPage.frames().map((f) => f.url())));
        const host = await lastPage.evaluate(() => ({
          text: document.body.innerText.slice(0, 600),
          iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({ src: f.getAttribute('src'), cls: f.className })),
        }));
        console.log('host state:', JSON.stringify(host).slice(0, 1200));
      } catch (e) { console.log('host dump failed:', e.message); }
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('脚本错误:', e); process.exitCode = 1; });
