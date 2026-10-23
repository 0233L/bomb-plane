# 小黑盒网络权限与 WebSocket 可行性验证

## Goal

用小黑盒官方模板建一个最小工程，验证沙箱页面里的 native `WebSocket` 能否连接现有游戏服务器 `wss://bomb-plane.onrender.com/ws`；同时提交 `network` 权限申请，为后续整体移植消除最大技术不确定性。

## Requirements

- 使用官方模板创建独立工程 `xiaoheihe/`，不改动现有 [public/](../../../../../public/)、[server.js](../../../../../server.js)、[ai.js](../../../../../ai.js) 和 [miniprogram/](../../../../../miniprogram/)。
- `package.json#heybox` 至少配置：
  - `miniProgramId`: `01a15288-dc63-73a6-90e7-f283d3b25abb`
  - `permissions.network.enabled: true`
  - `category: "game"`
  - 合法的 `name`、`icon`（200×200）、`coverImages`（510×272）、`platforms`（先写 `["android","ios"]`）
- 页面提供一个按钮，点击后执行：
  - `new WebSocket("wss://bomb-plane.onrender.com/ws")`
  - 展示 `open` / `error` / `close` 状态与错误信息
- 分别在 Browser Mock 和真机（条件允许时）测试，记录：
  - 是否成功 `open`
  - 失败时的具体错误（CSP、权限、Host 限制、网络等）
- 通过 CLI 提交 `network` 权限申请，域名只填 `bomb-plane.onrender.com`，记录申请状态。
- 结论写入本任务目录的 `result.md`，供后续移植任务使用。

## Acceptance Criteria

- [x] `xiaoheihe/` 工程创建成功，依赖安装成功。
- [x] `hb-sdk dev` 能启动 Browser Mock。
- [x] Browser Mock 中点击按钮后，WebSocket 成功 `open`，或记录了明确的失败原因。
- [x] 真机测试本次条件不允许（需要用户用小黑盒 App 扫码），已在 `result.md` 标注「未做真机验证」。
- [x] `network` 权限申请已提交，或记录了无法提交的具体阻塞点。
- [x] 现有游戏代码零改动（`git status` 可核对）。
- [x] `result.md` 给出明确结论：`GO`（native WebSocket 可用）或 `NO-GO`（需改轮询方案）。

## Constraints

- 这是验证任务，不追求 UI 完整，不做游戏移植。
- CLI 登录需要用户本人在浏览器完成小黑盒账号登录；真机扫码也需要用户配合。
- 不提交 git commit；验证产物保留在 `xiaoheihe/` 供后续任务继续使用。
- 不把任何账号凭据、Cookie、token 写入仓库或 `result.md`。

## Notes

- 本地 `hb-sdk dev` 会给已声明但未批准的 `network` 临时权限，并跳过平台 CSP；这是本次验证的关键前提。
- 如果 Browser Mock 成功但真机失败，需要区分是宿主能力限制还是网络问题。
- 如果 native WebSocket 不可用，后续移植任务改用 `network.request` 轮询；本任务只记录结论，不实现轮询。
