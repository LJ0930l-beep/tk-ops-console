---
number: 8
epic: E2
title: 库存模块（三期）：仓库、流水、查询与三类自动出入库
labels: [backend, frontend, stock, phase-3]
blocked-by: [EPIC-3-01, EPIC-5-03]
estimate: 3d
---

## 背景

`warehouse` / `stock_ledger` 两表已在 SQLite 与 MySQL DDL 中建好，演示数据已有 2 仓 / 65 条流水；前端 `views/stock/{WarehouseList,StockLedger,StockQuery}.vue` 三页也已建。但后端**完全没有 `stock.routes.ts` 文件**，`app.ts` 也没有 `/api/stock` 挂载（PRD D8）—— 三个页面现在必然 404。
是否要做这期取决于 Q3（客户有没有 ERP）：若客户有 ERP，本工单降级为「只读库存镜像」并明确禁止双写（PRD §1.2 Q3 影响面 ③）。

## 具体文件

- 新增：`apps/server/src/modules/stock.routes.ts`
- 改：`apps/server/src/app.ts`（`api.use('/stock', stockRouter)`）、`apps/web/src/router/index.ts`（3 条路由 meta 已存在则核对）
- 改：`apps/server/src/services/stock/ledger.ts`（新建；被订单发货、退货入库、寄样发货三处调用）
- 参考：PRD §3.9、`db/schema.sqlite.sql`（`warehouse`/`stock_ledger` 列与 `change_type` 7 值）

## 具体任务

1. 仓库 CRUD：`name` 必填 ≤100 且活跃行唯一；`wh_type` 1 国内/2 海外/3 平台仓；`status` 1/0；删除前若有流水 → 400（含条数）。
2. 流水：
   - `GET /api/stock/ledger`：列 `op_time/warehouse_name/sku_code/change_type/quantity/ref_no/operator_name`；筛选 `warehouse_id/sku_id/change_type/时间区间/ref_no`。
   - **只允许** `POST /api/stock/ledger`（新增）与 `POST /api/stock/ledger/:id/reverse`（生成一条反向冲销流水，`change_type=7 盘点调整`，`ref_no='RV<原id>'`）；**无 PUT/DELETE**。
   - 手工新增仅限 `warehouse` / `boss` 角色（`requireMenu('stock')` + `personScope(user,'l.operator_id')` 不限制本人，仓管可代录，但必须留操作人）。
3. 库存查询：`GET /api/stock/query` = `SUM(quantity) GROUP BY warehouse_id, sku_id`；返回 `available、sku_code、warehouse_name、safety_qty、below_safety`；安全阈值来自 `sys_dict`（新增 `dict_type='safety_stock'`，`dict_value='<sku_id>'`，`dict_label='<数量>'`，PRD B9 的"配置不改代码"）。
4. 三类自动生成（幂等键 `ref_no + change_type + sku_id`，命中已存在则跳过）：
   - 销售出库：订单进入已发货态时（`EPIC-4-02` 同步里调）写 `change_type=4`，`ref_no=tk_order_id`，数量 = 明细 `quantity`，出库仓 = 店铺默认仓（`tk_shop` 需新增 `default_warehouse_id`，或落 `sys_dict` 映射，二选一并在 PR 说明）。
   - 退货入库：`tk_return.is_restocked=1` 且 `status='COMPLETED'` → `change_type=6`，`ref_no=tk_return_id`。
   - 样品出库：`sample_shipment.status 1→2`（`EPIC-5-03`）→ `change_type=5`，`ref_no=collab_no`。
5. 恒等式自检：`GET /api/stock/query/check` 返回 `{sum_ledger, sum_stock, diff}`，`diff!==0` 时 `sendAlert`（PRD §6 可观测）。
6. 前端三页改用 `ResourcePage`；流水页无编辑按钮；库存查询页低于阈值标红。

## 接口契约

| method + path | 说明 |
| --- | --- |
| `GET/POST/PUT/DELETE /api/stock/warehouse` | 仓库 CRUD（DELETE 软删） |
| `GET/POST /api/stock/ledger`、`POST /api/stock/ledger/:id/reverse` | 流水只增不改 |
| `GET /api/stock/query`、`GET /api/stock/query/check` | 汇总与恒等式 |

## 验收标准

- [ ] `/api/stock/*` 全部 200（不再 404），`app.ts` 已挂载。
- [ ] 同一 `tk_return_id` 重复触发退货入库 → 流水仍只 1 条。
- [ ] 冲销后 `SUM(quantity)` 回到冲销前值；历史流水行 `updated_at` 不变（没被 UPDATE）。
- [ ] 恒等式 `diff === 0`；人为塞一条不配对流水后 `check` 返回非 0 且日志有告警。
- [ ] `stock` 菜单未开通的角色（如 `ops`）三页不可见、接口 403。
- [ ] `below_safety=true` 的行在页面上标红。

## 测试要求

`apps/server/tests/stock.spec.ts`：三类自动生成幂等（各跑 2 次）、冲销恒等式、删除仓库保护、安全阈值来自字典（改字典不改代码生效）、越权 403。
MySQL 方言检查：`SUM + GROUP BY` 与 `reverse` 的子查询写法在 `schema.mysql.sql` 下语法可行（规范 §5）。
