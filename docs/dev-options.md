# 开发选项清单（建议 1–12）

来源：2026-09-22 全链路冒烟（`npm run smoke`）+ 三轮全项目审验之后，对照 GitHub 上同类项目整理出的 12 项可选开发方向。
这里只写「按本项目当前实际情况值不值得做、怎么做、怎么算做完」，不做技术选型布道。

**状态图例**：✅ 已落地（有提交与测试）｜🟡 部分落地｜⬜ 待做｜📖 仅作参考，不建议改现有实现

**共同约束**（任何一项都不得违反）：技术栈保持 Express 5 + `node:sqlite` + Vue 3 + Element Plus；
阈值/开关一律走 `config.ts`（环境变量），不许写死；导出必过 `requireExport` + 掩码 + `sys_op_log(action='export')`；
`app_key/app_secret/access_token/sign` 不得出现在日志、错误文案与响应体里；规则引擎只提示不自动执行。

---

## 1. 接口限流 ✅ 已落地（`136c865`）

- **当时的现状**：全站零限流。拿到令牌就能无节制遍历 212 条路由；`/api/auth/login` 可以无限次试口令。
- **做法**：`core/rateLimit.ts` + `express-rate-limit@8`，三档——登录（IP+用户名，`skipSuccessfulRequests` 只数失败，默认 10 次/15 分钟）、全局 API（IP，600/15 分钟）、导出（IP，只对 `/export*`、`/import/template` 计数，20/15 分钟）。429 走项目信封 `{code:42900}` 并带 `RateLimit` 标准头。
- **验收**：`tests/rate-limit.spec.ts` 7 例（含「锁住 boss 不影响 finwu」「成功登录不占额度」）；`npm run smoke` 末尾三套极小阈值服务实测 429。
- **剩余风险 / 后续选项**：计数在单进程内存里，多实例部署会各算各的 → 届时换 Redis store；
  部署在 nginx 后**必须**设 `TRUST_PROXY=1`，否则全站共用一个计数桶（已写进 `docs/development-standards.md` §6.1.1）。

## 2. 压首屏体积 ✅ 已落地（`20f23de`，任务 #36）

- **现状（实测）**：`apps/web/dist/assets/` 两个 index chunk 分别 **1,262,848B（gzip 409,085B）** 与 **1,126,635B（gzip 377,339B）**。
  原因在 `apps/web/src/main.ts`：`import ElementPlus from 'element-plus'` 全量引入 + `import 'element-plus/dist/index.css'` 全量样式 + `for (const [name, comp] of Object.entries(ElIcons)) app.component(name, comp)` 把**全部图标**注册成全局组件；echarts 被 3 个页面（DashboardView / LiveList / ProductAbc）直接引入。路由已是懒加载（`LiveList-*.js` 只有 15KB），所以体积几乎全是 vendor。
- **做法**：① `unplugin-vue-components` + `unplugin-auto-import` 按需引入 Element Plus 与其样式；② 图标改成用到哪个 import 哪个（或只注册高频的几个）；③ `vite.config.ts` 加 `build.rollupOptions.output.manualChunks` 拆 `element-plus` / `echarts` / `vendor`；④ echarts 按需 `import { LineChart } from 'echarts/charts'`。
- **工作量**：1 人日。**验收**：最大 chunk 降到 500KB 以下（gzip < 200KB）；`npm run lint && npm run test && npm run build` 全绿；
  浏览器逐页走查无「组件未注册 / 样式丢失」（按需引入最常见的坑）——走查页面清单见 `docs/prd.md` §3 的菜单表。
- **风险**：`ElMessage/ElMessageBox` 这类函数式组件的样式按需引入容易漏，需要显式 import 其 style；`ResourcePage.vue` 里动态用的组件（`el-date-picker` 等）要保证被 resolver 扫到。

## 3. XLSX 导出与导出中心 🟡 部分落地（`3f822cc`，余量在任务 #30）

- **当时的现状**：PRD B8 要求 CSV 与 XLSX 两种格式，实际五个导出接口三套写法（两个只回 JSON、两个各自拼 CSV、一个 `sendCsv`），
  且**前端一个导出按钮都没有**；PRD D13 已点名「CSV 转义逻辑在每个文件里各写一遍」。
- **已做**：`core/export.ts` 成为唯一出口（表头 + 行数据 → `?format=csv|xlsx`）；XLSX 用 ExcelJS `stream.xlsx.WorkbookWriter` 逐行 commit 直接进 response，不堆整份工作簿；
  落地 B8 的行数上限（`EXPORT_MAX_ROWS`，默认 2 万行，超了 400 让人缩小范围）；新增 `ExportButton.vue`（无 `can_export` 不显示），`ResourcePage` 的 toolbar 插槽透出当前 `query`，接进订单 / SKU / 广告日报 / 利润报表四页。
- **验收**：`tests/export.spec.ts` 13 例——XLSX 用 ExcelJS **反解**核对表头与首行、与 CSV 同源比对、BOM 与 JSON 老口径不变、bd 无导出权限 403、无成本权限 403、行数上限拒绝；冒烟对五个导出各打 csv+xlsx 并校验文件魔数（`PK` / UTF-8 BOM）。
- **还没做（#30 的导出半边）**：PRD D13 列的九类导出（SPU / 待映射清单 / 达人 / 合作单 / 寄样 / 视频 / 直播 / 费用 / 广告日报之外的）尚未补齐；
  `/api/finance/settlement/reconcile/export` 有接口但**没有页面承载**（结算逐单对账页缺失）；超 2 万行的异步导出任务 + 站内提示（B8 的二期）。
  做法：新导出接口一律走 `sendTable`，别再自己拼字符串；异步导出可复用 `sync_log` 的写法（一条任务记录 + 状态轮询）。

## 4. OpenAPI 契约与前端类型安全 ✅ 已落地（`77ae21d`，任务 #37）

- **现状**：212 条路由没有机器可读的契约。本轮冒烟抓到的三个缺陷（`/api/creators/roi` 死路径、`/api/system/dict` 整页 500、同步任务下拉 4 项后端不认）本质都是**前后端契约漂移**，靠人读代码发现。
  目前只有过渡手段：`scripts/route-inventory.mjs` 扫源码出路由清单 + `tests/route-contract.spec.ts` 把清单整体打一遍断言无 404/500，并解析 `SyncLogList.vue` 的下拉常量逐个真发请求。
- **做法**：参考 [express-zod-api](https://github.com/RobinTail/express-zod-api) / [openapi-zod-client](https://github.com/astahmer/openapi-zod-client)，
  逐模块给路由补 zod schema（本项目 zod 已是入参校验的既有写法，改造面小），生成 OpenAPI，再从 OpenAPI 生成前端 TS 客户端，替掉手写 `apiGet<T>()` 的 `T`。
- **工作量**：3–5 人日（按模块渐进，不必一次全改）。**验收**：`docs/openapi.json` 进仓库并由 CI 校验「生成物与代码一致」；前端不再有手写响应类型；新增一条契约测试：OpenAPI 里的路径集合 === `collectRoutes()` 的路径集合。
- **风险**：渐进迁移期会存在「一半路由有 schema、一半没有」，要给未迁移路由留兜底；`@tk/shared` 里已有的枚举/类型要继续作为单一来源，别让生成物和它打架。

## 5. Playwright 端到端 ✅ 已落地（`npm run e2e`，50 例，任务 #38）

- **现状**：浏览器验收全靠人工（任务 #6、#7 至今 pending）。冒烟只覆盖 HTTP 层，**页面渲染、表单联动、下载、权限可见性**没有任何自动化。
- **做法**：[Playwright](https://playwright.dev/) 起 3 条关键路径就够回本：① 九个账号登录 → 断言菜单与页面可见性符合角色（RBAC 回归）；
  ② 导入中心走一遍（下载模板 → 填两行 → 提交 → 断言 `source='web'` 落库）；③ 行动中心：跑规则 → 出现预警 → 处置 → 效果回看。
  再加一条「每页都能打开且无 console error」的兜底遍历（可直接复用 `route-inventory` 的思路，遍历前端路由）。
- **工作量**：2–3 人日。**验收**：`npm run e2e` 本地可跑；CI 里用官方 action 跑；失败留截图与 trace。
- **注意**：e2e 必须跑在**独立的临时库**上（`DB_FILE` 指到临时文件），绝不能碰仓库里那份演示库 `apps/data/tk_ops.db`（项目红线）；
  headless 环境下 Element Plus 的下拉/弹层要点开才能断言，优先用 `data-testid` 而不是文案选择器。

## 6. SQLite → PostgreSQL/MySQL 迁移路径 🟡 地基已落地（任务 #39）

- **现状**：`apps/server/src/db/schema.mysql.sql` **已经存在**（37 张表，与 `schema.sqlite.sql` 数量一致），但没有任何代码加载它——运行时只有 `node:sqlite` 的 `DatabaseSync` 一条路，SQL 里也是 SQLite 写法（`datetime('now')`、`IFNULL`、`substr(order_time,1,10)`）。也就是说：那份 MySQL DDL 现在只是文档，既没有驱动/迁移路径，也没有「两份 schema 是否已经漂移」的校验。
- **做法**：① 先加一条**漂移校验**（两份 DDL 的表名/列名集合对拍，进 `npm test`），否则那份 MySQL DDL 会继续悄悄过期；
  ② 数据搬迁用 [pgloader](https://pgloader.readthedocs.io/en/latest/ref/sqlite.html) 一条命令（自动映射类型）；
  ③ 代码侧把方言差异收口到 `core/db.ts`（现在已是唯一出入口，改造点集中），逐个替换 `IFNULL/datetime()/substr(order_time,1,10)/AUTOINCREMENT`。
- **工作量**：漂移校验 0.5 人日；数据搬迁 0.5 人日；方言收口 3–5 人日。**验收**：同一套测试（243 例）在两种库上都绿；`npm run smoke` 在 PG 上跑通。
- **建议时机**：只有真的要多人并发写、或数据量超过单机 SQLite 舒适区时才做；否则先用 WAL + 定期备份顶着。

## 7. 后台任务队列 ✅ 已落地（`d6e3685`，任务 #41）

- **现状**：`jobs/scheduler.ts` 用 `node-cron` 在**同一个进程**里跑同步/聚合/规则评估；重活（一键全量补跑）是请求内同步执行，HTTP 会一直挂着。
- **做法**：两条路——① [BullMQ](https://bullmq.io/)（重试、延迟、并发控制齐全，代价是引入 Redis）；
  ② 不引依赖：用现有 `DatabaseSync` 自建任务表（`job_queue`：状态/重试次数/下次执行时间），由 cron 轮询领取。以本项目「单进程 + SQLite」的形态，②更契合，且 `sync_log` 已经是一套可复用的任务记录范式。
- **工作量**：②约 2 人日。**验收**：一键全量补跑立即返回任务 ID，前端轮询进度；进程重启后未完成任务能续跑；失败自动重试有上限并写 `sync_log.status=3`。
- **触发条件**：当「同步一次超过 30 秒」或「需要多实例部署」时再做，否则属于过度设计。

## 8. 权限策略外置（Casbin） 📖 仅参考

- **现状**：权限三层（菜单 → 数据范围 → 敏感字段/导出）写在 `core/auth.ts` 的 `requireMenu/shopScope/personScope/maskFields` 里，角色定义在 `packages/shared/src/constants.ts`，可以在 `RoleList.vue` 界面上改。
- **可借鉴**：[node-casbin](https://github.com/apache/casbin-node-casbin) 的 RBAC with domains 模型，与本项目 ALL/SHOPS/SELF 三档数据范围同构；其 policy 文件外置的思路可以用来做**权限矩阵快照测试**。
- **不建议**：替换现有实现。现在的写法与 SQL 拼装是一体的（`shopScope` 直接产出 `AND ...` 片段与参数），换成中间件式策略引擎反而要把数据范围二次翻译成 SQL。
- **可落地的小步**：加一条测试，把「角色 × 菜单 × 数据范围 × 成本可见」的矩阵与 `constants.ts` 对拍，防止改角色定义时静默放权。

## 9. 字段级权限与审计范本 🟡 已落地最小版（任务 #43）

- **可借鉴**：[NocoBase 的 RBAC 设计](https://github.com/nocobase/nocobase)（数据范围按「创建人/本部门/全部」分级 + 操作级权限）与本项目几乎一一对应，可对照检查有没有漏掉的操作级开关；
  [Directus](https://github.com/directus/directus) 的 `directus_revisions`/`activity` 双表是审计日志的成熟范本——本项目 `sys_op_log` 只有 before/after JSON，没有「哪次改动造成的」链路，做数据回溯时不如双表清晰。
- **现状差距**：`can_see_cost`/`can_see_contact`/`can_export` 三个开关是**角色级**的，没有字段级白名单；`sys_op_log` 无更新删除入口（符合 PRD §审计要求），但也没有按记录聚合的「这条 SKU 的成本被谁改过几次」视图。
- **可落地的小步**：给成本类字段做一份集中式字段白名单（现在散在各路由的 `maskFields` 调用里），并加一个「单条记录的变更历史」查询页（`sys_op_log` 按 `target_table + target_id` 聚合即可，无需改表）。

## 10. TikTok 官方 SDK 与 real 模式校准 🟡 脚手架已就绪，联调仍待授权（任务 #42）

- **现状**：`config.tiktokMode` 默认 `mock`；`services/tiktok/realClient.ts` 的签名与按店铺 access token 已按文档修过一轮（任务 #19），但**从未与真实店铺联调**——这是整个项目最大的未验证假设。
- **做法**：按 [官方 Node.js SDK 与文档](https://partner.tiktokshop.com/docv2/page/integrate-node-js-sdk) 逐个接口对齐签名、错误码、分页游标与限流规则；
  参考 [ttspc-sample-shared-types](https://github.com/tiktok/ttspc-sample-shared-types) 的做法，把平台响应类型收进 `@tk/shared`，让 mock 与 real 共用同一份契约类型（现在两边各自解释字段）。
- **工作量**：2–3 人日 + 一个真实店铺授权。**验收**：`describe.skipIf(!process.env.TT_APP_KEY)` 的真实联调用例（规范 §11 已约定这种写法）跑通订单/商品/售后/结算四类；mock 与 real 的字段映射表进 `docs/`。
- **红线**：真实凭证只走环境变量与 `tk_shop` 的 AES-GCM 密文，不得进仓库、日志与错误文案；不做真实店铺的写操作（改价、发货）。

## 11. 多平台适配层分层 📖 仅参考

- **可借鉴**：[启航跨境 ERP](https://gitee.com/qiliping/qihang-cb-erp) 支持 TikTok Shop / Shopify / SHEIN 多平台，其「平台适配器 + 统一领域模型」的分层值得对照——
  本项目现在是 `services/tiktok/{client,realClient}.ts` 两个实现 + 归一化函数（如 `normalizeOrderStatus`），只服务一个平台；将来接第二个平台时，归一化逻辑会散落。
- **可落地的小步**：把「平台字段 → 本地枚举」的归一化函数从 `jobs/syncJobs.ts` 抽到 `services/tiktok/normalize.ts`，让适配层边界显式化（纯搬家，不改行为，用现有测试兜底）。

## 12. 业务知识检索入口 📖 仅参考

- [跨境 ERP 资源索引](https://github.com/awesome-oversea/cross-border-erp)：跨境业务知识 + 开源项目清单（含达人建联、选品、财务模块）。
  用途是排路线图时查「别人怎么做」，不是代码依赖。本项目 PRD 已覆盖的模块与之对拍，可用来发现漏掉的业务场景（例如头程物流、多平台库存共享）。

---

## 与既有任务的对应关系

| 选项 | 任务 | PRD/规范锚点 | 状态 |
| --- | --- | --- | --- |
| 1 限流 | #34 | 规范 §6.1.1（本轮新增） | ✅ `136c865` |
| 2 首屏体积 | #36 | — | ✅ `20f23de` 首屏 gzip 786KB → 179KB |
| 3 XLSX / 导出中心 | #35、#30 | PRD B8、D13、§8.2 | ✅ 13 个导出接口全部在界面上有按钮（`3f822cc`/`f826b1b`/`5bd18da`） |
| 4 OpenAPI 契约 | #37 | 规范 §6 | ✅ `77ae21d` 186 路径 / 226 操作 + 前端 `ApiPath` 类型化 + 契约漂移门禁 |
| 5 Playwright | #38 | PRD §7 DoD | ✅ `npm run e2e` 50 例：RBAC 可见性 / 导入中心 / 行动中心闭环 / 全页面遍历 |
| 6 库迁移路径 | #39（与 #31 同源） | 规范 §5 | 🟡 两份 DDL 对拍 + 方言债棘轮 + `docs/db-migration.md`；方言收口按判断暂缓 |
| 7 任务队列 | #41 | PRD 6.2/6.4 | ✅ `d6e3685` 表即队列 + `POST /sync/run {async:true}` + 队列面板 |
| 8/9/11 参考项的可落地小步 | #43 | 规范 §9 | 🟡 权限矩阵快照 + 字段级变更历史（`GET /system/oplog/history` + 抽屉）已落地；Casbin 仍仅参考 |
| 10 real 模式联调 | #42（#19 的后续） | PRD §6.1 | 🟡 录制夹具 + mock↔real 对拍 + 联调清单已就绪；**真实店铺联调仍阻塞：需授权** |
| 12 业务知识检索入口 | — | — | 📖 不建任务，排路线图时查 |

**审验轮记录的既有缺陷（P0–P2）—— 本轮已全部修完**，每一项都有对应 spec 钉住，不是「改完就算」：
#28 宽表汇率缺失静默吞金额 + 宽表按 UTC 切日而利润引擎按店铺 IANA 时区 + cron 时区不一致
 → 汇率口径收敛到 `services/rates.ts` 一处、宽表改用 `tz_day()` 与利润引擎同源，由 `caliber-parity.spec.ts` 对拍 JS/SQL 两条路径；
#29 财务费用写入/改归属不校验数据范围、按单结算读订单不收敛 → `finance-scope.spec.ts`；
#30 `COALESCE(er.rate_to_cny, 1)` 三处把「缺汇率」当 1:1、售后退款缺 `status='COMPLETED'` 过滤、`live_session` 缺唯一键
 → 缺汇率改为「显式标记 + 告警」（`RebuildOutcome.rate_fallback_rows` 进 sync_log），退款口径与唯一键由 `v2-hardening.spec.ts` / `schema-drift.spec.ts` 守住；
#31 通知去重唯一键漏 `is_deleted`、seed reset 会清 `schema_migration`、`GET /notifications` 里写库、`due_at` 两处类型不一致
 → 前四项已修（迁移 `2026-09-22-notification-dedupe-soft-delete-v1` 等）；「MySQL 无迁移路径」这一项归到选项 6；
#33 「派生汇总刷新」不填窗口只算最近 24 小时导致空跑 → 改为按订单全区间，`aggregate-window.spec.ts` 守住。

**建议顺序**：#28 → #29 → #30 → #36（选项 2）→ #38（选项 5）→ #37（选项 4）→ #42（选项 10，等到有真实店铺授权）；#39/#41 按触发条件排，#43 可穿插做。
理由：前三个是「数字不对/越权」，属于正确性与安全；#36 是用户天天感知的体验；#38/#37 是防回归的基础设施；#42 有外部依赖，排不上就由它排。
