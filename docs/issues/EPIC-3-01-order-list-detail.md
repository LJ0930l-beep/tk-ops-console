---
number: 9
epic: E3
title: 订单列表与订单详情收口
labels: [backend, order, phase-1]
blocked-by: [EPIC-1-03, EPIC-2-02]
estimate: 2d
---

## 背景

**本工单的性质是「收口 + 证明」，不是从零开发。** 盘点（`prd.md §0.1`，2026-09-19 01:00）复测：`order.routes.ts` 已是 **975 行 / 12 端点**——`GET /`、`/summary`、`/unmatched`、`/export`、`/returns*`(5)、`/:id`、`/:id/profit`、`PUT /:id/sample`，文件头注释已把三条硬口径写清（成本快照、`cost_matched=0` 整体排除、样品单不计 GMV）。

因此本工单只做四件事：**① 逐列比对 PRD §3.4 找缺口 ② 清掉本文件 2 个类型错误 ③ 把口径固化成测试 ④ 确认「人工不可改金额/状态」在代码层面真的没有入口。**

> 开工前先复测：`wc -l apps/server/src/modules/order.routes.ts`、`npx tsc -p apps/server/tsconfig.json --noEmit | grep order.routes`。行数或错误数变了就先更新本工单再动手。

## 具体任务

1. **清 2 个类型错误**（D5 的一部分）：`order.routes.ts:526` 两处 `Property 'k'/'count' does not exist on type '{ responsibility_label: string }'` —— `returns/stats` 里 `group()` 的返回类型被 `.map()` 推窄了。修法：`const responsibility = group('r.responsibility')` 先取数组再单独 map，或给 `group()` 显式 `all<{k: number; count: number; refund_cny: number}>`。**禁止用 `as any` 消错。**
2. **逐列缺口比对（PRD §3.4 列表列 vs `ORDER_SELECT` + `orderView()`）**，缺什么补什么，重点核对这几项是否都在响应里：
   `shop_name`、`order_status_label`、`fulfillment_label`、`item_count`、`unmapped_item_count`、`matched_amount`、`unmapped_amount`、`cost_cny`、`commission_cny`、`refund_cny`、`gmv_cny`、`net_gmv_cny`、`est_profit_cny`、`est_profit_rate`、`rate_to_cny`、`rate_missing`、`counts_for_gmv`、`is_settled`、`is_estimated`、`settled_count`、`warn`、`synced_at`。
   列表**不含** `region`/`carrier`/`tracking_no` 之外的敏感收货信息（当前 `ORDER_SELECT` 用 `o.*`——**改为列白名单**，与 `EPIC-1-03` 的 `SHOP_COLUMNS` 同规范，见验收第 6 条）。
3. **详情 `GET /api/orders/:id`** 已返回 `items/settlements/returns/op_logs` 四组（前端 Tab 用得到），补校：
   - 明细行 `cost_missing_reason` 三值（`listing_unmapped | sku_no_cost | no_listing`）当前只有 `cost_note` 文案 → **增加机器可读字段**，前端按它出不同提示与"去绑定"跳转参数。
   - `items[]` 需要 `content_id` + `video_url`（已 JOIN `video v ON v.tk_video_id = i.content_id`）→ 确认达人视频行可点开。
4. **`/:id/profit` 利润分解**已实现"收入 → 成本快照 → 达人佣金 → 退款冲减 → 广告分摊 → 费用分摊"。核对分摊基数是否为**同店同站点自然日内已匹配金额占比**（PRD §5.4 / B4）；口径与 `services/profit.ts` 不一致的地方记入 `EPIC-8-01`，**本工单不重复实现引擎**。
5. **写入口审计**：确认全模块只有 `PUT /:id/sample` 与 `PUT /returns/:id` 两个写口，且都写了 `writeOpLog`/`logIfChanged`。若存在任何可改 `total_paid / order_status / *_time` 的路由 → 删除并在 PR §说明里记录。
6. **`GET /api/orders/export`** 已用 `requireExport` + `writeOpLog(action='export')`，CSV 内联实现；**本工单不抽公共库**（归 `EPIC-1-02`），只确认无 `can_see_cost` 时导出列里成本是 `***`。

## 涉及文件

- 改：`apps/server/src/modules/order.routes.ts`（975 行；重点 `:29-31` 列白名单、`:526` 类型错误、`:655-731` 详情、`:955` `/:id/sample`）
- 参考：`packages/shared/src/{constants,types,calc}.ts`（`ORDER_STATUS_LABEL`、`estItemProfitCny`、`statDate`）、`core/{query,auth,http,oplog}.ts`、PRD §3.4 / §5.3 / §5.4

## 接口契约（现状即契约，缺口按上文补齐）

| method + path | 权限 | 关键响应 |
| --- | --- | --- |
| `GET /api/orders` | `order` + `shopScope(o.shop_id)` | `{list[], total, page, pageSize, stats, tip}` |
| `GET /api/orders/summary` | order | `{totals, by_shop[], by_day[], note}`，`by_day` 按站点自然日 |
| `GET /api/orders/unmatched` | order | `{list[], totals{item_count,order_count,amount_local,amount_cny}, warn}` |
| `GET /api/orders/export` | order + `requireExport` | `?format=csv` 带 BOM；上限 20000 |
| `GET /api/orders/:id` | order（越权 → `notFound`，见验收 5） | 主信息 + `items[] settlements[] returns[] op_logs[]` + `fx_note` |
| `GET /api/orders/:id/profit` | order | 分层分解 + 各 basis 说明 |
| `PUT /api/orders/:id/sample` | order + 日志 | 唯一人工写订单字段 |

## 验收标准

- [ ] **复测通过**：`npx tsc --noEmit | grep order.routes` 输出 0 行。
- [ ] PRD §8.3 **TC-05**：`boss` 近 30 天 `stats.orders === 111`（非样品非取消口径），`SUM(total_paid)` 量级 130595.11；`/summary.totals.gmv_cny` 与之差仅来自汇率折算，且 `rate_missing=false`。
- [ ] **TC-03**：改 `product_sku.purchase_cost` 后，历史订单行 `cost_snapshot` 与 `GET /api/orders/summary` 数字**完全不变**。
- [ ] **TC-04**：`GET /api/orders?only_unmapped=1` 命中的订单其 `unmapped_item_count ≥ 1`；`/unmatched` 的 `totals.item_count === 6`（与 `EPIC-2-02` 一致），且这 6 行的 `cost_snapshot === null`（响应里被显式置 null，不是 0）。
- [ ] `limy`（仅店 1）：`total` 只含店 1；取店 3 的订单 id → **403 或 404（当前实现是 `notFound`，需在测试里固定为 404 code 40400，禁止 500）**；`est_profit_cny === '***'` 且 `cost_cny === '***'`。
- [ ] 响应体里**不出现** `o.*` 带出的未声明列（列白名单）；`grep -n "select: 'o\.\*'" apps/server/src/modules/order.routes.ts` 无结果。
- [ ] 尝试任何改金额的路由（`PUT /api/orders/:id`）→ 404；`PUT /:id/sample` → 200 且 `sys_op_log` 新增 1 条 `action='update'`、`before_after` 含 `is_sample_order`。
- [ ] 分页上限：`?pageSize=10000` → `pageSize === 200`；`?sortBy=total_paid&sortOrder=evil` 不 500。

## 测试要求

新增 `apps/server/tests/order.spec.ts`（用 `tests/helper.ts` 的 `boot()/ACCOUNTS/pageOf/dataOf`）≥ 14 用例，覆盖上面每条验收 + `cost_missing_reason` 三值 + `returns/stats` 在 `responsibility` 全 0 时不崩 + 恶意 `keyword`（`' OR 1=1--`、`%`、中文）不 500。`npx vitest run tests/order.spec.ts` 全绿。
