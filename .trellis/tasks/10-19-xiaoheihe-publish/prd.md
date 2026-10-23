# 小黑盒小程序上架（炸飞机）

## Goal

把现有的炸飞机网页版（[public/](../../../public/)）移植为小黑盒「小程序工坊」版本，
提审并发布，让小黑盒用户可以在 App 内玩到炸飞机。

2026-10-23 更新：`network` 权限因域名无 ICP 备案被自动驳回后，按用户决定
（“小黑盒改离线版，网页别动”）改为**纯离线版**：本地 AI 人机对战 + 同屏双人，
不申请网络权限。网页版 `public/` / `server.js` / `ai.js` 保持联机不变。
离线版工程与验证见子任务 [`10-23-xiaoheihe-offline`](../10-23-xiaoheihe-offline/)。

## 背景与关键事实

- 小黑盒小程序工坊使用标准 Web 技术（Vite + HTML/CSS/JS），通过 `@heybox/hb-sdk` 调用平台能力；**不是**微信小程序运行时。
- 现有 [miniprogram/](../../../miniprogram/) 是微信小程序代码，不能直接用于小黑盒；应基于 [public/](../../../public/) 的网页版移植。
- 游戏是服务器权威 + WebSocket 实时联机，服务器为 `bomb-plane.onrender.com`（Express + ws，见 [server.js](../../../server.js)）。
- 小黑盒生产构建默认注入 `connect-src 'none'` 的 CSP；只有平台批准 `network` 权限后，`remote deploy` 才会跳过该 CSP。因此 network 权限是硬门槛。
- 本地 `hb-sdk dev` 对已声明但未批准的 network 提供临时权限，可先做可行性验证。
- 用户已在小黑盒开放平台创建小程序，mini_program_id 为 `01a15288-dc63-73a6-90e7-f283d3b25abb`。

## Requirements

### 功能（当前：离线版 0.2.0）

- 首页：昵称/emoji 头像、经典模式、道具模式、地图规格、规则弹窗、主题切换。
- 人机对战：本地运行浏览器版 AI（`xiaoheihe/src/legacy/local-ai.js`），不依赖服务器。
- 同屏双人：一台设备两人操作；步数不落后时可在顶部主动切换，领先时高亮提示；
  交接页不透明，保护飞机布局。
- 本地能力：部署、揭示、6 个道具、步数规则、机头胜负、比分、再来一局、
  右键/长按标注、刷新回首页。
- 平台适配：小黑盒沙箱内的存储（仅 `storage` 权限）、安全区、屏幕适配。
- 小程序包完全离线，不连接任何服务器。

历史（联机版，已放弃）：WebSocket 创建/加入房间、观战、断线重连；
因 `bomb-plane.onrender.com` 无 ICP 备案，`network` 权限被驳回。

### 约束

- 只改 `xiaoheihe/`；不修改 `public/`、`server.js`、`ai.js`、`miniprogram/`。
- 发布包不得声明 `network`，不得包含 WebSocket 或服务器地址。
- 不使用微信小程序 API；不使用需要平台批准但未申请的能力。
- 不加入充值、支付、提现、付费解锁等商业化功能。
- 个人主体可申请；按平台要求完成实名认证与资质材料。
- 代码保持现有风格：简单直观、中文注释，方便用户阅读。
- 任何提交审核前必须完成 Browser Mock + 真机验收。

### 合规与审核材料

- 名称、简介、图标（200×200）、封面（510×272）、SemVer 版本号、版本说明。
- 测试说明：纯单机，一台设备即可验收人机对战与同屏双人，不要求两台设备。
- 权限披露：仅 `storage`；明确说明不联网、不上传对局数据。
- 隐私说明：昵称、emoji 头像、主题/规格偏好仅存本机。
- 内容安全：昵称只在本地展示，客户端做基础过滤（无聊天、无上传）。
- 不得使用第三方 IP/素材；不得暗示小黑盒官方背书。

## Task Map

| 任务 | 交付物 | 状态 |
|---|---|---|
| `10-19-xiaoheihe-ws-spike` | 验证沙箱内 native WebSocket 可用性；提交 network 权限申请；记录结论 | 完成（已归档；联机路线因 ICP 放弃） |
| `10-19-xiaoheihe-port` | 可构建的 `xiaoheihe/` 工程，Browser Mock + 真机可玩 | 完成（已归档） |
| `10-23-xiaoheihe-offline` | 离线版：本地 AI、同屏双人、移除 network | 代码与自动化测试完成；待真机 + 提审 |
| 提审发布（本任务） | 审核材料、`remote deploy`、审核通过后的 `remote release`、上线冒烟 | 进行中；按离线版 0.2.0 提审 |

## Acceptance Criteria

- [x] `xiaoheihe/` 工程可 `hb-sdk build`，构建产物通过官方校验。
- [x] 改为离线版：`network` 权限移除，发布包不含 WebSocket/服务器地址。
- [x] 人机对战与同屏双人完成 Browser Mock 自动化验收（含道具、S/M/L、再来一局）。
- [x] 正式图标/封面、隐私说明、测试说明、版本说明按离线版更新（`submission.md`）。
- [ ] 真机（iPhone）完成人机对战与同屏双人各一局，确认交接页与安全区。
- [ ] 版本 `0.2.0` 提交审核并发布；发布后在小黑盒 App 内再冒烟一次。
- [ ] 现有网页版与服务器功能未被破坏（`git status` 核对零改动）。

## Risks

1. **native WebSocket 未在官方文档明确承诺**：CSP 跳过机制表明可行，但必须先用最小工程验证；失败则改用 `network.request` 轮询。
2. **Render 冷启动**：实测冷启动约 23.6 秒，可能违反首屏/核心流程审核要求；需要 keep-alive 或常驻实例。
3. **国内网络可达性**：需用移动数据实测 `bomb-plane.onrender.com`。
4. **沙箱存储/分享差异**：localStorage 可能不可用；复制邀请链接在沙箱内不可用，需要房间号或平台分享 API。
5. **审核测试资源**：联机游戏必须让审核人员能方便地完成双人对战。

## Notes

- 当前只启动 spike 子任务；移植与提审子任务在 spike 结论出来后创建。
- 官方文档版本以 0.9.1 为准，规则可能更新；提审前重新核对上架规则。
- 2026-10-19：移植子任务已完成并归档；正式图标/封面已生成；提审文案与隐私/测试说明见
  [`submission.md`](submission.md)，执行顺序见 [`implement.md`](implement.md)。
  当前硬阻塞：`network` 平台批准仍为 `未批准`（申请 ID `e4fecd41-51c1-4e56-86d0-704a508bc0c9`）。
- 2026-10-19：冷启动体验改为「先进入界面、连上后再开放联机」：首页立即渲染，
  创建/加入/人机/再来一局在未连接时置灰，规则/主题/昵称仍可用；连接成功后自动恢复，
  中途断线同样置灰并显示重连提示。人机对战依赖服务器 AI（`ai.js`），因此也在门控范围内。
  Browser Mock 22/22 通过，见 [`evidence/offline-gating-test.js`](evidence/offline-gating-test.js)。
- 2026-10-23：`network` 申请被系统 ICP 核验自动驳回：`bomb-plane.onrender.com` 无 ICP 备案。
  备案绑定中国大陆服务器，Render 无法满足；CloudBase 默认域名也未备案，不能替代。
  可选路线见 [`submission.md`](submission.md)。
- 2026-10-23：用户决定走**离线版**（“小黑盒改离线版，网页别动”）。子任务
  [`10-23-xiaoheihe-offline`](../10-23-xiaoheihe-offline/) 完成：`LocalServer` + `local-ai.js`、
  同屏双人交接、首页精简、`network` 移除、版本 0.2.0；Browser Mock 全部通过。
  提审材料已按离线版重写；下一步是真机验收后 `remote deploy`。
