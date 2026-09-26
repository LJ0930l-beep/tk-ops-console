# 换库路径：SQLite → MySQL / PostgreSQL

对应 `docs/dev-options.md` 选项 6（任务 #39）。这份文档回答三个问题：
**现在欠多少、真要走怎么搬、什么条件下才值得动手。**

## 1. 先说结论：现在不动手

运行时只有 `core/db.ts` 一条路（`node:sqlite` 的 `DatabaseSync`，同步 API，全项目唯一出入口）。
单机 SQLite + WAL 在这个体量（演示库 4 店 / 千级订单，真实体量按每店每天几百单估）不是瓶颈，
**换库的收益要到「多人同时写同一张表」或「数据量超出单机舒适区」才出现**。
在那之前动手只会把 3–5 人日花在一个不阻塞任何事的目标上。

但「以后再改」最容易变成「永远改不了」，因为没人知道到底还欠多少。所以欠债现在是**可计量、只减不增**的：
见 `apps/server/tests/dialect-ratchet.spec.ts`。

## 2. 欠债清单（数字与 `tests/dialect-ratchet.spec.ts` 的 BUDGET 同步，2026-09-25 复测；`npm run test -w @tk/server` 会守住这些数字）

| 写法 | 处数 | 换库要做什么 |
| --- | --- | --- |
| `datetime('now')` | 122 | MySQL `NOW()` / PG `CURRENT_TIMESTAMP`（含 DDL 默认值与 `updated_at` 触发器） |
| `datetime(...)` 函数调用 | 130 | MySQL `DATETIME()` 可直接用；PG 要改成 `::timestamp` 比较 |
| `IFNULL(...)` | 59 | MySQL 有 `IFNULL`；PG 只有 `COALESCE` —— 建议统一改 `COALESCE`，两侧都支持，**这是唯一一处可以无脑先改的** |
| `substr(order_time,1,10)` 取日期 | 38 | MySQL `LEFT()` / PG `substr(...)` 可用但语义要核对；建议统一走 `tz_day()`（见下条） |
| `julianday(...)` 日期差 | 10 | MySQL `DATEDIFF` / PG `a - b` |
| `INSERT OR IGNORE` | 1 | MySQL `INSERT IGNORE` / PG `ON CONFLICT DO NOTHING` |
| `PRAGMA ...` | 13 | 库专属（WAL、外键开关、busy_timeout），换库后由连接参数/DSN 承担 |
| `AUTOINCREMENT` | 37 | MySQL `AUTO_INCREMENT` / PG `GENERATED ALWAYS AS IDENTITY` |
| `db.function(...)` 自定义 SQL 函数 | 1 | `tz_day(utc_text, iana_zone, region)`：切日口径的唯一真相（`core/db.ts`），换库必须落成等价存储函数或生成列，**这是全项目风险最高的一处** |
| `group_concat` / `strftime` | 0 | 已经没有了 |

两张 DDL（`schema.sqlite.sql` / `schema.mysql.sql`）的表/列集合由 `tests/schema-drift.spec.ts` 对拍，
所以 MySQL 那份不会继续悄悄过期。

### 2.1 口径切换也是一次搬家（2026-09-25 采购口径 → 品牌返点口径）

同一次改表里最容易出事不是"新列没加"，而是**旧数据按新语义被误读**。这次的处理写在
`migrate.ts: migrateRebateCaliber()`，规则值得抄给以后任何一次口径变更：

1. **能等价换算的才换算**：`first_leg_cost → logistics_cost`（本来就是同一笔钱）、`supplier → brand_name`、
   选品的 `est_margin → rebate_rate`（佣金/物流未拆时两者相等）。
2. **换不出来的绝不发明**：历史订单行的 `cost_snapshot` 是货款，推不出返点率 —— 于是那些行落在
   `rebate_matched = 0`，即"不计利润"，而不是拿一个猜的比率把报表填满。老库升级后利润区会先空掉，
   这是**对的**：它要求人先把返点率配进 SKU，再重跑派生汇总（`POST /api/sync/run {task_type:'aggregate'}`）。
3. 迁移只跑一次：靠 `schema_migration` 表里的版本号（`2026-09-25-brand-rebate-caliber-v1`）幂等；
   旧列在两份 DDL 里都已不再声明，所以迁移末尾 `DROP COLUMN`，否则 `schema-drift` 会红。
4. 演示夹具（`apps/data/tk_ops.db`）随 seed 重生成，不靠迁移搬 —— 迁移只服务"别人手里那份真库"。


## 3. 真要搬的时候按这个顺序

1. **先还便宜的债**：`IFNULL` → `COALESCE`（59 处，纯替换，改完棘轮会要求把预算同步调小）。
2. **把方言收口到一处**：`core/db.ts` 已经是唯一出入口，在这里加一层极薄的方言适配
   （现在只有 `DatabaseSync` 一个实现）：日期函数、upsert 语法、标识符引号。
   不要引入重型 ORM —— 项目现在的手写 SQL 是资产（口径可读、可测），换 ORM 会把口径藏起来。
3. **`tz_day` 单独处理**：MySQL 侧落成 `CREATE FUNCTION`，PG 侧同理；
   或者把「按店铺时区切日」从 SQL 挪到写入时算好的生成列（宽表已经有 `stat_date`，这条路更稳）。
   两种做法都必须让 `tests/daycut.spec.ts` 的既有断言原样通过 —— 那个 spec 就是切日口径的验收。
4. **搬数据**：MySQL 用 `mysqldump`/`LOAD DATA`；PG 用 pgloader 一条命令（类型自动映射）：

   ```bash
   pgloader scripts/pgloader/load-tk-ops.load
   ```

   模板见 `scripts/pgloader/load-tk-ops.load`（含逐表说明与到位后的校验 SQL）。
5. **搬完必须复跑**：`npm run test`（同一套测试要在两种库上都绿）+ `npm run smoke`（真实 HTTP 全路由），
   再对着旧库跑一次「同一区间利润/日报逐日对账」，两库差异为 0 才算完成。

## 4. 怎么判断「到点了」

出现下面任一条再动手，否则维持现状：
- 出现同一秒内多笔写同一张表的真实冲突（`database is locked`）；
- 需要多实例部署（现在的任务队列是「表即队列」，多进程可抢占，但调度器仍是单实例假设）；
- 单表行数进入千万级、或报表查询稳定超过数秒；
- 需要跨库 join（BI 直连）。

**迁移完成的标志**：删掉 `dialect-ratchet.spec.ts` 和本文档第 2 节，同时 `core/db.ts` 有两个以上驱动实现且测试双跑。
