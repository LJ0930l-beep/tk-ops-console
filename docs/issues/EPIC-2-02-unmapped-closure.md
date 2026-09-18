---
number: 6
epic: E2
title: 店铺商品映射与待映射清单闭环
labels: [backend, product, order, phase-1]
blocked-by: [EPIC-2-01]
estimate: 1.5d
---

## 背景

PRD §1.4 C3 定稿了方案里"待映射清单，并在工作台提醒"之后缺失的闭环：**谁处理、怎么处理、处理后数字怎么变**。
事实：`shop_listing` 27 行里有 2 行 `sku_id` 为空（演示 id 26 店 1 `tk_sku_id=2288900000`、id 27 店 2 `2288900001`，`seller_sku` 也是空）；`tk_order_item` 523 行里 6 行 `sku_id IS NULL AND cost_matched=0`。已有 `/mapping/preview` 与 `/mapping/auto` 两个端点，但规则与"绑定后回算"未闭环，`/unmapped` 也未与工作台计数同源。

## 具体任务

1. **自动匹配规则收口**（`POST /api/products/mapping/auto`）：
   - 命中优先级：① `shop_listing.seller_sku = product_sku.sku_code` 精确；② 同 SPU 下 `sku_code` 前缀唯一命中；③ 其余一律**不写**。
   - 多命中必须留在待映射并给出 `candidates`（预览接口返回 `{listing_id, matched_sku_id|null, candidates:[{sku_id,sku_code,reason}], reason}`）。
   - 只处理入参 `shop_id?` 范围内 `map_status=2` 的行；返回 `{fetched,matched,ambiguous,skipped}`；写 1 条 `sys_op_log(action='update', module:'商品中心', target_table:'shop_listing', after:{auto_matched:n})`。
2. **手工绑定 + 回算**（`PUT /api/products/listing/:id` 与新增 `POST /api/products/mapping/apply`）：
   - 绑定/换绑成功后，对**未参与结算**的历史订单行回算：`sku_id`、`cost_matched=1`、`cost_snapshot = round2(unitCostCny(sku) × quantity)`。
   - "未参与结算"判定：`tk_order_item` 关联订单在 `settlement_txn` 中无 `txn_type=1` 流水。已结算行**只更新 `sku_id/cost_matched` 不改 `cost_snapshot`**，并在响应里回 `recalc:{updated_lines, skipped_settled}`。
   - 解绑（`sku_id=null`）→ 相关行回 `cost_matched=0`、`cost_snapshot=0` 并提示"该操作会让本期成本下降，历史报表数字将变化"。
3. **待映射清单同源**（`GET /api/products/unmapped?tab=A|B`）：
   - Tab A = `shop_listing.map_status=2`；Tab B = `tk_order_item` `sku_id IS NULL OR cost_matched=0`（带 `tk_order_id/shop_name/tk_sku_id/quantity/item_amount/order_time/缺失原因`）。
   - 返回 `summary: {rows, gmv_cny_no_cost}`（未计成本行的 GMV 折算合计），页顶常驻提示用。
   - **工作台 `unmapped_listings` 必须调同一 SQL**（供 `EPIC-8-02` 复用，禁止两处各写一遍）。
4. 「去绑定」按钮：Tab B 每行点击 → 打开该 listing 的绑定框（无 listing 时提示先补平台 SKU 映射）。
5. 唯一索引 `ux_listing_shop_sku(shop_id,tk_sku_id) WHERE is_deleted=0`：同店同 `tk_sku_id` 二次创建 → 409。

## 涉及文件

- 改：`apps/server/src/modules/product.routes.ts`（`/mapping/*`、`/unmapped`、`/listing` 三块）
- 新增：`apps/server/src/services/product/recalc.ts`（回算函数，dashboard 与 mapping 共用）
- 改：`apps/web/src/views/product/{ListingList,UnmappedList}.vue`
- 参考：`db/schema.sqlite.sql`（`ux_listing_shop_sku`）、PRD §3.3、§1.4 C3、§5.3 要点 2

## 接口契约

见上；`GET /api/products/unmapped` 的 `summary.gmv_cny_no_cost` 为人民币、两位小数。

## 验收标准

- [ ] PRD §8.3 TC-04：`unmapped_listings === 6`；把待映射行 `cost_snapshot` 人为改成 99999 后 `est_cost/est_gross_profit` 不变。
- [ ] `seller_sku` 多命中场景：`auto` 返回 `ambiguous≥1` 且库里这些行 `sku_id` 仍为 NULL。
- [ ] 绑定演示 listing id 26 后：其订单行 `cost_matched` 变 1、`cost_snapshot>0`，`/unmapped` Tab B 少对应行数，工作台计数同步下降（同一接口）。
- [ ] 对已结算行绑定时 `skipped_settled≥1` 且其 `cost_snapshot` 不变。
- [ ] 同店同 `tk_sku_id` 重复映射 → 409 `code:40900`。

## 测试要求

`apps/server/tests/mapping.spec.ts`：自动匹配三档命中、多命中不写、回算仅未结算行、解绑后 `cost_matched=0`、`summary.gmv_cny_no_cost` 与手算一致、unmapped 与 dashboard 同源（同一 mock 下两接口数字相等）。
