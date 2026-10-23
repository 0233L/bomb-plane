# 小黑盒移植：网页版 → hb-sdk 工程

## Goal

把现有网页版 [public/](../../../public/) 完整移植到 [xiaoheihe/](../../../xiaoheihe/)（hb-sdk Vite 工程），在不修改游戏规则和服务器协议的前提下，让小黑盒用户可以在 App 内完成创建/加入房间、人机对战、观战和断线重连。

前置结论：WebSocket 可行性验证为 **GO**，见 [spike result](../archive/2026-10/10-19-xiaoheihe-ws-spike/result.md)。`network` 权限申请仍在审核中（申请 ID `e4fecd41-51c1-4e56-86d0-704a508bc0c9`），不影响开发与 Browser Mock/真机联调，但会阻塞正式发布。

## Requirements

### 功能范围

- 首页：昵称/emoji 头像、经典模式、道具模式、地图规格、创建房间、加入房间、人机对战、最近房间、规则弹窗、主题切换。
- 联机：WebSocket 连接 `wss://bomb-plane.onrender.com/ws`，复用现有 JSON 协议；创建/加入房间、部署、对战、道具、观战、再来一局、断线重连。
- 人机对战：复用服务器端 AI（[ai.js](../../../ai.js)），前端不重复实现 AI 逻辑。
- 访客统计/最近房间等现有辅助功能保持可用。

### 平台适配

- 使用 Vite 组织 `index.html`、CSS、JS 与静态资源；`base: './'`，构建产物可被小黑盒客户端加载。
- WebSocket 地址固定为 `wss://bomb-plane.onrender.com/ws`，不再用 `location.host` 拼接。
- 存储：优先使用沙箱可用的 `localStorage`；若不可用，封装异步存储适配层（hb-sdk storage），保证主题、昵称、最近房间等读写不报错。
- 分享/邀请：沙箱内不能依赖复制网页链接；改用房间号邀请，条件允许时接入 hb-sdk 分享能力。
- 屏幕适配：沿用现有手机端布局（棋盘占满宽度、固定标题区、底部抽屉规则弹窗），确认小黑盒 WebView 的安全区与横竖屏行为。
- 静态资源全部本地打包，不引用外部 CDN；确认 CSP 允许图片、字体、音频等资源。
- 昵称是展示给对手的 UGC，提交审核前加基础敏感词过滤或改用安全昵称方案。
- 构建产物遵守 100 MiB Web 预算。

### 约束

- 不修改 [public/](../../../public/) 的现有网页版行为；移植代码只放在 [xiaoheihe/](../../../xiaoheihe/)。
- 不修改 [server.js](../../../server.js) 的协议，除非出现已证实的阻塞问题。
- 不上传 `server.js`、`ai.js` 到小程序包。
- 不使用微信小程序 API；不使用未申请的小黑盒能力。
- 不加入充值、支付、提现、付费解锁等商业化功能。
- 保持现有代码风格：简单直观、中文注释。

### 依赖与风险

- `network` 权限获批是线上 WebSocket 的前提；审核期间先用本地临时权限开发。
- Render 免费版冷启动约 23.6 秒；提审前需要 keep-alive 或常驻实例，避免审核首屏/连接超时。
- 真机测试至少需要一台 Android 或 iOS 设备，并用小黑盒 App 扫码。
- 沙箱 `localStorage` 与分享 API 的实际行为需在 Browser Mock + 真机上验证。

## Acceptance Criteria

- [ ] [xiaoheihe/](../../../xiaoheihe/) 可执行 `npm run build`，构建通过且产物大小在限制内。
- [ ] Browser Mock 中完成：创建房间、加入房间、人机对战、观战、断线重连。
- [ ] 至少一台真机（Android 或 iOS 小黑盒 App）完成同样的核心流程。
- [ ] 主题、昵称、最近房间在沙箱内可正常保存/恢复；存储不可用时有降级方案。
- [ ] 邀请流程可用（房间号或平台分享），不依赖复制网页链接。
- [ ] 现有网页版 [public/](../../../public/) 与服务器功能回归通过，游戏代码无行为变化。
- [ ] 昵称输入有基础内容安全处理。
- [ ] 没有把账号凭据、token、Cookie 写入仓库或构建产物。

## Notes

- 本任务是复杂任务，`task.py start` 前需要补 `design.md` 与 `implement.md`。
- 服务器仍部署在 Render（或后续迁移的常驻服务器），小程序只上传前端构建产物。
- 提审、审核材料、正式发布由后续「提审发布」子任务负责，不在本任务范围内。
