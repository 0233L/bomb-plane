# WebSocket 可行性验证 · 执行清单

## 前置条件

- [x] Node.js >= 22.20.0（当前 v24.19.0）
- [ ] 用户可在浏览器完成小黑盒开放平台登录
- [ ] 用户可配合真机扫码（可选，但强烈建议）

## 步骤

### 1. 创建官方模板工程

```bash
cd d:/coding/project/bombPlane
npx @heybox/hb-sdk@latest create xiaoheihe
cd xiaoheihe
npm install
```

验收：`xiaoheihe/` 下有 `package.json`、`vite.config.js`、`index.html`、`src/main.js`。

### 2. 配置 package.json#heybox

- `miniProgramId` 填 `01a15288-dc63-73a6-90e7-f283d3b25abb`
- `name` 填「炸飞机联调验证」
- `category` 填 `game`
- `permissions.network.enabled` 填 `true`
- `platforms` 先填 `["android", "ios"]`
- 用模板占位图先跑通；提审前再换正式图

验收：`npm run build` 或 `npx hb-sdk build` 通过（CSP 仍会注入，因为权限未获批，这是预期）。

### 3. 写最小验证页

修改 `index.html` 与 `src/main.js`：

- 一个按钮「测试 WebSocket」
- 点击后连接 `wss://bomb-plane.onrender.com/ws`
- 页面显示状态：`connecting` / `open` / `error` / `close`
- 错误信息原样展示，例如 `SecurityError`、`CSP`、`WebSocket connection failed`
- 连接成功后发送一条测试消息（服务器可能返回错误或忽略；只验证连接层）

注意：不要在点击回调里等待 SDK 握手；本测试不依赖 SDK 能力。

验收：本地浏览器直接打开 Vite 页面不能作为结论（没有沙箱 CSP）；必须从 `hb-sdk dev` 调试台进入。

### 4. 启动调试并测试 Browser Mock

```bash
npm run hb-sdk -- login
npm run hb-sdk -- remote bind 01a15288-dc63-73a6-90e7-f283d3b25abb
npm run dev
```

- 从调试台打开 Browser Mock
- 点击「测试 WebSocket」
- 记录结果；如需排查，使用调试台日志或：
  ```bash
  npm run hb-sdk -- dev logs --json --level error
  ```

验收：明确记录 `open` 或具体失败原因。

### 5. 真机测试（需要用户配合）

- 在调试台选择手机实际可达的网卡
- 用小黑盒 App 扫码打开
- 重复点击测试
- 记录 Android/iOS 型号、App 版本、结果

验收：记录成功或失败；若用户无法配合，在 `result.md` 标注「未做真机验证」。

### 6. 提交 network 权限申请

```bash
npm run hb-sdk -- remote permission apply network \
  --reason "联机对战 WebSocket 服务器" \
  --domains "bomb-plane.onrender.com"
```

- 记录申请 ID、状态、审核意见
- 如果提示未绑定/无权限，先解决 `remote bind`
- 申请获批前，本地开发仍可用临时权限

验收：申请已提交，或记录明确阻塞点。

### 7. 写结论

新建 `result.md`，至少包含：

- 环境：OS、Node、hb-sdk 版本、App 版本
- Browser Mock 结果（含错误原文）
- 真机结果（如做）
- network 权限申请状态
- 结论：`GO` / `NO-GO`
- 若 `NO-GO`，建议的替代方案与预估改造量

### 8. 清理与核对

- [ ] `git status` 确认现有游戏代码未被修改
- [ ] `xiaoheihe/` 保留，供后续移植任务使用
- [ ] 没有把账号凭据/token 写入文件

## 回滚

- 本任务只新增 `xiaoheihe/` 和任务文档；如需回滚，删除 `xiaoheihe/` 即可，不影响现有游戏。
- 不执行 git commit，除非用户明确要求。

## 验证命令

```bash
cd xiaoheihe
npm run build
npm run dev
```

## 完成标准

见 `prd.md` 的 Acceptance Criteria；全部勾选后，将本任务标记完成，并在父任务中创建「移植」子任务。
