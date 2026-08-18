// ============================================
// test/slider-layout-test.js —— 首页两栏卡片排版实测
// 用系统 Chrome 无头渲染，测量两张玩法卡片、道具介绍、规格行的真实布局，
// 断言：两卡并排不重叠、道具介绍完整在卡片内、卡内按钮在介绍下方不重叠
// 用法：先起服务器（node server.js），再 node test/slider-layout-test.js
// ============================================
'use strict';
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async function () {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 1200 });
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle0', timeout: 20000 });

  const r = await page.evaluate(function () {
    const rect = function (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
    };
    return {
      classic: rect('.mode-card[data-mode="classic"]'),
      props: rect('.mode-card[data-mode="props"]'),
      intro: rect('.mode-card[data-mode="props"] .mode-card-desc'),
      create: rect('.mode-create'),
      ai: rect('.mode-ai'),
      actions: rect('.home-actions'),
      spec: rect('.spec-row')
    };
  });
  if (!r.classic || !r.props) {
    console.log('✗ 未找到玩法卡片（页面是否还是旧版？）');
    await browser.close();
    process.exit(1);
  }
  console.log('经典卡:', JSON.stringify(r.classic));
  console.log('道具卡:', JSON.stringify(r.props));
  console.log('道具介绍:', JSON.stringify(r.intro));
  console.log('道具卡创建按钮:', JSON.stringify(r.create));
  console.log('道具卡人机按钮:', JSON.stringify(r.ai));
  console.log('规格行:', JSON.stringify(r.spec));

  let ok = true;
  // 断言 1：两卡水平并排（经典卡右缘 <= 道具卡左缘，互不重叠）
  const sideBySide = r.classic.right <= r.props.x + 1;
  console.log((sideBySide ? '✓' : '✗') + ' 两张卡片并排不重叠（经典右缘=' + r.classic.right + ' 道具左缘=' + r.props.x + '）');
  ok = ok && sideBySide;
  // 断言 2：两卡顶部对齐（同一行）
  const sameRow = Math.abs(r.classic.y - r.props.y) < 2;
  console.log((sameRow ? '✓' : '✗') + ' 两张卡片同一行顶部对齐');
  ok = ok && sameRow;
  // 断言 3：道具介绍完整在道具卡内（不溢出卡片）
  const introInCard = r.intro.x >= r.props.x - 1 && r.intro.right <= r.props.right + 1;
  console.log((introInCard ? '✓' : '✗') + ' 道具介绍在道具卡内不溢出');
  ok = ok && introInCard;
  // 断言 4：创建/人机按钮在地图选择下方（不在卡片框里）
  const btnBelow = r.create.y >= r.spec.bottom - 1 && r.ai.y >= r.spec.bottom - 1;
  console.log((btnBelow ? '✓' : '✗') + ' 创建/人机按钮在地图选择下方（按钮顶部=' + r.create.y + ' 地图选择底部=' + r.spec.bottom + '）');
  ok = ok && btnBelow;
  // 断言 5：规格行在卡片下方
  const specBelow = r.spec.y >= Math.max(r.classic.bottom, r.props.bottom) - 1;
  console.log((specBelow ? '✓' : '✗') + ' 规格行在卡片下方');
  ok = ok && specBelow;

  await browser.close();
  process.exitCode = ok ? 0 : 1;
})();
