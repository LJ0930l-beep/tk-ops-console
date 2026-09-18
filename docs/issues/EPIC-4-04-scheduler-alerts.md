---
number: 15
epic: E4
title: 调度器挂载、五类告警与每日对账作业
labels: [backend, sync, jobs, monitoring, phase-1, blocking]
blocked-by: [EPIC-4-02]
estimate: 2d
---

## 背景

**这是全项目风险最高的一条缺口（PRD D10），一期阻断项。**

现状：`apps/server/src/index.ts:14` 写着 `if (config.enableScheduler) startScheduler();`，看起来"有调度"，但 `jobs/scheduler.ts` 全文只有 8 行：

```
export function startScheduler(): void {
  void all; void get; void sendAlert;
  console.log('[jobs] scheduler 待接入（由 sync/content 模块提供具体任务）');
}
```

而两个作业模块都已经把注册函数写好并明确写了"等谁调"：`registerSyncJobs(cron)`（order `*/15 * * * *`、returns `35 * * * *`、listing `10 4 * * *`、affiliate `50 3 * * *`、aggregate `55 3 * * *`）、`registerCreatorJobs(cron)`（protect-recycle `10 2 * * *`、sample-overdue `25 2 * * *`、collab-overdue `40 2 * * *`、video-aggregate `55 2 * * *`、live-reminder `0 1 * * *`）。`node-cron@^4.2.1` 已在依赖里，**但全仓没有任何 `import 'node-cron'`**。

后果：方案 6.4 整条"数据不悄悄断"不成立 —— 订单不会自动进来、保护期不回收、寄样不超期提醒、授权到期不告警，工作台数字会长期静止，而客户第一周就会发现"昨天还是这些数"。

同时告警侧只有 `core/oplog.ts:sendAlert`（企业微信单格式 + 恒 `console.warn`，**无去重**），C1/C2 两项定稿都落在这里。

> 开工前复测：`grep -rn "node-cron" apps/server/src`（应为 0）、`cat apps/server/src/jobs/scheduler.ts`（应为 8 行）。

## 具体任务

1. **挂载调度器**（`jobs/scheduler.ts` 重写，保持 `startScheduler()` 签名不变，`index.ts` 不改）
   - `import cron from 'node-cron'`，依次调用 `registerSyncJobs(cron)` 与 `registerCreatorJobs(cron)`，把两者返回的 `{name, expr}` 汇总成 `startedJobs` 供 `GET /api/sync/tasks` 回读（现在那个接口的 `tip` 明说"调度注册需在 scheduler 内调用，本接口只回读表达式"）。
   - 环境变量开关细化：`ENABLE_SCHEDULER=false` → 完全不注册（现状即如此）；新增 `SCHEDULER_ONLY=<逗号分隔任务名>` 便于生产单独重起某一类；两个注册函数返回值与 cron 表达式写入启动日志。
   - **进程内互斥**：`startedJobs` 为空或注册抛错时，进程启动即 `console.error` + `sendAlert`（不要让调度器静默失败，那正是今天的状态）。
   - SQLite 单写者：作业内一律用 `runTaskForAllShops`（内部按店串行），**不要**给同一任务开 `async` 并发批次（B1）。
2. **告警去重（C2）**：新增 `core/alert.ts`（或在 `sendAlert` 内）实现
   - 键 `(title 前缀 + task_type + shop_id + 错误类别)`，30 分钟窗口内只推一次；窗口内重复 → 只 `console.warn` 并计数。
   - 连续失败每 30 分钟重推一次；同一键首次"成功"时推一条"已恢复"（状态存内存 Map 即可，进程重启丢状态可接受，但要在注释里写明，别让人以为它持久）。
   - `sendAlert` 保持**同步返回、永不抛错**（今天的 `.catch(() => undefined)` 语义要保留：webhook 挂了不能把业务带崩）。
3. **双格式（C1）**：按 `config.alertWebhook` 前缀自动判别企业微信（`qyapi.weixin.qq.com` → `{msgtype:'text',text:{content}}`）与飞书（`open.feishu.cn` → `{msg_type:'text',content:{text}}`）；其它前缀按企业微信格式并在启动时 warn 一次。**未配置 webhook 时降级 `console.warn`，但 `sync_log` 计数与工作台红点必须照样正确**（这是硬要求：告警可以丢，状态不能丢）。
4. **五类告警逐条落地并可在系统页看到**：

   | # | 触发 | 现状 |
   | --- | --- | --- |
   | A1 同步失败 | `withSyncLog` catch → `status=3` | 已有 `sendAlert`，缺去重 |
   | A2 "平时有单今天 0 条" | 已实现（近 30 天有单 + 拉到 0 → 判失败并告警） | 已有，缺去重 |
   | A3 授权即将过期 | `withAuthExpiry` 只在读时算状态，**没有作业扫全表** | 新增 `checkShopAuthExpiry()` 每日 08:00，`token_expire_at` ≤7 天 → 告警 + `auth_status=2`；已过期 → `auth_status=3` + 告警 |
   | A4 保护期到期回收 | `recycleExpiredCreators()` 已有，无人调 | 由本工单 `10 2 * * *` 挂载；回收要写 `sys_op_log(操作人=system)`（`created_by=0 SYSTEM_USER_ID` 已定义） |
   | A5 寄样/合作单超期 | `flagOverdueSamples/flagOverdueCollabs` 已有 | 同上挂载；命中数计入工作台待办（`EPIC-8-02`） |
   | 附：汇率缺失（B3/D17）与待映射（`alertUnmapped`） | 待映射已告警；汇率缺失未告警 | 汇率缺失告警实现在 `EPIC-7-03`，本工单只提供去重后的 `sendAlert` 供其复用 |

5. **每日对账作业**（轻量版，给 `EPIC-7-02` 打前站）：`dailyReconcile()` 每日 UTC 19:00（≈北京时间 03:00 之后、美区前一天已闭合）跑三件事，结果写 `sys_dict(reconcile_result)` 或 `sync_log(task_type='reconcile')`：
   - 昨日各店订单数/金额为 0 但近 7 天均值 > 20 → 告警；
   - `tk_return` 中 `orphan`（找不到订单）数量 > 0 → 告警（与 `EPIC-3-02` 对齐）；
   - `settlement_txn` 与 `tk_order` 差集（有结算无订单 / 有订单已结算但 `is_estimated=1` 未刷新）→ 告警条数。
6. **修 D15**：`syncLogRouter` 补 `requireMenu('system')`（现在 `userRouter/roleRouter/dataScopeRouter/opLogRouter` 都有 `sysOnly`，只有它漏了），并把 `/api/system/synclog*` 标为兼容入口、`/api/sync/logs|health` 为对外口径。
7. **可观测**：`GET /api/sync/tasks` 返回 `{jobs:[{name, expr, timezone, enabled}], last_runs:{name: {at, status}}}`，让"调度到底活着吗"在页面上 5 秒可判断。

## 涉及文件

- 改：`apps/server/src/jobs/scheduler.ts`（8 行 → 完整实现）、`core/oplog.ts`（`sendAlert` 去重 + 双格式）、`modules/sync.routes.ts`（任务回读）、`modules/system.routes.ts`（D15）、`jobs/creatorJobs.ts` 或 `jobs/syncJobs.ts`（新增 `checkShopAuthExpiry`、`dailyReconcile`）、`config.ts`（`SCHEDULER_ONLY`、告警去重窗口常量）
- 前端：`views/system/SyncLogList.vue` 增"调度器状态"卡（任务表 + 上次执行）

## 接口契约

| 项 | 定稿 |
| --- | --- |
| `GET /api/sync/tasks` | `{enabled:boolean, jobs:[{name,expr,timezone}], last_runs:{}}`，`system` 菜单 |
| cron 表达式 | **不得改** `registerSyncJobs/registerCreatorJobs` 内已写死的表达式（测试与运维文档都引用它们），新增任务才新增表达式 |
| 时区 | 作业统一 `{timezone:'UTC'}`（`registerCreatorJobs` 现状），表达式含义按 UTC 记录在文档 |
| 告警 | `sendAlert({title, detail, level})` 签名不变；新增 `sendAlert` 的 `dedupKey?` 可选参数，缺省用 `title` 前 40 字符 |

## 验收标准

- [ ] 启动后日志出现 `[jobs] 已注册 10 个定时任务`，`GET /api/sync/tasks` 的 `jobs` 长度 ≥10 且表达式与两个 `register*Jobs` 返回一致。
- [ ] `grep -rn "node-cron" apps/server/src` 至少命中 `jobs/scheduler.ts` 一处（今天为 0，这是本工单的"确已挂载"证据）。
- [ ] **一期 DoD 项**：`ENABLE_SCHEDULER=false` 启动 → `GET /api/sync/tasks` 返回 `enabled:false`、`jobs:[]`，且 30 分钟内 `sync_log` 无自动新增行。
- [ ] 单测注入假 `CronLike`，断言 `registerSyncJobs/registerCreatorJobs` 各注册了预期任务名与表达式（两模块已有返回结构，直接断言）。
- [ ] 用 `vi.useFakeTimers()` + 手动触发回调，断言 A3 授权到期作业把 `auth_status` 从 1 改成 2 并产生 1 条告警；30 分钟内重复触发只推 1 次（C2）。
- [ ] 未配置 `ALERT_WEBHOOK` 时：告警走 `console.warn`（测试 spy），`sync_log.status` 与工作台待办计数仍然正确 —— **证明"告警可以丢、状态不能丢"**。
- [ ] 配置飞书前缀 webhook 时抓包（注入假 `fetch`）body 为 `{msg_type:'text',content:{text}}`；企业微信前缀为 `{msgtype:'text',text:{content}}`。
- [ ] `limy`（无 `system` 菜单）访问 `GET /api/system/synclog` → **403 code 40300**（D15 修复证明）。
- [ ] `dailyReconcile` 在演示库上跑一次：三类检查各产出一条结构化结果（可以是 0 异常），异常置 0 时不告警。

## 测试要求

`apps/server/tests/jobs-alerts.spec.ts`（新）≥ 12 用例：注册完整性、`SCHEDULER_ONLY` 过滤、A1~A5 每类各一条触发用例、去重窗口、双格式报文、webhook 抛错不影响业务、D15 权限、对账三检查。测试**不得**依赖真实定时器等待（一律假时钟或直接调用作业函数）。
