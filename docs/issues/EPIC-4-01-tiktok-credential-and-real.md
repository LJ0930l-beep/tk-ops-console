---
number: 12
epic: E4
title: TikTok 店铺凭证补齐与 real 模式可用化
labels: [backend, sync, security, phase-1]
blocked-by: [EPIC-1-03]
estimate: 2d
---

## 背景

`services/tiktok/realClient.ts` 已经写完：HMAC-SHA256 签名（`app_secret + path + 排序参数 + timestamp + nonce`）、`x-tt-appkey/x-tt-sign/x-tt-timestamp/x-tt-nonce` 头、`AbortSignal.timeout`、非 JSON 与业务码非 0 时抛 `TikTokApiError`、`safe()` 已把 `sign=` 正则脱敏。**但 real 模式今天跑不起来**，两个硬缺口：

1. **D3**：`tk_shop` 两侧 DDL 都只有 `app_key_enc` / `app_secret_enc`，**没有 `access_token_enc`**。`buildShopCredential()` 于是走 `process.env.TIKTOK_SHOP_ACCESS_TOKEN` 兜底 —— 全局一个 token 打所有店，多店铺场景必然串号。
2. `POST /api/shops/:id/auth` 的 zod 只收 `app_key/app_secret/shop_cipher/token_expire_at`，**前端根本没有地方录入 access token**。
3. **D2**：`GET /api/shops` 用 `select: 's.*, ...'` 会把两个密文列原样吐给前端（`EPIC-1-03` 做列白名单，本工单负责确保加列后新列也在白名单之外）。

> 开工前复测：`grep -n "access_token_enc" apps/server/src/db/schema.*.sql` 应为 0 命中。

## 具体任务

1. **加列（两侧 DDL 同步 + 迁移）**
   - `schema.sqlite.sql` / `schema.mysql.sql` 的 `tk_shop` 增 `access_token_enc TEXT`（MySQL `VARCHAR(512)`），紧跟 `app_secret_enc`。
   - `db/migrate.ts` 增加幂等 `ALTER TABLE tk_shop ADD COLUMN access_token_enc TEXT`（先查 `PRAGMA table_info`，MySQL 侧查 `information_schema.COLUMNS`），保证老库可原地升级、`npm run db:init` 不炸。
2. **授权接口收 access token**：`POST /api/shops/:id/auth` body 增 `access_token: z.string().min(8)`（可选字段？——**定稿：必填**，因为它是 real 模式唯一缺口；mock 模式不校验）。`update('tk_shop', id, { access_token_enc: encryptSecret(body.access_token), ... })`。
   - 兼容：允许 `access_token` 缺省（只更新 app_key/secret 时不清空原值），用 `body.access_token ? {...} : {}` 控制。
3. **`buildShopCredential()` 收口**：删掉 `process.env.TIKTOK_SHOP_ACCESS_TOKEN` 兜底（**多店铺下的隐患大于收益**），改为无 token 时抛 `AppError(400, '店铺「X」未授权 access token，请在店铺页重新授权', 40020)`，与 `realClient.request()` 里缺 app_key 的写法一致；错误信息**不含任何凭证片段**。
4. **脱敏与不留痕（C5）**
   - `writeOpLog` 的 `after` 只写 `{ auth: 'renewed', access_token_updated: true|false, token_expire_at }`，绝不写密文（现在已经是 `{auth:'renewed'}`，加字段时注意）。
   - `GET /api/shops`、`/api/shops/:id` 响应里**不得出现** `app_key_enc/app_secret_enc/access_token_enc` 三列（由 `EPIC-1-03` 的 `SHOP_COLUMNS` 白名单负责，本工单加列后同步更新该白名单并加断言）。
   - 前端授权弹窗：`app_secret`/`access_token` 用 `type=password`，保存后不回显，只显示"已配置（更新于 …）"。
5. **provider 收口**：`createTiktokClient()` 的实例缓存 `{mode, client}` 在 `config.tiktokMode` 运行期不变的前提下 OK；补 `resetClient()` 在测试里的使用文档，并确保 `mockProvider.ts` 与 `realClient.ts` 返回**同一套 `Platform*` 结构**（`types.ts` 是契约），real 侧字段缺失时必须在 provider 内补齐默认值而不是让 `syncJobs` 崩。
6. **real 模式最小可用验证（不依赖真实店铺的部分）**：用本地 mock server（`node:http` 起在 127.0.0.1 随机端口）跑 `realClient.getOrders()`，断言签名可复算、超时与非 0 业务码转成 `TikTokApiError`、`error_msg` 落 `sync_log` 前已脱敏。真实店铺联调留给 `EPIC-9-04` 的 M5。

## 涉及文件

- 改：`apps/server/src/db/schema.sqlite.sql`、`schema.mysql.sql`、`db/migrate.ts`、`modules/shop.routes.ts`（`/:id/auth`）、`services/tiktok/client.ts`（`buildShopCredential`）、`apps/web/src/views/shop/ShopList.vue`（授权弹窗）
- 参考：`core/auth.ts`（`encryptSecret/decryptSecret`，AES-256-GCM，`iv.tag.data` base64，密钥 `sha256(JWT_SECRET)`）、`realClient.ts` 的 `buildSign/safe`、PRD §7.2 / 决策表 C5

## 接口契约

| 项 | 定稿 |
| --- | --- |
| `POST /api/shops/:id/auth` body | `{app_key, app_secret, access_token?, shop_cipher?, token_expire_at?}` |
| real 缺 token | 400 code **40020**，message `店铺「X」未授权 access token，请在店铺页重新授权` |
| 列表/详情响应 | 三列密文一律不出现（不是返回 `***`，是**不返回该键**） |
| `auth_status` | 保存成功即 `AUTHORIZED`；`token_expire_at` 距今 ≤7 天 → `withAuthExpiry` 标 `EXPIRING`（已实现，保持） |

## 验收标准

- [ ] `grep -c "access_token_enc" apps/server/src/db/schema.sqlite.sql apps/server/src/db/schema.mysql.sql` 各 ≥1；老库跑 `npm run db:migrate`（或 `db:init`）不报错且新列为 NULL。
- [ ] **TC-01 扩展**：任何角色 `GET /api/shops` 与 `/api/shops/:id` 的响应 JSON **不含键** `app_key_enc`、`app_secret_enc`、`access_token_enc`（用 `Object.keys` 断言，不是断言值为 `***`）。
- [ ] 授权后库里存的是 `iv.tag.data` 三段 base64（可用 `decryptSecret` 反解回原值），`sys_op_log` 最近一条该店铺的日志 `before_after` 里搜不到密文与明文 token。
- [ ] `TIKTOK_API_MODE=real` 且店铺无 token：`POST /api/sync/run {task_type:'order', shop_id:1}` → 返回**结构化失败**（`sync_log.status=3` + `error_msg` 含"未授权 access token"），进程不崩、不 500 裸栈。
- [ ] 本地 mock server 联调：签名可被独立复算一致（把 `buildSign` 的用例向量固化到测试），HTTP 超时 → `TikTokApiError(path, 0, '网络异常…')` 且 `sync_log.error_msg` 里 `sign=` 已变 `***`。
- [ ] `mock` 模式下不产生任何外网请求（测试里断言 `realClient` 未被构造：`createTiktokClient().mode === 'mock'`）。

## 测试要求

`apps/server/tests/shop-auth.spec.ts`（新）≥ 8 用例：授权写入/密文不回显/缺 token 40020/日志脱敏/迁移幂等（连跑两次 migrate）/签名向量/超时与业务码/`resetClient` 后模式切换。
