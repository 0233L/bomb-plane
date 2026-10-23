# 小黑盒上架 · 执行清单（离线版 0.2.0）

> 状态（2026-10-23）：已按用户决定改为离线版（本地人机 + 同屏双人），
> 移除 `network` 权限。代码与 Browser Mock 自动化测试完成，待真机验收与提审。
> 提审材料见 [`submission.md`](submission.md)；离线版实现见子任务
> [`10-23-xiaoheihe-offline`](../10-23-xiaoheihe-offline/)。

## 1. 离线版已完成

- [x] 复制 `ai.js` → `xiaoheihe/src/legacy/local-ai.js`（算法不变，依赖包装为浏览器可用）。
- [x] 新建 `xiaoheihe/src/legacy/local-server.js`：WSClient 同款接口、房间/规则/道具/AI 调度。
- [x] 同屏双人：`activeSeat` / `clientSeat`、`passReady` 服务端校验、全量快照、
      顶部主动换人悬浮条 + 不透明交接页、部署草稿不落盘。
- [x] 首页移除联机入口（创建/加入/最近房间/访客/连接提示），新增「同屏双人」。
- [x] `package.json#heybox` 删除 `network`，版本 `0.2.0`，简介改为单机描述。
- [x] `npm run build` 通过；产物无 `wss://` / `onrender` / `WebSocket`，manifest 仅 `storage`。
- [x] Browser Mock 自动化：人机完整对局 + 再来一局、同屏部署/对战/道具、S/M/L 矩阵、
      昵称/头像/主题/规则/刷新回首页。
- [x] 正式图标 `assets/icon.png`（200×200）和封面 `assets/cover.png`（510×272）。
- [x] `submission.md` 按离线版重写（简介、版本说明、单人审核步骤、隐私无网络传输）。

## 2. 提审前剩余

- [ ] 真机（iPhone）验收：
  - 人机对战一局 + 再来一局；
  - 同屏双人一局（双方部署、顶部悬浮条主动换人、交接页、轮流开火）；
  - 悬浮条不遮挡返回菜单/规则；交接页覆盖刘海/安全区且不透明；
    返回菜单确认框正常。
- [ ] 重新构建并核对 `dist/`（构建后 `git status`、manifest、无网络残留）。
- [ ] 在开放平台后台补齐/核对：名称、简介、图标、封面、隐私说明、测试说明。
- [ ] `npx hb-sdk remote permission list` 确认只有 `storage`。
- [ ] `npx hb-sdk remote deploy --release-note "..."`（内容见 `submission.md` 第 2 节，
      不要加 `--auto-publish`）。
- [ ] `npx hb-sdk remote versions` 记录版本号与审核状态。

## 3. 发布与冒烟

- [ ] 审核通过后：`npx hb-sdk remote release 0.2.0`（不要用 `--auto-publish`）。
- [ ] 在小黑盒 App 内完成：首页 → 人机对战 → 部署 → 开火 → 结束 → 再来一局。
- [ ] 同屏双人：双方部署 → 主动切换 → 开火（落后继续、追平半透明、领先高亮）
      → 交接页；确认看不到对方布局。
- [ ] 检查刘海安全区、规则弹窗、主题切换、返回菜单、刷新回首页。
- [ ] 记录发布版本号、时间、冒烟结果；更新本任务 `result.md`（如需要）。

## 4. 回滚

- 审核中发现问题：`npx hb-sdk remote withdraw <version>`。
- 已上线发现问题：`npx hb-sdk remote take-down`，修复后重新提审。
- 代码回滚只影响 `xiaoheihe/`；`public/`、`server.js`、`ai.js`、`miniprogram/` 未改动。

## 5. 约束

- 不修改 `public/`、`server.js`、`ai.js`、`miniprogram/`。
- 不加入充值、支付、付费解锁等商业化功能。
- 不把账号凭据、Cookie、token 写入仓库或任务文件。
- 不执行 git commit（除非用户明确要求）。

## 6. 历史：联机版（已放弃）

- `network` 申请被系统 ICP 核验自动驳回（`bomb-plane.onrender.com` 无 ICP 备案，
  申请 ID `e4fecd41-51c1-4e56-86d0-704a508bc0c9`）。
- 联机版曾完成 Browser Mock 22/22 冷启动门控与 iPhone 真机联机验收。
- 保留联机需要：ICP 备案域名 + 中国大陆服务器，重新申请 `network`；
  在此之前不要发布任何依赖网络的构建。
