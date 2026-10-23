# 小黑盒小程序工坊：平台约束与对本项目的结论

调研日期：2026-10-19。官方文档版本：`@heybox/hb-sdk` 0.9.1。规则可能更新，提审前重新核对。

## 1. 平台模型

- 小黑盒「小程序工坊」运行在小黑盒 App 的受控沙箱中，使用**标准 Web 技术**（Vite 5+，HTML/CSS/JS），通过 `@heybox/hb-sdk` 调用平台能力。
- **不是**微信小程序运行时；现有 `miniprogram/`（微信版）不能直接复用。
- 生产构建不能当普通网页直接运行；必须由小黑盒客户端加载。
- 项目根 `package.json#heybox` 声明版本名称、简介、图标、封面、类别、目标平台、权限、窗口、关联游戏、桌面辅助应用和远端绑定。
- `category` 可选 `tool` / `game` / `other`，新上传版本必填；本项目用 `game`。
- `icon` 200×200；`coverImages` 1–5 张（上架规则建议 510×272）；单张 ≤10 MiB、≤4000 万像素。
- `package.json.version` 必须符合 SemVer，且新版本号高于历史版本；构建产物 Web 预算 100 MiB。

## 2. 网络与 CSP（最关键）

官方 Vite 插件在 `hb-sdk build` / `vite build` 时默认注入生产 CSP，核心指令：

```text
default-src 'none'
connect-src 'none'
script-src 'self' 'unsafe-inline' https://xiaoheihe.cn https://*.xiaoheihe.cn ...
style-src 'self' 'unsafe-inline' ...
img-src 'self' data: blob: ...
frame-src 'none'; worker-src 'none'; object-src 'none'
```

结论：

- **没有 network 权限批准时，页面里的 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` 全部被 CSP 拦截**。
- `hb-sdk remote deploy` 在构建前读取远端批准结果；**仅当有效 `network` 权限启用时才跳过平台 CSP**（`skipPlatformCsp`）。
- 本地 `hb-sdk dev` 对已声明但未批准的 `network` 提供当前会话的临时权限，并允许跳过平台 CSP；这是做 WebSocket 验证的前提。
- 官方文档只明确承诺 `network.request()`、`network.download()`、`network.upload()`；**没有明确写 native WebSocket**。但从“批准后跳过整条 CSP”的实现看，native WebSocket 大概率可用，必须用最小工程在 Browser Mock + 真机验证。
- `network` 权限申请：声明 `package.json#heybox.permissions.network.enabled = true`，并在开放平台「小程序管理 → 权限申请」提交；CLI 也可：
  ```bash
  hb-sdk remote permission apply network --reason "..." --domains "example.com"
  ```
  域名 1–20 个，不含协议、端口、路径、通配符。批准绑定小程序，不绑定版本。
- 网络权限的文档 API 还有超时/大小/重定向/敏感路径等限制；如果改轮询，需要按 `network.request` 的约束设计（默认超时约 10 秒，最大 30000ms）。

## 3. 发布流程（CLI）

```bash
npx @heybox/hb-sdk@latest create <dir>   # 官方模板，Node >= 22.20.0
cd <dir> && npm install
npm run hb-sdk -- login                  # 浏览器登录小黑盒账号
npm run hb-sdk -- remote create          # 新建小程序
# 或
npm run hb-sdk -- remote bind <miniProgramId>
npm run dev                              # Browser Mock + 真机调试
npm run hb-sdk -- remote deploy --release-note "..."   # 构建、上传、提审
npm run hb-sdk -- remote release <version>             # 审核通过后发布
```

- `remote deploy` 会执行项目的 `scripts.build`，因此类型检查/构建脚本会运行。
- 默认审核通过后手动发布；普通低风险版本可加 `--auto-publish`。
- 提审必须从当前项目重新构建并上传，不支持选历史产物。
- `remote permission list` 查看审批状态；`remote versions` 查看版本。

## 4. 上架规则要点

- 主体：个人/企业均可，需实名认证；平台采用主体授权制。
- 必备资料：名称、图标、封面、SemVer 版本号、版本说明、开发者信息、可供审核人员正常访问的预览入口。
- 审核范围包括静态页面、接口内容、外链、动态配置；动态内容与提审版本同规。
- 域名/SDK 披露：平台有权要求主要访问域名、资源域名、接口域名、第三方 SDK 名称与用途；后续会引入域名白名单/黑名单。
- 运行质量：首屏合理时间加载；核心链路可用；界面适配主流移动设备；不能白屏、死循环、频繁报错。
- 测试资源：依赖特定登录/授权/第三方账号/特定数据的流程，必须提供演示账号、白名单、测试说明和预置数据。
- 内容红线：违法违规、外挂作弊、钓鱼恶意代码、色情低俗、侵权、冒用品牌/官方。
- 商业化红线：未经批准不得充值、提现、支付、打赏、会员订阅、付费解锁；不得虚拟货币充值/兑换；不得引导站外交易/私域导流；不得暗示官方背书。
- 数据与隐私：最小必要、知情同意；禁止收集账号密码、支付密码、验证码、身份证、银行卡等；限制收集手机号、邮箱、真实姓名、地址、精确定位、设备唯一标识等。
- 设计规范：图标 200×200；封面 510×272；主体清晰，避免纯色+文字。

## 5. 对本项目的直接影响

1. **必须申请 `network` 权限**，域名填 `bomb-plane.onrender.com`。没有它，生产版无法连接游戏服务器。
2. **WebSocket 地址必须固定为 `wss://bomb-plane.onrender.com/ws`**，不能再用 `location.host`（沙箱里那是小黑盒的地址）。
3. **服务器必须支持 wss**，且审核期间保持在线。Render 免费版实测冷启动 23.6 秒、热启动 0.9 秒；审核规则要求首屏合理时间加载，建议 keep-alive 或常驻实例。
4. **不能用 `public/index.html` 原样上传**：需要改成 Vite 工程；内联主题脚本、`<script src>`、localStorage 依赖都要适配。
5. **邀请链接**：沙箱内复制出的链接别人打不开；应改用房间号或 `share.copyLink` / `share.showShareMenu`。
6. **昵称是 UGC**：会展示给对手，需要基础敏感词过滤或安全昵称方案，否则内容审核有风险。
7. **统计数据**：昵称、emoji 头像、匿名访客 ID 需要在隐私说明中披露；不要收集敏感信息。

## 6. 待验证问题

- native WebSocket 在 Browser Mock 和真机中是否都能 `open`（本任务核心）。
- 沙箱内 `localStorage` 是否可用；不可用时 hb-sdk `storage` 的异步接口如何接入现有同步读写。
- `share.copyLink` / `share.showShareMenu` 在小黑盒内的实际分享形态与房间号参数保留方式。
- Render 域名在国内移动网络下的可达性与稳定性。

## 7. 来源

- 官方文档：https://docs.xiaoheihe.cn/hb_sdk/
- 权限声明：https://docs.xiaoheihe.cn/hb_sdk/guide/permissions
- 上架规则：https://docs.xiaoheihe.cn/hb_sdk/guide/mini-program-publishing-rules
- 项目配置：https://docs.xiaoheihe.cn/hb_sdk/guide/project-configuration
- CLI 与发布：https://docs.xiaoheihe.cn/hb_sdk/guide/cli
- 版本名称与图片：https://docs.xiaoheihe.cn/hb_sdk/guide/version-profile
- 社区介绍：https://www.vgover.com/news/237570
- SDK 0.9.1 包内 `dist/vite.cjs.js` 的 `PRODUCTION_CSP` 与 `skipPlatformCsp` 实现。
