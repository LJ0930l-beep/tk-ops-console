---
number: 13
epic: E4
title: 订单/商品/售后同步幂等验证与成本快照固化
labels: [backend, sync, phase-1, caliber]
blocked-by: [EPIC-4-01, EPIC-3-01]
estimate: 2d
---

## 背景

同步主体已经写在 `jobs/syncJobs.ts`（盘点 **824 行**，且已被 `sync.routes.ts` 的 `POST /api/sync/run` 打通），包含 `resolveWindow / upsertPlatformOrder / upsertPlatformProduct / upsertPlatformReturn / applyAffiliateAttribution / refreshDerivedAggregates / withSyncLog / runTask / runTaskForAllShops`，也已经有"近 30 天有单但本次拉到 0 条 → 判失败并告警"的逻辑。

**但它从来没有被反复执行验证过**（调度器没挂，`EPIC-4-04` 才挂；手动补跑只在开发时点过一次）。B1 定的幂等协议里至少三条是"纸面承诺"。本工单的任务是**把幂等从代码风格变成有证据的性质**，并补齐同串行/成本快照两处缺口。

> 开工前复测：`grep -n "export function resolveWindow" apps/server/src/modules/../jobs/syncJobs.ts`、`curl -s -X POST localhost:8787/api/sync/run -d '{"task_type":"order"}'` 能返回 `sync_log` 行。

## 具体任务

1. **幂等键核对表**（逐条确认 DDL 与代码一致，缺哪补哪）：

   | 对象 | 幂等键 | 现状 |
   | --- | --- | --- |
   | `tk_order` | `tk_order_id TEXT NOT NULL UNIQUE` | 已建；`upsertPlatformOrder` 需确认走 `INSERT ... ON CONFLICT(tk_order_id) DO UPDATE`（SQLite）而非"先 SELECT 再 INSERT"（后者在并发下会抛 UNIQUE → 500） |
   | `tk_return` | `tk_return_id UNIQUE` | 已建 |
   | `shop_listing` | 部分唯一索引（`ux_listing_shop_sku`） | 已建，确认冲突时按 `map_status` 更新而非跳过 |
   | `tk_order_item` | **无唯一键** | 缺口：同一订单同一行（`order_id`+`listing_id`+`seller_sku`+`quantity`+`unit_price`）重复同步会插重复行 → **加 `ux_order_item(order_id, listing_id, sequence)` 并让同步写入稳定 `sequence`（平台报文行序号）**；MySQL 侧把 `is_deleted` 入键 |
   | `settlement_txn` | `ux_settle_txn(shop_id, statement_id, tk_order_id, txn_type)` | 已建（二期用，见 `EPIC-4-03`） |

2. **窗口与串行（B1）**：`resolveWindow` 已实现"接上次 `window_end` 并回退 `config.syncOverlapMinutes`(默认 5) 分钟"。补两件事：
   - **同店同任务串行**：`withSyncLog` 开始前查 `sync_log` 是否存在同 `(task_type, shop_id)` 且 `finished_at IS NULL` 的行 → 有则直接返回一条 `status=2, error_msg='上一次未结束，跳过'`，不重复跑（SQLite 单写者下这是防 `SQLITE_BUSY` 的关键）。
   - **后到报文不覆盖更优状态**：`upsertPlatformOrder` 的 `DO UPDATE SET ... WHERE` 需带"仅当来源报文不更旧"的条件（用 `synced_at`/平台 `update_time` 比较），并在测试里造一条乱序报文验证。
3. **成本快照只插不改**：确认 `upsertPlatformOrder` 对**已存在**的 `tk_order_item` **不覆盖** `cost_snapshot/cost_matched/sku_id`（历史成本冻结，TC-03 的写入侧保证）；新行才按 `snapshotCost(sku, quantity)` 计算。若当前实现会覆盖 → 改掉并加回归。
4. **待映射不静默**：`resolveItemSku` 返回未匹配时 → `alertUnmapped(shop, count)` 已有；补：`sync_log.detail.unmapped` 计数必须出现，且 `EPIC-2-02` 的 6 行清单能在同步后仍保持 `cost_matched=0`（同步不得"顺手"按 0 成本补上）。
5. **表格导入与接口同步同通道**：`importOrdersForShop` 已复用 upsert；确认导入路径也写 `sync_log`（`task_type='order'`，`created_by` 为操作人，`detail.source='import'`），否则 `EPIC-1-02` 的导入中心无法显示结果。
6. **`refreshDerivedAggregates` 与 `creatorJobs.refreshVideoAggregates` 的去重**：两者都算视频/达人汇总，确认调用顺序（`runTask('all')` 末尾会 `refreshDerivedAggregates`，`registerCreatorJobs` 里 2:55 又跑 `refreshVideoAggregates`）→ 保留两者但在函数注释里写清"谁是权威"，避免两处口径不同（这是 D11 的同型问题）。

## 涉及文件

- 改：`apps/server/src/jobs/syncJobs.ts`、`apps/server/src/db/schema.sqlite.sql` + `schema.mysql.sql`（`ux_order_item`）、`db/migrate.ts`
- 参考：`services/tiktok/types.ts`（`PlatformOrder/PlatformProduct/PlatformReturn`）、`core/db.ts`（`db.insert/update/scalar/tx`）、`config.syncOverlapMinutes`

## 接口契约

- `POST /api/sync/run` 响应沿用 `SyncResult[]`：`{log_id, task_type, shop_id, window_start, window_end, fetched, inserted, updated, failed, status, error_msg, started_at, finished_at, detail}`（契约已存在，本工单只补 `detail.unmapped`、`detail.skipped_running`、`detail.source`）。
- 任务不存在/未知类型 → 400（`runTask` 现在 `throw new Error` → 会变成 500 code 50000；**改为 `badRequest`**）。

## 验收标准

- [ ] **TC-06（幂等，一期阻断）**：mock 模式下 `POST /api/sync/run {task_type:'all'}` 连续执行 3 次 → `tk_order` / `tk_order_item` / `tk_return` / `shop_listing` 行数**逐次完全不变**，`inserted=0`，`updated` 可为正，**且 0 条 UNIQUE 冲突导致的 500**。
- [ ] 同一订单报文顺序打乱重放（先到 `COMPLETED` 后到 `TO_BE_SHIPPED`）→ 终态仍是 `COMPLETED`。
- [ ] 改 `product_sku.purchase_cost` 后再跑一次同步 → 历史订单行 `cost_snapshot` 不变（TC-03 的同步侧）。
- [ ] 人为占用：把一条 `sync_log` 的 `finished_at` 置 NULL 后再触发同任务 → 返回 `status=2` 且 `error_msg` 含"未结束，跳过"，不产生第二行抓取记录。
- [ ] `POST /api/sync/run {task_type:'不存在的任务'}` → 400 code 40000（不是 500）。
- [ ] 同步后 `/api/products/unmapped` 仍为 6 行、`GET /api/orders?only_unmapped=1` 结果不变。
- [ ] `ux_order_item` 迁移在**已有 523 行明细的演示库上**执行成功（先查重复组，若存在历史重复需给出清理脚本而不是让迁移失败）。

## 测试要求

`apps/server/tests/sync-idempotent.spec.ts`（新）≥ 10 用例：三放不重、乱序报文、成本冻结、串行跳过、未知任务 400、导入通道写日志、`detail` 计数、迁移幂等。全部用 `helper.boot()` 起临时库，**禁止**连 `apps/data/tk_ops.db`。
