---
number: 14
epic: E4
title: 结算流水/广告日报/联盟归因同步扩展（二期）
labels: [backend, sync, finance, ads, phase-2]
blocked-by: [EPIC-4-02]
estimate: 2d
---

## 背景

`jobs/syncJobs.ts` 的任务类型枚举当前是 `SyncTaskType = 'order' | 'listing' | 'returns' | 'affiliate_order' | 'aggregate'`（`export type` 原文），**结算与广告两类完全没有同步实现**，而表和数据已经躺在库里（`settlement_txn` 681 行、`ad_daily` 360 行），`finance.routes.ts` 已经能读它们做对账（`/settlement/reconcile`）。

方案第七章的定位是"能走接口全走接口，接口覆盖不到用表格导入兜底"。现状恰好相反：**读侧已完备、取数侧只有订单族**。本工单补齐三类取数，并保证与已有导入通道不冲突。

> 前置事实：`sync.routes.ts` 的 `TASK_TYPES` 白名单是 `['order','listing','returns','affiliate','product','affiliate_order','aggregate','all']`，加新任务必须同时改这里与 `runTask` 分支，否则接口返回"未知任务"。

## 具体任务

1. **结算流水 `settlement`**
   - `TikTokShopClient` 增 `getSettlements(shop, window): Promise<PlatformSettlementTxn[]>`（`types.ts` 加接口 + `mockProvider` 造样本 + `realClient` 走 `/settlement/202309/statements/search` 与 `/payments/...`，路径待真实权限确认后以常量集中放置）。
   - 入库：幂等键 `ux_settle_txn(shop_id, statement_id, tk_order_id, txn_type)`；`amount` **收入为正、扣款为负**（符号在 provider 归一化阶段定，注释写清每个 `txn_type` 的符号约定，否则对账永远差一个负号）；`payment_status` 允许从 3失败→2处理中 的回退。
   - **已知风险**：方案 11 章把"结算接口权限"列为未批事项 → 本工单实现的是 **mock + 接口占位 + 表格导入兜底**（`POST /api/finance/settlement/import` 已存在，必须复用它而不是新写一套解析）。
2. **广告日报 `ad`**
   - 数据源是 **TikTok Ads Marketing API**（`config.adsBaseUrl`，注意 D12：该字段现在读的是非法变量名 `process.env.adsApiBase`，由 `EPIC-0-01` 修）；**与店铺 access token 是两套授权**，因此广告同步凭证独立于 `tk_shop`，放 `sys_dict(ads_credential)` 或环境变量，**不入 `tk_shop`**（避免把两套体系混在一张表）。
   - 入库幂等键 `ux_ad_daily(shop_id, campaign_id, stat_date, ad_type)`；`stat_date` **按店铺站点时区的自然日**（B7/D4：用 IANA 从 `tk_shop.timezone` 算，不用 `REGION_TZ_OFFSET`）；`spend/gmv` 保留原币种 + `currency`，人民币折算只在读侧（`EPIC-7-01`）。
   - 归因映射：`campaign_name`/`spu_id`/`video_id` 尽力关联（能匹配上就写外键，匹配不上留 NULL 并在 `detail.unlinked` 计数），**不得**因为关联失败而丢整行。
3. **联盟归因 `affiliate_order`**（已有 `applyAffiliateAttribution` + `pickAttributionTarget`）：补**回归验证而非重写** —— 断言归因只写 `tk_order_item.creator_id/content_type/content_id/commission_rate/est_commission`，**绝不写 `cost_snapshot`**；`est_commission` 的基准是 `item_amount × commission_rate`，率来自平台报文（若为 0 保留 0 并在 `detail.rate_missing` 计数）。
4. **达人视频指标 `video`**：视频播放/互动数据（`video.views/likes/comments/shares`）目前只能人工录；补 `getVideos(shop, window)` 拉自有账号发布数据，**只更新指标列，不改 `tk_video_id/spu_id/collab_id` 绑定**（绑定是人工资产）。
5. 每类任务都要：`withSyncLog` 包裹（自动 `sync_log` 行）、`runTaskForAllShops` 支持、`'all'` 顺序追加在 `returns` 之后 `aggregate` 之前、`TASK_TYPES`/`TASK_LABEL` 更新、`EPIC-4-04` 的 cron 表登记表达式。

## 涉及文件

- 改：`services/tiktok/{types,client,mockProvider,realClient}.ts`、`jobs/syncJobs.ts`、`modules/sync.routes.ts`（任务白名单）、`config.ts`（广告凭证/基址）
- 参考：`db/schema.sqlite.sql` 的 `settlement_txn`/`ad_daily` 与两个唯一索引、`finance.routes.ts` 的 `/settlement/import`、`EPIC-7-01/02`

## 接口契约

| 项 | 定稿 |
| --- | --- |
| `POST /api/sync/run` 新 `task_type` | `settlement` / `ad` / `video`，返回结构不变（`SyncResult[]`） |
| 符号约定 | `txn_type∈{1订单收入,6平台补贴}` 为正；`{2退款,3平台佣金,4达人佣金,5运费,7调整}` 为负；`8其他` 按报文符号 |
| 广告失败 | 未配置广告凭证 → `status=3` + `error_msg='广告接口未配置凭证'`，**不影响订单族同步**（各任务独立 try） |
| 幂等 | 重复执行只 `updated`，不新增行 |

## 验收标准

- [ ] 三类新任务各跑两次：`settlement_txn`、`ad_daily`、`video` 行数不变、`inserted=0`（TC-06 的扩展）。
- [ ] `GET /api/finance/settlement/reconcile?shop_id=1` 在同步后 `差异` 列**全部为 0 或在容差内**（`EPIC-7-02` 提供判定），且 `sync` 与 `import` 两条通道导入同一份数据结果一致。
- [ ] `ad_daily` 的 `stat_date` 对 `America/Los_Angeles` 店在夏令时边界日（3 月第二个周日 / 11 月第一个周日）不出现同一订单跨两日重复计入（构造用例验证）。
- [ ] 联盟归因后 `tk_order_item.cost_snapshot` 与 `cost_matched` **逐行未变**（断言同步前后快照哈希一致）。
- [ ] `GET /api/sync/tasks` 返回新增任务与对应 cron 表达式；未配置广告凭证时 `POST /api/sync/run {task_type:'ad'}` → 结构化失败而非 500。
- [ ] 广告凭证不出现在任何 `GET` 响应与 `sys_op_log`/`sync_log.error_msg` 中（C5）。

## 测试要求

`apps/server/tests/sync-phase2.spec.ts`（新）≥ 10 用例，含符号约定断言（每个 `txn_type` 各一条）、`'all'` 任务顺序与失败隔离、广告凭证缺失路径。所有网络调用走 mock provider 或本地假 server，禁止真实外网请求（CI 需要能离线跑）。
