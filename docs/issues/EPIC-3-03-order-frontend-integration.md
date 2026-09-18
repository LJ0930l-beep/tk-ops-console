---
number: 11
epic: E3
title: 订单三页前端联调收口
labels: [frontend, order, phase-1]
blocked-by: [EPIC-3-01, EPIC-3-02, EPIC-1-02]
estimate: 2d
---

## 背景

`views/order/OrderList.vue`(186 行) / `OrderDetail.vue`(367 行) / `ReturnList.vue`(128 行) 三页已建，列表页走通用 `ResourcePage api="/orders"`，后端已能返回真实数据。剩下的问题是**"页面有没有把后端已经算对的口径显示出来"**——这是最容易被悄悄丢掉的一层：后端给了 `warn`、`counts_for_gmv`、`rate_missing`、`est_profit_cny='***'`，前端不显示就等于没有（用户会以为系统在算 0 成本）。

> 开工前复测三个文件的行数与 `api=` 指向；后端 `GET /api/orders` 必须已能返回非空 `list`。

## 具体任务

1. **OrderList**
   - 列：`tk_order_id`（链接到 `/orders/:id`，已实现 `link` 与行点击事件委托，保留）、`shop_name`、`order_status_label` + `order_status`（英文原文放 tooltip，方案要求"中文为主、原文可见"）、`order_time`、`paid_time`、`total_paid` + `currency`、`gmv_cny`、`item_count`、`fulfillment_label`、`tracking_no`、`is_sample_order`、`est_profit_cny` + `est_profit_rate`、`synced_at`。
   - 行样式：`counts_for_gmv===0` → 灰底 + 文案"样品单·不计 GMV"或"已取消"；`unmapped_item_count>0` → 行 warning + `warn` 文案气泡；`rate_missing` → 金额列黄标"缺汇率"（对应 D17 的过渡显示）。
   - 筛选：`shop_id`（下拉数据源用 `/shops/mine`，不用 `/shops/all`）、`order_status` 多选、`region`、`fulfillment_type`、`is_sample_order`、`only_unmapped` 开关、`order_time` 区间（默认近 30 天）、`keyword`。
   - 汇总条用响应里的 `stats`（**不得前端二次累加当前页**），并常驻显示 `tip` 原文。
   - 导出按钮接 `EPIC-1-02` 的 `ExportButton`：带当前筛选参数、`can_export=false` 时 disabled + 提示"无导出权限"。
2. **OrderDetail**（`/orders/:id`）
   - 四个 Tab：`明细` / `结算流水(settlements)` / `售后(returns)` / `操作日志(op_logs)`；明细行红字用 `cost_missing_reason`（`EPIC-3-01` 新增的机器码）而不是字符串匹配 `cost_note`。
   - 利润分解区接 `GET /api/orders/:id/profit`：按"收入 → 成本 → 佣金 → 退款 → 广告分摊 → 费用分摊 → 预估毛利"逐行显示，**每行右侧显示其 basis 文案**（分摊怎么算的必须可见，B4）。
   - `fx_note` 显示在金额区上方；`is_estimated=1` 时全页顶部灰条"该单未结算，数字为预估"。
   - `PUT /api/orders/:id/sample` 做成带二次确认的开关（说明"该字段影响 GMV 口径，将写入操作日志"）。
3. **ReturnList**
   - 顶部两行 KPI 接 `/returns/impact`（`refund_rate`、`restock_rate`、`unset_responsibility`、`lost_cost_cny`），并显示"仅 COMPLETED 冲减（B5）"。
   - `responsibility` 分布饼图 + `reason_top` 接 `/returns/stats`。
   - 默认筛选 `unset_responsibility=1`（进页面就能看到待办），一键切"全部"。
   - 行内"补填"抽屉：只有 `responsibility`、`is_restocked` 两个可编辑项（与 `z.strict()` 一致），提交后局部刷新该行。
   - `orphan` 行红标 + "等待订单同步"提示。
4. **掩码渲染规范（三页共用，写进 `EPIC-9-01` 的组件层）**：值等于 `MASK('***')` 时渲染为 `***` + 锁图标 tooltip"你没有成本查看权限"，**不得显示 0 或 NaN**。
5. 空态文案统一："最近 N 天没有订单，若确定有单请检查 数据同步 → 同步监控"。

## 涉及文件

- 改：`apps/web/src/views/order/OrderList.vue`、`OrderDetail.vue`、`ReturnList.vue`
- 可能改：`apps/web/src/components/ResourcePage.vue`（若缺 `rowClass`/`summary` 插槽，改动需保持对既有 30+ 页面兼容，走**新增可选 prop**，禁止破坏性改签名）

## 接口契约

全部消费 `EPIC-3-01/02` 已实现端点；**前端不得自行计算 `gmv_cny`、`est_profit_cny`、`refund_rate`**（口径只在后端）。

## 验收标准

- [ ] `boss` 打开订单列表：汇总条 `orders` 与 `stats.orders` 逐字一致；切 `only_unmapped=1` 后 `total` 与 `GET /api/orders/unmatched` 的 `totals.order_count` 一致。
- [ ] `limy` 登录：利润列显示 `***`（不是 0 / NaN / 空），店铺下拉只有店 1，导出按钮状态与 `perms.can_export` 一致。
- [ ] `OrderDetail` 四 Tab 均有数据；明细里 `cost_matched=0` 行红字提示与后端 `cost_missing_reason` 一一对应；利润分解各行相加等于 `est_profit_cny`（±0.01）。
- [ ] `ReturnList` 默认视图待办数 = `unset_responsibility`；补填一条后待办数 −1，且刷新后仍是 −1（非前端假象）。
- [ ] 三页 console 无 `Vue warn`、无 404/500 请求；`npm run build`（`apps/web`）通过。
- [ ] 移动端 375px 宽下订单列表可横向滚动且详情抽屉可用（PRD §6 响应式）。

## 测试要求

前端至少补 2 个组件测试（若本期未接入 Vitest+jsdom，则在 `EPIC-9-03` 前用 Playwright 冒烟覆盖）：掩码渲染、`only_unmapped` 参数透传。后端契约变更须同步改 `EPIC-3-01/02` 的用例。
