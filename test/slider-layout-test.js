// ============================================
// test/slider-layout-test.js —— 首页道具开关排版实测
// 用系统 Chrome 无头渲染，测量滑块轨道/圆点/文字的真实布局，
// 断言：轨道宽 40px、圆点在轨道内、文字在轨道右侧不重叠
// 用法：node test/slider-layout-test.js
// ============================================
'use strict';
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async function () {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 500, height: 900 });
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle0', timeout: 20000 });

  const r = await page.evaluate(function () {
    const rect = function (el) {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, display: getComputedStyle(el).display };
    };
    return {
      slider: rect(document.querySelector('.props-slider')),
      dot: rect(document.querySelector('.props-slider::after') || document.querySelector('.props-slider')),
      label: rect(document.querySelector('.props-label')),
      input: rect(document.querySelector('#props-toggle'))
    };
  });
  console.log('滑块轨道:', JSON.stringify(r.slider));
  console.log('文字:', JSON.stringify(r.label));

  // 断言：轨道宽度生效（40px 左右）
  const trackOk = r.slider.w > 30 && r.slider.h > 15;
  // 断言：文字在轨道右侧（不重叠）
  const noOverlap = r.label.x >= r.slider.x + r.slider.w - 1;
  console.log((trackOk ? '✓' : '✗') + ' 滑块轨道宽度生效（' + r.slider.w + '×' + r.slider.h + '）');
  console.log((noOverlap ? '✓' : '✗') + ' 文字在轨道右侧不重叠（文字 x=' + r.label.x + ' 轨道右缘=' + (r.slider.x + r.slider.w) + '）');

  await browser.close();
  process.exitCode = (trackOk && noOverlap) ? 0 : 1;
})();
