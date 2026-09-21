# TikTok 运营管理后台 · 开发规范

> 适用范围：本仓全部代码（`packages/shared`、`apps/server`、`apps/web`、`scripts`、文档）。
> 本文件是**约束文档**，不是教程：所有示例都是仓库里真实存在或必须能编译通过的写法。每条规则后面给了依据文件与行号（写文档时实读）。
> 与 `docs/prd.md` 冲突时以 PRD 为准；与代码事实冲突时以代码为准并**立刻来改这份文件**（本文档随代码走，过期即缺陷）。

---

## 1. 技术栈与版本（不可随意替换）

| 层 | 选型 | 版本 | 说明 |
| --- | --- | --- | --- |
| 运行时 | Node | `engines: >=22.5.0`（实测 v24.18.0） | `node:sqlite` 需要 ≥22.5；实验性警告用 `--disable-warning=ExperimentalWarning` 关闭（见 root `package.json` scripts） |
| 包管理 | npm workspaces | 11.16.0 | `workspaces: ["apps/*", "packages/*"]`，**不用** pnpm/yarn，别引入 lockfile 变体 |
| 语言 | TypeScript | ^5.9.3 | `tsconfig.base.json`：`target ES2023`、`module NodeNext`、`strict: true`、`declaration`、`sourceMap` |
| 后端 | Express | ^5.2.1 | 注意 Express 5 的路径通配写法与 4 不同（`'*'` 非法，用 `app.use`） |
| 数据库 | `node:sqlite`（`DatabaseSync`，Node ≥22 内置） | 内置，**无驱动依赖** | 无 ORM，手写 SQL。**一期交付形态只有 SQLite**；`schema.mysql.sql` 是**为未来移植准备的等价 DDL，运行时 0 支持**（无 `mysql2`、无 `DB_TYPE` 开关，见 PRD D18）。写 SQL 必须写"两边都能跑"的形式，但**任何人不得在文档/PR/回复客户时说"系统支持 MySQL"**，只能说"已按 MySQL 兼容方式编写，移植预估 3~5 人日（`EPIC-9-04`）" |
| 校验 | zod | ^3.25.76 | 所有入参必过 schema |
| 鉴权 | jsonwebtoken ^9.0.2 | — | HS256，`config.jwtTtlSeconds` 默认 8h |
| 调度 | node-cron ^4.2.1 | — | 只在 `jobs/scheduler.ts` 里 import；作业模块本身**不 import** cron（`syncJobs.ts`/`creatorJobs.ts` 各自声明最小 `interface CronLike { schedule(...) }`，测试可注入假实现，见 PRD D10） |
| 前端 | Vue ^3.5 + Vite ^7.2 + Element Plus ^2.14.6 + Pinia ^3.0.4 + vue-router ^4.6.4 | — | hash 路由；echarts ^6.1 |
| 测试 | vitest ^3.2.4 + supertest ^7.2.2 | — | 服务端集成测试用 supertest 打真 app |

**禁止**：引入 ORM、引入 axios 之外的 HTTP 客户端、把 `node:sqlite` 换成 `better-sqlite3`、在业务层拼签名、为省事改 `tsconfig` 的 `strict`。

---

## 2. 目录结构（新增文件必须落在这张表里）

```
packages/shared/src/{constants,types,calc}.ts   # 枚举/类型/纯计算，前后端共用，不得 import 任何 node 内置模块
apps/server/src/
  config.ts                    # 唯一环境变量出口
  index.ts                     # 启动：prepareDatabase → setDb → createApp → listen → startScheduler
  app.ts                       # 路由挂载 + 统一错误处理（新模块必须在这里 mount）
  core/{auth,db,http,oplog,query}.ts   # 基座，改动需 2 人评审
  db/{schema.sqlite.sql,schema.mysql.sql,migrate.ts,seed.ts,cli.ts,bootstrap.ts}
  modules/<domain>.routes.ts   # HTTP 层：只做参数校验 + 调 service + 权限 + 日志
  services/<domain>/*.ts       # 业务层：口径、状态机、汇总（可被 job 与 route 共用）
  jobs/{scheduler,syncJobs,creatorJobs}.ts   # 定时与手动触发共用的作业入口
apps/web/src/
  api/client.ts  router/index.ts  stores/*.ts  layouts/MainLayout.vue
  components/ResourcePage.vue  # 通用 CRUD 页，能用它就不要手写表格
  views/<menu>/<Page>.vue
apps/data/tk_ops.db            # 演示库（跟随仓库，便于验收）
scripts/{copy-assets.mjs,github-import.md}
docs/{prd,development-standards,epics,changes-vs-plan,source-plan}.md/.txt + issues/*.md
```

服务子目录约定：`services/tiktok/`（provider 与签名）、`services/creator/`（`protect.ts` 保护期/链接解析、`roi.ts` 汇总）、`services/finance/`（`profit.ts` 利润引擎、`rates.ts` 汇率）。
**同一口径只允许存在一处实现**：`profit`/`rates` 目前同时存在 `services/profit.ts` 与 `services/finance/profit.ts`（PRD §1.5 D11），收口前**不得**再有第三种；新代码一律 import `services/finance/*`。

---

## 3. 命名规范

| 对象 | 规则 | 例子 |
| --- | --- | --- |
| 表 | 平台实体带前缀 `tk_`，内部实体裸名（snake_case 单数），系统表 `sys_` 前缀 | `tk_order`、`product_sku`、`collaboration`、`sys_op_log`；库存例外用集合语义 `stock_ledger` |
| 字段 | `snake_case`；外键 `<表去前缀>_id`；布尔 `is_`/`can_` 前缀；时间 `_at`（DATETIME）/ `_date`（自然日）/ `_time`（时刻） | `shop_id`、`is_sample_order`、`can_see_cost`、`paid_time`、`stat_date`、`protect_until`(日期) |
| 枚举值 | 存 `TINYINT`/`VARCHAR`，常量放 `packages/shared/src/constants.ts`，**名字全大写 + 语义后缀**，展示名 `*_LABEL` | `COLLAB_STATUS.SIGNED`、`ORDER_STATUS_LABEL` |
| 派生/展示列 | SQL 里用 `AS` 起的别名单独在 types 里声明为可选 | `owner_name`、`sku_count`、`roi` |
| 后端文件 | `<domain>.routes.ts`（路由）、`<domain>.service.ts` 或 `<domain>/<verb>.ts`（服务）、`<noun>Jobs.ts`（作业） | `product.routes.ts`、`creatorJobs.ts` |
| 前端文件 | `<Entity><Action>.vue`，PascalCase；路由 path 用 kebab/camel 与后端一致 | `SpuList.vue`、`UnmappedList.vue`、`/products/unmapped` |
| REST 路由 | 资源复数、小写、连字符；非 CRUD 动作做子资源且用 POST | `/api/shops/:id/auth`、`/api/products/mapping/auto`、`/api/creators/:id/claim` |
| 菜单 key | `<menu>:<page>`（一级 = `MENU_KEYS` 10 个之一） | `product:unmapped`、`creator:roi` |
| Issue 文件 | `EPIC-<n>-<两位序号>-<kebab-slug>.md`，`n` 为 Epic 号 0~9 | `EPIC-2-04-stock-module.md` |

---

## 4. TypeScript 与 ESM 写法

1. **严格模式不许关**。`tsconfig.base.json` 已 `strict: true`；`noUncheckedIndexedAccess` 为 `false`（放开数组下标检查），因此 `arr[0]`、`map.get(k)` 之类要**自己**判空，不要指望编译器。
2. **相对导入必须带 `.js` 后缀**（`"type": "module"` + NodeNext）。源码里写：
   ```ts
   import { Q, queryPage } from '../core/query.js';
   import type { CurrentUser, MenuKey } from '@tk/shared';
   ```
   `tsx` 开发时不带后缀也能跑，但 `tsc` 产出的 `dist/` 一旦缺后缀就 `ERR_MODULE_NOT_FOUND` —— **CI 只跑 `npm run build`，别在本地用 `tsx` 侥幸**。
3 `@tk/shared` 是唯一允许的跨包 import 方式；前端用 `@/` 别名（vite 配置），后端不用别名。
4. **路由处理函数的 `req` 类型**：统一用 `AuthedRequest`（`core/auth.ts:83`）或 `req satisfies Request`。
   现有 `shop.routes.ts:10` 的 `current = (req: object) => ...` 写法在把 `req` 继续传给 `queryPage/parseBody` 时会退化成 `object` 并**产生 21 个类型错误**（`product.routes.ts` 即当前受害者）。新代码禁止再抄这个签名，正确写法：
   ```ts
   import { type AuthedRequest } from '../core/auth.js';
   const { user } = req as AuthedRequest;          // 取当前用户
   queryPage(req, { from: 'xxx t', q });            // req 保持 Request 类型
   ```
5. 允许 `as never` 的**唯一**场景是 `insert()/update()` 的字段对象（它们的入参是 `Record<string, SqlParam>` 而 zod 产出可选字段）：`update('tk_shop', id, body as never)`。**不得**用 `as never` 掩盖真实类型不匹配。
6. 魔法数字必须进 `constants.ts`；口径计算必须进 `packages/shared/src/calc.ts`（前后端共用同一函数，前端展示与后端汇总不许各写一份）。

---

## 5. SQL 与 SQLite/MySQL 双方言

写 SQL 时**同时**想着两个方言（`schema.sqlite.sql` 与 `schema.mysql.sql` 必须等价，`EPIC-0-01` 负责校验）。

| 事项 | 规则 |
| --- | --- |
| 不支持 `UPDATE ... FROM` | 跨表更新必须用相关子查询：`UPDATE tk_order_item i SET cost_snapshot = (SELECT ...) WHERE i.id = ?`（MySQL 用 `UPDATE a JOIN b` 也行，但为保一致**两边都写子查询**） |
| 不支持 `FILTER (WHERE ...)` | 条件聚合一律 `SUM(CASE WHEN x THEN y ELSE 0 END)` |
| 无 `GROUP_CONCAT(DISTINCT ... ORDER BY)` 通用写法 | 用子查询去重后再 `GROUP_CONCAT`（MySQL）/`GROUP_CONCAT`（SQLite），或干脆在 JS 里拼 |
| 部分唯一索引 | SQLite 用 `CREATE UNIQUE INDEX ux_x ON t(cols) WHERE is_deleted = 0`（现 6 处：`ux_user_shop`/`ux_dict`/`ux_listing_shop_sku`/`ux_ad_daily`/`ux_settle_txn`/`ux_rate`）；**MySQL 没有部分索引** → `schema.mysql.sql` 把 `is_deleted` 放进唯一键，服务层负责"恢复/新建时先探测同键活跃行"并返回 409 |
| 软删 | 所有查询默认 `is_deleted = 0`；`softDelete(table,id)` 只改标记。禁止物理 `DELETE`（`sys_op_log`/`sync_log` 归档脚本除外） |
| 时间比较 | 存 UTC 文本 `YYYY-MM-DD HH:MM:SS`，字符串序 == 时间序，可直接 `>=`/`<=`；写库统一 `datetime('now')`（SQLite）/ `CURRENT_TIMESTAMP`（MySQL），**不要**在 JS 里 `new Date().toLocaleString()` |
| 分页 | 一律 `LIMIT ? OFFSET ?`，参数由 `paginate()` 给 |
| 金额 | SQLite 是 `REAL`、MySQL 是 `DECIMAL(18,2)` → 见 §8 |
| 布尔 | 用 `TINYINT 0/1`，不用 `BOOLEAN`/`bool` 列类型 |
| JSON 列 | `menu_perms`/`before_after` 在 SQLite 存 TEXT、MySQL 存 JSON；读侧必须 `JSON.parse(String(row.menu_perms ?? '[]'))`（见 `core/auth.ts:78`） |
| 参数绑定 | 永不拼接用户输入。字符串拼接只允许出现在**白名单校验过的**列名/排序字段（见 `buildListSql`） |

---

## 6. HTTP 层规范

### 6.1 统一响应体与错误码

| 项 | 规则 | 出处 |
| --- | --- | --- |
| 成功 | `ok(res, data, message?)` → `{code:0, message:'ok', data}` | `core/http.ts:22` |
| 分页 | `data = {list,total,page,pageSize}` | `queryPage()` |
| 业务错误 | `throw new AppError(status, message)`，`code = status*100`；快捷：`badRequest/unauthorized/forbidden/notFound` | `core/http.ts:14-17` |
| 校验失败 | `parseBody(schema, req.body)` → 400，`message` 为 `字段: 原因; 字段: 原因` | `core/http.ts:30-37` |
| 唯一冲突 | 由 `app.ts:50` 兜底捕获 `UNIQUE constraint failed` → **409 `code:40900`**，消息固定"编号/唯一标识重复，请检查后重试" | `app.ts` |
| 未匹配路由 | 404 `code:40400` | `app.ts:41` |
| 未预期异常 | 500 `code:50000`，**不返回堆栈** | `app.ts:55` |
| 触发限流 | 429 `code:42900`，带 `RateLimit`/`RateLimit-Policy` 标准头 | `core/rateLimit.ts` |

错误码分段约定（新增码不许自创段）：`0` 成功；`400xx` 参数/业务规则；`401xx` 未登录/过期；`403xx` 无权限；`404xx` 不存在；`409xx` 冲突；`429xx` 限流；`500xx` 服务端。**报表/口径类错误**在 `400` 内用子码细分（如 `EPIC-7-03` 的汇率缺失返回 400 + `code:40010`，前端据此弹专属提示）。

异步/作业里的错误不抛 HTTP，一律 `sendAlert({level:'error'})` + 写 `sync_log.status=3`。

### 6.1.1 限流三档（`core/rateLimit.ts`）

| 档 | 计数键 | 默认 | 环境变量 |
| --- | --- | --- | --- |
| 登录 | IP + 用户名，**只数失败** | 10 次 / 15 分钟 | `RATE_LIMIT_LOGIN_MAX`、`RATE_LIMIT_LOGIN_WINDOW_MIN` |
| 全局 API | IP | 600 次 / 15 分钟 | `RATE_LIMIT_MAX`、`RATE_LIMIT_WINDOW_MIN` |
| 导出/模板 | IP（只对 `/export*`、`/import/template` 计数） | 20 次 / 15 分钟 | `RATE_LIMIT_EXPORT_MAX`、`RATE_LIMIT_EXPORT_WINDOW_MIN` |

整体开关 `RATE_LIMIT=false` 关闭；`NODE_ENV=test` 下默认关闭（整套回归会从 127.0.0.1 打上千次请求），
需要验限流的用例用 `boot(true, { rateLimit: { enabled: true, ... } })` 显式打开。
部署在 nginx 等反向代理后面**必须**设 `TRUST_PROXY=1`，否则 `req.ip` 是代理地址，全站共用一个计数桶。
计数在单进程内存里（与「单进程 + SQLite」的部署形态一致）；真要多实例，得先换 Redis store。

### 6.2 核心工具函数用法（逐个实测签名，照抄即可运行）

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { CurrentUser } from '@tk/shared';
import { all, get, insert, update, softDelete, scalar, tx, run } from '../core/db.js';
import { AppError, badRequest, forbidden, notFound, ok, parseBody, wrap, qv, paginate, buildListSql } from '../core/http.js';
import { Q, queryList, queryPage } from '../core/query.js';
import { authenticate, encryptSecret, decryptSecret, hashPassword, verifyPassword,
         loadUser, maskFields, personScope, requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { logIfChanged, sendAlert, writeOpLog } from '../core/oplog.js';

export const demoRouter = Router();
demoRouter.use(authenticate);                     // 实际由 app.ts 统一挂 authenticate，模块内一般不重复

/* ---- 1) Q：条件构造器。空值自动忽略该条件（undefined/null/'' 三种都算空） ---- */
const q = new Q('t.is_deleted = 0')               // 构造时可给首个条件
  .eq('t.shop_id', req.query.shop_id)             // (col, value, asNumber=true) 数字比较默认 Number()
  .eq('t.region', req.query.region, false)        // 字符串比较必须显式传 false
  .like('t.name LIKE ? OR t.code LIKE ?', req.query.keyword)   // ? 个数 = 自动按 1~n 个槽位填 %kw%
  .between('t.created_at', req.query.created_from, req.query.created_to)  // 生成 >= 与 <=
  .in('t.status IN', [1, 2]);                     // 空数组 → 生成恒假条件 `1 = 0`（不会漏成全表）
// 拼数据范围（scope.sql 可能为空串，Q.and 会自动跳过空条件）：
const scope = shopScope(user, 't.shop_id');
q.and(scope.sql || '', ...scope.params);
q.whereSql;  // ' WHERE t.is_deleted = 0 AND t.shop_id = ? ...'（自带前导 WHERE）
q.params;    // SqlParam[]，顺序与 whereSql 中 ? 严格一致

/* ---- 2) queryPage：分页查询。from 必须自带别名，且与 select 前缀一致 ---- */
const page = queryPage<Record<string, unknown>>(req, {
  from: `tk_shop s LEFT JOIN sys_user ou ON ou.id = s.owner_id`,   // 别名 s
  select: 's.id, s.shop_name, ou.real_name AS owner_name',         // 不给默认 't.*'，务必与 from 别名匹配
  q: new Q('s.is_deleted = 0'),
  orderBy: 's.id DESC',                                            // 默认 'id DESC'
  extraFromParams: [],                                             // from 子句里 ? 的参数（少见）
});
ok(res, page);        // {list,total,page,pageSize}

/* ---- 3) queryList：下拉/导出不分页（limit 上限 500，且 SQL 里是字面量拼接） ---- */
queryList({ from: 'tk_shop s', select: 's.id, s.shop_name', q: new Q('s.is_deleted = 0'), orderBy: 's.shop_name ASC', limit: 200 });

/* ---- 4) buildListSql：把 filter 对象转 SQL（白名单在调用方给） ---- */
const { sql, params, countSql } = buildListSql({
  base: `SELECT * FROM tk_order`,        // 会被包成 (base) t，因此列名要能在 t 上解析
  filters: { shop_id: 1, order_time_from: '2026-09-01' },
  likeKeys: ['tk_order_id'], dateKeys: ['order_time_from', 'order_time_to'],
  allowedSort: ['order_time', 'total_paid'], sortBy: 'order_time', sortOrder: 'desc',
  defaultSort: 'order_time',
});
// 它恒定注入 `t.is_deleted = 0`；`*_from/_to` 自动去掉后缀当列名；`*_id` 与 id 列自动 Number()

/* ---- 5) db：insert/update/softDelete/scalar/tx ---- */
const id = insert('tk_shop', { shop_name: 'X', region: 'MY', currency: 'MYR', created_by: user.id }); // 返回 lastInsertRowid
update('tk_shop', id, { shop_name: 'Y' });        // 自动追加 updated_at = datetime('now')，返回 changes
softDelete('tk_shop', id);                         // is_deleted = 1 + updated_at
const n = scalar<number>(`SELECT COUNT(*) FROM tk_order WHERE shop_id = ?`, 1);
tx(() => { update(...); insert(...); });           // BEGIN/COMMIT/ROLLBACK，同步版（node:sqlite 无 await）

/* ---- 6) 响应与包装：wrap 负责把 async handler 的 reject 转给 next ---- */
demoRouter.get('/x', requireMenu('product'), wrap(async (req, res) => {
  const body = parseBody(z.object({ page: z.coerce.number().int().min(1).default(1) }), req.query);
  if (body.page > 500) throw badRequest('页码过大');
  return ok(res, body);
}));

/* ---- 7) 权限三层 ---- */
demoRouter.get('/list', requireMenu('order'), requireExport, wrap((req, res) => {
  const user = (req as AuthedRequest).user;
  const shop = shopScope(user, 'o.shop_id');          // 店维度：ALL/DEPT/SELF/SHOPS → {sql,params}
  const person = personScope(user, 'c.owner_id', true); // 人维度：第三参 true 才允许"本组"(dept)；否则 DEPT 也退化成仅本人
  const rows = all<Record<string, unknown>>(
    `SELECT o.id, o.total_paid, o.cost_snapshot FROM tk_order o WHERE o.is_deleted = 0 ${shop.sql} ${person.sql}`.replace('  ', ' '),
    ...shop.params, ...person.params,
  );
  ok(res, rows.map((r) => maskFields(r, ['cost_snapshot'], user.can_see_cost))); // 无权限 → 值变 '***'
}));

/* ---- 8) 日志与告警 ---- */
writeOpLog({ user_id: user.id, module: '商品中心', action: 'update', target_table: 'product_sku', target_id: id,
             before, after: { ...before, ...body }, ip: req.ip });   // before_after 存 {"before":..,"after":..}
logIfChanged({ user_id: user.id, module: '商品中心', action: 'update', target_table: 'product_sku', target_id: id,
               before, after: { ...before, ...body }, keys: ['purchase_cost', 'first_leg_cost'] }); // keys 无变化则不写
sendAlert({ title: '订单同步失败', detail: `shop=1 ${msg}`, level: 'error' }); // 有 ALERT_WEBHOOK 就推，无则 console.warn
```

**必须遵守的三条**：
- `requireMenu` 的参数只能是 `MENU_KEYS` 的 10 个一级 key；页面级/按钮级权限走 `menu_perms` 之外的前端显隐（PRD §2.3 粒度定稿）。
- `maskFields` 只能用于 `can_see_cost` / `can_see_contact` 对应字段；利润报表整页按 PRD §3.8 直接 403，不许只掩码。
- 任何 `POST/PUT/DELETE` 成功路径必须写 `sys_op_log`；改成本/归属/费用/删除/导出必须带 before/after（`EPIC-1-03` 做日志覆盖率审计）。

### 6.3 zod 规范

- 每个 router 顶部一个 `<entity>Body` schema，PUT 用 `<entity>Body.partial()`；**不可改字段**用 `.partial().omit({username:true})`（参照 `system.routes.ts` 对 `sys_user.username` 的处理）。
- 字符串一律给 `.max(数据库长度)`；枚举给 `.int().min().max()` 或 `z.union([z.literal(1), z.literal(2)])`；金额 `.number().min(0)` + `round2()` 落库；`currency` `.length(3)`；日期字符串 `.max(20)`。
- 可空列用 `.nullish()`（产出 `undefined | null`）而不是 `.optional()`，否则 `update()` 会写进 `undefined` 变 `NULL`/报错不一致。
- 默认值写在 schema 里（`.default(...)`），不要写在 JS 分支，前后端才可能对齐。
- 校验消息用中文（`message` 会直接显示给用户）。

---

## 7. 数据口径规范（改口径 = 改 PRD + 加测试，三件一起做）

| 主题 | 唯一实现 | 规则 |
| --- | --- | --- |
| 单件成本 | `unitCostCny(sku)` | `purchase_cost + first_leg_cost`，人民币/件 |
| 成本快照 | `tk_order_item.cost_snapshot` | 明细写入时冻结；**任何改价不得 UPDATE 历史行** |
| 有效成本 | `cost_matched = 1` | 所有成本/毛利/利润 SQL 必须带此条件；GMV 不带 |
| 预估毛利 | `estItemProfitCny()` | `实收折算CNY − cost_snapshot − 佣金折算`；`rate \|\| 1` 的兜底**只允许** `currency==='CNY'` 时生效 |
| GMV | `net_gmv` 口径 | `item_amount` 折 CNY，`AND is_sample_order = 0`，扣 `tk_return.status='COMPLETED'` 退款 |
| 达人/合作 ROI | `collabRoi()` | 分母仅 `样品成本 + 寄样运费 + 坑位费 + 达人佣金`；分母 ≤0 → `null`（显示"—"，不参与 Top） |
| 广告 ROI | `adRoi(spend,gmv)` | `spend<=0 → null` |
| 利润率 | `profitRate(profit, base)` | 分母 ≤0 → 0，别返回 `NaN` |
| 切日 | `statDate(utc, tzOffsetMinutes)` | **偏移必须由 `tk_shop.timezone`(IANA) 计算**，不得直接用 `REGION_TZ_OFFSET` 常量（PRD D4）；`ad_daily.stat_date` 落库即站点自然日 |
| 归一化 | `normalizeHandle()` / `parseVideoId()` / `buildCollabNo()` | handle 小写去 `@`；video id 支持 `/video/`、`/v/`、`?item_id=`、纯 ≥12 位数字；编号 `CB<YYYYMMDD>-<4位>` |
| 公共费用分摊 | `services/finance/profit.ts` | 直接归属优先；`expense.shop_id IS NULL` 才按各店净 GMV 占比摊；坑位费不二次摊；**禁止在 SQL 里写比例常量** |

新增口径函数一律放 `packages/shared/src/calc.ts`，写 JSDoc + 单测；不许在服务层复制粘贴。

---

## 8. 金额与时间

| 项 | 规则 |
| --- | --- |
| `DECIMAL → REAL` 风险 | SQLite 侧金额列是 `REAL`（浮点），累加会出现 `130595.11000000002`。对策：① 写库前 `round2()`；② 聚合后 `round2()` 再返回；③ 对账允许 ≤0.5% 容差；④ 前端展示固定 2 位（`ResourcePage` 的 `money` 列已用 `toLocaleString({min/maxFractionDigits:2})`）；⑤ 跨表比较用整数分（`Math.round(x*100)`） |
| 币种 | 原始币种列必留（`currency`），CNY 汇总列命名 `*_cny`（`amount_cny`、`net_gmv_cny`）；无当日汇率**不得**按 1 折算，要显式回退 + 标注（PRD B3） |
| 时间 | 存 UTC 文本；前端展示浏览器时区；筛选接受 `YYYY-MM-DD`，服务端补 ` 00:00:00` / ` 23:59:59` |
| 日期列 | `rate_date`/`stat_date`/`protect_until` 用 `YYYY-MM-DD`，比较用字符串；跨"天"计算用 `Date.UTC` 避免本地时区干扰 |

---

## 9. 权限三层规范

| 层 | 必须调用 | 反例（评审直接打回） |
| --- | --- | --- |
| 菜单 | 路由级 `requireMenu('<MENU_KEY>')` | 在 handler 里手写 `if (!user.menu_perms...)` |
| 数据范围 | 店维度 `shopScope(user,'别名.shop_id')`；人维度 `personScope(user,'别名.owner_id', 是否本组)` | `SELF` 角色去过滤店（`shopScope` 在 `SELF` 下过滤 `tk_shop.owner_id`，BD 会查不到任何数据 —— PRD D1 根因，达人域必须用 `personScope`） |
| 字段 | `maskFields(row, FIELDS, user.can_see_cost \|\| user.can_see_contact)` | 只在前端隐藏列 |
| 导出 | `requireExport` + `writeOpLog({action:'export'})`（before 记筛选条件与行数） | 提供不带权限校验的 `/download` |
| 前端 | 路由 `meta.menu` + `stores/user` 的 `perms` 控制显隐；`***` 值按字符串渲染并上灰色 | 前端猜权限 |

补充硬规则：`boss` 在 `requireMenu` 中隐式放行全部菜单（`core/auth.ts:124`），**不要**给别的角色开后门；`GET /api/system/dict/:type` 与 `synclog/health` 允许仅登录访问（工作台需要）；`sys_op_log` 无 PUT/DELETE 路由，任何需求要"改日志"都拒绝。

---

## 10. Git 与提交

| 项 | 约定 |
| --- | --- |
| 分支 | `master`（主干，受保护）→ `feature/EPIC-<n>-<seq>-<slug>` → PR 回 `master`；缺陷 `fix/...`；文档 `docs/...` |
| Commit | Conventional Commits：`feat(order): 订单列表与详情接口 (#9)`、`fix(sync): 同步窗口重叠避免漏单 (#13)`、`docs: 同步 PRD §5 口径` |
| scope | 用领域名：`shared/server/web/sync/product/creator/content/order/ads/finance/stock/system/docs` |
| PR | 标题 ≤70 字符；描述里必须有：关联网关 Issue 号、执行过的命令（`npm run build && npm run test`）、口径影响说明（是否改变历史数字） |
| 禁止 | `--no-verify`、`push -f` 到 `master`、把 `apps/data/tk_ops.db` 之外的真实库提交进来、`.env` 入库（已在 `.gitignore`） |
| 密钥 | 任何 `app_key/app_secret/access_token/OSS AccessKey/JWT_SECRET` 只走环境变量；测试 fixtures 用假值（`mock` 模式不访问外网） |

---

## 11. 测试规范

| 项 | 规则 |
| --- | --- |
| 位置与命名 | `apps/server/tests/<domain>.spec.ts`（vitest 只认 `*.spec.ts`/`*.test.ts`；**当前一个都没有**，`npm run test` 会以 "No test files found" 退出 1，PRD D9） |
| 起手式 | 一律用 `tests/helper.ts`：`const { db, http } = boot();`（内存 SQLite + migrate + seed），`const token = await login(http, ACCOUNTS.ops)`，`await http.get('/api/shops').set(auth(token))` |
| 取数 | `pageOf(res.body)` 取 `{list,total}`；`dataOf(res.body)` 取 `data`；断言只依赖响应体，不在测试里 import 服务的私有 SQL |
| 账号 | 固定用 `ACCOUNTS`（boss/ops=limy/opsManager=wangqiang/bd=chenbd/bd2=lubd/content=yinuo/finance=finwu/ads=adskent/warehouse=whzhao），密码统一 `DEFAULT_PASSWORD='Passw0rd!'` |
| 模式 | 测试永远 `TIKTOK_API_MODE=mock`；需要真实凭证的用 `describe.skipIf(!process.env.TT_APP_KEY)` |
| 必测清单 | ① 10 角色 × 敏感字段 × 越权（PRD §2.4 逐条）；② 三条口径硬约束（成本快照不回溯 / 待映射不按 0 成本 / 样品单不计 GMV）；③ 两套状态机非法流转 400；④ 同步幂等（重复执行行数不变 + 旧报文不覆盖新状态）；⑤ 汇率缺失/回退；⑥ 分页上限 200；⑦ `pageSize=10000`、`sortBy=<非白名单>`、注入串三类恶意输入；⑧ 10 万订单行下列表 P95 |
| 前端 | `apps/web/tests/unit/*.spec.ts`（`npm run test:e2e -w @tk/web`，jsdom + @vue/test-utils），至少覆盖 `ResourcePage` 的列格式化与掩码渲染 |
| 归档 | 每个 Issue 的"测试要求"栏写进 `*.spec.ts` 的 `describe` 名，末尾标 `// EPIC-<n>-<seq>`，便于 DoD 反查 |

---

## 12. 完成定义（DoD）清单 —— 每个 PR 自查

- [ ] `npm run build` 通过（三个 workspace 全绿，无新增类型错误；本迭代目标是把现有 35 个清零，不许再加第 36 个）。
- [ ] `npm run lint`（= 各包 `tsc --noEmit`）零输出。
- [ ] `npm run test` 全绿，且本 Issue 的"测试要求"栏每条都有对应断言。
- [ ] 新接口有 `requireMenu`（或明确说明为何仅需登录）+ 数据范围 + 写操作日志；导出有 `requireExport` + 日志。
- [ ] 敏感字段走 `maskFields`；响应体不含 `*_enc`、`password`（含掩码前）字段。
- [ ] 列表接口分页、排序白名单、空值筛选不报错（`Q` 自动忽略）。
- [ ] 涉及口径的改动：`packages/shared/src/calc.ts` 或 `services/finance/*` 是唯一改动点，并同步更新 PRD §5 / §7。
- [ ] SQL 在 SQLite 下已验证，并检查 MySQL 兼容性（无 `UPDATE...FROM`、无 `FILTER`、部分唯一索引有服务层兜底）。
- [ ] 空态/告警态在页面上可见（列表页不许只有一张空表）。
- [ ] 本地手工验证路径写进 PR 描述（账号 + 点哪几步 + 期望数字）。
- [ ] Issue 已更新实际接口路径与偏差说明（如与 PRD 契约不同，必须同时改 `docs/changes-vs-plan.md`）。

---

## 13. 代码评审要点（评审者按此逐项打回）

1. **口径**：有没有绕过 `calc.ts` 自己写公式？聚合 SQL 有没有漏 `cost_matched = 1` / `is_sample_order = 0`？汇率回退是否静默？
2. **权限**：`shopScope` 用在了人维度（或反之）？越权靠前端隐藏？导出没走 `requireExport`？
3. **幂等**：新写入是否可安全重跑（同步、费用生成、库存流水、归因回填、自动匹配）？有无显式幂等键或唯一索引？
4. **软删**：查询漏 `is_deleted = 0`？用物理 DELETE？恢复/新建没探测同键活跃行（MySQL 无部分索引）？
5. **性能**：`SELECT *` 带出密文或大字段？无 `LIMIT` 的全表扫？循环里逐行 SQL（N+1，应改批量）？缺索引（对照 PRD §5.2 索引清单）？
6. **时区**：出现 `REGION_TZ_OFFSET` 直取？`new Date()` 参与日切？把 `timezone`(IANA) 与固定偏移混用？
7. **ESM/类型**：相对 import 漏 `.js`？`as never` 掩盖真错？`as any`？`req: object` 传染（§4 第 4 条）？
8. **错误与日志**：`catch` 后吞异常不写 `sync_log`？把凭证/明文密码写进 `error_msg` 或日志 `after`？
9. **重复实现**：又写了第二套利润/汇率/汇总（D11 的前兆）？前端复制粘贴 `<Page>.vue` 而不用 `ResourcePage`？
10. **契约漂移**：改了字段/枚举/路由却没同步 `types.ts`、PRD §3、Issue 契约与 `changes-vs-plan.md`？
