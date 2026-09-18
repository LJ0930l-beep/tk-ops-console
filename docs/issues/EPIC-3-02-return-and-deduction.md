---
number: 10
epic: E3
title: 售后退款口径收口与责任归属闭环
labels: [backend, order, phase-1, caliber]
blocked-by: [EPIC-3-01]
estimate: 2d
---

## 背景

售后侧后端也已实现：`GET /api/orders/returns`、`/returns/stats`、`/returns/impact`、`GET|PUT /api/orders/returns/:id`（含 `unset_responsibility`、`orphan`、`days` 筛选与 `responsibility_label`）。但读代码发现一个**会直接改变报表数字的口径缺陷 D16**：

```
const SUM_REFUND = `(SELECT COALESCE(SUM(r.refund_amount), 0) FROM tk_return r
                     WHERE r.order_id = o.id AND r.is_deleted = 0)`
```

没有 `status='COMPLETED'` 条件 → 演示库 40 条售后里，9 条 `PROCESSING` + 11 条 `SELLER_REJECTED` 也被扣进了 `refund_cny` / `net_gmv_cny`，**违反决策表 B5**（只在 COMPLETED 时冲减，PROCESSING 只在"售后未完结"列表展示）。同时 `/returns/impact` 的 `completed` 计数与 `refund_cny` 不同口径，页面会出现"退款率 > 实际完成退款"的解释不了的现象。

> 开工前复测：`grep -n "const SUM_REFUND" apps/server/src/modules/order.routes.ts`，确认该常量仍然不带状态条件。

## 具体任务

1. **修 D16**：`SUM_REFUND` 加 `AND r.status = 'COMPLETED'`。改名不改（避免与并行分支冲突），但注释必须写明"仅 COMPLETED 冲减（B5）"。
   - 同时新增只读常量 `SUM_REFUND_PENDING`（`status <> 'COMPLETED'`）并在**列表行**输出 `refund_pending`，让客服知道"这单还有 ¥X 在流程中"。
   - 冲减归属日 = **原订单下单日**（`tk_order.order_time`）：现有实现天然满足（子查询挂在订单上，`by_day` 按 `o.order_time` 分组），**必须用测试把它钉住**，禁止以后改成按 `apply_time` 分日。
2. **`/returns/impact` 口径自洽**：`totals.refund_cny` 与 `refund_rate` 改为只算 COMPLETED；新增 `refund_pending_cny` 与 `pending_rate` 分列；`lost_cost_cny` 保持"未回仓行的 `cost_snapshot`"，但需 `cost_matched=1` 才计入（当前 `CASE WHEN r.is_restocked=0 THEN i.cost_snapshot` 会把待映射行按快照 0 计入 → 加 `AND i.cost_matched = 1`）。
3. **责任归属闭环（工作台待办的来源）**：
   - `GET /api/orders/returns?unset_responsibility=1` 已可用；补 `GET /api/orders/returns/unset-count`（或复用 `stats.unset_responsibility`，二选一并在 PRD §7 标注），供 `EPIC-8-02` 工作台红点消费，**必须走 `shopScope`**。
   - `PUT /api/orders/returns/:id` 保持 `z.strict()` 只收 `responsibility/is_restocked`；**补一条硬校验**：`is_restocked=1` 但 `return_type=1`（仅退款）→ `badRequest('仅退款不存在回仓')`。
   - 责任归属为 `1质量/2物流/3描述不符` 且 `is_restocked=0` 时，响应回 `hint`："损失 ¥X（成本快照），建议进利润报表核对"。
4. **孤立售后（`order_id IS NULL`）**：同步来的退款单可能找不到本地订单（订单还没同步到）。当前 `orphan=1` 能筛出来 → 补：列表行 `warn='找不到对应订单，等待订单同步或手动补跑'`，并在 `EPIC-4-04` 的每日对账里把 orphan 数量计入异常。
5. **列白名单**：`RETURN_SELECT` 里的 `r.*`/`i.*` 收敛为显式列（`tk_return` 无敏感列，但按 `EPIC-1-03` 统一规范执行，禁止新增 `SELECT x.*`）。
6. 清掉本文件售后侧遗留的类型错误（`returns/stats` 的 `group()` 返回类型；若 `EPIC-3-01` 已清则跳过并在此注明）。

## 涉及文件

- 改：`apps/server/src/modules/order.routes.ts`（售后段：`SUM_REFUND`、`RETURN_SELECT`、`/returns*` 四端点、`returnUpdateBody`）
- 参考：`packages/shared/src/constants.ts`（`RESPONSIBILITY`、`RETURN_*`）、PRD §3.4 售后段 / §4.5 状态机 D / 决策表 B5

## 接口契约

| method + path | 变更 |
| --- | --- |
| `GET /api/orders` / `/summary` | `refund_cny`、`net_gmv_cny` 数字变小（只含 COMPLETED）；新增 `refund_pending` |
| `GET /api/orders/returns/impact` | `totals.refund_cny` 口径改为 COMPLETED；新增 `refund_pending_cny`、`pending_rate` |
| `PUT /api/orders/returns/:id` | 新增「仅退款不可回仓」400 |
| `GET /api/orders/returns?orphan=1` | 行内新增 `warn` |

## 验收标准

- [ ] **TC-05 关联**：演示库 `GET /api/orders/summary?days=90` 的 `refund_cny` 只等于 20 条 COMPLETED 的折算和；`SELECT COUNT(*) FROM tk_return WHERE status='COMPLETED'` = 20，`unset_responsibility` 与 `stats` 一致。
- [ ] 把某条 `PROCESSING` 售后改为 `COMPLETED` → 该订单 `net_gmv_cny` 立刻下降、`refund_pending` 归零；改回则复原（冲减时点口径唯一）。
- [ ] 冲减归原日：取一笔 8 月下单、9 月完成退款的订单，`/summary.by_day` 中 8 月那一行的 `net_gmv_cny` 已扣减、9 月行不出现负数退款。
- [ ] `PUT /api/orders/returns/:id {return_type 场景}`：仅退款行提交 `is_restocked=1` → 400 code 40000 且文案含"仅退款"。
- [ ] 提交 `{responsibility:1, is_restocked:0}` → 200，`sys_op_log` 1 条且 `before_after` 只含这两个键（`logIfChanged(keys)` 生效）；提交 `{remark:'x'}` → 400（strict）。
- [ ] `limy` 访问 `/api/orders/returns` 只见店 1；`unset_responsibility` 计数与列表 `total` 同范围（不能是全局数）。
- [ ] `grep -n "SELECT r\.\*\|select: \`r\.\*" apps/server/src/modules/order.routes.ts` 无结果。

## 测试要求

`apps/server/tests/returns.spec.ts`（新）≥ 10 用例：B5 三口径（COMPLETED 冲减 / PROCESSING 不冲 / REJECTED 不冲）、归原下单日、`lost_cost_cny` 排除 `cost_matched=0`、仅退款不可回仓、orphan 行、数据范围、日志键集。与 `EPIC-9-02` 的口径基线合并进 CI。
