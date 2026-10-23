// 生成小黑盒小程序图标（200×200）和封面（510×272）。
// 设计：浅色天空 + 棋盘网格 + 深蓝飞机 + 橙色命中标记，浅色/深色模式都清楚。
// 用法：node make-assets.js
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = path.resolve(__dirname, '../../../../xiaoheihe/assets');

// 图标：200×200，棋盘格 + 飞机 + 命中环
const ICON_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 200px; height: 200px; overflow: hidden; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    background: linear-gradient(160deg, #f2f9ff 0%, #d6ecff 52%, #a9d4ff 100%);
  }
  .icon { position: relative; width: 200px; height: 200px; overflow: hidden; }
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(23, 62, 110, .12) 1px, transparent 1px),
      linear-gradient(90deg, rgba(23, 62, 110, .12) 1px, transparent 1px);
    background-size: 20px 20px;
  }
  .sun {
    position: absolute; width: 190px; height: 190px; left: -36px; top: -50px;
    background: radial-gradient(circle, rgba(255,255,255,.95), rgba(255,255,255,0) 66%);
  }
  .ring {
    position: absolute; right: 16px; bottom: 16px; width: 74px; height: 74px;
  }
  .plane {
    position: absolute; left: 34px; top: 42px; width: 128px; height: 128px;
    transform: rotate(-14deg);
    filter: drop-shadow(0 9px 9px rgba(19, 52, 94, .28));
  }
</style></head>
<body>
  <div class="icon">
    <div class="grid"></div>
    <div class="sun"></div>

    <!-- 命中标记：橙色双环 + 中心点 -->
    <svg class="ring" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="42" fill="rgba(255,255,255,.55)" stroke="#ff8a3d" stroke-width="9"/>
      <circle cx="50" cy="50" r="21" fill="none" stroke="#ff8a3d" stroke-width="7" opacity=".85"/>
      <circle cx="50" cy="50" r="6" fill="#ff6a00"/>
    </svg>

    <!-- 飞机：深蓝剪影 + 浅色座舱 -->
    <svg class="plane" viewBox="0 0 100 100">
      <path d="M50 4 C57 4 61 14 61 27 L61 46 L91 63 L91 72 L61 63 L61 80 L72 91 L72 97 L50 90 L28 97 L28 91 L39 80 L39 63 L9 72 L9 63 L39 46 L39 27 C39 14 43 4 50 4 Z"
            fill="#173e6e"/>
      <path d="M50 17 C53.2 17 55.4 22 55.4 29.5 L55.4 40 L44.6 40 L44.6 29.5 C44.6 22 46.8 17 50 17 Z"
            fill="#bfe3ff"/>
      <path d="M50 55 L57 58 L57 66 L50 63 L43 66 L43 58 Z" fill="#2c5d96" opacity=".55"/>
    </svg>
  </div>
</body></html>`;

// 封面：510×272，左侧标题，右侧 10×10 小棋盘
const COVER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 510px; height: 272px; overflow: hidden; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    background: linear-gradient(135deg, #eef8ff 0%, #d3eaff 48%, #a8d2ff 100%);
  }
  .cover { position: relative; width: 510px; height: 272px; overflow: hidden; }
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(23, 62, 110, .09) 1px, transparent 1px),
      linear-gradient(90deg, rgba(23, 62, 110, .09) 1px, transparent 1px);
    background-size: 34px 34px;
  }
  .glow {
    position: absolute; width: 420px; height: 420px; left: -110px; top: -180px;
    background: radial-gradient(circle, rgba(255,255,255,.95), rgba(255,255,255,0) 65%);
  }
  .copy { position: absolute; left: 38px; top: 42px; width: 238px; }
  .kicker {
    display: inline-block; padding: 5px 11px; border-radius: 999px;
    background: rgba(255,255,255,.75); color: #2a5f9e;
    font-size: 12px; font-weight: 700; letter-spacing: 1px;
    box-shadow: 0 2px 8px rgba(23,62,110,.08);
  }
  h1 {
    margin-top: 13px; color: #12325a; font-size: 54px; line-height: 1.05;
    font-weight: 900; letter-spacing: 2px;
    text-shadow: 0 3px 0 rgba(255,255,255,.65);
  }
  .sub {
    margin-top: 11px; color: #245082; font-size: 18px; font-weight: 700;
    letter-spacing: .5px; line-height: 1.45;
  }
  .tags { margin-top: 14px; display: flex; gap: 8px; }
  .tag {
    padding: 5px 10px; border-radius: 8px; background: #fff;
    color: #2a5f9e; font-size: 12px; font-weight: 700;
    box-shadow: 0 3px 10px rgba(23,62,110,.10);
  }
  /* 右侧棋盘 */
  .board-wrap {
    position: absolute; right: 30px; top: 50%; transform: translateY(-50%) rotate(-5deg);
    width: 196px; height: 196px;
    background: rgba(255,255,255,.86); border-radius: 16px;
    box-shadow: 0 14px 30px rgba(23,62,110,.18);
    padding: 12px;
  }
  .board {
    width: 100%; height: 100%; display: grid;
    grid-template-columns: repeat(10, 1fr); grid-template-rows: repeat(10, 1fr);
    gap: 2px;
  }
  .cell { background: #e2effc; border-radius: 2px; }
  .cell.plane { background: #173e6e; }
  .cell.hit { background: #ff8a3d; }
  .cell.miss { background: #b9cde4; }
  .plane-icon {
    position: absolute; right: -16px; bottom: -36px; width: 118px; height: 118px;
    transform: rotate(-18deg);
    filter: drop-shadow(0 12px 14px rgba(19,52,94,.28));
  }
  .burst {
    position: absolute; right: -18px; top: -24px; width: 86px; height: 86px;
  }
</style></head>
<body>
  <div class="cover">
    <div class="grid"></div>
    <div class="glow"></div>

    <div class="copy">
      <span class="kicker">小黑盒 · 双人实时对战</span>
      <h1>炸飞机</h1>
      <div class="sub">找到对方飞机<br>先击中 3 个机头获胜</div>
      <div class="tags">
        <span class="tag">创建房间</span>
        <span class="tag">好友对战</span>
        <span class="tag">人机练习</span>
      </div>
    </div>

    <div class="board-wrap">
      <div class="board" id="board"></div>

      <!-- 棋盘角落的小飞机装饰 -->
      <svg class="plane-icon" viewBox="0 0 100 100">
        <path d="M50 4 C57 4 61 14 61 27 L61 46 L91 63 L91 72 L61 63 L61 80 L72 91 L72 97 L50 90 L28 97 L28 91 L39 80 L39 63 L9 72 L9 63 L39 46 L39 27 C39 14 43 4 50 4 Z"
              fill="#173e6e"/>
        <path d="M50 17 C53.2 17 55.4 22 55.4 29.5 L55.4 40 L44.6 40 L44.6 29.5 C44.6 22 46.8 17 50 17 Z"
              fill="#bfe3ff"/>
      </svg>

      <!-- 右上角爆炸装饰 -->
      <svg class="burst" viewBox="0 0 100 100">
        <polygon points="50,0 61,31 94,17 72,44 100,50 72,57 93,85 61,69 50,100 39,69 7,85 28,57 0,50 28,44 6,17 39,31"
                 fill="#ffb020"/>
        <polygon points="50,20 58,40 79,31 64,48 82,52 64,57 76,75 58,64 50,84 42,64 24,75 36,57 18,52 36,48 21,31 42,40"
                 fill="#ff7a1a"/>
      </svg>
    </div>
  </div>

  <script>
    // 10×10 棋盘：摆一架飞机（机头朝上）和几个命中/未命中格
    var board = document.getElementById('board');
    var plane = new Set(['3-5','4-5','5-5','6-5','5-4','5-6','5-3','5-7']); // 机身 + 机翼（行-列）
    var hits = new Set(['3-5','5-4','7-2']);
    var miss = new Set(['1-1','2-8','8-7','6-2']);
    for (var r = 0; r < 10; r++) {
      for (var c = 0; c < 10; c++) {
        var el = document.createElement('div');
        el.className = 'cell';
        var key = r + '-' + c;
        if (plane.has(key)) el.classList.add('plane');
        if (hits.has(key)) el.classList.add('hit');
        else if (miss.has(key)) el.classList.add('miss');
        board.appendChild(el);
      }
    }
  </script>
</body></html>`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none']
  });

  async function shot(html, width, height, file) {
    const page = await browser.newPage();
    await page.setViewport({ width: width, height: height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: file, type: 'png', omitBackground: false });
    await page.close();
    console.log('saved', file);
  }

  await shot(ICON_HTML, 200, 200, path.join(OUT_DIR, 'icon.png'));
  await shot(COVER_HTML, 510, 272, path.join(OUT_DIR, 'cover.png'));
  await browser.close();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
