# 道具价格方案 A + AI 无所遁形判断改进

## 背景

用户选定道具价格方案 A「价值校准」（2026-08-18）：
- 无所遁形（expose）：4 → **6**（信息价值高：10 格 + 必赚机头，原价严重低估）
- 吞噬者（devour）：6 → **5**（降低赌博税，鼓励使用）
- 其余价格不动：sonar 3 / pro 2 / burst 5 / doom 10

同时修复 AI 的 expose 冲动问题（用户指出「找到机头就一定要用无所遁形吗？可能当前信息已经能推出飞机位置」）：
- 现状：`findExposeHead` 只要「某个 in-board 朝向还有未知格」就返回机头 → 即使只剩 1 个合法朝向（飞机位置已确定）也花金币买已经推得出的信息
- 目标：只有 ≥2 个合法朝向（信息不足）时才值得 expose；只剩 1 个合法朝向 → 不浪费金币

## 需求

1. **价格调整**（3 处同步）：
   - server.js `ITEM_PRICES`：expose 4→6、devour 6→5
   - public/client.js `ITEM_PRICES`（按钮置灰用，与服务器保持一致）
   - AI 决策表金币阈值：expose 的 `coins >= 5` → `coins >= 6`（价格联动）
2. **findExposeHead 改进**（ai.js）：统计该机头的「合法朝向数」（in-board 且无已揭示空格冲突）：
   - 合法朝向 ≥2 且仍有未知格 → 值得 expose，返回 {row, col}
   - 只剩 1 个合法朝向 → 位置已确定，不返回（AI 走普通揭示即可，省 6 金币）
   - 0 个合法朝向 → 不可能（数据一致性兜底，不返回）
3. **测试同步**：
   - props-items-test.js：expose 价格断言 13-4=9 → 13-6=7；devour 断言 8-6=2 → 8-5=3
   - ai 相关测试若依赖价格数值 → 同步更新

## 验收标准

- [ ] server.js + client.js 价格表一致：expose 6、devour 5，其余不变
- [ ] AI 金币阈值：expose 需 coins ≥ 6
- [ ] `node --check` 通过（server.js / ai.js / client.js）
- [ ] 全部回归测试通过（props-items、props-smoke、doom-item、item-render、home-ui、e2e 等）
- [ ] findExposeHead 行为验证：唯一合法朝向的机头不返回、多个合法朝向返回
- [ ] 提交推送（用户已授权自动上线）

## 不做

- 其他道具价格不动
- 吞噬者的赌博概率、金币经济（机头 5 金币）不动——留待实测数据再调
