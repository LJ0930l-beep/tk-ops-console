---
number: 3
epic: E1
title: 导出中心与表格导入兜底
labels: [backend, frontend, system, phase-1]
blocked-by: [EPIC-1-01]
estimate: 2d
---

## 背景

方案 8.2 硬规则「导出默认关闭、按角色开通、每次导出记录是谁导了什么」目前**完全没落地**：`requireExport`（`core/auth.ts:128`）没有任何路由引用；全仓唯一导出端点是 `GET /api/products/export/sku`（`product.routes.ts:826`）；`sys_op_log` 里 `action='export'` 一条都没有（PRD D13）。
同时方案第七章要求"官方接口覆盖不到的数据，用卖家中心导出的表格一键导入兜底"，现在只有商品两个导入口（`/api/products/import/spu`、`/import/sku`），Q9 的"拿不到授权就全走导入"这条退路只开了一个角。

## 具体任务

1. 后端新增 `apps/server/src/core/export.ts`：
   - `toCsv(rows, columns, {bom:true})`（UTF-8 BOM，Excel 不乱码）、`toXlsx(...)`（不引第三方重量级库时，用 SpreadsheetML/最小 xlsx 写法或复用已有依赖；选型写进 PR，不许临场引 20MB 包）。
   - `EXPORT_ROW_LIMIT = 20_000`：命中 → 400 `code:40020`，消息「本次结果 3.2 万行超过同步导出上限 2 万，请缩小时间范围或改用异步导出（二期）」。
   - `exportGuard(menu, table, query)` 中间件：`requireExport` + 掩码（`can_see_cost=false` 时成本列输出 `***`，与列表一致）+ 写 `sys_op_log(action='export', target_table, before_after={filters, rows, format})` + `ip`。
2. 为四类列表补导出（与列表同一套筛选参数，直接复用各自的 `Q` 构造）：
   `GET /api/orders/export`、`/api/returns/export`、`/api/finance/settlement/export`、`/api/finance/expense/export`、`/api/creators/export`、`/api/products/sku/export`（把现有 `/export/sku` 路径规范化并保留旧路径 301 一版）。
3. 前端 `components/ExportButton.vue`：无 `can_export` 不渲染；点击选 `CSV/XLSX`；成功后 `ElMessage` 提示行数；403/40020 走 `errMsg` 展示。
4. 导入兜底统一 `POST /api/system/import`：`{ table: 'tk_order'|'tk_return'|'shop_listing'|'product_spu'|'product_sku'|'settlement_txn'|'ad_daily', mode:'upsert', rows: [...] }`，服务端按目标表的唯一键复用同步作业的 upsert 通道（PRD B1，禁止先删后插），返回 `{fetched,inserted,updated,failed,errors:[{row,reason}]}` 并写 `sync_log(task_type='import')`。
5. 提供模板下载 `GET /api/system/import/template?table=`（列名 + 一行示例 + 表头注释），路径与校验和 §4 契约一致。

## 涉及文件

- 新增：`apps/server/src/core/export.ts`、`apps/server/src/modules/import.routes.ts`（或挂 `system.routes.ts`）、`apps/web/src/components/ExportButton.vue`
- 改：`apps/server/src/modules/{order,finance,creator,product}.routes.ts`（加导出路由）、`app.ts`（挂 import）、`apps/web/src/views/**`（放 ExportButton）
- 参考：`product.routes.ts:826`（现状唯一导出实现）、`core/auth.ts:128`（`requireExport`）、`jobs/syncJobs.ts`（可复用 upsert）

## 接口契约

| 响应 | 说明 |
| --- | --- |
| `200 text/csv; charset=utf-8` + `Content-Disposition: attachment; filename=orders-20260919.csv` | CSV 带 BOM |
| `200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | XLSX |
| `403 code:40300` `当前角色未开通导出权限` | 且**不写** export 日志 |
| `400 code:40020` | 超 2 万行 |

## 验收标准

- [ ] PRD §8.3「导出用例」：`limy` 导订单 → 403 且 `sys_op_log` 无新增；`finwu` 导订单 → 200 且新增 1 条 `action='export'`，`before_after` 能还原筛选条件。
- [ ] CSV 用 Excel 双击打开中文不乱码（BOM 存在，首字节 `EF BB BF`）。
- [ ] 给 `limy` 导出 SKU 时成本列为 `***`（服务端掩码，不是前端）。
- [ ] 构造 2.1 万行筛选 → 400 `code:40020`，消息含建议动作。
- [ ] 用导入模板灌 100 行订单，重复导入同一文件两次：第二次 `inserted=0`、`updated=100`，`tk_order` 行数不变（走同一幂等通道）。
- [ ] 导入含 1 行脏数据（缺 `tk_order_id`）→ 该行进 `errors`、其余 99 行成功、整体 `status=2 部分失败`。

## 测试要求

`apps/server/tests/export-import.spec.ts`：权限矩阵（`can_export` 0/1）、BOM 断言、行数上限、掩码、导入幂等（两次调用行数不变）、脏行部分失败、`sync_log(task_type='import')` 有行。
