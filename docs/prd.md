# TikTok 运营管理后台 · PRD（工程可执行版）

## 0. 文档信息

| 项 | 内容 |
| --- | --- |
| 文档版本 | V2.0（2026-09-19）｜替换 V1.0 草稿，V1.0 中引用的 `docs/plan-review.md`、`docs/PROJECT.md`、`docs/issues/E01.md~E12.md` 与 `Issue #NN` 编号均已废弃，统一改指向本套文档 |
| 上游输入 | 《TikTok 运营管理后台-建设方案与数据表设计》V1.0，32 页，编制 陈新，2026-08-14；纯文本 `docs/source-plan.txt`（1939 行，已全文核对） |
| 权威事实源 | `apps/server/src/db/schema.sqlite.sql`（26 表，536 行）、`packages/shared/src/{constants,types,calc}.ts`、`apps/server/src/core/{auth,db,http,oplog,query}.ts`、`apps/server/src/modules/*.routes.ts`、`apps/data/tk_ops.db`（演示数据） |
| 配套文档 | `docs/development-standards.md`（开发规范）、`docs/epics.md`（Epic 总览）、`docs/issues/EPIC-<n>-<seq>-<slug>.md`（34 张工单，`number` 1~34）、`docs/changes-vs-plan.md`（与方案原文的全部差异）、`scripts/github-import.md`（工单导入 GitHub） |
| 冲突处理 | 方案原文 ↔ 本文档不一致时，**以本文档为准**，并逐条记入 `docs/changes-vs-plan.md`；本文档 ↔ 代码不一致时，以代码为准并在 §1.5 登记缺陷 |

**状态标记约定（全文使用，不得省略）**

| 标记 | 含义 |
| --- | --- |
| `[已实现]` | 代码已在仓库（基座 commit `a7f5725`）且可运行，本文档只做规格化描述 |
| `[本迭代]` | 并行开发中，本期交付；本 PRD 写到的字段与校验即为验收契约 |
| `[待开发]` | 尚未动工，已拆为 Issue 并给出依赖与工时 |
| `[已核实缺陷]` | 读代码/跑数据确认存在的问题，已进 §1.5 并挂 Issue |

### 0.1 工程现状盘点（实测时间 **2026-09-19 01:00**，命令与行数见下表）

> **注意**：本项目为 2 人并行开发，代码在文档撰写期间仍在变动（`order/finance/sync` 三个模块在本次盘点从桩变为已实现）。
> 因此每张工单的第一条验收都是**「开工前用 `wc -l` / `npx tsc --noEmit` 复测本工单引用的行号与错误数是否仍然成立」**，不成立就先更新工单再动手，禁止按过期描述盲改。

| 层 | 模块（实测行数） | 实测状态 | 还差什么 |
| --- | --- | --- | --- |
| 数据 | `schema.sqlite.sql`（26 表）/ `schema.mysql.sql`（26 表，583 行） | `[已实现]` 双方言 DDL 齐 | 两侧均**无 `tk_shop.access_token_enc`**（D3）；无 `.env.example` |
| 数据 | `db/seed.ts`（695 行，确定性 RNG 20260814） | `[已实现]` 12 用户/4 店/13 SKU/260 订单行 523/40 售后/12 达人/12 视频/26 直播/360 广告/681 结算 | 演示数据与 §8 用例数值需随代码变动重算（`EPIC-9-04`） |
| 基座 | `core/{auth,db,http,oplog,query}.ts`、`modules/{auth,system,shop}.routes.ts`（47/324/228 行）、`components/ResourcePage.vue` | `[已实现]` | 导出/导入中心、回收站、列白名单待收口（`EPIC-1-02/03`） |
| 后端 | `product.routes.ts` **856** 行（26 端点：SPU/SKU/listing/unmapped/mapping preview+auto/import/export/cost-history） | `[本迭代]` 主体完成 | **21 个类型错误**（D5）；自动匹配多命中兜底与绑定后回算（`EPIC-2-02`） |
| 后端 | `creator.routes.ts` **1799** 行（38 端点：达人/认领退回黑名单/跟进/合作单状态机/寄样/ROI/BD 绩效） | `[本迭代]` 主体完成 | 认领 CAS、坑位费幂等、超期作业接线（`EPIC-5-*`） |
| 后端 | `content.routes.ts` **1010** 行（19 端点：视频/排行/归因/直播排班/开播下播/复盘/三个排行） | `[本迭代]` 主体完成，**0 个类型错误** | 演示 `video.orders/gmv` 合计为 0（汇总作业从未回填，`EPIC-6-01`） |
| 后端 | `order.routes.ts` **975** 行（12 端点：列表/summary/unmatched/export/returns 全家桶/`:id`/`:id/profit`/`:id/sample`） | `[本迭代]` 主体完成 | 2 个类型错误（D5）；**全部 0 测试覆盖**（`EPIC-3-01/02`） |
| 后端 | `finance.routes.ts` **920** 行（24 端点：结算/对账/导入/费用 CRUD+付款/汇率 CRUD+fetch+fill-missing+health/利润报表 4 端点） | `[本迭代]` 主体完成 | **16 个类型错误**（D5，`EPIC-7-02/03`） |
| 后端 | `sync.routes.ts` **330** 行（5 端点：`/tasks`、`/run`、`/logs`、`/health`、`/import/orders`） | `[本迭代]` 手动补跑与监控入口已通 | 缺结算/广告/达人视频三类同步（`EPIC-4-03`） |
| 后端 | `ads.routes.ts`、`dashboard.routes.ts` | **均为 2 行桩** | 广告日报后端（`EPIC-7-01`）、工作台聚合（`EPIC-8-02`） |
| 后端 | 库存（仓库/流水/查询） | **无 `stock.routes.ts`**，`app.ts` 未挂 `/api/stock`（D8），前端 3 页已建 | 三期整模块（`EPIC-2-04`） |
| 服务 | `services/tiktok/{client,mockProvider,realClient,types}.ts`（real 侧 HMAC-SHA256 签名与脱敏已实现） | `[本迭代]` | 无凭证列 → real 拿不到 access token（D3） |
| 服务 | `jobs/syncJobs.ts` **824** 行、`jobs/creatorJobs.ts` 172 行、`services/aggregate.ts` 245 行 | `[本迭代]` 幂等 upsert + 夜间作业已写 | **`scheduler.ts` 仍是 8 行桩**：`startScheduler()` 只打印"待接入"，`registerSyncJobs/registerCreatorJobs` 无人调用（D10） |
| 服务 | `services/profit.ts` **1743** + `services/rates.ts` **254**（`finance.routes.ts:29-30` 引用）↔ `services/finance/profit.ts` 804 + `finance/rates.ts` 116（**全仓无人 import**） | **两套并存**：活的是根目录版，`finance/` 版是死副本且带 6 个类型错误 | 删除死副本、口径回归一处（D11、`EPIC-8-01`） |
| 前端 | 33 个 `views/*.vue`、`router/index.ts` 33 条业务 path + 登录 + 兜底跳转、`MainLayout` | `[本迭代]` 骨架与页面齐 | 广告/看板/库存 7 页打到桩接口；空态/掩码/权限待统一联调（`EPIC-9-01`） |
| 质量 | `apps/server/tests/`：`creator.spec.ts` **863 行 / 44 用例** + `helper.ts` | `[本迭代]` **只有达人域有测试**，其余 10 个模块 0 覆盖 | `EPIC-9-02`、`EPIC-9-03` |
| 构建 | `npx tsc --noEmit -p apps/server` | **45 个错误**：`product.routes.ts` 21 / `finance.routes.ts` 16 / `services/finance/profit.ts` 6 / `order.routes.ts` 2 | `EPIC-2-01`、`EPIC-7-02`、`EPIC-8-01` |
| 环境 | Node v24.18.0、npm 11.16.0、`gh` 2.97.0 **未登录**、git 分支 `master` 无 remote、3 个 commit | — | 工单导入需 token（`scripts/github-import.md`） |

> 结论：**基座 + 商品/达人/内容/订单/财务/同步六域后端主体 + 前端骨架已完成约 74%**（按 34 张工单口径折算，剩余 27.5 人日）。
> 剩余关键路径只有 5 条：**① 调度器挂载（D10，一期阻断）② 利润引擎与死副本收口（D11）③ 45 个类型错误清零（阻断 `npm run build`）④ ads/dashboard/stock 三个后端模块 ⑤ 测试基线（除达人域外 0 覆盖）**。

阅读约定：表名、字段名、枚举值、路由一律用代码原文（如 `tk_order_item.rebate_cny`、`COLLAB_STATUS.SIGNED`、`POST /api/creators/:id/claim`）。中文展示名放在括号里。

---

## 1. 方案评审结论

### 1.1 总体判断：**方案可采纳，作为一期建设依据；但按原文直接开工会在 4 处踩坑**

| 维度 | 判断 | 依据（可核对） |
| --- | --- | --- |
| 数据模型 | **合理，全盘采纳 26 表** | 业务 20 + 支撑 6，覆盖"店铺—商品—订单—达人—内容—钱"闭环；`tk_order_item` 同时挂 `sku_id/creator_id/content_type/content_id` 是归因关键，方案表 7 已到位 |
| 三条设计要点 | **合理，但必须按品牌服务方口径重述后再写成硬约束 + 测试** | ① 返点/物流快照冻结 ② 未配返点率的行不按 0 收入进利润 ③ 样品单不计 GMV；已落为 `rebate_cny`+`logistics_cny` / `rebate_matched` / `is_sample_order`（`schema.sqlite.sql` 已建列）。原方案的"成本快照"预设了我们付货款，见 §5.4「生意模式」 |
| 菜单与权限 | **合理，但粒度需降级后再实现** | 方案 8.1 只给"菜单级 + 三个开关"，未定义按钮级；`sys_role.menu_perms` 用 `z.enum(MENU_KEYS)` 只能存 10 个一级 key（`shop.routes.ts`/`system.routes.ts`），按钮级权限属超范围 → §1.2-Q8 定稿为"页面级显隐 + 服务端一级菜单校验" |
| 分期 | **偏乐观 15~25%** | 方案 4~5 周 + 3 周 + 1.5~2 周按"1 人全栈"隐含口径；实测一期 27 人日、二期 7、三期 4 = 38 人日，2 人并行 ≈ 4.5 周（含缓冲 6 周），见 §9 |
| 技术架构 | **已偏离且必须偏离** | 方案第九章写 Java/Python + MySQL 8；仓库实际是 TypeScript（Express 5 + `node:sqlite`）。方案自己承认"Java 或 Python"，属可选型；MySQL → SQLite 的差异已全部记入 `docs/changes-vs-plan.md` |
| 接口能力 | **方案自己标注不确定，必须做兜底** | 第七章原文对联盟申样、视频、直播三类数据标注"开发前逐项核实"，且"权限审批时间不计入开发周期" → 一期以 mock + 表格导入交付（§7） |

### 1.2 决策表 A：方案第十一章 12 个待确认问题的逐条落定

> 方案第十一章实际列了 **12 条**（原文 1890~1937 行），任务书说 11 条，以原文为准。
> 每条给出「默认取值 + 为什么这么取 + 影响面」；客户不回复即按此实现；客户答复不同则按「影响面」评估变更代价。

| # | 待确认问题（原文摘要） | 默认取值 | 为什么 | 影响面 |
| --- | --- | --- | --- | --- |
| Q1 | 几个店铺？哪些站点？跨境/本土？ | **≤10 店、多站点混营**，站点集合固定 9 个 `REGIONS = US/UK/ID/MY/TH/VN/PH/SG/MX`，`shop_type` 1 跨境 / 2 本土；演示 4 店（MY/PH/US/SG，含 1 个本土店） | 方案表 1 已含 `region/currency/timezone/shop_type` 四列，9 站点是 TikTok Shop 当期开放站点全集；演示数据即按此分布 | 站点超集 → 改 `packages/shared/src/constants.ts` + `REGION_TZ_OFFSET` + `sys_dict.region` 并回归切日用例（1 人日）；若"一店卖多站点" → 需新增店铺-站点多对多表并重构店铺维度报表（3~5 人日 + 历史回填） |
| Q2 | 团队多少人？哪些岗位？ | **≤50 人、10 个 role_key、一人一角色**，`dept` 单层字符串（管理层/运营一组/达人一组/内容组/直播组/投放组/财务部/仓储部，见 seed） | `sys_user.role_id` 是单值外键；方案 8.1 列 8 行角色，代码 `DEFAULT_ROLES` 拆成 10 个（内容/主播拆开，补仓库） | 一人多角色 → `sys_user_role` 多对多 + `menu_perms` 取并集，权限层与全部测试回归（3~4 人日）；多级部门 → `data_scope=2` 改递归查询，MySQL/SQLite 写法分叉（2 人日） |
| Q3 | 有无 ERP？库存发货在哪管？ | **假设 6 个月内有 ERP → 库存放三期，且默认不启用 `stock` 菜单**；发货信息只读同步自 `tk_order.carrier/tracking_no` | 方案表 20/21 标注"三期（可选）"，且原文明确"有 ERP 就不建库存表，避免两套数据打架" | 无 ERP 且要管库存 → 三期提前到一期并需新增**采购单表**（26 表中无，`stock_ledger.ref_no` 只有 `PO2026000` 文本约定，无父表）（5~8 人日）；要求 ERP 实时同步库存 → 新增对接层 + 冲突仲裁（10+ 人日，属新范围）；任何情况下禁止双写库存 |
| Q4 | 每月订单量？ | **≤3 万单/月**（≈1000 单/天），明细≈订单×2 = 6 万行/月，年 72 万行 | 当前 SQLite 索引 `ix_order_shop_time`/`ix_order_status` + `paginate` 上限 200 在此量级下 P95 可控（<500ms，实测待 `EPIC-9-02` 出数） | >10 万单/月 或多任务并发写 → 必须切 MySQL 8（`EPIC-0-01` 的 `schema.mysql.sql`）+ 同步改队列分批（5~7 人日）；看板实时聚合变慢 → 加日汇总表（26 表之外）+ 预聚合（3 人日） |
| Q5 | 合作多少达人？几个 BD？寄样走平台免费样品还是线下自寄？ | **私海达人 ≤5000、合作单 ≤1000、BD 6 人**；寄样以 `ship_method=2 线下自寄` 为主、平台免费样品（`=1`，需回填 `tk_order_id`）为辅 | `sample_shipment.ship_method` 默认值即 2；演示数据 4 条寄样中 2 条平台单 | 以平台申样为主 → 依赖"联盟样品申请接口"，**方案自己标注"开发前逐项核实"**，拿不到则申样状态全人工、超期催办失去数据基础（最高不确定项）；达人 >10 万 → `handle` 唯一索引 + 游标分页 + 认领/回收改批量（3 人日）；BD 提成要"首触归因/多人分成" → 现表只有单一 `owner_id`，需归因权重表（4~6 人日） |
| Q6 | 几个自营账号/直播间？要排班吗？ | **需排班 → `live_session` 提前到一期交付页面**，数据一期手工录入、二期接同步 | `MENUS.content.phase = 1`（`constants.ts`），表与 seed（26 场，4 排班/22 已结束）已就绪；方案第十章原文允许"直播是主力的团队可把直播场次表提前到一期" | 不做直播 → 移除 2 页省 3~4 人日，但 `content_type=2/4`（达人直播/自营直播）归因永远为空，报表需注明；直播是绝对主力 → 需"直播中实时看板/挂车监控"，26 表无对应结构（≥2 张新表，8+ 人日） |
| Q7 | 利润口径：下单日还是结算日？汇率取哪天？公共费用怎么摊？ | **按下单日（站点时区）归集 + 结算日到账后原地替换为实际口径**；汇率取业务发生当日、缺失回退更早最近一条并标注；公共费用按各店**净 GMV 占比**分摊；未结算行 `is_estimated=1` | 方案 6.2 原文"还没结算的订单用预估值，并单独标注预估"→ 双口径并存，单日只出一份对外数字 | 改纯结算日 → 同一订单跨期归属变化，`ProfitRow` 全维度重算，上线首月与卖家中心"收入"必然不一致，需并行双列（2~3 人日 + 解释成本）；要求月均/结算日汇率 → `exchange_rate` 加 `rate_type` 列并改折算服务（1~2 人日）；改分摊基数（订单数/毛利/手工） → **历史数字整体变化，必须先约定生效日期**（2 人日） |
| Q8 | 报表按北京时间还是站点当地时间切日？ | **按站点时区切日**（`statDate(t, REGION_TZ_OFFSET[region])`），`ad_daily.stat_date` 落库即站点自然日；前端展示按浏览器时区 | 方案表 17 `stat_date` 语义即"当地自然日"；卖家中心也是当地日 | 改北京时间 → 历史 `stat_date` 全量重刷、趋势同比重算，"昨天的数字会变"（1~2 人日 + 沟通成本）；**夏令时已知限制**：`REGION_TZ_OFFSET` 是固定分钟偏移，而 `tk_shop.timezone` 是 IANA 名（演示数据 `America/Los_Angeles` 等），两者不等价，US/MX 夏令时窗口内有 1 小时错位 → 见 §1.5 D4 与 `EPIC-8-01` |
| Q9 | 能否提供店铺主账号授权与开发者资质？ | **一期以 `TIKTOK_API_MODE=mock` + 表格导入交付**，`real` provider 同期就位但不作为验收前置；假设客户二期前完成 Partner Center 应用创建 + 主账号授权 + 联盟权限申请 | 方案第七章"权限审批时间不计入开发周期"，且本机与 CI 环境均无平台凭证 | 长期拿不到授权 → 结算缺失 = **没有真实利润口径**，利润报表长期 `is_estimated=1`，需事前书面对齐；只拿到部分（常见：订单可以、联盟不行）→ 归因需人工回填，验收项 A3 降级为"人工归因可用"；审批延迟不影响代码交付，影响联调窗口 |
| Q10 | 服务器用谁的云账号？已有阿里云吗？ | **客户自有阿里云（香港优先，新加坡备选），2 核 4G 起步**；Node 24 + 构建产物 `dist/`；起步单文件 SQLite，正式切 RDS MySQL 8；备份落 OSS | 方案第九章原文即建议阿里云香港、免 ICP 备案；数据与源码归客户 | 用我方云托管 → 需另签数据归属与运维条款；只有内地机房 → 访问接口不稳定且需备案，与方案原文冲突需客户确认；无 RDS 预算 → 接受 SQLite 单写者限制；OSS AccessKey 与接口凭证同级敏感，只走环境变量、不入仓（`EPIC-9-03`） |
| Q11 | 历史数据要不要导？导多久？ | **只导近 90 天订单/售后 + 全部商品/SKU/返点协议 + 全部达人与合作单 + 全部历史汇率；历史结算流水不导，真实利润自上线日起算** | 90 天足够覆盖趋势与同期对比；历史 `rebate_cny` 无法还原（返点协议改过），导了也是错数字 | 要导 1 年（≈36 万单）→ 导入时长 + `shop_listing` 映射快照失效导致"历史利润不可信"，必须书面声明；要导历史结算 → 平台导出行数约为订单 4 倍，需分批 + 断点续传（2~3 人日）；要求历史利润精确 → 必须"先配好 SKU 返点率再导订单"，导入顺序敏感（`EPIC-1-02` 的导入工具需支持顺序编排） |
| Q12 | 哪些角色要用手机？ | **只适配 4 个高频动作页**：`/creators/outreach`（记跟进）、`/creators/sample`（寄样发货）、`/lives`（复盘）、`/dashboard`（看板），其余 PC 优先，最小适配宽度 1280 | 方案 9.1 原文即"BD 记跟进、主播填复盘等高频小操作做手机适配" | BD 要求达人库/合作单手机全功能 → 表单重排 + 小屏下拉设计（≈5 人日）；主播要看直播中实时数据 → 与 Q4 的 15~30 分钟粒度冲突，**不承诺分钟级**；手机访问扩大凭证暴露面 → 必须 HTTPS + 收紧 `JWT_TTL`（现 8h）+ 登录失败锁定（`EPIC-1-03`） |

### 1.3 决策表 B：方案没写、开工前必须定的 9 项

| # | 空白点 | 定稿 | 影响面 |
| --- | --- | --- | --- |
| B1 | 同步并发与幂等协议 | 幂等键 = 平台单号唯一索引；**窗口重叠 5 分钟**（`config.SYNC_OVERLAP_MIN`）+ "后到报文不覆盖更优状态"（按 `updated_at` 比较）；同店同任务串行（`sync_log` 存在 `status` 未终结即跳过），跨店并行 ≤3 | 无重叠窗口会漏单（平台更新时间滞后）；不串行则 SQLite 下并发 upsert 抛 `SQLITE_BUSY`，MySQL 下会死锁 |
| B2 | 达人保护期天数 | 认领即 `protect_until = today + 30 天`；每条有效跟进续 7 天（`max(现有, today+7)`）；到期前 7 天工作台提醒；到期夜间作业退回公海并清空 `owner_id`，留 `sys_op_log(操作人=system)` | 30 天是 BD 平均成单周期经验值；改天数只改 `config.protectDefaultDays`，但**回收是破坏性动作**，必须先在演示环境跑一轮 |
| B3 | 汇率缺失兜底 | 当日无汇率 → 回退该币种"更早的最近一条"并在报表标注"回退 N 行"；连更早一条都没有 → **该行不参与人民币汇总 + 立即告警，严禁按 1 折算**（`calc.ts` 里 `rate \|\| 1` 仅允许 `currency==='CNY'`） | 按 1 折算会把 USD 单当成 CNY，利润虚高数倍；静默回退会让老板看到"莫名对不上"，两者都必须显性化（`EPIC-7-03`） |
| B4 | 公共费用分摊 | `expense.shop_id IS NULL` 即公共费用 → 当期按各店**净 GMV 占比**摊到店，再按店内订单 `item_amount` 占比摊到 SKU/达人；`expense_type=1 坑位费`不参与二次摊；演示数据已有 2 条公共费用（12800 类型3、9500 类型6，`shop_id NULL`） | 摊法不唯一，必须在报表页展示"分摊基数 = 净 GMV"字样；改摊法 = 历史数字变，需约定生效日 |
| B5 | 退款冲减时点 | 只在 `tk_return.status='COMPLETED'` 时冲减 `net_gmv` 与达人业绩；`PROCESSING` 只在"售后未完结"列表展示、不冲减；冲减归属**原订单下单日**（不回冲今天） | 若按申请时点冲减，会与平台结算流水对不上；归属回原日才能和结算口径一致 |
| B6 | 软删可恢复性 | 所有业务表 `is_deleted=1` 可恢复；新增 `POST /api/system/restore {table, id}`（需 `system` 菜单 + 写日志）；**唯一例外**：`tk_order/tk_order_item` 不提供恢复（状态由同步覆盖）；列表页默认过滤 `is_deleted=0`，回收站 Tab 才可见 | 恢复会撞唯一索引（如 `product_sku.sku_code`），实现必须先查同键活跃行并 409 提示（`EPIC-1-03`） |
| B7 | 多站点切日 | 站点时区切日为唯一对外口径（见 Q8）；**实现要求**：从 `tk_shop.timezone`(IANA) 用 `Intl.DateTimeFormat` 计算当日真实偏移，不再用 `REGION_TZ_OFFSET` 常量表（当前缺陷 D4） | 若沿用固定偏移，美国店每年约 3 个月切日错位 1 小时，月末最后一天的单会掉错日 |
| B8 | 导出格式与行数上限 | 格式 `CSV(UTF-8 BOM)` 与 `XLSX` 两种；同步导出上限 **2 万行**，超出走异步任务 + 站内提示（一期只做到 2 万行同步 + 明确拒绝文案）；导出必过 `requireExport` + 掩码 + `sys_op_log(action='export')` | 无上限会让 523 行订单明细变 50 万行字符拼接，Node 单进程内存与浏览器都会卡；`requireExport` 已存在但无导出路由（`EPIC-1-02`） |
| B9 | 大列表性能与索引 | 每页强制 ≤200；列表接口禁止 `SELECT *`（订单列表除外，见 D2）；新增组合索引 `tk_order(shop_id,is_sample_order,order_status)`、`tk_order_item(order_id)`、`tk_return(shop_id,status)`、`sync_log(shop_id,task_type,started_at)`；`sys_op_log`/`sync_log` 按月归档保留 12 个月在线 | 现在 `tk_order_item` 只有 `ix_item_order`/`ix_item_sku`，逐单详情 OK，但"待映射清单"全表扫 `sku_id IS NULL OR rebate_matched=0` 在 72 万行/年下不可用 |

### 1.4 决策表 C：方案写得模糊处的定稿

| # | 原文模糊处 | 定稿 | 落点 |
| --- | --- | --- | --- |
| C1 | "推送到企业微信 / 飞书群"（6.4、9.1） | 统一走 `config.alertWebhook`（`core/oplog.ts:sendAlert` 已实现）：报文按企业微信 `{msgtype:'text',text:{content}}` 与飞书 `{msg_type:'text',content:{text}}` 双格式由 URL 前缀自动判别；**未配置时降级 `console.warn`，但工作台红点与 `sync_log` 计数仍必须正确** | `EPIC-4-04` |
| C2 | 告警去重与频率 | 同一 `(task_type, shop_id, 错误类别)` 30 分钟内只推 1 次；连续失败每 30 分钟重推；恢复时推 1 条"已恢复" | `EPIC-4-04` |
| C3 | "待映射清单，并在工作台提醒"（6.2）—— 提醒之后谁处理、怎么算闭环 | 待映射有明确处置闭环：工作台卡片 → `/products/unmapped` → 绑定 SKU → **自动回算受影响订单行的 `rebate_matched/sku_id/rebate_cny`（仅未参与结算的行）**，并在页面显示"本清单累计 N 行未配返点率，折合 GMV ¥X 未计利润" | `EPIC-2-02` |
| C4 | "宁可多拉，不能漏单" | 落成 B1 的重叠窗口 + 唯一索引去重；同时**禁止**任何"先删后插"式同步 | `EPIC-4-02` |
| C5 | "接口凭证加密保存，只在服务器端使用，不出现在页面和日志里" | 服务端 `encryptSecret/decryptSecret`（AES-256-GCM）；**响应体列白名单**（禁止 `SELECT s.*`，见 D2）；`error_msg` 入 `sync_log` 前正则脱敏 `app_secret|access_token|shop_cipher` | `EPIC-1-03` / `EPIC-4-01` |
| C6 | "删除只打标记不真删" | 见 B6（可恢复 + 例外表 + 唯一索引冲突处理） | `EPIC-1-03` |
| C7 | "坑位费一键生成待付款费用" | 幂等：同 `expense(ref_type='collaboration', ref_id)` 已存在则不新建，返回已有行；币种取 `collaboration.fee_currency`，`amount_cny` 按当日汇率算并冻结 | `EPIC-5-03` |
| C8 | "超过约定天数没出内容，自动提醒 BD 催" | 约定天数 = 全局配置 `sampleContentDueDays` 默认 7 天，从 `sign_time` 起算；置 `SAMPLE_STATUS.OVERDUE(5)` 并按日提醒（去重同 C2）；不做逐合作单自定义（避免一期复杂度） | `EPIC-5-03` |
| C9 | "系统自动算合作投产比" 的分母口径 | **分子 = 应收返点，不是带货 GMV**；分母严格 = `物流 + 寄样运费 + 坑位费 + 达人佣金`（四项，人民币）；**不含广告费、不含公共费用分摊**（那是利润口径不是达人 ROI 口径）；分母为 0 → `roi = null` 显示"—"，不参与 Top | `EPIC-5-04` |

### 1.5 本迭代已核实代码缺陷（写文档时读出来的，全部已挂 Issue）

| ID | 缺陷 | 证据 | 后果 | 修复 |
| --- | --- | --- | --- | --- |
| D1 | ~~BD 在任何"按店铺过滤"的列表里查不到数据~~ **达人域已修复**：`collabScope()`/`personScope(user,'creator.owner_id')` 已按人过滤（`creator.routes.ts:844-855`） | 实测代码 | 残留风险：`shopScope(user,col)` 在 `DATA_SCOPE.SELF` 下仍返回 `AND col IN (SELECT shop_id FROM tk_shop WHERE owner_id=?)`，若将来给 `content/host/bd` 开通 `order/product` 菜单，同一坑会复现 | 规范 §4.5 明令：`SELF` 角色不得访问店铺维度列表；`EPIC-9-02` 加回归用例 |
| D2 | `GET /api/shops` 用 `SELECT s.*`，会把 `app_key_enc / app_secret_enc` 密文原样返回前端 | `shop.routes.ts:57` `select: 's.*, ou.real_name AS owner_name'` | 密文外泄面扩大（虽非明文，但违反 C5） | 列白名单；`EPIC-1-03` |
| D3 | `tk_shop` **没有 `access_token_enc` 列**（SQLite 与 MySQL DDL 都没有），而 `buildShopCredential()` 会读它 | `schema.sqlite.sql:122` 只有 `app_secret_enc`；`services/tiktok/client.ts:66-79` 注释已承认"schema 未预留列" | 不崩（走了 `row.access_token_enc ? … : ''` 兜底），但 **real 模式拿不到 access token，等于不可用** | 两侧 DDL 加列 + 授权接口写入 + 掩码；`EPIC-4-01` |
| D4 | `REGION_TZ_OFFSET` 固定偏移与 `tk_shop.timezone`(IANA) 不等价 | `packages/shared/src/calc.ts:74-76`；演示店含 `America/Los_Angeles` | US/MX 夏令时窗口内切日错位 1 小时，月末订单掉错日 | 统一从 IANA 计算真实偏移；`EPIC-8-01` |
| D5 | **45 个 TypeScript 错误（阻断 `npm run build`）**：`product.routes.ts` 21（`current(req: object)` 传给需要 `Request` 的 `queryPage/parseBody`）、`finance.routes.ts` 16（`Duplicate identifier 'all'` ×2、`body` possibly undefined ×9、`SqlParam` 传 `undefined` ×2、`ProfitDim` 不含 `'content'` ×1、`expenseBody` 结构不匹配 ×1）、`services/finance/profit.ts` 6（死副本，见 D11）、`order.routes.ts` 2（`group()` 返回类型把 `responsibility/stats` 推窄，取 `.k/.count` 报错） | 实跑 `npx tsc -p apps/server/tsconfig.json --noEmit`，按文件 `uniq -c` 统计 | 一期 DoD 直接阻断 | `EPIC-2-01`(product 21)、`EPIC-7-02/03`(finance 16)、`EPIC-8-01`(删死副本 6 + order 2) |
| D6 | 利润报表的维度联合类型缺 `'content'`：`REPORT_DIMS`/`ProfitDim` 只有 `shop|creator|month|sku`，而 `finance.routes.ts:846` 会把 `content` 维度传进去 → 编译期即报错；死副本 `services/finance/profit.ts:loadDayRows()` 同样向 `newRow()` 传 `content` | `npx tsc` 报 `Type '"content"' is not assignable to type '"shop" \| "creator" \| "month" \| "sku"'`；`grep -n "content" apps/server/src/services/profit.ts` | 「按内容维度看利润」这一档报表要么编译不过要么静默丢列，而方案 4.4 明确要求视频/直播维度投产比 | 活引擎补 `content` 维度并出对照用例；`EPIC-8-01` |
| D7 | ~~`MainLayout.vue` 从数组读 `.status`，`alertCount` 恒 0~~ **已修复**（现用 `Array.isArray(rows) && filter(r => Number(r.status)>=2)`） | `apps/web/src/layouts/MainLayout.vue:128-129` | 无 | 保留回归用例（`EPIC-9-02`） |
| D8 | `app.ts` 未挂载 `/api/stock`（`MENU_KEYS` 已含 `stock`），且**无 `stock.routes.ts` 文件**，但前端已有 3 个库存页面 | `apps/server/src/app.ts:28-38`；`views/stock/` | 库存三页 404 | `EPIC-2-04` |
| D9 | 测试覆盖只有达人域：`tests/creator.spec.ts` 863 行 / 44 用例 / 8 个 `describe`；`order/product/content/finance/sync/system/shop/stock/dashboard` **0 用例**，§8.3 的 TC-01~TC-10 全部没有自动化 | `ls apps/server/tests/` | 三条硬口径（返点快照冻结/未配返点排除/样品排除）与状态机改一行代码就可能悄悄回归 | `EPIC-9-02`（口径与权限基线）、`EPIC-9-03`（TC 自动化） |
| D10 | **调度器未挂载**：`jobs/scheduler.ts` 是 8 行桩（`startScheduler()` 只 `console.log('[jobs] scheduler 待接入')`），`syncJobs.ts`(824 行) 与 `creatorJobs.ts`(172 行) 的 `registerSyncJobs(cron)/registerCreatorJobs(cron)` **无人调用**（`node-cron@^4.2.1` 在 `apps/server/package.json:19` 但全仓无 `import 'cron'`） | `grep -rn "node-cron" apps/server/src` 无结果 | 订单不会自动同步、保护期不回收、寄样不超期提醒、授权到期不告警 —— **方案 6.4"数据不悄悄断"整条落空**，前端工作台数字长期静止（当前只能靠 `POST /api/sync/run` 手动补跑） | `EPIC-4-04`（一期阻断项） |
| D11 | **同一套利润口径存在三处实现**：① 活引擎 `services/profit.ts`(1743 行) + `services/rates.ts`(254 行)，被 `finance.routes.ts:29-30` import；② **死副本** `services/finance/profit.ts`(804 行) + `services/finance/rates.ts`(116 行)，全仓无人 import 且带 6 个类型错误；③ 订单模块自建的第三份口径 `order.routes.ts` 内联 `AGGREGATE_SELECT` + `rateExprOf()` + `tzExprFromRegion()`（源码注释原文："此处独立实现，避免耦合他人正在改的 profit.ts"） | `grep -rn "finance/profit" apps/server/src` 无结果；`order.routes.ts` 顶部注释 | 同一期间「订单列表汇总条」「利润报表」「工作台卡片」可能出三个 GMV/毛利数字，老板第一个问的就是这个；`tzExprFromRegion` 用固定偏移，切日与 IANA 也不一致（叠加 D4） | **保留活引擎（`services/profit.ts` + `services/rates.ts`）→ 删 `services/finance/*` 死副本 → 把 `order.routes.ts` 的聚合改为调引擎**；`EPIC-8-01` |
| D12 | `config.adsBaseUrl` 读的是 `process.env.adsApiBase`（小写驼峰，非法环境变量名），永远不会被命中 | `apps/server/src/config.ts:17` | 广告 real 模式基址无法配置 | 改 `ADS_API_BASE` 并补 `.env.example`；`EPIC-0-01` |
| D13 | 导出授权已部分落地：`requireExport` 现被 3 个端点使用（`/api/orders/export`、`/api/finance/settlement/reconcile/export`、`/api/finance/profit/export`）+ `products/export/sku`（未加 `requireExport`）。**仍缺**：SPU/SKU/待映射清单/达人/合作单/寄样/视频/直播/费用/广告日报的导出，且 CSV 转义逻辑在每个文件里各写一遍 | `grep -n "requireExport" apps/server/src/modules/*.ts` | 方案 8.2「导出必须授权 + 留痕」只覆盖了一半场景；导出实现重复，改一处不影响其余 | 抽 `core/export.ts` 统一（BOM/上限/留痕/掩码）+ 补齐九类导出；`EPIC-1-02` |
| D14 | 软删数据不可恢复：无 `restore` 端点、无回收站页面 | grep `restore` 无结果 | 误删只能改数据库（B6 未落地） | `EPIC-1-03` |
| D15 | **`/api/system/synclog` 与 `/api/system/synclog/health` 无任何权限校验**（同文件的 `userRouter/roleRouter/dataScopeRouter/opLogRouter` 都有 `sysOnly`，只有 `syncLogRouter` 漏了），而功能重复的 `/api/sync/logs`、`/api/sync/health` 已 `requireMenu('system')` | `system.routes.ts:206-238` 无 `.use(`；对照 `:188 opLogRouter.use(sysOnly)` | 剪辑/工厂等最低权限账号可枚举全部店铺名、同步失败原因与窗口，成为跨部门信息泄漏点；同时"同一数据两个入口两套权限" | 给 `syncLogRouter` 加 `requireMenu('system')` 并保留 `/api/sync/logs` 为唯一对外口径（system 侧标记 deprecated）；`EPIC-4-04` |
| D16 | **退款冲减未加状态条件，直接违反 B5**：`SUM_REFUND` 统计的是该单**全部** `tk_return` 的 `refund_amount`，没有 `status='COMPLETED'` 过滤，于是 `PROCESSING`（演示 9 条）与 `SELLER_REJECTED`（演示 11 条）也进了 `net_gmv_cny` / `refund_cny` | `order.routes.ts` 内 `const SUM_REFUND = ` 一整行（按文本定位，行号随并行提交漂移）；演示库状态分布 COMPLETED 20 / PROCESSING 9 / SELLER_REJECTED 11 | 「净 GMV」系统性偏低（演示约 20/40 的量级偏差），且与结算流水的对账永远差一块 | `SUM_REFUND` 加 `AND r.status = 'COMPLETED'`，`returns/impact` 同步；`EPIC-3-02` |
| D17 | **汇率缺失按 1 折算，违反 B3**（三处并存）：订单 `RATE = COALESCE(rateExprOf(...), 1)`；达人 ROI 侧 `AMOUNT_CNY / REFUND_CNY / COMMISSION_CNY` 三个 SQL 常量都是 `COALESCE(er.rate_to_cny, 1)`；汇率服务 `toCnySql()` 同样带兜底 | `order.routes.ts` 内 `const RATE = \`COALESCE(${RATE_RAW}, 1)\`;`；`services/creator/roi.ts` 内 `export const AMOUNT_CNY = ` 一行 | 一笔 USD 1000 的订单在缺汇率时会被当成 ¥1000 计入 GMV/ROI，**利润与达人投产比同时虚高数倍**；`rate_missing` 标记前端不展示就等于静默 | 缺汇率的行**不参与人民币汇总**（`gmv_cny=null` + 计入 `gmv_cny_no_rate_rows`），聚合改为 `SUM(CASE WHEN rate IS NULL THEN 0 ...)` 并 `sendAlert`；`EPIC-7-03`（订单侧随 `EPIC-3-01`、达人侧随 `EPIC-5-04` 一起改） |
| D18 | **MySQL 只有 DDL 文件，运行时 0 支持**：`core/db.ts`/`db/bootstrap.ts` 只 `import { DatabaseSync } from 'node:sqlite'`，`config` 无 `DB_TYPE`/连接串字段，**全仓 `package.json` 无 `mysql2` 依赖**，`grep -rn "mysql" apps/server/src` 命中 0 | `apps/server/src/db/bootstrap.ts:1`；`config.ts:13` 只有 `dbFile` | 方案第九章与客户预期是"MySQL 8"；若在 Q4（>10 万单/月）触发切库，**这不是配置项而是一个 3~5 人日的移植工程**（连接层、`datetime('now')`、`INSERT ... ON CONFLICT`、部分唯一索引、`lastInsertRowid` 语义全部要过一遍） | 本文档统一改口："**一期交付 SQLite，MySQL 为待评估移植项**"；移植前置约束（禁 `UPDATE...FROM`、`is_deleted` 入唯一键等）写进开发规范 §5 并由 `EPIC-9-04` 出可行性 spike 与真实工时 |

---

## 2. 目标用户与角色

### 2.1 8 类角色（方案 2.2）→ 10 个 `role_key`（代码落地）

| 方案角色 | `role_key` | 日常动作（系统内） | 关心指标 |
| --- | --- | --- | --- |
| 老板 | `boss` | 看全局与利润、开权限、审导出 | 净利润、现金回款、店/达人贡献 |
| 运营主管 | `ops_manager` | 团队排期、跨店对比、盯异常 | GMV、退款率、店铺投产比 |
| 运营 | `ops` | 店铺商品维护、订单异常处理、看自己店 | 待发货、待映射、店铺日销 |
| BD 主管 | `bd_manager` | 达人分配、离职交接、审合作单 | 谈妥率、达人 ROI、坑位费产出 |
| BD | `bd` | 公海认领、记跟进、建合作单、贴视频链接 | 私海数、待跟进数、自己带货 GMV |
| 内容（编导/剪辑） | `content` | 登记视频、看视频表现 | 播放、千次观看成交额、被采用条数 |
| 主播/场控 | `host` | 排班确认、填复盘 | 场次、时长、场均 GMV |
| 投放 | `ads` | 维护广告日报、看投产比 | 消耗、ROI、CPM/CPC |
| 财务 | `finance` | 结算对账、费用与汇率、导出 | 实收、平台扣费、未回款 |
| （方案 8.1 缺行，2.2 有岗位） | `warehouse` | 寄样发货、库存录入（三期） | 待发寄样、库存水位 |

### 2.2 权限矩阵（方案 8.1 → `DEFAULT_ROLES` 实测值）

`data_scope`：1 全部 / 2 本组 / 3 仅本人 / 4 指定店铺（读 `sys_user_shop`）。`boss` 在 `requireMenu` 中隐式放行全部菜单。

| role_key | data_scope | can_see_cost | can_see_contact | can_export | menu_perms（一级菜单） | 与方案 8.1 差异 |
| --- | --- | --- | --- | --- | --- | --- |
| `boss` | 1 | ✓ | ✓ | ✓ | 全部 10 个 | 一致 |
| `ops_manager` | 2 | ✓ | — | ✓ | dashboard,shop,product,order,content,ads,finance,system | 一致（不含 creator/stock） |
| `ops` | 4 | — | — | — | dashboard,shop,product,order,content | 一致 |
| `bd_manager` | 2 | — | ✓ | ✓ | dashboard,creator,content | 一致 |
| `bd` | 3 | — | ✓ | — | dashboard,creator,content | 方案"仅自己私海"→ `can_see_contact=1` + `personScope` 双条件；见 D1 |
| `content` | 3 | — | — | — | dashboard,content | 方案"内容/主播"合一行 → 拆 2 个 key |
| `host` | 3 | — | — | — | dashboard,content | 同上 |
| `ads` | 4 | — | — | — | dashboard,ads,order | 额外给 `order` 以核对成交单数 |
| `finance` | 1 | ✓ | — | ✓ | dashboard,finance,order,ads | 一致 |
| `warehouse` | 1 | — | — | — | dashboard,creator,stock | **方案 8.1 未列该角色**，我方补齐 |

### 2.3 三层权限的实现规范（不得自创）

| 层 | 函数（`apps/server/src/core/auth.ts`）| 规则 |
| --- | --- | --- |
| 菜单/按钮 | `requireMenu(menu)` | 路由级中间件；非 `boss` 且 `menu_perms` 不含该 key → 403 `code:40300` |
| 导出 | `requireExport` | 读 `can_export`；未开通 → 403 且**不写** `action='export'` 日志 |
| 数据范围（店） | `shopScope(user, col)` | 1 无约束 / 2 本部门（`dept` 匹配） / 3 仅本人 / 4 `sys_user_shop` 白名单；**仅用于店铺维度表** |
| 数据范围（人） | `personScope(user, col, dept?)` | 达人私海、剪辑绩效、主播场次、跟进记录 |
| 敏感字段 | `maskFields(row, keys, allowed)` | 不允许 → 值改 `'***'`（`MASK`），**服务端掩码，不靠前端隐藏** |

粒度定稿：服务端鉴权粒度 = 一级菜单 key；`MENUS[].children[].key`（如 `product:unmapped`）只用于前端路由与页面/按钮显隐。原因：`roleBody.menu_perms` 用 `z.enum(MENU_KEYS)` 校验，存不进子 key。按钮级权限记为技术债 TD-1（`docs/changes-vs-plan.md`）。

### 2.4 硬规则（方案 8.2）落地

| 原文 | 实现 | Issue |
| --- | --- | --- |
| BD 离职一键交接私海达人 + 合作单 | `POST /api/system/transfer-creator {from_user_id, to_user_id}`：一个事务内改 `creator.owner_id`、`collaboration.owner_id`、`creator_outreach` 保留历史不改，写 1 条汇总日志 | `EPIC-1-01` |
| 删除只打标记，任何人不能改日志 | `softDelete()`；`sys_op_log` 无 PUT/DELETE 路由 | `EPIC-1-03` |
| 改成本价/改归属/改费用/导出全写日志 | `writeOpLog` + `logIfChanged(keys)` | 各写接口 |
| 导出默认关闭、按角色开、留痕 | `requireExport` + `sys_op_log(action='export', target_table, before_after 记筛选条件)` | `EPIC-1-02` |

---

## 3. 功能范围（11 个一级菜单 × 页面级）

### 3.0 全局页面约定

| 项 | 约定 | 依据 |
| --- | --- | --- |
| 分页 | 默认 20，上限 200（超出截断）；响应 `{list,total,page,pageSize}` | `[已实现]` `paginate()` `core/http.ts` |
| 排序 | `sortBy`/`sortOrder`，服务端白名单外回落默认 | `[已实现]` `buildListSql()` |
| 响应体 | 一律 `{code,message,data}`，`code=0` 成功 | `[已实现]` `ok()` |
| 错误 | `AppError(status,message)` → `code = status*100`（400→40000、403→40300、409→40900、401→40100、500→50000）；zod 校验失败 → 400 带 `issues` | `[已实现]` `app.ts` 错误处理（UNIQUE→409 已映射） |
| 软删 | 列表默认 `is_deleted=0`；二次确认文案须写"仅打标记，历史可追溯" | `[已实现]` `softDelete()` |
| 时间 | 存 UTC 文本 `YYYY-MM-DD HH:MM:SS`（字符串序 = 时间序）；展示走浏览器时区；报表按站点时区切日 | `[已实现]` `datetime('now')` |
| 金额 | 两位小数（`round2`）；订单侧带店铺币种，成本/费用侧固定 CNY 并标 `CNY` | `[已实现]` `calc.ts` |
| 敏感字段 | 无权限渲染 `***`（不是隐藏列），列头加锁图标 + tooltip | `[本迭代]` `EPIC-9-01` |
| 店铺下拉 | 全站统一 `/api/shops/mine`（受范围约束），禁止硬编码 | `[已实现]`（`/shops/all` 需修，D2/`EPIC-1-03`） |
| 字典下拉 | `/api/system/dict/:type`，6 类：`category/creator_tag/return_reason/expense_type/region/gmv_level`（演示 25 行） | `[已实现]` |
| 空态 | 每个列表页必须：图标 + 一句话原因 + 一个引导按钮（"去同步"/"去映射"/"新增店铺"） | 规范 |
| 告警态 | 异常行 warning 底色 + 角标；看板待办红点 = 异常计数（`MainLayout` 已按 `synclog/health` 计数，D7 已修） | 规范 |

### 3.1 `dashboard` 工作台 `[待开发]`（前端 `DashboardView.vue` 已建，后端 `dashboard.routes.ts` 为 2 行桩 → 页面当前必然空/报错）

| 子页 | key / path | 内容 |
| --- | --- | --- |
| 经营看板 | `dashboard:view` → `/dashboard` | 指标卡 + 5 图 + 6 待办卡 |

**指标卡（`DashboardSummary`，`packages/shared/src/types.ts`）**

| 卡 | 字段 | 口径 | 权限 |
| --- | --- | --- | --- |
| GMV | `gmv` | `tk_order_item.item_amount` 折 CNY；**排除 `is_sample_order=1`**；扣已完成退款 | 公开 |
| 订单数 | `orders` | 非 CANCELLED、非样品单，按站点时区切日 | 公开 |
| 退款 | `refund_amount`/`refund_rate` | `tk_return(status='COMPLETED').refund_amount` 之和；率 = 退款额 ÷ GMV | 公开 |
| 应收返点 | `est_rebate` | `SUM(rebate_cny) WHERE rebate_matched=1`（成交时冻结） | `can_see_cost` |
| 物流支出 | `est_logistics` | `SUM(logistics_cny) WHERE rebate_matched=1` | `can_see_cost` |
| 预估贡献毛利 | `est_gross_profit`/`est_profit_rate` | 返点 − 物流 − 达人佣金；**率的分母是返点（我们自己的收入），不是 GMV** | `can_see_cost` |
| 预估毛利 | `est_gross_profit`/`est_profit_rate` | `estItemProfitCny()` 逐行和；率分母 = GMV | `can_see_cost` |
| 实际到账 | `settled_amount` | `settlement_txn.payment_status=1` 的 `amount` 折 CNY | `can_see_cost` |
| 广告 | `ad_spend`/`ad_gmv`/`ad_roi` | `ad_daily` 汇总；`adRoi(spend,gmv)` | 公开 |

**图表**：`gmv_trend`（逐日 GMV/订单/**日净利**折柱混合 —— 这一列含广告与公共费用，与指标卡的"预估贡献毛利"不是同一个数，图例已分开命名）、`shop_rank`（Top10 柱）、`creator_rank`（表：带货 GMV / 订单 / 应收返点 / **有效返点率**）、`content_type_split`（环形饼，圆心放合计）、`bd_rank`（跟进数/谈妥数/谈妥率条/带货 GMV）。
`creator_rank` **不再带 `roi`**：达人投产比的分母按 C9 严格是「物流 + 寄样运费 + 坑位费 + 佣金」，而利润引擎的达人维度没有后两项，硬算会得到和「达人 ROI」页对不上的第二个"投产比"（演示库上同一个人 0.02 对 1.90）。投产比只有一个出处：`/api/creators/roi/rank`。

**待办卡（点击跳列表并带筛选）**

| 卡 | 字段 | 触发条件 | 跳转 | 演示数据现值 |
| --- | --- | --- | --- | --- |
| 待映射 SKU | `unmapped_listings` | `shop_listing.map_status=2` 或 `tk_order_item.sku_id IS NULL OR rebate_matched=0` | `/products/unmapped` | 2 条 listing + 6 条订单行 |
| 待跟进达人 | `creators_to_follow` | `creator_outreach.next_follow_at<=today` 或保护期 ≤7 天 | `/creators/outreach` | 保护期 2026-09-12 到期（基准日 09-18，已过期 4 人） |
| 寄样超期 | `samples_overdue` | `sample_shipment.status=3` 且 `sign_time < today-7` | `/creators/sample` | 0（4 条寄样均未签收） |
| 授权即将过期 | `auth_expiring` | `tk_shop.auth_status IN (2,3)` 或 `token_expire_at` <7 天 | `/shops` | 1（店 4 Conqland SG `auth_status=2`） |
| 同步异常 | `sync_failed` | 最近一次 `sync_log.status IN (2,3)` | `/system/synclog` | 1（shop3 settlement `status=3`） |
| 今日直播 | `live_today` | `live_session.status=1` 且 `plan_start` 为今日 | `/lives/schedule` | 4 场排班 |

**空态**：无可见店铺 → 全卡 0 + "你还没有可见店铺，请联系管理员配置数据权限"。
**告警态**：`sync_failed>0` 页顶红横幅，展示最近一条 `sync_log.error_msg`（已脱敏）。

### 3.2 `shop` 店铺与账号

| 子页 | key / path | 表 | 状态 |
| --- | --- | --- | --- |
| 店铺管理 | `shop:list` → `/shops` | `tk_shop` | 后端 `[已实现]`，前端 `[待开发]` `EPIC-9-01` |
| TikTok 账号 | `account:list` → `/accounts` | `tk_account` | 后端 `[已实现]`，前端 `[待开发]` |

**店铺管理 `/api/shops`（47 行，`shop.routes.ts`）**

- 列表列：`shop_name`、`tk_shop_id`、`region`、`shop_type`(1 跨境/2 本土)、`currency`、`timezone`、`auth_status`(4 态徽标)、`token_expire_at`、`owner_name`、`status`(1 运营中/2 暂停/3 已关店)、操作列。**不得返回 `app_key_enc/app_secret_enc`**（D2）。
- 筛选项：`keyword`(店铺名 LIKE)、`region`、`shop_type`、`status`、`auth_status`、`owner_id`。
- 表单校验（`shopBody` zod，新页面不得放宽）：`shop_name` 1~100 必填；`tk_shop_id` ≤64 选填但填了唯一；`shop_cipher` ≤128；`region` 2~8 必填（下拉 `REGIONS`）；`currency` 必须 3 位；`timezone` ≤32 默认 `Asia/Shanghai`；`auth_status` 0~3 默认 0；`status` 1~3 默认 1。
- 按钮与权限：新增/编辑/删除 = `requireMenu('shop')`；**重新授权** `POST /api/shops/:id/auth`（`app_key`/`app_secret`/`shop_cipher`/`token_expire_at` → `encryptSecret` 存 `*_enc`，任何页面与日志不回显明文）；删除前若有订单 → 403"可改为暂停/关店"。
- 空态："还没有店铺，先新增一个店铺并完成授权"。
- 告警态：`auth_status=2` 黄 + 剩余天数；`=3` 红；`withAuthExpiry()` 在 `token_expire_at` <7 天时自动把返回值置 2。

**TikTok 账号 `/api/accounts`**

- 列：`handle`、`nickname`、`account_type`(1 官方号/2 内容号/3 直播号)、`shop_name`、`region`、`followers`、`owner_name`、`account_status`(1 正常/2 限流/3 封禁/4 停用)、`remark`。
- 筛选：`keyword`(handle/nickname)、`shop_id`、`account_type`、`account_status`。
- 表单：`handle` 2~64 必填，提交前 `trim().toLowerCase().replace(/^@+/,'')`（后端已做，`tk_account.handle` UNIQUE）；`followers ≥0` 整数；`remark ≤500` 且页面提示"禁止填写账号密码"。
- 权限：`accountRouter.use(requireMenu('shop'))`。
- 告警态：`account_status≠1` 红标，不计入工作台。

### 3.3 `product` 商品中心 `[本迭代]`（后端 `product.routes.ts` 856 行 / 26 端点主体已实现，21 个类型错误待清 D5；前端 4 页已建）

| 子页 | key / path | 表 | Issue |
| --- | --- | --- | --- |
| 商品 SPU | `product:spu` → `/products/spu` | `product_spu` | `EPIC-2-01` |
| SKU 与返点 | `product:sku` → `/products/sku` | `product_sku` | `EPIC-2-01` |
| 店铺商品映射 | `product:listing` → `/products/listing` | `shop_listing` | `EPIC-2-02` |
| 待映射清单 | `product:unmapped` → `/products/unmapped` | `shop_listing` + `tk_order_item` | `EPIC-2-02` |

**SPU**：列 `spu_code`、`main_image`、`name_cn`、`name_en`、`category`(字典)、`owner_id→real_name`、`status`(1 开发中/2 在售/3 停售)、`sku_count`（`ProductSpu.sku_count`）。筛选 `keyword`(spu_code/name_cn/name_en)、`category`、`status`、`owner_id`。表单：`spu_code` 必填 ≤64 唯一、`name_cn` 必填 ≤200、`name_en ≤300`、`main_image ≤500` URL 格式。按钮：新增/编辑 `requireMenu('product')`；删除前存在 SKU → 400。

**SKU 与返点**：列 `sku_code`、`spu_code`、`name_cn`、`spec`、`rebate_rate`(品牌给的返点率，0-1 小数)、`logistics_cost`(CNY/件，头程+海外仓；品牌承担填 0)、`weight_g`、`package_size`、`status`(1 在售/0 停售)、最近改协议人与时间。筛选 `keyword`、`spu_id`、`category`、`status`、`返点率未配`(`rebate_rate = 0`)。表单：`spu_id` 必填且存在；`sku_code` 必填 ≤64 唯一；`rebate_rate` ∈ [0,1]（填 18 这类百分数直接 400，报错要写"0.18 = 18%"）；`logistics_cost ≥ 0`；`weight_g ≥ 0` 整数；`package_size ≤ 50`。**没有采购价/头程成本这两列了** —— 我们不背货款。
**核心规则**：改返点率**只影响后续订单**（历史行的 `rebate_cny` 是冻结值）；保存必须 `logIfChanged(['rebate_rate','logistics_cost'])`；接口返回该 SKU 近 90 天订单行数与被映射店铺数供前端确认框展示；无 `can_see_cost` → 返点率与金额列一律 `***` 且 PUT 403。

**店铺商品映射**：列 `shop_name`、`product_name`（方案表 8 无此列，代码有 → `changes-vs-plan` #5）、`tk_product_id`、`tk_sku_id`、`seller_sku`、内部 `sku_code`、`sale_price`+`currency`、`listing_status`(1 草稿/2 审核中/3 在售/4 下架/5 违规)、`map_status`(1 已映射/2 待映射)、`last_sync_at`。筛选 `shop_id`、`map_status`、`listing_status`、`keyword`。表单：`shop_id` 必填；(`shop_id`,`tk_sku_id`) 联合唯一 `ux_listing_shop_sku`；`sku_id` 可空（= 待映射）；`sale_price ≥0`。
按钮：**按 `seller_sku` 自动匹配**（`POST /api/products/listings/auto-match`：`seller_sku = sku_code` 精确命中或前缀唯一命中才写，多命中不写并进人工清单）、**手工绑定**。
闭环（C3）：绑定成功后回算受影响订单行的 `sku_id/rebate_matched/rebate_cny`（仅未参与结算的行），并写日志。
空态/告警：`map_status=2` 整行 warning + 列头计数；`listing_status=5` 红角标。

**待映射清单**：Tab A 未映射 `shop_listing`；Tab B 已产生订单但取不到品牌返点率的 `tk_order_item`（演示 6 行，`sku_id NULL` 且 `rebate_matched=0`），列 `tk_order_id`、`shop_name`、`tk_sku_id`、`quantity`、`item_amount`、`order_time`、缺失原因；每行"去绑定"直开映射编辑框。页顶固定说明："这些行不计入返点与利润（不是 0 利润），且持续告警"。

### 3.4 `order` 订单中心 `[本迭代]`（后端 `order.routes.ts` 975 行 / 12 端点已实现，含 `/summary`、`/unmatched`、`/export`、`/returns*`、`/:id`、`/:id/profit`；2 个类型错误待清，**0 测试覆盖**；前端三页已建）

| 子页 | key / path | 表 | 实测端点（`orderRouter`） | Issue |
| --- | --- | --- | --- | --- |
| 订单列表 | `order:list` → `/orders` | `tk_order` + `tk_order_item` | `GET /api/orders`、`GET /api/orders/summary`（totals/by_shop/by_day）、`GET /api/orders/unmatched`、`GET /api/orders/export` | `EPIC-3-01` |
| 订单详情 | `order:detail` → `/orders/:id` | `tk_order` + `tk_order_item` + `settlement_txn` + `tk_return` + `sys_op_log` | `GET /api/orders/:id`、`GET /api/orders/:id/profit`（利润分解）、`PUT /api/orders/:id/sample` | `EPIC-3-01` |
| 售后退款 | `return:list` → `/returns` | `tk_return` | `GET /api/orders/returns`、`/returns/stats`（原因 Top + 责任分布）、`/returns/impact`（退款率/回仓率/未回仓损失）、`GET+PUT /api/orders/returns/:id` | `EPIC-3-02` |

**列表列**：`tk_order_id`、`shop_name`、`order_status`（中文用 `ORDER_STATUS_LABEL`：`TO_BE_SHIPPED/INVOICE_CREATED→待发货`、`ON_HOLD_SUBSTATUS_ESCALATION→暂停`）、`order_time`、`paid_time`、`currency`、`subtotal`、`seller_discount`、`platform_discount`、`shipping_fee`、`total_paid`、`item_count`、`fulfillment_type`(1 平台仓/2 自发货/3 海外仓)、`carrier`、`tracking_no`、`is_sample_order`、`est_profit`（受 `can_see_cost`）、`synced_at`。
**筛选项**：`shop_id`、`order_status`(多选)、`keyword`(`tk_order_id`/`tracking_no`)、`order_time_from/to`、`paid_time_from/to`、`is_sample_order`、`fulfillment_type`、`region`、仅含待映射行。
**按钮与权限**：详情（`order` 菜单）、导出（`requireExport`）。**金额与状态人工不可改**（方案表 6）；唯一允许人工写的是 `is_sample_order`（历史样品单纠正），必须写日志。
**空态**："最近 N 天没有订单" + "检查同步"。**告警态**：样品单灰底"样品单·不计 GMV"；含 `rebate_matched=0` 行 warning。

**详情**：金额区（含 `item_amount × rate_to_cny` 折算）；明细表逐行 `sku_code`/`rebate_rate`/`rebate_cny`/`logistics_cny`/`rebate_matched`/`creator_handle`/`content_type`/`content_id`/`commission_rate`/`est_commission`；返点与利润字段整体 `maskFields`；下方 Tab 结算流水（`settlement_txn.tk_order_id`）/ 售后 / 操作日志。`rebate_matched=0` 行必须红字"未配返点率，未参与利润计算（不是 0 利润）"。

**售后退款**：列 `tk_return_id`、`tk_order_id`、`shop_name`、`return_type`(1 仅退款/2 退货退款)、`reason`、`refund_amount`+`currency`、`status`（平台原文；演示分布 COMPLETED 20 / PROCESSING 9 / SELLER_REJECTED 11）、`apply_time`、`finish_time`、`responsibility`(0 未归类/1 质量/2 物流/3 描述不符/4 买家原因)、`is_restocked`。
筛选 `shop_id`、`responsibility`（默认筛 0 引导补填）、`status`、`return_type`、`apply_time_from/to`、`keyword`。
表单（客服补填）：`tk_return` **没有人工备注列**，因此只允许改 `responsibility`、`is_restocked` 两个字段（`PUT /api/orders/returns/:id` 用 `z.strict()`，多传即 400）；退款金额与状态由同步覆盖。补充说明写进操作日志 `before_after`。
告警态：`responsibility=0` warning 且计入工作台。页顶：本期退款率 + `responsibility` 分布饼图。

### 3.5 `creator` 达人中心 `[本迭代]`（后端 `creator.routes.ts` 1799 行 / 38 端点主体已实现；前端 6 页已建）

| 子页 | key / path | 表 | Issue |
| --- | --- | --- | --- |
| 达人公海 | `creator:pool` → `/creators/pool` | `creator` `pool_status=1` | `EPIC-5-01` |
| 我的达人 | `creator:mine` → `/creators/mine` | `creator` `owner_id=me` | `EPIC-5-01` |
| 建联跟进 | `creator:outreach` → `/creators/outreach` | `creator_outreach` | `EPIC-5-02` |
| 合作单 | `creator:collab` → `/creators/collab` | `collaboration` | `EPIC-5-03` |
| 寄样管理 | `creator:sample` → `/creators/sample` | `sample_shipment` | `EPIC-5-03` |
| 达人 ROI 排行 | `creator:roi` → `/creators/roi` | 汇总 | `EPIC-5-04` |

**达人库列表**：列 `handle`、`nickname`、`region`、`followers`、`category_tags`(逗号多标签)、`avg_views`、`gmv_level`(字典 A/B/C)、`email`、`whatsapp`（两列受 `can_see_contact`）、`owner_name`、`protect_until`、`pool_status`(1 公海/2 私海/3 合作中/4 黑名单)、`source`(1 联盟广场/2 TikTok搜索/3 达人申样/4 机构推荐)。
筛选：`keyword`、`region`、`category_tags`、`pool_status`、`owner_id`、`protect_until_from/to`、`followers_min`。
表单：`handle` 必填 2~64，保存前 `normalizeHandle()`（小写去 `@`，`creator.handle` UNIQUE）；冲突 409"达人已存在，请去公海认领"；`email` 邮箱格式；`whatsapp ≤64`；`protect_until` `YYYY-MM-DD`。
按钮：新增/编辑、**认领**（`1→2`、`owner_id=me`、`protect_until=today+30`，CAS）、**退回公海**（`owner_id=null`、`protect_until=null`、`pool_status=1`）、**转交**（`bd_manager`/`boss`）、**加入黑名单**（`pool_status=4`，写日志）、批量导入。
**权限实现（D1）**：达人域一律 `personScope(user,'creator.owner_id')`，**不得**用 `shopScope`。
空态：公海引导"导入 / 联盟搜索入库"。告警态：保护期 ≤7 天黄、已过期红并提示"将被夜间作业退回公海"。

**建联跟进**：列 `creator_handle`、`user_name`、`channel`(1 私信/2 邮件/3 WhatsApp/4 平台定向邀约)、`contact_time`、`summary`、`result`(1 未回复/2 已回复/3 有意向/4 报价中/5 拒绝/6 谈妥)、`next_follow_at`。筛选 `creator_id`、`user_id`、`result`、`channel`、`contact_time_from/to`、今日待跟进。
表单（要求 10 秒可完成）：`creator_id`（扫 handle 带出）、`channel`、`contact_time` 默认当前、`result`、`summary ≤500`、`next_follow_at` 可选。保存后自动 `protect_until = max(现有, today+7)`；`result=6` 时不续期而提示"去建合作单"。统计条：本人跟进数/回复率(`result≥2`÷总数)/谈妥数；`bd_manager` 可切本组。演示：chenbd 10 条、lubd 8 条。

**合作单**：列 `collab_no`（`CB<YYYYMMDD>-<4位>`，UNIQUE）、`creator_handle`、`shop_name`、`spu_name`、`coop_type`(1 纯佣金/2 坑位费+佣金/3 付费视频/4 直播专场)、`commission_rate`、`fixed_fee`+`fee_currency`（`>0` 时对无 `can_see_cost` 掩码）、`promised_videos`、`promised_lives`、`deadline`、`tk_plan_id`、`status`(8 态见 §4)、`owner_name`、汇总列 发布视频数/带货订单数/带货净 GMV/ROI。
表单：`creator_id`、`shop_id` 必填；`spu_id` 可空但提示；`commission_rate` 0~100；`fixed_fee ≥0`；`fee_currency` 3 位；`deadline` 日期；`coop_type≠1 且 fixed_fee=0` → 400。
按钮：新建、编辑、**生成待付款费用**（幂等 C7）、变更状态、导出。

**寄样管理**：列 `collab_no`、`creator_handle`、`sku_code`、`quantity`、`shipping_cost`(CNY，我们掏的寄样运费)、`ship_method`(1 平台免费样品/2 线下自寄/3 海外仓代发)、`tk_order_id`、`tracking_no`、`ship_time`、`sign_time`、`status`(6 态见 §4)。
筛选 `status`、`creator_id`、`ship_method`、`ship_time_from/to`、超期未出内容。
表单：`creator_id` 必填；**只登记 `shipping_cost`** —— 样品货值是品牌出的，我们不为它垫钱，所以没有"样品成本"这一列；`ship_method=1` → `tk_order_id` 必填；`status=2` 需 `tracking_no`；`status=3` 需 `sign_time`。
按钮：新增、发货（填单号→2）、登记签收（→3）、标记丢件（→6）、关联平台样品单（回填 `tk_order_id` 并置 `is_sample_order=1`）。

**达人 ROI 排行**：列 `handle`、`region`、`owner_name`、合作单数、寄样运费、坑位费(CNY)、达人佣金(CNY)、**应收返点(CNY)**、带货净 GMV(CNY，参考列)、ROI、订单数。口径 = `collabRoi({rebate_cny, sample_shipping, fixed_fee_cny, commission_cny, logistics_cny})`（C9：分子是我们的返点，分母不含广告与公共费用）；`roi=null` 显示"—"不参与 Top。维度切换：按达人/按 BD/按合作单。整页含成本列，无 `can_see_cost` 时数值全 `***`（页面可打开，便于 BD 看名次）。

### 3.6 `content` 内容中心 `[本迭代]`（后端 `content.routes.ts` 1010 行 / 19 端点主体已实现，类型错误已清零；前端 3 页已建）

| 子页 | key / path | 表 | 期次 | Issue |
| --- | --- | --- | --- | --- |
| 视频库与带货排行 | `video:list` → `/videos` | `video` | 一期 | `EPIC-6-01` |
| 直播排班 | `live:schedule` → `/lives/schedule` | `live_session` | 一期（Q6 提前） | `EPIC-6-02` |
| 直播复盘 | `live:review` → `/lives` | `live_session` | 一期 | `EPIC-6-02` |

**视频库**：列 `tk_video_id`、`video_url`(可点)、`publisher_type`(1 自有账号/2 达人)、`account_handle`、`creator_handle`、`collab_no`、`spu_name`、`publish_time`、`editor_name`、`views`、`likes`、`comments`、`shares`、`orders`、`gmv`。筛选 `keyword`(`tk_video_id`/url)、`publisher_type`、`creator_id`、`account_id`、`spu_id`、`editor_id`、`shop_id`、`publish_time_from/to`。
表单：`video_url` 必填 ≤500；`tk_video_id` 由 `parseVideoId(url)` 自动解析（支持 `/video/<id>`、`/v/<id>`、`?item_id=<id>`、纯 ≥12 位数字），失败 400 且前端红字；`publisher_type=1` → `account_id` 必填；`=2` → `creator_id` 与 `collab_id` 必填（方案表 13）。`tk_video_id` UNIQUE。
`orders/gmv` 为汇总列、只读，由汇总作业按 `tk_order_item.content_type/content_id` 回填（演示数据当前全 0 → `EPIC-6-01` 负责回填）；页面标注"汇总于 <last_run>"。排行按 `gmv` 降序 + `千次观看成交额 = gmv/views×1000`。

**直播排班**：日历 + 列表。列 `plan_start~plan_end`、`account_handle`、`shop_name`、`host_name`、`assistant_name`、`creator_handle`、`status`(1 已排班/2 直播中/3 已结束/4 取消)。表单：`shop_id` 必填；`plan_start<plan_end`；同 `account_id` 时段冲突 409；`host_id`/`assistant_id` 选填。按钮：新建排班、取消、开播/下播（写 `actual_start/actual_end`，状态 2/3）。提醒：开播前 1 天 `sendAlert`。
**直播复盘**：列 `actual_start/actual_end`、时长(自动)、`viewers`、`peak_online`、`orders`、`gmv`、`ad_spend`、`review_note` 摘要、GMV/小时、千次观看成交额。筛选 `shop_id`、`host_id`、`plan_start_from/to`、`status=3`。表单：仅已结束可编辑；`ad_spend` 默认从 `ad_daily`（同店同 `stat_date`、`ad_type=2`）带入可覆盖；`review_note` 文本。权限：`host` 只能改自己 `host_id/assistant_id` 的场次（`personScope`）。排行：主播时长榜、场均 GMV、千次观看成交额。

### 3.7 `ads` 投放中心 `[待开发]`（二期；后端 `ads.routes.ts` 为桩，前端 `AdDaily.vue` 已建）

| 子页 | key / path | 表 | Issue |
| --- | --- | --- | --- |
| 广告日报 | `ad:daily` → `/ads/daily` | `ad_daily` | `EPIC-7-01` |

列：`stat_date`、`shop_name`、`advertiser_id`、`campaign_id`、`campaign_name`、`ad_type`(1 GMV Max商品/2 GMV Max直播/3 视频投流/4 达人授权投放)、`spu_name`、`video_id`、`spend`+`currency`、`impressions`、`clicks`、`conversions`、`gmv`、`roi`（`adRoi()`，后端算）、CTR、CPC、CPM。
筛选：`stat_date_from/to`（默认近 7 天）、`shop_id`、`ad_type`、`campaign_id`、`spu_id`、`keyword`(计划名)。
表单（人工补录/导入）：`stat_date` 必填（站点自然日）；(`shop_id`,`campaign_id`,`stat_date`,`ad_type`) 唯一 `ux_ad_daily`，重复导入按更新；`spend ≥0`；`currency` 3 位；计数字段 ≥0 整数。
聚合 Tab：按商品 / 按视频 / 按店铺的投产比。空态："未同步到广告数据，检查广告账户授权或改用导入"。ROI 不含成本，`ads` 角色可见。

### 3.8 `finance` 财务中心 `[本迭代]`（二期；后端 `finance.routes.ts` 920 行 / 24 端点已实现（结算 6 + 售后 1 + 费用 5 + 汇率 7 + 利润 4 + 其他），**16 个类型错误待清 D5**；前端 4 页已建）

| 子页 | key / path | 表 | Issue |
| --- | --- | --- | --- |
| 结算对账 | `settlement:list` → `/finance/settlement` | `settlement_txn` | `EPIC-7-02` |
| 费用登记 | `expense:list` → `/finance/expense` | `expense` | `EPIC-7-03` |
| 汇率维护 | `rate:list` → `/finance/rate` | `exchange_rate` | `EPIC-7-03` |
| 利润报表 | `profit:report` → `/finance/profit` | 汇总 | `EPIC-8-03` |

**结算对账**：列 `statement_id`、`statement_time`、`tk_order_id`、`shop_name`、`txn_type`(1 订单收入/2 退款/3 平台佣金/4 达人佣金/5 运费/6 平台补贴/7 调整/8 其他)、`amount`（收入正/扣款负）、`currency`、折算 CNY、`payment_id`、`payment_status`(1 已打款/2 处理中/3 失败)。筛选 `shop_id`、`txn_type`、`payment_status`、`statement_id`、`tk_order_id`、`statement_time_from/to`。页顶按店"已打款/处理中/失败"三档汇总。演示 681 行。**逐单对账**：`GET /api/finance/reconcile?tk_order_id=` 输出预估 vs 实际差异来源（退款未入账/佣金差异/汇率差异）。
**费用登记**：列 `expense_date`、`expense_type`(1 坑位费/2 头程物流/3 海外仓费/4 工具订阅/5 服务费/6 其他)、`shop_name`（空显示"公共费用"）、`ref_type/ref_id`（可跳详情）、`amount`+`currency`、`amount_cny`、`payee`、`voucher`、`status`(1 待付款/2 已付款)、`remark`（方案表 19 无 `remark`，代码有 → `changes-vs-plan` #9）。
表单：`expense_date` 必填；`amount ≥0`；`currency` 默认 CNY；`amount_cny` 由汇率服务算、**不可手改**（回退时提示用了哪天）；`voucher ≤500`；`status=2` 需 `payee`。改 `amount/amount_cny/shop_id` 必须 `logIfChanged`。
**汇率维护**：列 `rate_date`、`currency`、`rate_to_cny`（`DECIMAL(18,6)` 语义，展示 4 位）、`source`(1 自动/2 手工)。唯一 `ux_rate(rate_date,currency)`。按钮：手工新增/覆盖、补最近 7 天缺失、每日自动取价作业。缺失当日汇率在工作台告警。演示 240 行（MYR/PHP/SGD/USD × 60 天，2026-07-21~09-18；USD 7.15 / MYR 2.12 / PHP 0.128 / SGD 5.6）。
**利润报表**：行 = `ProfitRow`：`dim_key`、`dim_name`、`currency`、`gmv`、`refund`、`net_gmv`、`cost`、`commission`、`ad_spend`、`expense`、`settled_amount`、`profit`、`profit_rate`、`is_estimated`、`orders`。维度必做 4 个：`shop/sku/creator/month`。筛选：期间、`shop_id`、`region`、`only_settled`、`include_sample`(默认 false)。
公式：`profit = settled_amount(缺失回退 net_gmv) − cost − commission − ad_spend(直接归属) − expense(含 B4 分摊)`；`profit_rate = profitRate(profit, net_gmv)`。
展示：`is_estimated=1` 灰字标"预估" + 页顶说明未结算单数；合计行常驻；导出走 `requireExport`；无 `can_see_cost` **整页 403**（利润视为成本敏感，不只掩码）。

### 3.9 `stock` 库存（三期，可选）`[待开发]` `EPIC-2-04`

| 子页 | key / path | 表 |
| --- | --- | --- |
| 仓库管理 | `warehouse:list` → `/stock/warehouse` | `warehouse` |
| 出入库流水 | `stock:ledger` → `/stock/ledger` | `stock_ledger` |
| 库存查询 | `stock:query` → `/stock/query` | `stock_ledger` 汇总 |

- 仓库：列 `name`、`wh_type`(1 国内仓/2 海外仓/3 平台仓)、`region`、`status`(1 启用/0 停用)；`name ≤100` 必填唯一。演示 2 仓。
- 流水：列 `op_time`、仓库名、`sku_code`、`change_type`(1 采购入库/2 头程发货/3 调拨/4 销售出库/5 样品出库/6 退货入库/7 盘点调整)、`quantity`（入正/出负）、`ref_no`、`operator_name`。**只可追加与冲销，无 PUT**。演示 65 行。
- 查询：`当前库存 = SUM(quantity) GROUP BY warehouse_id, sku_id`；低于安全阈值（`sys_dict` 维护）标红；筛选 `warehouse_id`、`sku_id`、`spu_id`。
- 自动生成：销售出库（订单发货）、退货入库（`tk_return.is_restocked=1`）、样品出库（`sample_shipment` 发货）三类，幂等键 `ref_no + change_type + sku_id`。
- **缺口**：`app.ts` 未挂载 `/api/stock`（D8），本 Issue 必须补挂载。

### 3.10 `system` 系统设置

| 子页 | key / path | 表 | 后端 | 前端 |
| --- | --- | --- | --- | --- |
| 员工管理 | `user:list` → `/system/users` | `sys_user` + `sys_user_shop` | `[已实现]` | `EPIC-1-01` |
| 角色权限 | `role:list` → `/system/roles` | `sys_role` | `[已实现]` | `EPIC-1-01` |
| 操作日志 | `oplog:list` → `/system/oplog` | `sys_op_log` | `[已实现]` | `EPIC-1-01` |
| 同步监控 | `synclog:list` → `/system/synclog` | `sync_log` | `[已实现]` | `EPIC-1-01` |
| 数据字典 | `dict:list` → `/system/dict` | `sys_dict` | `[已实现]` | `EPIC-1-01` |

- **员工管理**：列 `username`、`real_name`、`phone`、`dept`、`role_name`(+`role_key`)、`status`(1 在职/0 停用)、`last_login_at`、授权店铺数。筛选 `keyword`、`role_id`、`dept`、`status`。表单（`userBody`）：`username` 2~64 必填唯一且**编辑时禁止改**（`userBody.partial().omit({username:true})`）；`password` 8~64，新建必填否则 400"新建员工必须提供初始密码（至少 8 位）"；`real_name` 1~50 必填；`phone ≤20`；`dept ≤50`；`role_id` 必填存在；`status ∈{0,1}`；`shop_ids` 数组同事务覆盖写 `sys_user_shop`（`ux_user_shop`）。按钮：新增/编辑/停用（`POST /api/system/users/:id/deactivate`，不真删）。日志：`after.password` 必须为 `'***'`（已实现，规范强制）。
- **角色权限**：列 `role_name`、`role_key`、`data_scope`、三个开关、`menu_perms`(Tag)、`user_count`。表单：`menu_perms` 多选（仅 11 个一级 key）、`data_scope 1~4`、三开关 `∈{0,1}`；改权限必须写日志并提示"该角色下 N 个账号的可见范围会立即变化"。`role_key` UNIQUE。
- **操作日志**：列 `op_time`、`user_name`、`module`(一级菜单中文名)、`action`(`create/update/delete/export/login`)、`target_table`、`target_id`、`before_after`(JSON diff 展开)、`ip`。筛选 `user_id`、`module`、`action`、`target_table`、`start_date/end_date`。**只读**。
- **同步监控**：列 `started_at`、`task_type`(`order/product/listing/returns/settlement/affiliate_order/ad/video/live`)、`shop_name`、`window_start~window_end`、`fetched/inserted/updated/failed`、`status`(1 成功/2 部分失败/3 失败)、`error_msg`。`GET /api/system/synclog/health` 提供"每店每任务最近一次"。按钮：立即重跑（`POST /api/sync/run`）。失败行红底；`error_msg` 渲染前脱敏（C5）。
- **数据字典**：列 `dict_type`、`dict_value`、`dict_label`、`sort`、`status`。唯一 `ux_dict(dict_type,dict_value)`。注意：`GET /api/system/dict/:type` 与同步健康检查对**所有登录用户**开放（工作台需要），管理端增删改才需 `system` 菜单。

### 3.11 `selection` 选品管理 `[已实现]`（方案第十一章：候选品从登记到正式销售的五阶段流水线）

| 子页 | key / path | 表 | 后端 | 前端 |
| --- | --- | --- | --- | --- |
| 选品流水线 | `selection:board` → `/selection` | `selection_flow` + `selection_log` | `selection.routes.ts`（15 端点） | `views/selection/SelectionBoard.vue` |

这一章的价值全在**闸门**上：状态机不许绕、结论必须带数据、清单没清完不许上架。三条中任何一条能被绕过，流水线两周内就会退化成一张谁都不维护的选品表，而且退化时界面上看不出来 —— 所以闸门一律做在后端，前端只是把按钮摆出来。

| 端点 | 作用 | 硬规则 |
| --- | --- | --- |
| `GET /api/selection` | 分页列表（`stage/owner_id/shop_id/source/conclusion/keyword/overdue`） | `overdue=1` 的边界时间戳在 JS 里算，SQL 只做文本比较，与看板卡片同一口径（不新增方言债） |
| `GET /api/selection/board` | 五列看板 + 每卡 `dwell_days/due_days/overdue_level` | 档位由后端算，前端只投影颜色，不自己判"该不该红" |
| `GET /api/selection/funnel` | 登记 → 测试 → 通过 → 上架 四步漏斗 + 通过率 + 各阶段水位 | 与列表共用同一套筛选与数据范围 |
| `GET /api/selection/export` | CSV/XLSX | `requireExport`；有 `selection` 菜单但没有导出权的角色 403 |
| `GET /api/selection/:id`、`/:id/logs` | 详情（含解析后的 `snapshot/checklist` 与 `next_stages`）/ 流转日志 | 范围外一律 404，不用报错摸 ID |
| `POST /api/selection` | 登记（品牌方 / 建议售价 / 计划折扣 / 返点率 / 佣金率 / 物流费率） | 自动生成 `SEL-YYYY-NNNN`（撞号顺延重试，不静默失败）；`est_margin = 返点率 − 佣金率 − 物流费率`、`breakeven_roas = 1/est_margin` **由后端推，手填一律不认**；同时写第一条流转日志（`from_stage=0`＝登记前） |
| `PUT /api/selection/:id` | 改基础信息 | **改不动 `stage`/`conclusion`**（状态只能走流转接口，否则日志会缺一条）；改任一费率会带着重算毛利率与平衡线 |
| `POST /api/selection/:id/stage` | 唯一的改 `stage` 入口 | 边表外 → 400；进测试必须指定店铺；转销售必须清单全勾 + 关联 SPU；淘汰必须写原因 |
| `POST /api/selection/:id/conclusion` | 提交测试结论（2→3） | 7 个指标（`SELECTION_METRICS`）缺一个就 400 并**点名缺哪几个**；`需调整后复测` 必须写调整项；快照原样入库并进日志 |
| `POST /api/selection/:id/conclusion/confirm` | 结论落地（3→4/2/6） | 通过→销售前准备、复测→回上架测试、不通过→淘汰池（原因带进 `reject_reason`） |
| `PUT /api/selection/:id/checklist` | 六项清单（资料/价格/库存/渠道/财务/合规） | 未知清单项 400；只有阶段四能维护；已勾完的项前端要求指定责任人 |

- **数据范围**：已指定测试店铺的按店铺范围收敛；`shop_id IS NULL`（还在登记阶段）的候选品是登记人的草稿，只对 `owner_id`/`registered_by` 本人可见。直接套 `shopScope` 会让 SELF/SHOPS 角色连自己刚登记的品都看不见 —— 流水线在第一步就断。
- **超时口径**（`config.selection*`，可环境变量覆盖）：登记待测试 7 天 / 测试出结论 14 天 / 结论落地 3 天 / 准备清完 7 天，首次检测 48~72 小时，停留满阈值 70% 转黄、超过红线转红。
- **规则**（`alert_rule` 表驱动，命中后进「今日行动中心」的 P0/P1/P2 清单，管理入口是系统设置 → 规则中心）：`SELECTION_REGISTER_STALE`(P1)、`SELECTION_TEST_OVERDUE`(**P0**)、`SELECTION_FIRST_CHECK`(P2)、`SELECTION_TEST_STRONG`(P1，CTR/CVR 基准写在 `params_json`，无基准不判定)、`SELECTION_FEEDBACK_STALE`(P1)、`SELECTION_PREPARE_OVERDUE`(P1)。`target_type='selection'`，`ownerOf` 取 `selection_flow.owner_id` → 直接进「我的待办」。规则只检测/建议，**绝不自动改阶段状态**。
- **与商品/新品端口的关系**（方案 11.4）：选品管"从 0 到 1"，转 `正常销售` 后写 `spu_id` 与 `selling_at`，归商品端口做动态检测；三个端口共用同一个 SPU，数据不重复录入，只做状态流转。



### 3.13 `ai` AI 助手 `[已实现]`（模型服务商接入 + 对话 + 白名单工具）

| 子页 | key / path | 表 | 后端 | 前端 |
| --- | --- | --- | --- | --- |
| AI 对话 | `ai:chat` → `/ai/chat` | `ai_conversation` + `ai_message` + `ai_call_log` + `ai_action_log` | `ai.routes.ts`（15 端点） | `views/ai/ChatView.vue` |
| 模型服务商 | `ai:provider` → `/ai/providers` | `ai_provider` | 同上 | `views/ai/ProviderList.vue` |
| AI 调用审计 | `ai:audit` → `/ai/audit` | `ai_call_log` + `ai_action_log` | 同上 | `views/ai/AiAudit.vue` |

**这一节的边界（用户定的三条，写死在这里免得下一轮被人"顺手放宽"）**：

1. **协议只有两种**：`openai` 兼容报文（GPT / DeepSeek / 自建网关，只差 base_url 与 model）与 `gemini` 原生报文。加一家新厂商 = 在 `AI_VENDOR_PRESETS` 加一行预设，不是再写一个适配器。
2. **没有 mock 服务商**：没配 key 就是 409 一句可读的"去模型服务商配一家"，产品代码里不存在假数据分支。真实模型往返因此**不在 e2e 里测**，改由 `tests/ai.spec.ts` 注入桩 transport 离线对拍（报文形态、工具循环、落库、脱敏全都走生产代码）。
3. **AI 可以写业务数据，但只有白名单**：`AI_WRITE_TOOLS` 当前是 `record_alert_action`（预警处置）与 `create_outreach`（建联跟进）。写入走的是**人在界面上写时同一个 service 函数**（`handleEvent` / `recordOutreach`），因此权限、数据范围、校验、op_log 一条都不会少；`created_by` 记的是发起对话的那个人。删除、改价/上架、对外给达人发消息三类**永不进名单**。

| 端点 | 作用 | 硬规则 |
| --- | --- | --- |
| `GET/POST /api/ai/providers`、`PUT/DELETE /:id` | 服务商 CRUD | 读取走字段白名单，**密文列 `api_key_enc` 与明文 key 都不出接口**（只回 `has_key`）；`base_url` 必须 https（本机回环例外）且命中 `AI_ALLOWED_HOSTS`（配了才校验）；编辑时 key 留空＝保持原值 |
| `POST /api/ai/providers/:id/test` | 测活：一次最小往返 | 结果与失败原因（`maskError` 后）落到该行上，界面上看得见"上次测活：失败 + 为什么" |
| `GET /api/ai/tools` | 工具清单（名称/中文标签/是否写入） | 前端把"AI 能干什么"显示出来，不让人猜 |
| `POST /api/ai/chat` | 一轮对话（非流式） | `AI_ENABLED=false` → 503；没可用服务商 → 409；单条 >8000 字 → 400；工具轮数上限 `AI_MAX_TOOL_ROUNDS`，用完必须留一条说明而不是空回复 |
| `GET /api/ai/conversations`、`/:id`、`DELETE /:id` | 会话 | 只能看/删自己的会话；别人的会话一律 404（不区分 403/404，免得被拿来探测 ID） |
| `GET /api/ai/calls`、`/calls/usage`、`/actions` | 审计与用量 | SELF 角色只看到自己发起的调用与花费，主管/老板看全部 |

- **为什么非流式**：内部系统一问一答够用，而 `EventSource` 带不上 `Authorization` 头 —— 要上流式得先改鉴权方式（cookie 或短期票据），那是另一整件事。
- **前端超时必须单独放宽**：服务端出网给模型最多 `AI_HTTP_TIMEOUT_MS`（默认 45s），跟着 axios 默认的 30s 会先把请求掐掉，表现是"AI 明明在算，界面报了个网络错误"。
- **审计三张表各司其职**：`ai_call_log` 记每次出网（token/耗时/估算花费/失败原因），`ai_message` 记对话原文（含 `tool_calls`），`ai_action_log` 只记写工具，字段是"哪条消息、哪个工具、改了哪张表哪一行、被拒还是失败"。
- **配置项**（全部 env 可覆盖，见 `config.ts`）：`AI_ENABLED`、`AI_HTTP_TIMEOUT_MS`、`AI_MAX_RETRY`、`AI_MAX_TOOL_ROUNDS`、`AI_HISTORY_LIMIT`、`AI_ALLOWED_HOSTS`、`AI_MAX_PROMPT_CHARS`。

---

## 4. 四条核心业务流程与状态机

### 4.1 流程一：达人带货闭环（方案 6.1）

`找达人 → 出单 → 算 ROI`

| 步 | 动作 | 表 | 系统行为 |
| --- | --- | --- | --- |
| 1 | BD 公海搜索/导入达人，认领进私海 | `creator` | `pool_status 1→2`、`owner_id=me`、`protect_until=today+30`；并发认领 CAS 只允许一人成功 |
| 2 | 每次联系记一条跟进，约下次时间 | `creator_outreach` | 到点进工作台 `creators_to_follow`；有效跟进续期 7 天 |
| 3 | 谈妥建合作单（方式/佣金率/坑位费/条数/截止日） | `collaboration` | 生成 `collab_no`、`status=1` |
| 4 | 坑位费一键生成待付款费用 | `expense` | `expense_type=1`、`ref_type='collaboration'`、幂等（C7） |
| 5 | 仓库寄样、填物流单号；签收计时 | `sample_shipment` | `shipping_cost` 记我们掏的寄样运费；超 `sampleContentDueDays`(7) 无内容自动提醒 |
| 6 | 达人发布后 BD 贴视频链接 | `video` | `parseVideoId()` 解析并挂到合作单 |
| 7 | 联盟订单同步按视频/达人归因 | `tk_order_item` | 写 `creator_id/content_type/content_id/commission_rate/est_commission` |
| 8 | 自动算合作投产比并按达人/BD 出排行 | 汇总 | `collabRoi()`，口径 C9 |

### 4.2 流程二：订单到利润（方案 6.2）

`同步(15~30 分钟增量，按更新时间，窗口重叠 5 分钟) → 明细经映射冻结返点与物流 → 售后冲减 → 每日结算替换预估 → 逐单利润折 CNY → 报表(店/SKU/达人/月)`

| 步 | 关键约束 |
| --- | --- |
| 同步 | 幂等 B1；每批 1 行 `sync_log`；`fetched=0` 且历史有单 → 告警 |
| 成本 | 映射命中 → `sku_id`+`rebate_cny`+`rebate_matched=1`；未命中 → `rebate_matched=0`，**绝不按 0 收入进利润** |
| 售后 | 仅 `COMPLETED` 冲减，归属原下单日（B5） |
| 结算 | `settlement_txn` 按 `ux_settle_txn` 去重；`payment_status=1` 才计 `settled_amount` |
| 利润 | `profit = 应收返点 − 物流 − 达人佣金 − 广告(直接归属) − 费用(含分摊)`，全折 CNY；平台结算实收只作对账列，不计入我们的收入 |
| 报表 | 未结算行用预估并标 `is_estimated=1` |

### 4.3 流程三：直播（方案 6.3）

`按周排班(账号/主播/场控/时段/主推) → 开播前一天提醒 → 下播后同步或导入(场观/最高在线/单数/GMV) + 投流花费从广告日报汇总 → 主播填复盘 → 出时长榜/场均 GMV/千次观看成交额`

### 4.4 流程四：数据同步与告警（方案 6.4）

`按 店铺×数据类型 执行 → 写 sync_log → 窗口重叠靠单号去重 → 失败/授权将到期/异常 0 条 → 告警(企业微信/飞书 webhook，未配置降级 console) → 凭证加密只在服务端`

### 4.5 状态机

**A. 合作单 `collaboration.status`（8 态）**

| 值 | 名称 | 进入条件 | 允许的下一态 | 触发动作 |
| --- | --- | --- | --- | --- |
| 1 | 已谈妥 | BD 新建合作单（`result=6` 后） | 2 / 8 | 生成 `collab_no`；坑位费可生成费用 |
| 2 | 待寄样 | 1 下"需要寄样"或直接创建寄样单 | 3 / 8 | — |
| 3 | 样品在途 | `sample_shipment.status→2`（发货）自动 | 4 / 8 | 自动，回填 `tracking_no` |
| 4 | 待发布 | 样品 `status→3` 签收后无内容 | 5 / 7 / 8 | 开始 7 天倒计时（C8） |
| 5 | 已发布 | 登记 `video` 且解析成功自动 | 6 / 7 / 8 | 回填 `video.collab_id`；寄样单 `→4` |
| 6 | 已完结 | 达成 `promised_videos/promised_lives` 或人工确认 | — | 归档；ROI 结算 |
| 7 | 超期未履约 | 夜间作业：`status∈(4,5)` 且 `deadline<today` 且发布数 < 约定 | 6 / 8 | 写日志（操作人 `system`）+ 提醒 BD |
| 8 | 取消 | 人工（需 `boss`/`bd_manager`） | — | 写日志；不回收已发生费用 |

非法流转（如 `1→5`、`6→3`、`8→1`）→ 400。演示数据 6 条合作单覆盖 `1..6` 各一条，owner 均 chenbd（5 条进行中）。

**B. 寄样单 `sample_shipment.status`（6 态）**

| 值 | 名称 | 进入条件 | 下一态 | 触发动作 |
| --- | --- | --- | --- | --- |
| 1 | 待发货 | 合作单需要寄样 | 2 / 6 | — |
| 2 | 在途 | 发货并填 `tracking_no`（`ship_method=2/3`）；`=1` 需回填 `tk_order_id` | 3 / 6 | 合作单自动 `2→3` |
| 3 | 已签收 | 登记 `sign_time` | 4 / 5 | 启动出内容倒计时 |
| 4 | 已出内容 | 关联 `video` 且 `parseVideoId` 成功 | — | 合作单 `→5` |
| 5 | 超期未出内容 | 作业：`status=3` 且 `sign_time < now-7天` | 4 | 工作台 `samples_overdue+1`，按日提醒 |
| 6 | 丢件 | 人工标记 | — | 计入寄样成本，写日志 |

演示数据 4 条：`status=1`×2、`status=4`×2，无已签收（`=5` 触发需先造 `sign_time`，见 §8 TC-09）。

**C. 达人池 `creator.pool_status`（4 态）+ 保护期**

| 值 | 名称 | 迁移 | 条件与动作 |
| --- | --- | --- | --- |
| 1 | 公海 | 1→2 | 认领：`owner_id=me`、`protect_until=today+30`；CAS 失败 409 |
| 2 | 私海 | 2→1 | 主动退回（清空 owner/protect_until）；或夜间作业：`protect_until<today` 且无 `result≥3` 跟进 → 回收（操作人 `system`） |
| 2 | 私海 | 2→3 | 存在任意非取消 `collaboration` → 自动置"合作中" |
| 3 | 合作中 | 3→1/2 | 合作单全部完结或取消后按保护期重算 |
| 任意 | 黑名单 | →4 | 人工加入，写日志；不参与认领 |

演示数据 12 位达人：公海 5（cosy.ph/gadgetgabe/techtales/dealsdrop/dailyfinds.my）、私海 4、合作中 2、黑名单 1（glowwithme）；chenbd 拥有 4 人（ids 1,3,5,7）、lubd 2 人（ids 2,10），`protect_until` 全部 2026-09-12（基准日 2026-09-18 → 已过期，回收作业应命中 6 人）。

**D. 选品流水线 `selection_flow.stage`（方案 11.2，6 态）**

| 值 | 名称 | 进入条件 | 允许的下一态 | 触发动作 |
| --- | --- | --- | --- | --- |
| 1 | 商品选品登记 | `POST /api/selection`（自动生成编号与盈亏平衡 ROAS） | 2 / 6 | 写第一条流转日志；`>7 天`未进测试 → P1 |
| 2 | 店铺上架测试 | 流转并**必须指定测试店铺**（`shop_id`、`test_started_at`） | 6（结论走接口） | 满 14 天未提交结论 → **P0**；48~72h 首次检测 → P2 |
| 3 | 测试反馈 | `POST /:id/conclusion`（7 个指标一个不许少） | 4 / 2 / 6（经 `conclusion/confirm`） | 快照入库 + 进日志；`>3 天`未落地 → P1 |
| 4 | 销售前准备 | 结论为「通过」并确认落地 | 5 / 6 | 六项清单（资料/价格/库存/渠道/财务/合规）；`>7 天`未清完 → P1 |
| 5 | 正常销售 | 清单全勾完 + 关联 `spu_id` | — | 写 `selling_at`；此后归商品端口动态检测，选品端口只留历史 |
| 6 | 淘汰池 | 流转或结论为「不通过」，**必须写原因** | 1 | 原因进 `reject_reason`，复盘后可「捞回登记」 |

非法流转（如 `1→4`、`1→3`、`5→2`）→ 400；`2→3` 不在流转接口的出边里（`next_stages` 也不报给前端），因为那一跳必须携带数据快照，只能由结论接口产生。每次流转写 `selection_log(from_stage,to_stage,action,operator_id,note)`，链条从登记那一条开始完整。

**E. 其他状态字段（非状态机，仅同步覆盖）**

| 字段 | 取值 | 来源 |
| --- | --- | --- |
| `tk_order.order_status` | 平台原文（`ORDER_STATUS_LABEL` 展示中文） | 同步只覆盖，人工不可改 |
| `tk_return.status` | `PROCESSING/COMPLETED/SELLER_REJECTED` | 同步；只有 COMPLETED 冲减 |
| `tk_shop.auth_status` | 0 未授权/1 已授权/2 即将过期/3 已过期 | 授权 + 每日作业 |
| `live_session.status` | 1 已排班/2 直播中/3 已结束/4 取消 | 人工开播下播 |
| `expense.status` | 1 待付款/2 已付款 | 人工 |
| `sync_log.status` | 1 成功/2 部分失败/3 失败 | 作业 |

---

## 5. 数据模型

### 5.1 表清单（一期 26 张；V2.0 分析/预警表与选品表见 §5.5）

| # | 表 | 作用 | 期次 | 关键业务字段 | 唯一约束（`WHERE is_deleted=0`）| 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `tk_shop` | 店铺 | 1 | `shop_name, tk_shop_id, shop_cipher, region, shop_type, currency, timezone, auth_status, token_expire_at, owner_id, status` | `tk_shop_id` UNIQUE；另含 `app_key_enc/app_secret_enc`（+ 需补 `access_token_enc`，D3） | `[已实现]` 接口 |
| 2 | `tk_account` | 自营 TikTok 账号 | 1 | `handle, nickname, account_type, shop_id, followers, owner_id, account_status, remark` | `handle` UNIQUE | `[已实现]` |
| 3 | `product_spu` | 商品 SPU | 1 | `spu_code, name_cn, name_en, main_image, category, owner_id, status` | `spu_code` UNIQUE | `[待开发]` |
| 4 | `product_sku` | SKU 与返点 | 1 | `spu_id, sku_code, name_cn, spec, rebate_rate, logistics_cost, weight_g, package_size, status` | `sku_code` UNIQUE | `[待开发]` |
| 5 | `shop_listing` | 平台商品↔内部 SKU 映射 | 1 | `shop_id, tk_product_id, tk_sku_id, seller_sku, product_name, sale_price, currency, listing_status, sku_id, map_status, last_sync_at` | `ux_listing_shop_sku(shop_id,tk_sku_id)` | `[待开发]` |
| 6 | `tk_order` | 订单主表 | 1 | `tk_order_id, shop_id, order_status, order_time, paid_time, subtotal, seller_discount, platform_discount, shipping_fee, total_paid, currency, fulfillment_type, carrier, tracking_no, is_sample_order, item_count, est_profit, synced_at` | `tk_order_id` UNIQUE | `[待开发]`（同步 mock `[本迭代]`） |
| 7 | `tk_order_item` | 订单明细（归因载体）| 1 | `order_id, listing_id, tk_sku_id, sku_id, quantity, item_amount, currency, rebate_cny, rebate_matched, creator_id, content_type, content_id, commission_rate, est_commission` | `ix_item_order` + 去重键 `order_id+listing_id+tk_sku_id` | `[待开发]` |
| 8 | `tk_return` | 售后退款 | 1 | `tk_return_id, shop_id, tk_order_id, return_type, reason, refund_amount, currency, status, apply_time, finish_time, responsibility, is_restocked, remark` | `tk_return_id` UNIQUE | `[待开发]` |
| 9 | `creator` | 达人档案 | 1 | `handle, nickname, region, followers, category_tags, avg_views, gmv_level, email, whatsapp, owner_id, protect_until, pool_status, source` | `handle` UNIQUE | `[待开发]`（服务 `creator/protect.ts` `[本迭代]`） |
| 10 | `creator_outreach` | 建联跟进 | 1 | `creator_id, user_id, channel, contact_time, summary, result, next_follow_at` | — | `[待开发]` |
| 11 | `collaboration` | 合作单 | 1 | `collab_no, creator_id, shop_id, spu_id, owner_id, coop_type, commission_rate, fixed_fee, fee_currency, promised_videos, promised_lives, deadline, tk_plan_id, status` | `collab_no` UNIQUE | `[待开发]` |
| 12 | `sample_shipment` | 寄样 | 1 | `collab_id, creator_id, sku_id, quantity, shipping_cost, ship_method, tk_order_id, tracking_no, ship_time, sign_time, status` | — | `[待开发]` |
| 13 | `video` | 视频与带货汇总 | 1 | `tk_video_id, video_url, publisher_type, account_id, creator_id, collab_id, spu_id, shop_id, editor_id, publish_time, views, likes, comments, shares, orders, gmv, status` | `tk_video_id` UNIQUE | `[待开发]` |
| 14 | `live_session` | 直播场次 | **1（Q6 提前）** | `shop_id, account_id, host_id, assistant_id, creator_id, plan_start, plan_end, actual_start, actual_end, status, viewers, peak_online, orders, gmv, ad_spend, review_note` | — | `[待开发]` |
| 15 | `ad_daily` | 广告日报 | 2 | `shop_id, advertiser_id, campaign_id, campaign_name, ad_type, spu_id, video_id, stat_date, spend, currency, impressions, clicks, conversions, gmv` | `ux_ad_daily(shop_id,campaign_id,stat_date,ad_type)` | `[待开发]` |
| 16 | `settlement_txn` | 结算流水 | 2 | `shop_id, statement_id, payment_id, payment_status, tk_order_id, txn_type, amount, currency, statement_time` | `ux_settle_txn(shop_id,statement_id,tk_order_id,txn_type)` | `[待开发]` |
| 17 | `expense` | 费用登记 | 2 | `expense_date, expense_type, shop_id, ref_type, ref_id, amount, currency, amount_cny, payee, voucher, status, remark` | — | `[待开发]`（`finance/rates.ts` `[本迭代]`） |
| 18 | `exchange_rate` | 汇率 | 2 | `rate_date, currency, rate_to_cny, source` | `ux_rate(rate_date,currency)` | `[本迭代]` `rates.ts` |
| 19 | `warehouse` | 仓库 | 3 | `name, wh_type, region, status` | — | `[待开发]` |
| 20 | `stock_ledger` | 库存流水 | 3 | `warehouse_id, sku_id, change_type, quantity, ref_no, operator_id, op_time` | 幂等键 `ref_no+change_type+sku_id`（服务层） | `[待开发]` |
| 21 | `sys_user` | 员工 | 1 支撑 | `username, password, real_name, phone, dept, role_id, status, last_login_at` | `username` UNIQUE | `[已实现]` |
| 22 | `sys_role` | 角色 | 1 | `role_name, role_key, menu_perms(JSON), data_scope, can_see_cost, can_see_contact, can_export` | `role_key` UNIQUE | `[已实现]` |
| 23 | `sys_user_shop` | 数据权限 | 1 | `user_id, shop_id` | `ux_user_shop(user_id,shop_id)` | `[已实现]` |
| 24 | `sys_op_log` | 操作日志（不可改）| 1 | `user_id, op_time, module, action, target_table, target_id, before_after(JSON), ip` | — | `[已实现]` |
| 25 | `sync_log` | 同步日志 | 1 | `task_type, shop_id, window_start, window_end, fetched, inserted, updated, failed, status, error_msg, started_at, finished_at` | — | `[已实现]` 查询侧 |
| 26 | `sys_dict` | 数据字典 | 1 | `dict_type, dict_value, dict_label, sort, status` | `ux_dict(dict_type,dict_value)` | `[已实现]` |
| 27 | `ai_provider` | 模型服务商 | 13 AI | `name, vendor, protocol, base_url, model, api_key_enc, temperature, max_output_tokens, price_in/out_per_1k, supports_tools, enabled, is_default, last_test_*` | `name` UNIQUE(软删过滤) | `[已实现]` |
| 28 | `ai_conversation` | AI 会话头 | 13 | `user_id, title, provider_id, model, message_count, last_message_at` | `ix_ai_conv_user(user_id,id)` | `[已实现]` |
| 29 | `ai_message` | AI 消息 | 13 | `conversation_id, role, content, tool_calls(JSON), tool_name, call_id, prompt/completion_tokens, latency_ms` | `ix_ai_msg_conv(conversation_id,id)` | `[已实现]` |
| 30 | `ai_call_log` | AI 出网调用审计 | 13 | `user_id, provider_id, conversation_id, model, status, tokens, latency_ms, cost_cny, tool_count, error_msg` | `ix_ai_call_user`、`ix_ai_call_time` | `[已实现]` |
| 31 | `ai_action_log` | AI 发起的写入 | 13 | `call_id, conversation_id, user_id, tool_name, status, arguments, result, target_table, target_id, error_msg` | `ix_ai_action_user`、`ix_ai_action_call` | `[已实现]` |

公共 5 字段（方案表 5 约定，全部表已落）：`id`、`created_at`、`updated_at`、`is_deleted`、`remark?`（方案为 `created_by/updated_by` 语义，代码用 `created_at/updated_at + is_deleted`，差异见 `changes-vs-plan` #2）。

### 5.2 索引清单（现状 + 本迭代新增）

| 表 | 现有索引 | 需新增（B9） |
| --- | --- | --- |
| `tk_order` | `tk_order_id` UNIQUE、`ix_order_shop_time(shop_id,order_time)`、`ix_order_status` | `ix_order_sample(shop_id,is_sample_order,order_status)` |
| `tk_order_item` | `ix_item_order(order_id)`、`ix_item_sku(sku_id)` | `ix_item_unmapped(rebate_matched,sku_id)`、`ix_item_creator(creator_id)` |
| `tk_return` | `tk_return_id` UNIQUE | `ix_return_shop_status(shop_id,status)` |
| `sync_log` | `ix_sync_shop_task(shop_id,task_type)` | `ix_sync_started(started_at)` |
| `sys_op_log` | `ix_oplog_user_time(user_id,op_time)` | — |
| 全部唯一索引 | 均带 `WHERE is_deleted = 0`（SQLite 部分索引；MySQL 无部分索引 → 用 `is_deleted` 入键的等价写法，见 `EPIC-0-01`） | — |

### 5.3 三条设计要点 → 硬约束 → 测试

| 方案要点 | 字段落点 | 硬约束 | 回归测试（`EPIC-9-02`） |
| --- | --- | --- | --- |
| 返点与物流快照冻结，改协议不回溯 | `tk_order_item.rebate_cny` / `logistics_cny` | 订单写入时按当时 `rebate_rate` 与 `unitLogisticsCny(sku)×quantity` 冻结；改 `product_sku.rebate_rate` **禁止** UPDATE 任何历史明细 | 老订单行 `rebate_cny` 在改返点率前后逐字节不变 |
| 未配返点率不能按 0 收入 | `rebate_matched=0` | 所有返点/毛利/利润 SQL 必须带 `rebate_matched=1`；GMV 仍计入并显性提示"N 行未配返点率，不计利润" | 把未配返点行的 `rebate_cny` 人为改大 → 毛利/利润数字不变 |
| 样品单不计 GMV | `tk_order.is_sample_order` | 所有 GMV/订单数/退款率/达人业绩口径 `AND is_sample_order=0`；寄样成本走 ROI 分母 | `/api/dashboard/summary.gmv` 与手算（排除 8 条样品单）一致 |
| AI 只能走白名单工具写数据 | `ai_provider.api_key_enc` / `ai_action_log` | key 只进不出（AES-256-GCM + 字段白名单 + `maskError`）；`base_url` 必须 https 且可被 `AI_ALLOWED_HOSTS` 锁死；写工具仅限 `AI_WRITE_TOOLS`，执行时用的是**发起对话那个人的权限与数据范围**，并同写 op_log | `tests/ai.spec.ts`：key 不出接口/不出错误文案、白名单外工具不执行、无 creator 菜单者让 AI 写建联被拒且留痕 |

### 5.4 金额与时间口径

| 项 | 规则 |
| --- | --- |
| 金额类型 | 方案 `DECIMAL(18,2)`；SQLite 侧实为 `REAL`。**对策**：写库前 `round2()`，聚合用"整数分"或 `ROUND(...,2)` 收敛，跨表对账允许 ≤0.5% 容差；对外报表禁止展示超过 2 位小数；`rate_to_cny` 按 `DECIMAL(18,6)` 语义处理（REAL + 展示 4 位）。MySQL DDL 保留 `DECIMAL`（`EPIC-0-01`） |
| **生意模式（先读这条）** | 我们是**品牌服务方（代运营/服务商）**：货和货款都是品牌的，系统里**不存在采购价**。唯一收入 = 品牌按实收 GMV 给的**返点**（`product_sku.rebate_rate`，成交时冻结进 `tk_order_item.rebate_cny`）。我们的支出 = 达人佣金 + 坑位费 + 寄样运费 + 我们承担的物流 + 投流 + 工具费。GMV / 结算实收是**品牌侧的现金**，只作规模参考与对账，一律不算进我们的收入 |
| 毛利率的分母 | 报表与看板的 `est_profit_rate` 分母是**应收返点**（我们自己的收入），不是 GMV —— 用 GMV 当分母会得到一个看着像 3% 的"毛利率"，而真实留存是 20% 上下，两者不可混用。广告侧的 `盈亏平衡 ROAS = 1 / 贡献毛利率`，其中贡献毛利率 =（应收返点 − 物流 − 达人佣金）÷ GMV（保持"每 1 元广告要带回多少元 GMV"这个可操作语义） |
| 物流双记 | SKU 的 `logistics_cost`（逐行冻结）与费用表的「头程物流 / 海外仓费」常是同一笔钱。引擎不猜哪边对：两边同时有数时输出 `warn.logistics_overlap_cny`，由界面说清、运营选边（要么 SKU 记成本、费用不重复记；要么 SKU 填 0、物流走期间费用） |
| 时间 | 一律 UTC 文本 `YYYY-MM-DD HH:MM:SS`（字符串序 == 时间序，便于索引比较）；`stat_date` 存站点自然日 |
| 汇率 | 一律折 CNY：`金额 × rate_to_cny`；CNY 恒 1；取"业务发生当日"，缺失回退更早最近一条并标注；完全缺失不参与汇总 + 告警（B3） |
| 切日 | 站点时区（Q8/B7），US/MX 夏令时用 IANA 计算，禁止固定偏移（D4） |
| 币种 | 订单/广告/费用原始币种 + 统一 CNY 汇总列；界面必须显式标 `CNY` |

### 5.5 选品新增表（方案 11.5，两份方言 DDL 同步维护）

| 表 | 作用 | 关键业务字段 | 唯一约束 |
| --- | --- | --- | --- |
| `selection_flow` | 选品流程状态表（一个候选品一行，流水线本体） | `code`(候选品 ID)、`name/image_url/category`、`brand_name`(品牌方)、`list_price`(建议售价)、`planned_discount`(计划折扣率)、`rebate_rate`/`commission_rate`/`logistics_rate`、`est_margin`(= 返点−佣金−物流，服务端推)、`breakeven_roas`(= 1/est_margin)、`source`、`shop_id/spu_id`、`stage/stage_entered_at`、`owner_id/registered_by`、`conclusion/conclusion_note/reject_reason/adjustments`、`test_started_at/test_snapshot(JSON)`、`checklist(JSON)`、`selling_at` | `ux_selection_code(code)` WHERE `is_deleted=0` |
| `selection_log` | 阶段流转日志表（回溯谁在什么时候把它从哪推到哪） | `selection_id`、`from_stage`(0＝登记前)、`to_stage`、`action`(register/transition/submit_conclusion/confirm_conclusion)、`operator_id`、`note` | 只追加，不更新 |

- 两张表都守同一份公共字段约定（`id/created_by/created_at/updated_at/is_deleted`），由 `tests/schema-drift.spec.ts` 校验两份 DDL 列集合一致；`tests/dialect-ratchet.spec.ts` 钉住"新增业务代码零方言债"（日期差在 JS 里算，SQL 只做文本比较）。
- 演示数据 14 个候选品铺满六个阶段，且每阶段的停留天数刻意做出 绿/黄/红 三档（含 2 个带原因的淘汰），首页 P0 至少命中一条 `SELECTION_TEST_OVERDUE`。

---

## 6. 非功能需求

| 类别 | 要求 | 校验方式 |
| --- | --- | --- |
| 分页上限 | 强制分页，`pageSize ≤ 200`，禁止无 `LIMIT` 全表返回 | `EPIC-9-02` 请求 `pageSize=10000` 断言返回 200 |
| 性能量级 | ≤10 店、≤50 用户、≤3 万订单/月、≤6 万明细行/月；列表 P95<500ms（`pageSize=20`）；工作台 <1.5s（可缓存 60s）；利润报表月度全店 <5s（可异步） | 10 万订单行合成数据压测（`EPIC-9-02`） |
| 报表耗时 | 报表接口 >3s 必须转异步导出 + 轮询；一期可先拒绝并提示缩小范围 | 用例断言 |
| 同步频率 | 订单 15~30 分钟增量（按更新时间，窗口重叠 5 分钟）；结算/广告每日；联盟每小时~每日；`sync_log` 每批一行 | `EPIC-4-04` |
| 告警 | 同步失败、失败条数>0、"平时有单今天 0 条"、授权即将过期、汇率缺失、备份失败 → `sendAlert` 推企业微信/飞书 webhook；未配置降级 `console.warn`；去重 30 分钟（C1/C2） | 单元测试 + 手动注入 |
| 备份 | 每日全量备份，**保留 30 天**（方案 9.1）；SQLite：`.db` 快照 + 清 WAL；MySQL：`mysqldump`/RDS 快照；落 OSS 并加密；失败必告警 | `EPIC-9-03` 脚本 + 演练记录 |
| 恢复演练 | 上线前 1 次"备份→隔离环境恢复→抽查订单数/返点快照/日志条数一致"，留存 `docs/ops/restore-runbook.md`；RPO ≤24h、RTO ≤2h | `EPIC-9-03` |
| 安全 | 生产强制 HTTPS；接口凭证 AES-256-GCM 入库（`encryptSecret`），永不回显、永不入日志（C5）；密码 scrypt 摘要（`hashPassword`，`scrypt$<salt>$<hash>`），最小 8 位；口令/凭证不出现在前端；不存 TikTok 账号密码 | 代码评审 + 日志 grep |
| 越权 | 未认证 401 `code:40100`；无菜单/越权 403 `code:40300`；`data_scope` 过滤后不可见他店数据（不是隐藏按钮，是 SQL 条件） | `EPIC-9-02` 权限矩阵用例 |
| 导出留痕 | 未开通 `can_export` → 403 且不写日志；开通后每次导出写 `sys_op_log(action='export')`，`before_after` 记筛选条件与行数 | `EPIC-1-02` |
| 个人信息 | 达人 `email/whatsapp` 默认掩码、默认禁止导出、被访问写日志；员工离职只停用不删除 | `EPIC-1-03` |
| 审计 | 写操作 100% 走 `writeOpLog`；成本/归属/费用/删除/导出五类必带 before/after；`sys_op_log` 无更新删除入口 | 每条写接口 |
| 软删与可恢复 | 见 B6 | `EPIC-1-03` |
| 幂等 | 所有外部单号唯一索引 + 服务层显式幂等键（费用生成、库存流水、归因回填、自动匹配） | `EPIC-4-02`/`EPIC-9-02` |
| 并发与可用性 | 应用无状态（JWT，8h）可水平扩；SQLite 单写者（WAL + `busy_timeout=5000`），重同步时段避免人工批量改成本，失败需重试提示；上游 5xx/超时退避重试 3 次，最终失败写 `sync_log.status=3` 且不阻塞其他店铺 | 评审 |
| 错误处理 | 4xx 可解释含字段名；5xx 不泄漏堆栈 | `app.ts` |
| 可观测 | 启动打印 `mode=mock|real`；作业打印 店/类型/条数；工作台红点 = 最近异常；保护期回收/寄样超期/汇率缺失执行结果落 `sync_log` 或操作日志 | `EPIC-4-04` |
| 兼容性 | Chrome/Edge 最新两大版本；≥1280×720；4 个高频页 ≥375px 可用（Q12） | 手工 |
| 环境 | Node 24（`engines >=22.5.0`）、TS 严格模式、ESM + `.js` 后缀导入、无 ORM（`node:sqlite` 薄封装 + 手写 SQL） | `npm run build` |
| 交付物 | 可运行代码 + 26 表 SQLite/MySQL 双 DDL + 演示数据 + 本 PRD + 开发规范 + 34 张可导入 GitHub 的 Issue + 验收记录 | §8 |

---

## 7. 接口对接策略

### 7.1 数据源与频率（方案第七章 → `sync_log.task_type`）

| task_type | 目标表 | 官方来源 | 方式与频率 | 能力确定性 | 兜底 |
| --- | --- | --- | --- | --- | --- |
| `order` | `tk_order`,`tk_order_item` | TikTok Shop 开放平台（Partner Center）订单接口 | 接口；**15~30 分钟增量**（按更新时间，窗口重叠） | 高 | CSV 导入（`EPIC-1-02`） |
| `product` | `shop_listing` | 商品接口 | 接口；每日 + 手动 | 高 | CSV 导入 |
| `listing` | `shop_listing` 预匹配 | 同上，按 `seller_sku`↔`sku_code` | 商品同步后触发 | 中 | 人工绑定 |
| `returns` | `tk_return` | 售后接口 | 接口；每小时~每日 | 高 | 人工登记 |
| `settlement` | `settlement_txn` | 财务接口（结算单/结算单交易明细/未结算交易） | 接口；每日 | 高 | 财务导入（利润降级为预估） |
| `affiliate_order` | `tk_order_item.creator_id/content_type/content_id/commission_rate/est_commission` | 联盟卖家接口（Affiliate Seller API）联盟订单查询 | 接口；每小时或每日 | **中（需开通联盟权限）** | 按 `video` 人工归因 |
| `ad` | `ad_daily` | TikTok API for Business（含 GMV Max 报表） | 接口；每日 | 中（需广告账户管理员授权） | 后台导出表导入 |
| `video` | `video.views/likes/comments/shares` | **官方覆盖范围需逐项核实** | 可用则每日 | **低** | 表格导入/人工 |
| `live` | `live_session.viewers/peak_online/orders/gmv` | **官方覆盖范围需逐项核实** | 每场次 | **低** | 直播后台导出导入 |
| （按需）联盟达人搜索 | `creator` 一键入库 | 联盟卖家接口达人搜索（GMV/关键词/人群） | 按需 | 低-中 | BD 手工录入 |
| （每日）汇率 | `exchange_rate` | 公开牌价 | 每日 | 中 | 财务月填（`source=2`） |
| 内部数据 | 联系方式/沟通/坑位费/头程 | 公司自有 | 人工录入 / Excel | — | — |

> 接口路径、字段与签名以 Partner Center / TikTok API for Business 当期官方文档为准。**权限审批时间不计入开发周期**（方案第七章原文，写进交付计划）；`real` 模式可用性以客户完成授权为前置（Q9）。需客户提供：① 店铺主账号；② 开发者注册企业资质；③ 广告账户管理员授权。
> 原则（方案第七章）：**能走官方接口全部走官方接口**；接口覆盖不到用卖家中心/罗面导出表格一键导入兜底（`EPIC-1-02`）。
>
> 口径变更（2026-09-20，客户决定）：原文「不爬网页、不模拟登录」放宽为**允许浏览器辅助抓取**，但硬约束不变——
> ① 只复用运营本人已登录的卖家中心/罗面会话，系统**不采集、不存储、不代填 TikTok 账号密码**（凭证红线见 8.2）；
> ② 抓取结果一律经 `POST /api/system/import` 的幂等通道入库并标 `source='web'`，与人工表格（`source='manual'`）在 `sync_log`/`sys_op_log` 里可分开对账；
> ③ 自动化访问仍受平台风控与条款约束，抓取节奏与失败重试由使用方自担，接口能覆盖的字段一律以接口为准。

### 7.2 mock / real 双实现

| 项 | 说明 |
| --- | --- |
| 开关 | `TIKTOK_API_MODE=mock|real`，默认 `mock`；读自 `apps/server/src/config.ts`；启动日志打印 `mode=` |
| mock | 不访问外网；provider 从本地 fixtures（与 `db/seed.ts` 确定性 RNG 同构）返回分页数据，走**完全相同**的 upsert/快照/日志代码路径 |
| real | 走 `config.tiktokBaseUrl`（默认 `https://open-api.tiktokglobalshop.com`）与 `config.adsBaseUrl`（`https://business-api.tiktok.com`）；凭证从 `tk_shop.app_key_enc/app_secret_enc(+access_token_enc)` 经 `decryptSecret()` 取，仅内存使用 |
| 端口 | `TiktokProvider`：`searchOrders/searchProducts/searchReturns/listSettlements/listAffiliateOrders/listAdDaily/getVideoStats/getLiveStats`；`ExchangeRateProvider.daily()`；`getProvider()` 按 mode 注入 |
| 分层约束 | provider 只做"拉取 + 归一化到本系统字段"；**写库、返点与物流冻结、同步日志一律在 service 层**，保证 mock 与 real 结果一致可测 |
| 签名 | real 模式按官方 `X-Tt-Signature`（HMAC-SHA256，参数排序 + body hash）实现，统一封装在 `services/tiktok/client.ts`，禁止在业务层拼签名 |
| 测试 | vitest 固定 `mock`；real 无凭证时 `skipIf` |

### 7.3 同步对外接口

| method + path | 说明 | 权限 | 状态 |
| --- | --- | --- | --- |
| `GET /api/sync/tasks` | 可跑任务清单（`order/listing/product/returns/affiliate/affiliate_order/aggregate/all`）+ 已注册 cron 表达式回读 | `requireMenu('system')` | `[已实现]` `sync.routes.ts:114+` |
| `POST /api/sync/run` | `{task_type, shop_id?, window_start?, window_end?}` 手动补跑，每次留 `sync_log` 行 | `requireMenu('system')` | `[已实现]`（`EPIC-4-02` 只需补幂等/结算类任务与测试） |
| `GET /api/sync/logs` | 同步日志分页（等价 `/api/system/synclog`，保留后者兼容前端） | `requireMenu('system')` | `[已实现]` |
| `GET /api/sync/health` | 每店每任务最近一次状态，供工作台红点 | `requireMenu('system')` | `[已实现]` |
| `POST /api/sync/import/orders` | 表格导入订单兜底（复用同步 upsert 通道，`importOrdersForShop`） | `requireMenu('system')` | `[已实现]` |
| `GET /api/system/synclog[/health]` | **重复入口且无权限校验**（D15） | 应同为 `system`，当前**登录即可** | `[已核实缺陷]` → `EPIC-4-04` |
| `POST /api/shops/:id/auth` | 重新授权（当前 body 只收 `app_key/app_secret/shop_cipher/token_expire_at`，**不收 access token**） | `shop` | `[本迭代]` 补 `access_token` → `EPIC-4-01` |
| `GET /api/shops/mine` | 范围内店铺下拉 | 登录即可 | `[已实现]` |

---

## 8. 验收标准

### 8.1 一期 DoD（19 表 + 8 个一级菜单，全部满足才算完）

- [ ] `npm run build`、`npm run lint`（`tsc --noEmit`）**零错误**（盘点时 45 个：product 21 / finance.routes 16 / `services/finance/profit.ts` 6 / order.routes 2，D5 必须清零）、`npx vitest run` 全绿（当前仅 `creator.spec.ts` 44 用例，其余 10 模块 0 覆盖，D9）。
- [ ] `schema.sqlite.sql` 26 表与 `packages/shared/src/types.ts` 字段一一对应，无孤儿字段；`schema.mysql.sql` 等价 DDL 已存在（583 行）→ 本迭代只需补 `access_token_enc` 与两侧索引对齐（`EPIC-0-01`/`EPIC-4-01`）。
- [ ] 一期菜单 dashboard/shop/product/order/creator/content/system 全部可操作；每个接口都有 `requireMenu` + 数据范围 + 写操作日志。
- [ ] **调度器挂载完成（D10）**：`startScheduler()` 注册 `registerSyncJobs` + `registerCreatorJobs`，`ENABLE_SCHEDULER=false` 时可全关；`sync_log` 出现自动写入的行。
- [ ] **利润口径收口为一处（D11）**：删除死副本 `services/finance/{profit,rates}.ts`，`order.routes.ts` 内联聚合与 `dashboard` 均改为 import `services/profit.ts`；同一期间三处（订单汇总条 / 利润报表 / 工作台卡片）`gmv_cny`、`est_profit_cny` 完全相等。
- [ ] 订单同步（mock）跑通：演示 260 单 / 523 明细重复执行不产生重复行；2 条待映射 listing 与 6 条待映射明细进入工作台与 `/products/unmapped`。
- [ ] §5.3 三条口径（返点快照冻结 / 未配返点率不计利润 / 样品单不计 GMV）各有 ≥1 个专项测试。
- [ ] BD 数据隔离回归通过：`chenbd` 可见自己 4 位私海达人（D1 已修，转为回归用例）；同时断言 `content` 角色访问 `/api/orders` 被 `requireMenu` 403 拦住（防 D1 复现）。
- [ ] 四条流程（§4.1~4.4）在真实浏览器按 §8.3 用例验收通过，留存步骤与截图。
- [ ] 10 角色 × 敏感字段权限矩阵自动化用例通过。
- [ ] 演示账号（12 个，密码 `Passw0rd!`）可直接登录；`README.md` 从零跑通无人工干预。
- [ ] `EPIC-0-01 ~ EPIC-8-03` 中一期范围 Issue 全部关闭并回填实际接口路径。

### 8.2 二期 / 三期 DoD

| 期 | DoD |
| --- | --- |
| 二期（+5 表 = 24） | 结算/广告/费用/汇率四表可同步或录入且幂等（唯一索引命中）；利润报表 4 维度与 `settlement_txn` 汇总误差 ≤0.5%，`is_estimated` 标注正确；汇率缺失/回退有告警且报表可解释，历史报表不因今日汇率变化而变；逐单对账可定位差异来源（退款未入账/佣金差异/汇率差异）；`ProfitRow` 契约测试 + 导出带权限与日志 |
| 三期（+2 表 = 26） | `stock.routes.ts` 已在 `app.ts` 挂载；仓库/流水/查询三页可用；销售出库/退货入库/样品出库自动生成幂等（`ref_no+change_type+sku_id`）；库存 = 流水汇总恒等式通过；历史流水无 PUT |

### 8.3 端到端验收用例（10 条，输入与期望数值基于演示库 `apps/data/tk_ops.db`，基准日 2026-08-18 种子 RNG=20260814、系统基准 `2026-09-18`）

| ID | 场景 | 输入 | 期望（可断言） | 权限/口径 |
| --- | --- | --- | --- | --- |
| TC-01 | 越权与掩码 | 以 `limy`（运营，`data_scope=4`，仅授权店 1）登录 | `GET /api/dashboard/summary` 返回 `est_profit === "***"`；`GET /api/system/oplog` → **403 `code:40300`**；`GET /api/shops` → `total === 1` 且响应体**不含** `app_key_enc`/`app_secret_enc` 键；`GET /api/shops/3` → 403 | §2.3、D2 |
| TC-02 | BD 达人隔离 | 以 `chenbd`（`data_scope=3`）登录 | `GET /api/creators/mine` → `total === 4`（ids 1,3,5,7）；`GET /api/creators/collab` → `total === 6`（全部 owner=chenbd）；以 `lubd` 登录 → `mine.total === 2`（ids 2,10）；`GET /api/creators/pool` → `total === 5` 且不含他人私海达人的 `email/whatsapp` | D1 |
| TC-03 | 返点与物流快照不回溯 | 演示 SKU（`rebate_rate=0.22`、`logistics_cost=14`）→ 其历史订单行 `rebate_cny` 记为 X、`logistics_cny = 14 × qty` | 改 `rebate_rate` 0.22→0.30（`PUT /api/products/skus/:id`）后：X 与 `logistics_cny` 逐字节不变；只有之后同步进来的行才按 0.30 冻结；`sys_op_log` 新增 1 行 `action='update'` 且 `before_after` 含 `0.22→0.3` | §5.3 要点 1 |
| TC-04 | 未配返点率不按 0 收入进利润 | `GET /api/dashboard/summary` | `unmapped_listings === 6`（演示 `tk_order_item` `sku_id IS NULL AND rebate_matched=0` 共 6 行）；把其中若干行 `rebate_cny` 人为改成 99999 → `est_rebate`/`est_gross_profit` 数字**不变**（同时 `warn.unmapped_items` 仍报这 6 行，界面写"不计利润"而不是"利润为 0"）；`/api/products/unmapped?tab=B` 可列出这些行 | §5.3 要点 2 |
| TC-05 | GMV 口径 | `GET /api/dashboard/summary?days=30`（店全选，boss） | `orders` 与手算"近 30 天、非 CANCELLED（37 条）、非样品单（8 条）"一致 = **111 单**；`total_paid` 合计 **130595.11** 量级一致（差异仅由币种折算解释）；`gmv` 与"排除 `is_sample_order=1`"手算一致 | §5.3 要点 3 |
| TC-06 | 同步幂等 | 连续执行 `POST /api/sync/run {task_type:'order', shop_id:1}` **3 次**（mock，重叠窗口） | `tk_order`/`tk_order_item` 行数 3 次后完全不变；第 2、3 次 `sync_log.inserted === 0` 且 `updated ≥ 0`；旧报文（`updated_at` 更早）不得覆盖已有 `order_status` | B1 |
| TC-07 | 认领并发 | `chenbd` 与 `lubd` 同时 `POST /api/creators/5/claim` | 恰好 1 个 200，另 1 个 **409 `code:40900`**；成功后 `pool_status=2`、`owner_id` 唯一、`protect_until = today+30`；`sys_op_log` 只 1 条认领记录 | B2、§4.5C |
| TC-08 | 状态机非法流转 | `PUT /api/creators/collabs/:id/status` 依次传 `5`（当前 1）、`3`（当前 6）、`1`（当前 8） | 三次均 **400**，`message` 含"非法流转"与当前态/目标态；合法链 `1→2→3→4→5→6` 逐次 200 | §4.5A |
| TC-09 | 寄样超期闭环 | 给某 `status=3` 寄样单登记 `sign_time = today-8`，跑夜间作业 | 该单 `status → 5`；工作台 `samples_overdue ≥ 1`；触发 1 条告警（30 分钟内重复跑不再推）；随后录入视频链接（合法 `/video/123456789`）→ `video` 新增、`sample.status=4`、`collab.status=5`、`creator.pool_status=3` | C8、§4.5B |
| TC-10 | 交接 + 汇率缺失 | ① `POST /api/system/transfer-creator {from_user_id: chenbd, to_user_id: lubd}`；② 删除 SGD 当日与更早全部汇率 | ① 返回 `{creators:4, collabs:5}`；lubd 私海由 2 → **6**，chenbd 私海 → 0；写 1 条汇总日志。② 涉及 SGD 的行不参与 CNY 汇总且接口返回 400 `code:40010`（或报表页显式"汇率缺失"标记），并发出汇率缺失告警；**不得**按 1 折算 | B3、方案 8.2 |

导出用例：`GET /api/orders/export?…` 以 `limy`（`can_export=0`）→ 403 且**无** `action='export'` 日志；以 `finwu`（`can_export=1`）→ 200 CSV（带 BOM）且新增 1 条 export 日志含筛选条件。

---

## 9. 里程碑与工时（对照方案第十章校准）

### 9.1 工时（人日，2 人全栈并行；按 §0.1 实测进度校准）

| 期 | 范围 | 方案参考周期 | 总盘子 | 已完成 | **剩余** | 剩余构成 |
| --- | --- | --- | --- | --- | --- | --- |
| 一期 核心打通 | 19 表能力 + 7 菜单 + mock 同步 + 权限 | 4~5 周 | 27 | **≈17**（基座 5 + 商品/达人/内容后端 8 + 前端骨架 4） | **≈10** | 订单后端 3、看板后端 1.5、调度器接线 1.5、类型错误清零 1、导出与权限收口 1.5、测试基线 1.5 |
| 二期 经营核算 | +5 表、ads/finance 菜单、结算口径报表、对账 | 约 3 周 | 9 | **≈0.5**（汇率服务已写） | **≈8.5** | 财务后端 3、广告后端 2、利润引擎收口 2.5、对账 1 |
| 三期 库存（可选） | +2 表 | 1.5~2 周 | 4 | **≈0**（仅 3 个前端页） | **≈4** | 后端 2.5 + 联动 1.5 |
| 交付工程 | CI/部署/备份/演示数据/文档 | 方案未列 | 5 | **≈0** | **≈5** | CI 1.5、部署备份 2、交付文档与演示校准 1.5 |
| 合计 | — | 8.5~10 周（串行） | **45 人日** | ≈17.5（39%） | **≈27.5 人日 ≈ 2 人 2.75 周；+25% 缓冲 ≈ 3.5 周** | 一期日历时间比方案短，因基座（26 表双方言 DDL、鉴权/RBAC、CRUD 组件、演示数据、三域后端主体）已完成 |

> 剩余关键路径（决定发布日）：**订单后端 → 调度器接线 → 利润引擎收口 → 看板/报表 → 测试基线**。前端 33 页里有 12 页（订单 3 / 财务 4 / 广告 1 / 库存 3 / 看板 1）依赖尚未实现的后端，属同一批出口。

### 9.2 里程碑

| 里程碑 | 内容 | 出口判据 | 剩余日历日 |
| --- | --- | --- | --- |
| M0 收口阻断项 | 类型错误 35→0、调度器挂载（D10）、利润引擎二选一（D11）、`.env.example` | `npm run build/lint/test` 三绿 + `sync_log` 出现自动写入行 | +4 |
| M1 订单可用 | 订单/明细/售后后端 + 成本快照 + 归因列（前端 3 页联调） | TC-03/04/05 通过 | +8 |
| M2 同步闭环 | mock provider 收口 + `access_token_enc`（D3）+ 订单/商品/售后同步幂等 + 五类告警 | TC-06/07/08/09 通过 | +12 |
| M3 一期发布 | 看板后端 + 导出中心 + 回收站/权限收口 + 权限矩阵测试 + 演示环境 | §8.1 全绿 | +15 |
| M4 经营核算 | 结算/广告/费用/汇率后端 + 利润报表 + 逐单对账 | §8.2 二期 DoD、TC-10 通过 | +22 |
| M5 生产就绪 | Docker + MySQL 切换 + OSS 备份 + 恢复演练 + 交付文档 | 恢复演练记录 + 真实店铺 `real` 联调 1 家 | +26 |
| M6 库存（可选） | 后端三接口 + 挂载 + 三类自动出库 | §8.2 三期 DoD | +30 |

> 关键路径与外部依赖（不占开发日历但阻塞联调）：平台开发者应用创建、店铺主账号授权、联盟接口权限审批、广告账户授权、阿里云账号与 OSS AccessKey（Q9/Q10）。这些必须在 M2 结束前发起，否则 M4 的"真实利润口径"无法验证。

---

## 10. 需求追踪表（表 ↔ 菜单 ↔ Issue `number`）

`number` = `docs/issues/*.md` front matter 的 `number`（1~34，与文件名排序一致），导入 GitHub 后即为 Issue 号（见 `scripts/github-import.md`）。

| 表 | 一级菜单 | 交付 Issue（number / 文件名） |
| --- | --- | --- |
| `tk_shop` | shop | 4 `EPIC-1-03`（列白名单）、12 `EPIC-4-01`（凭证列）、1 `EPIC-0-01`（DDL 对齐） |
| `tk_account` | shop | 31 `EPIC-9-01`（前端联调） |
| `product_spu` / `product_sku` | product | 5 `EPIC-2-01` |
| `shop_listing` | product | 6 `EPIC-2-02`、7 `EPIC-2-03` |
| `tk_order` / `tk_order_item` | order | 9 `EPIC-3-01`、13 `EPIC-4-02`、11 `EPIC-3-03`、28 `EPIC-8-01` |
| `tk_return` | order | 10 `EPIC-3-02`、13 `EPIC-4-02` |
| `creator` | creator | 16 `EPIC-5-01`、20 `EPIC-5-05` |
| `creator_outreach` | creator | 17 `EPIC-5-02`、20 |
| `collaboration` | creator | 18 `EPIC-5-03`、20 |
| `sample_shipment` | creator / stock | 18、8 `EPIC-2-04` |
| `video` | content | 21 `EPIC-6-01`、23 `EPIC-6-03` |
| `live_session` | content | 22 `EPIC-6-02`、23 |
| `ad_daily` | ads | 24 `EPIC-7-01`、14 `EPIC-4-03` |
| `settlement_txn` | finance | 25 `EPIC-7-02`、14 |
| `expense` | finance | 26 `EPIC-7-03`、18 |
| `exchange_rate` | finance | 26、28 `EPIC-8-01` |
| `warehouse` / `stock_ledger` | stock | 8 `EPIC-2-04` |
| `sys_user`/`sys_role`/`sys_user_shop`/`sys_op_log`/`sys_dict` | system | 2 `EPIC-1-01`、4 `EPIC-1-03`、5（导出）/ 3 `EPIC-1-02` |
| `sync_log` | system / dashboard | 15 `EPIC-4-04`、29 `EPIC-8-02` |
| `selection_flow` / `selection_log` | selection（选品管理） | 35 `EPIC-10-01` |
| 跨表汇总（工作台/报表） | dashboard / finance | 28、29、30 `EPIC-8-03` |
| 前端骨架与 33 个页面 | 全部 | 31 + 各模块联调 Issue 7, 11, 20, 23, 27, 30 |
| 测试 / CI / 部署 / 交付 | — | 32 `EPIC-9-02`、33 `EPIC-9-03`、34 `EPIC-9-04` |

Epic 总览与依赖见 `docs/epics.md`；与方案原文的差异清单见 `docs/changes-vs-plan.md`。
