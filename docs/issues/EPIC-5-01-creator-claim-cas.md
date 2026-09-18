---
number: 16
epic: E5
title: 达人认领/退回/转交/黑名单的 CAS 一致性收口
labels: [backend, creator, phase-1, concurrency]
blocked-by: [EPIC-1-03]
estimate: 2d
---

## 背景

达人域是全项目完成度最高的模块：`creator.routes.ts` 1799 行 / 38 端点，`tests/creator.spec.ts` 863 行 / 44 用例，其中**认领的并发安全已经做对了**：

```
UPDATE creator SET owner_id=?, pool_status=?, protect_until=?
 WHERE id=? AND is_deleted=0 AND owner_id IS NULL AND pool_status=?   -- 取 .changes 判定
→ 0 行则 409「刚被 X 认领」
```

（`/:id/claim`，且有测试「他人重复认领 409 且不泄露联系方式」）。

**问题在其他三个写口没有同等保护**，而它们恰恰是交接/冲突最容易出事的地方：

| 端点 | 现状 | 风险 |
| --- | --- | --- |
| `POST /:id/release` | 先 `get` 再无条件 `update('creator', id, {owner_id:null,...})` | 与「同时有人建合作单 / 同时被回收作业处理」竞态，可能把刚转成"合作中"的达人退回公海 |
| `POST /:id/blacklist` | 同上（`update()` 无条件） | 拉黑与认领并发 → 黑名单达人带上了 `owner_id` |
| `PUT /:id`（改归属，主管/老板） | `update()` 无条件 | 交接期间被原 BD 并发写 `protect_until` |
| `POST /api/system/transfer-creator` | `tx()` 里 `UPDATE ... WHERE owner_id=?`（**这条是条件更新，正确**） | 但只写 1 条汇总日志，单达人级别无法追溯 |

> 开工前复测：`grep -n "AND owner_id IS NULL" apps/server/src/modules/creator.routes.ts` —— 今天应只有 `claim` 一处命中，本工单做完后 release/blacklist/改归属都要有等价条件。

## 具体任务

1. **统一条件更新工具**：新增局部助手 `casUpdateCreator(id, expect: {owner_id?, pool_status?}, set, user)`，内部 `run(UPDATE ... WHERE id=? AND is_deleted=0 AND <expect 条件>)` 并返回 `.changes`；0 行 → `conflict('状态已变化，请刷新后重试' + 当前归属人姓名)`。**禁止**再在这三个端点里用裸 `update('creator', ...)`。
2. **release**：条件 = `owner_id = 当前记录值 AND pool_status IN (2,3)`；退回前"进行中合作单"检查（已有 `ongoing` 计数）**改为硬拦截**：`ongoing > 0` → `badRequest('该达人有 N 个进行中合作单，请先完结或转交')`，但允许 `?force=1`（主管/老板）并把它写进日志 `after.force=true`。
   - 与 `EPIC-5-03` 对齐：`COLLAB_STATUS` 的"进行中"集合定义必须与 `creatorJobs.OVERDUE_COLLAB_WHERE`、`release` 里的 `status NOT IN (6,8,7)` **同一份常量**（今天至少三处内联字面量 → 抽到 `packages/shared/src/constants.ts` 的 `ONGOING_COLLAB_STATUSES`）。
3. **blacklist**：条件 = 当前 `pool_status`；拉黑时同时把 `owner_id` 保留（现状即保留，便于解除时回私海）并清 `protect_until`（**定稿：拉黑不清 owner，只置 `pool_status=4`；解除回私海并 `protect_until = today + protectDefaultDays`**，与现有测试"解除回私海并续保护期"一致）。
4. **改归属（`PUT /:id`）**：`owner_id` 变化时条件更新 + 校验目标人存在且 `role_key ∈ {bd, bd_manager}`；写日志必须含 `before.owner_id/after.owner_id`（现有测试已断言"改归属必须主管/老板，且 before-after 留痕"，保持）。
5. **一键交接可追溯**：`transfer-creator` 保留 1 条汇总日志（PRD §2.4 硬规则），但 `after` 里必须落 **ids 列表**（现在有 `creators.length/collabs.length`，缺 `ids`）；`creator_outreach` 的 `UPDATE ... WHERE result NOT IN (5,6)` 同步返回受影响行数并入日志。
6. **回收作业一致性**：`recycleExpiredCreators()` 的 SQL 必须与 release 使用同一条件语义（`pool_status=2 AND protect_until < today` 且无进行中合作单）；确认其写 `created_by=0`(`SYSTEM_USER_ID`) 的日志。**这一条依赖 `EPIC-4-04` 才会真正被触发**，本工单只保证"被调用时行为正确 + 单测直调函数"。
7. `personScope` 收口：断言达人域 6 个列表端点（`/`、`/mine`、`/stats`、`/expiring`、`/outreach`、`/collab`、`/sample`）全部按人/按组过滤，**不得出现 `shopScope`**（D1 残留风险的防复现闸门；`creator.routes.ts` 现在没有 `shopScope`，用一条 grep 断言把它钉死）。

## 涉及文件

- 改：`apps/server/src/modules/creator.routes.ts`（`/claim` 保持、`/release`、`/blacklist`、`PUT /:id`、`/search`、`/:id/import-from-search`）、`modules/system.routes.ts`（`transfer-creator` 的 `ids`）、`packages/shared/src/constants.ts`（`ONGOING_COLLAB_STATUSES`）、`jobs/creatorJobs.ts`（复用常量）
- 参考：`services/creator/protect.ts`（199 行，`check*` 函数注释里写明是给调度器调的）、`core/db.ts`（`run/tx/scalar`）、PRD §4.5 状态机 C

## 接口契约

| 场景 | 期望 |
| --- | --- |
| 两人同时认领同一达人 | 一个 200，一个 **409** code 40900，message 含归属人姓名且不含联系方式 |
| 有进行中合作单时 release | 400（`?force=1` + 主管 → 200 并留痕） |
| release/blacklist/改归属 遇状态已变 | 409「状态已变化，请刷新后重试」 |
| `transfer-creator` 成功 | `{creators:n, collabs:m}`（**现有响应结构不变**，TC-10 依赖），日志 `after` 增 `ids` |

## 验收标准

- [ ] 现名 44 个用例**全部保持通过**（改的是内部实现，不许改既有断言语义）。
- [ ] 并发用例：`Promise.all` 两个不同 BD 同时 `claim` 同一达人 → 恰好 1 个 200 + 1 个 409，库里 `owner_id` 等于 200 的那个（TC-07）。
- [ ] 并发用例：A `release`、B `PUT /:id` 改归属同一达人同时发起 → 不得出现 `owner_id` 非空且 `pool_status=1`（公海带归属人）的脏状态。
- [ ] `release` 在达人有 1 个 `status=4(待发布)` 合作单时 → 400；`force=1` 且 `boss` → 200。
- [ ] `grep -n "shopScope" apps/server/src/modules/creator.routes.ts` 命中 0（防 D1 复现）。
- [ ] `grep -c "status NOT IN (6,8" apps/server/src/**/*.ts` 命中 0（内联字面量已换成常量）。
- [ ] `TC-10`：`boss` 对 `chenbd` 执行一键交接 → `{creators:4, collabs:5}`，交接后 `lubd` 私海数 +4、`chenbd` 私海为 0，`sys_op_log` 恰好新增 1 条且 `after.ids.length===4`。

## 测试要求

扩写 `tests/creator.spec.ts`（认领/退回/黑名单三个 describe 内追加）≥ 8 新用例，重点是**并发与状态脏化**断言；SQLite 下用"先读到旧值再由另一请求写入"的手工交错来模拟（不需要真多线程）。
