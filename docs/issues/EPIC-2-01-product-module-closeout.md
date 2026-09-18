---
number: 5
epic: E2
title: 商品 SPU/SKU 后端收口（含 21 个类型错误清零与成本审计）
labels: [backend, product, phase-1]
blocked-by: [EPIC-1-03]
estimate: 2d
---

## 背景

`product.routes.ts` 已写到 854 行（SPU CRUD、SKU CRUD、`/sku/:id/cost-history`、`/listing`、`/unmapped`、`/mapping/preview`、`/mapping/auto`、`/import/spu`、`/import/sku`、`/export/sku`、`/categories`），**但 `npx tsc --noEmit -p apps/server` 在该文件报了 21 个错误**（PRD D5），意味着一期 `npm run build` 现在过不去，是发布阻断项。错误集中在两类：
1. 抄了 `shop.routes.ts:10` 的 `current = (req: object)` 写法后，把 `req` 继续传给 `queryPage(req, ...)` / `parseBody(...)` → `object` 不能赋给 `Request`（20 处）。规范 §4 第 4 条已禁止该写法。
2. `unitCostCny({purchase_cost, first_leg_cost})` 收到 zod `.partial()` 产出的可选字段（`product.routes.ts:337/340`）。

## 具体任务

1. 按开发规范 §4.4 把 `current(req: object)` 改成 `AuthedRequest` 断言（或 `req satisfies Request`），清零本文件 21 个错误；改动**只允许**修类型与随之暴露的真 bug，不许顺手重构路由结构。
2. `PUT /api/products/sku/:id` 的成本改动：
   - 落库前 `unitCostCny` 入参用 `num()` 兜底（`purchase_cost ?? before.purchase_cost`）。
   - 必须 `logIfChanged({keys:['purchase_cost','first_leg_cost']})`，`before/after` 只含这两个键 + `operator`。
   - 响应新增 `impact: {order_lines_90d: number, mapped_shops: number, historical_cost_frozen: true}`，供前端确认框展示（PRD §3.3「历史快照不回溯」）。
   - **禁止**任何 UPDATE 触及 `tk_order_item.cost_snapshot`（评审要点：搜 diff 里是否出现该表）。
3. 删除保护：`DELETE /api/products/spu/:id` 存在活跃 SKU → 400「请先删除或转移其下 N 个 SKU」；`DELETE /api/products/sku/:id` 被 `shop_listing` 或 `tk_order_item` 引用 → 400 并给引用计数（软删可被 `EPIC-1-03` 的回收站恢复）。
4. `GET /api/products/sku` 的筛选补 `cost_missing=1`（`purchase_cost + first_leg_cost = 0`），列补 `unit_cost`（后端算，前端不许自己加）。
5. 无 `can_see_cost`：`SKU_COST_FIELDS` 三列掩码（已有 `maskFields`，需补断言）且 `PUT` 改成本 → 403。

## 涉及文件

- 改：`apps/server/src/modules/product.routes.ts`（854 行，主要工作区）
- 参考：`packages/shared/src/calc.ts:9`（`unitCostCny`）、`core/auth.ts:173`（`maskFields`）、`core/query.ts:84`（`queryPage`）、`docs/prd.md §3.3`

## 接口契约

严格照 PRD §3.3 的 SPU/SKU 两页表格；新增字段：`impact`（改价响应）、`unit_cost`（列表）、`last_cost_changed_by/_at`（列表）。

## 验收标准

- [ ] `npx tsc --noEmit -p apps/server` 中 `product.routes.ts` 的 21 个错误全部消失，且**未新增其他文件的错误**（对比 `EPIC-0-01` 记录的基线数）。
- [ ] PRD §8.3 TC-03：改 `96→120` 后历史行 `cost_snapshot` 逐字节不变、新行用新值、日志含 before/after。
- [ ] `limy` 改成本 → 403；`boss` 改 → 200 且 `impact.order_lines_90d` 与实际查询一致（演示数据可核对）。
- [ ] 删除有 SKU 的 SPU → 400 且消息含数量。
- [ ] `cost_missing=1` 筛选返回的行 `purchase_cost+first_leg_cost===0` 全成立（演示 13 个 SKU 中命中数需与脚本核对）。

## 测试要求

`apps/server/tests/product.spec.ts`：TC-03 全链（建 SKU→建映射→造订单行→改价→断言快照）、删除保护、`cost_missing` 筛选、掩码三列、`PUT` 无权限 403、非法 `sku_code` 重复 409。
