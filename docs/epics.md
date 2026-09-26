# TikTok 运营管理后台 · Epic 总览

> 共 **12 个 Epic（E0~E11）/ 36 张工单**（`docs/issues/EPIC-<n>-<seq>-<slug>.md`，`number` 1~36 与文件名排序严格一致）。
> 规模：`S` ≤1 人日、`M` 1~2 人日、`L` 2~3 人日。估算单位 = 人日（`estimate` 字段用 `0.5d/1d/2d/3d`）。
> 依赖字段 `blocked-by` 用的是**文件名前缀**（如 `EPIC-3-01`），导入 GitHub 后会自动解析为 Issue 编号（见 `scripts/github-import.md`）。
> 状态口径来自 `docs/prd.md §0.1` 的实测盘点（**2026-09-19 01:00 复测**）：**基座 + 六域后端主体 + 前端骨架已完成约 74%**，因此**多数工单的性质是「收口 + 补测试 + 接线」而不是从零开发**，工单正文里已写清"已存在什么、还差什么"。
> 代码在文档撰写期间仍在并行变动（`order/finance/sync` 三个模块在本次盘点从桩变为已实现），所以**每张工单的第一条验收都是"开工前复测引用的行数/端点/错误数"**。

## Epic 一览

| Epic | 名称 | 期次 | 工单数 | 规模 | 涉及表 | blocked-by | 完成判据（Epic 级 DoD） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **E0** | 基座与环境配置收口 | 一期 | 1 | S | 全部 26（DDL 层） | — | `npm run build/lint` 无环境相关失败；照 `.env.example` 复制即可在裸机跑通 |
| **E1** | 系统支撑、权限与审计 | 一期 | 3 | M | `sys_user/sys_role/sys_user_shop/sys_op_log/sys_dict/sync_log/tk_shop` | E0 | 10 角色矩阵用例通过；导出必须授权 + 留痕；软删可恢复；密文不出接口 |
| **E2** | 商品中心与库存 | 一期（库存三期） | 4 | L | `product_spu/product_sku/shop_listing/warehouse/stock_ledger` | E0,E1 | 成本快照与待映射闭环可解释；自动匹配不猜；库存三页不再是 404 |
| **E3** | 订单中心 | 一期 | 3 | M | `tk_order/tk_order_item/tk_return` | E1 | 列表/详情/售后三页出真实数据；人工不可改金额；退款冲减口径正确 |
| **E4** | 数据同步与告警 | 一期为主（部分二期） | 4 | L | `tk_shop/tk_order*/tk_return/settlement_txn/ad_daily/sync_log/video/live_session` | E1,E2,E3 | `sync_log` 自动有行；重复执行幂等；五类异常都能收到告警 |
| **E5** | 达人中心 | 一期 | 5 | L | `creator/creator_outreach/collaboration/sample_shipment/expense/tk_order_item` | E1,E2,E3 | 两套状态机 + 保护期闭环全部有测试；BD 只看得到自己该看的 |
| **E6** | 内容中心 | 一期 | 3 | M | `video/live_session/tk_order_item/collaboration` | E5 | 视频带货汇总非 0；直播排班冲突与提醒生效 |
| **E7** | 投放与财务 | 二期 | 4 | L | `ad_daily/settlement_txn/expense/exchange_rate` | E3,E4 | 结算口径可逐单对账；汇率缺失不静默 |
| **E8** | 利润引擎与看板报表 | 二期（看板一期） | 3 | L | 跨 20 张业务表 | E7（看板部分仅 E3/E4） | **只剩一套利润引擎**；看板与报表同源；切日按 IANA |
| **E9** | 交付工程（骨架/测试/部署/文档） | 一二三期 | 4 | L | — | 全部 | 10 条端到端用例自动化；恢复演练有记录；交付文档可自助跑通 |
| **E10** | 选品流水线（方案第十一章） | 三期新增 | 1 | L | `selection_flow/selection_log` + 复用 `product_spu/tk_shop/alert_*` | E1,E8,E9 | 三道闸门（状态机/结论带数据/清单未清完不许上架）都在服务端且被测试从 HTTP 打过；六条超时规则进首页动作清单；看板五列档位与"只看超时"同一口径 |
| **E11** | AI 助手（模型服务商 + 对话 + 白名单工具） | 三期新增 | 1 | L | `ai_provider/ai_conversation/ai_message/ai_call_log/ai_action_log` | E9,E10 | 密钥只进不出（加密列 + 字段白名单 + 错误脱敏）；写工具仅限白名单且按发起人权限执行，三处留痕；两家协议离线对拍 |

---

## E0 · 基座与环境配置收口 `[一期]`

**目标**：把"能跑起来"变成一件不需要口口相传的事。当前 `schema.mysql.sql` 已有 26 表（583 行）但**全仓无 `.env.example`**，且 `config.ts:17` 读的是非法环境变量名 `adsApiBase`（PRD D12）。
**涉及表**：全部（DDL 层）。**依赖**：无。**规模**：S。
**完成判据**：新同事 `cp .env.example .env && npm ci && npm run build && npm run db:init && npm run db:seed && npm run dev` 一条链路成功；两份 DDL 表数、列名、索引语义一致（差异只允许是方言本身）。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 1 | `EPIC-0-01-env-example-and-ddl-align` | 1d | 补 `.env.example`、修 `ADS_API_BASE`、两侧 DDL 对齐校验 |

---

## E1 · 系统支撑、权限与审计 `[一期]`

**目标**：`sys_*` 五页与三层权限从"后端可用 + 前端已有页面"变成"契约一致、越权可证明、审计无死角"。已实现：`system.routes.ts` 324 行（含 `/transfer-creator`）、5 个 `views/system/*.vue`、`MainLayout` 红点已修（D7）。缺口：导出只有 1 个端点且 `requireExport` 未被任何路由使用（D13）、软删不可恢复（D14）、`GET /api/shops` 返回密文列（D2）、`/shops/all` 不受数据范围约束。
**涉及表**：`sys_user`、`sys_role`、`sys_user_shop`、`sys_op_log`、`sys_dict`、`sync_log`、`tk_shop`（列白名单）。
**依赖**：E0。**规模**：M（合计 5.5 人日）。
**完成判据**：PRD §2.4 的 8 条权限验收全部有自动化用例；PRD §8.3 TC-01 与"导出用例"通过；BD 离职交接在页面上可完成且只写 1 条汇总日志。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 2 | `EPIC-1-01-system-pages-hardening` | 2d | 系统设置五页联调收口（角色矩阵提示 / 字典 / 同步监控重跑 / 一键交接 / 员工授权店铺） |
| 3 | `EPIC-1-02-import-export-center` | 2d | 导出中心（CSV BOM + XLSX、2 万行上限、授权与留痕、掩码）+ 表格导入兜底统一 |
| 4 | `EPIC-1-03-dataperm-and-restore` | 1.5d | 列白名单去密文、`/shops/all` 范围化、回收站 + restore、登录失败锁定、操作日志覆盖率审计 |

---

## E2 · 商品中心与库存 `[一期；库存三期]`

**目标**：商品档案三页 + 待映射清单从"后端 854 行 + 前端 4 页已建"收口为可验收；三期补齐库存后端与挂载。已实现：`product.routes.ts` 854 行（SPU/SKU/listing/unmapped/mapping preview+auto/import spu+sku/export sku/cost-history）。缺口：21 个类型错误（D5）、自动匹配多命中兜底文案、绑定后回算未结算行（C3）、`/api/stock` 未挂载且无 `stock.routes.ts`（D8）。
**涉及表**：`product_spu`、`product_sku`、`shop_listing`、`warehouse`、`stock_ledger`、`tk_order_item`（回算）。
**依赖**：E0、E1。**规模**：L（合计 6 人日）。
**完成判据**：TC-03（成本快照不回溯）、TC-04（待映射不按 0 成本）通过；`/products/unmapped` 数字与工作台一致；库存三页（三期）返回真实数据。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 5 | `EPIC-2-01-product-module-closeout` | 2d | 商品后端收口：清 21 个类型错误、成本审计回显、删除保护、`cost-history` 与改价确认框 |
| 6 | `EPIC-2-02-unmapped-closure` | 1.5d | 自动匹配规则收口 + 待映射闭环（绑定后回算未结算行、未计成本金额提示） |
| 7 | `EPIC-2-03-product-frontend-integration` | 1.5d | 商品四页联调（筛选项/校验/空态/掩码列一致） |
| 8 | `EPIC-2-04-stock-module` | 3d | 三期库存：`stock.routes.ts` + 挂载 `/api/stock` + 三类自动出入库幂等 |

---

## E3 · 订单中心 `[一期]`

**目标**：把唯一的业务事实源从"只有表和数据"变成"能查能看能解释"。**盘点复测：`order.routes.ts` 已从 2 行桩变为 975 行 / 12 端点**（列表、`/summary`、`/unmatched`、`/export`、售后 5 端点、`/:id`、`/:id/profit`、`/:id/sample`），三条硬口径写在文件头注释里并已在 SQL 中实现。因此 E3 的剩余工作**不是开发，而是证明**：补测试、清 2 个类型错误、前端三页联调。演示数据 260 单 / 523 明细 / 40 售后。
**涉及表**：`tk_order`、`tk_order_item`、`tk_return`、`shop_listing`、`product_sku`、`exchange_rate`。
**依赖**：E1（权限与掩码）、E2（映射与成本）。**规模**：M（合计 6 人日）。
**完成判据**：TC-05（GMV 口径 111 单 / 130595.11 量级）、TC-03、TC-04 在订单侧闭环；`cost_matched=0` 行在列表与详情都有红字；人工无法改金额与状态。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 9 | `EPIC-3-01-order-list-detail` | 2d | 订单列表/详情**收口**：逐列对照 PRD §3.4 补缺项、清 2 个类型错误、把口径写成测试 |
| 10 | `EPIC-3-02-return-and-deduction` | 2d | 售后收口：`responsibility` 补填闭环、退款冲减口径（仅 COMPLETED、归原下单日）与 `returns/impact` 验证 |
| 11 | `EPIC-3-03-order-frontend-integration` | 2d | 订单三页联调（详情四 Tab、"仅含待映射行"筛选、导出与告警态） |

---

## E4 · 数据同步与告警 `[一期为主]`

**目标**：让方案 6.4"数据不悄悄断"真正成立。**盘点复测**：`jobs/syncJobs.ts` 已长到 **824 行**且 `sync.routes.ts`（330 行 / 5 端点）已把"手动补跑 + 日志 + 健康度 + 表格导入"接上，**但 `scheduler.ts` 仍是 8 行桩**（`registerSyncJobs/registerCreatorJobs` 依旧无人调用，`node-cron` 全仓无 import，D10），且 `tk_shop` 仍无 `access_token_enc` 列导致 real 模式拿不到 token（D3）。E4 剩余 = **凭证补齐 + 自动调度挂载 + 结算/广告/视频三类同步 + 五类告警与去重 + `EPIC-4-04` 顺带修 D15（`/api/system/synclog` 无权限校验）**。
**涉及表**：`tk_shop`、`tk_order`、`tk_order_item`、`tk_return`、`shop_listing`、`settlement_txn`、`ad_daily`、`sync_log`、`video`、`live_session`。
**依赖**：E1、E2、E3。**规模**：L（合计 8 人日）。
**完成判据**：TC-06（幂等）通过；关掉 `ENABLE_SCHEDULER` 后无任何自动任务；五类异常各触发一次告警且 30 分钟内不重复。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 12 | `EPIC-4-01-tiktok-credential-and-real` | 2d | `access_token_enc` 列 + 签名封装 + provider 收口 + 凭证脱敏（C5） |
| 13 | `EPIC-4-02-order-sync-idempotent` | 2d | 订单/商品/售后同步作业接线与幂等（重叠窗口、成本快照、只插不删） |
| 14 | `EPIC-4-03-settlement-ads-affiliate-sync` | 2d | 二期同步：结算流水 / 广告日报 / 联盟订单归因 |
| 15 | `EPIC-4-04-scheduler-alerts` | 2d | 调度器挂载（node-cron）+ 五类告警 + 去重 + 每日对账作业 |

---

## E5 · 达人中心 `[一期]`

**目标**：达人资产闭环从"能写"到"经得起并发与交接"。已实现：`creator.routes.ts` 1799 行 / 38 端点 + `services/creator/{protect,roi}.ts` + 前端 6 页；达人域已改用 `personScope`（D1 修复）。缺口：认领 CAS 未证明、合作单/寄样状态机非法流转未拦全、坑位费生成费用幂等、ROI 分母口径、夜间回收与超期提醒依赖 E4 调度。
**涉及表**：`creator`、`creator_outreach`、`collaboration`、`sample_shipment`、`video`、`expense`、`tk_order_item`。
**依赖**：E1、E2、E3（ROI 需归因数据）。**规模**：L（合计 9 人日）。
**完成判据**：TC-07（并发认领）、TC-08（非法流转）、TC-09（寄样超期闭环）、TC-10（一键交接）通过。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 16 | `EPIC-5-01-creator-claim-cas` | 2d | 认领/退回/转交/黑名单 CAS 与保护期起算，收口 personScope |
| 17 | `EPIC-5-02-outreach-and-protection` | 1.5d | 跟进续期规则、今日待跟进、BD 统计条与手机端 10 秒录入 |
| 18 | `EPIC-5-03-collab-sample-state-machine` | 3d | 合作单 8 态 + 寄样 6 态流转校验、坑位费幂等生成费用、超期作业 |
| 19 | `EPIC-5-04-creator-roi-closeout` | 1.5d | ROI 口径（C9 分母四项）、`roi=null`、按达人/BD/合作单三维度 |
| 20 | `EPIC-5-05-creator-frontend-integration` | 2d | 达人六页联调（公海/私海/跟进/合作单/寄样/ROI + 移动端 2 页） |

---

## E6 · 内容中心 `[一期]`

**目标**：让"内容能不能带货"可量化。**盘点复测**：`content.routes.ts` 已到 **1010 行 / 19 端点**（视频 CRUD、`/videos/recalc`、`/videos/rank`、`/videos/:id/attribution`、直播排班/日历/提醒/开播/结束/复盘/取消、`host-rank`、两个 options 下拉），`creatorJobs.ts` 里的 `refreshVideoAggregates`、`remindUpcomingLives` 已被本模块 import，**该文件类型错误已清零**。缺口只剩两件：**演示库 `video.orders/gmv` 合计仍为 0（汇总作业从未在种子数据上跑过）与排班/复盘权限的测试证明**。
**涉及表**：`video`、`live_session`、`tk_order_item`、`creator`、`collaboration`、`ad_daily`（投流花费）。
**依赖**：E5。**规模**：M（合计 5 人日）。
**完成判据**：视频带货汇总非 0 且可追溯 `last_run`；同账号排班冲突 409；主播只能改自己场次。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 21 | `EPIC-6-01-video-aggregates` | 2d | 视频库收口：演示库 `orders/gmv` 回填（当前合计 0）、`parseVideoId`、合作单绑定、汇总作业接线验证 |
| 22 | `EPIC-6-02-live-schedule-review` | 2d | 直播排班冲突/开播下播/复盘权限/投流花费带入/三个排行 |
| 23 | `EPIC-6-03-content-frontend-integration` | 1d | 内容三页联调（日历视图、复盘手机端、汇总时间标注） |

---

## E7 · 投放与财务 `[二期]`

**目标**：出"真实利润"所需的全部输入。**盘点复测**：`finance.routes.ts` 已从桩变为 **920 行 / 24 端点**（结算 6、售后 1、费用 5、汇率 7、利润报表 4），且已 import 活引擎 `services/profit.ts`；**`ads.routes.ts` 仍是 2 行桩**，而前端 `AdDaily.vue` 已按 `ROI/CTR/CPC/CPM` 口径写完，正打空接口。表与数据已就位（广告 360 行、结算 681 行、费用 7 行、汇率 240 行）。所以 E7 的真实工作量集中在 **① 广告后端从零 ② 财务 16 个类型错误清零 ③ 对账/分摊口径的测试证明 ④ 五页前端联调**。
**涉及表**：`ad_daily`、`settlement_txn`、`expense`、`exchange_rate`、`tk_order`。
**依赖**：E3、E4。**规模**：L（合计 8 人日）。
**完成判据**：TC-10（汇率缺失不静默）通过；逐单对账能定位三类差异；公共费用分摊有可复核的基数展示。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 24 | `EPIC-7-01-ads-daily-backend` | 2d | 广告日报后端 + 三个聚合维度（店/商品/视频）投产比 |
| 25 | `EPIC-7-02-settlement-reconcile` | 2d | 结算/对账**收口 + 清 16 个类型错误中的结算侧**：三档汇总、逐单对账差异可解释到分项 |
| 26 | `EPIC-7-03-expense-rate-backend` | 2d | 费用/汇率**收口**：公共费用分摊基数（B4）、汇率缺失 400 code 40010 不静默（B3）、幂等键 |
| 27 | `EPIC-7-04-ads-finance-frontend-integration` | 2d | 投放 + 财务五页联调（整页 403 与导出） |

---

## E8 · 利润引擎与看板报表 `[二期；看板一期]`

**目标**：一份口径、一处实现、两个消费端（工作台 + 报表）。**盘点复测**：活引擎 `services/profit.ts`(1743) + `services/rates.ts`(254) **已被 `finance.routes.ts:29-30` import**，`services/finance/*`(804+116) 退化为**无人引用且带 6 个类型错误的死副本**；同时 `order.routes.ts` 为规避耦合**自己内联了第三份口径**（`AGGREGATE_SELECT` + `rateExprOf` + `tzExprFromRegion`，D11/D4）。看板 `dashboard.routes.ts` 仍是 2 行桩 → 工作台前端必然拿不到数。E8 = **删死副本 + 订单侧改调引擎 + 补 `content` 维度（D6）+ IANA 切日 + 看板聚合从零到一**。
**涉及表**：跨全部业务表（输出 `DashboardSummary` / `ProfitRow`）。
**依赖**：E7（报表）、E3+E4（看板）。**规模**：L（合计 6.5 人日）。
**完成判据**：`grep -rn "SUM(CASE WHEN" apps/server/src/modules/order.routes.ts` 命中 0（口径已全部下沉到引擎）；`apps/server/src/services/finance/` 目录不存在；`/api/dashboard/summary` 与 `/api/finance/profit/report` 同一期间的 `est_profit_cny` **逐分相等**；TC-05 通过。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 28 | `EPIC-8-01-profit-engine-consolidation` | 3d | 利润引擎二选一 + IANA 切日 + 公共费用分摊 + 13 个类型错误清零（D4/D5/D6/D11） |
| 29 | `EPIC-8-02-dashboard-summary-api` | 1.5d | `/api/dashboard/summary`：指标卡 + 5 图 + 6 待办计数（含缓存 60s） |
| 30 | `EPIC-8-03-dashboard-profit-frontend` | 2d | 工作台与利润报表前端联调（待办跳转带筛选、预估标注、合计行） |

---

## E9 · 交付工程 `[一二三期]`

**目标**：可发布、可回归、可交给客户自运维。当前 33 个前端页面已建但路由/权限/空态未统一收口；0 个测试文件；无 Docker/备份脚本。
**涉及范围**：`apps/web`（骨架与 12 个待联调页）、CI、部署、演示数据、交付文档。
**依赖**：对应业务 Epic。**规模**：L（合计 9 人日）。
**完成判据**：PRD §8.1 一期 DoD 全绿；GitHub Actions 在 PR 上跑 build+lint+test；恢复演练有留存记录。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 31 | `EPIC-9-01-web-shell-and-routes` | 2d | 前端骨架收口：33 页路由与权限、菜单由 `perms` 生成、空态/掩码规范、移动端 4 页 |
| 32 | `EPIC-9-02-caliber-tests` | 2d | 口径与权限自动化测试基线（三条硬口径 + 状态机 + 幂等 + 汇率 + 分页/恶意输入） |
| 33 | `EPIC-9-03-e2e-ci` | 2d | 10 条端到端用例（TC-01~TC-10）+ GitHub Actions + 10 万行性能基线 |
| 34 | `EPIC-9-04-deploy-backup-delivery` | 3d | Docker/MySQL 切换、阿里云香港部署、OSS 每日备份（保留 30 天）与恢复演练、演示数据与交付文档校准 |

---

## E10 · 选品流水线 `[三期，方案第十一章]`

**目标**：把"候选品从登记到正式销售"从一张谁都不维护的共享 Excel，变成一条有状态、有责任人、有超时预警的流水线。
**涉及表**：`selection_flow/selection_log`（写）、`product_spu/tk_shop/alert_rule/alert_event`（读）。**依赖**：E9（前端骨架与规则中心）。**规模**：L。
**完成判据**：三道闸门（状态机边表 / 结论必须带 7 个指标快照 / 清单没清完不许上架）都在服务端且各有测试；
六条 `SELECTION_*` 规则出现在规则中心并可配阈值，命中的 P0 能在今日行动中心点开并落到「我的待办」；
浏览器走完 登记→测试→结论→落地→清单→上架 与 淘汰→捞回 两条路径。详见 `docs/issues/EPIC-10-01-selection-pipeline.md`。

| number | 工单 | 规模 | 一句话 |
| --- | --- | --- | --- |
| 35 | `EPIC-10-01-selection-pipeline` | 4d | 选品五阶段流水线：两张新表 + 15 端点 + 6 条超时规则 + 五列看板/漏斗/淘汰池 |

---

## 依赖图（文字版）

```
E0 ──┬─→ E1 ──┬─→ E2 ──┐
     │        ├─→ E3 ──┼─→ E4 ──┐
     │        └─→ E5 ──┴─→ E6   │
     │                          ├─→ E7 ──→ E8 ──→ 一期/二期发布
     └──────────────────────────┘
E9（31 与前端并行；32/33 依赖各业务 Epic；34 依赖 E8）
```

**排期建议（与 PRD §9.2 里程碑一致）**：M0 先做 `EPIC-0-01` + 类型错误清零 + `EPIC-4-04`（解除 D10 阻断）→ M1 `E3` → M2 `EPIC-4-01/02/03` → M3 `EPIC-8-02` + `E1` + `EPIC-9-02` → M4 `E7` + `EPIC-8-01/03` → M5 `EPIC-9-01/03/04` → M6 `EPIC-2-04`。

---

## Epic 之外的可选开发方向

`EPIC-0~9` 是 PRD 一期/二期的既定范围。**范围之外**的 12 项可选方向（接口限流、首屏体积、XLSX 与导出中心、
OpenAPI 契约生成、Playwright e2e、SQLite→PG/MySQL 迁移、后台任务队列、权限策略外置、字段级权限与审计范本、
TikTok 官方 SDK 联调、多平台适配层、业务知识检索入口）统一记在 **`docs/dev-options.md`**：
每项都写了当前实际现状（含实测数字与文件位置）、做法、工作量、验收标准与风险，以及和上表 Epic / 现有任务的对应关系。
新增可选项请写进那份清单，不要另开文档。

---

## E11 · AI 助手 `[三期新增]`

让系统里已有的经营数据能被"问"，并且 AI 的结论必须来自现取的数据而不是记忆。
边界由用户明确定下：接一个 chat、服务商与密钥进数据库、没配就报错（不做 mock）、允许 AI 直接写业务数据。
"直接写"与项目原红线相反，所以补偿是硬性的：工具白名单、按发起人的权限与数据范围执行、
`op_log` + `ai_action_log` + 业务表三处留痕，删除/改价/对外发消息不入名单。
详见 `docs/issues/EPIC-11-01-ai-assistant.md`、PRD §3.13、开发规范 §15。

| number | 文件 | 估算 | 内容 |
| --- | --- | --- | --- |
| 36 | `EPIC-11-01-ai-assistant` | 4d | 五张新表 + 两家协议适配 + 白名单工具（3 读 2 写）+ 15 端点 + 对话/配置/审计三页 + 14 单测 3 e2e |
