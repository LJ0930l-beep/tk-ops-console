---
number: 1
epic: E0
title: 环境变量样例与 SQLite/MySQL 两侧 DDL 对齐
labels: [infra, backend, phase-1]
blocked-by: []
estimate: 1d
---

## 背景

`config.ts` 是全部环境变量的唯一出口，但仓库里**没有任何 `.env.example`**，新环境只能靠读代码猜变量名；同时 `config.ts:17` 读的是 `process.env.adsApiBase`（小写驼峰，环境变量不可能命中），广告 real 基址永远取默认值（PRD §1.5 D12）。
另外 `schema.sqlite.sql`（536 行，26 表）与 `schema.mysql.sql`（583 行，26 表）由不同人分头写，列/索引差异目前无人核对；MySQL 侧还缺 `is_deleted` 参与唯一键的处理约定（PRD §5 B9/§5.2）。

## 具体任务

1. 新增 `.env.example`（仓库根），逐变量给注释与安全提示：
   `NODE_ENV PORT HOST JWT_SECRET JWT_TTL DB_FILE TIKTOK_API_MODE TIKTOK_API_BASE ADS_API_BASE ALERT_WEBHOOK SAMPLE_DUE_DAYS CREATOR_PROTECT_DAYS SYNC_OVERLAP_MIN ENABLE_SCHEDULER`
   生产预留段（不入仓、只写在注释里）：`MYSQL_URL OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_BUCKET BACKUP_CRON`。
   每行标注"是否敏感/是否入仓/丢失后果"。
2. `config.ts`：`process.env.adsApiBase` → `process.env.ADS_API_BASE`；新增 `mysqlUrl`（空 = 用 SQLite）、`isProd` 派生字段；启动时若 `NODE_ENV=production` 且 `JWT_SECRET` 仍是默认值 → 拒绝启动并打印明确原因。
3. 写一个校验脚本 `apps/server/src/db/cli.ts` 子命令 `ddl-check`：读两份 DDL，输出「表数 / 每表列名差集 / 唯一约束差集」报告，差异必须为 0（方言类型差异白名单化：`TEXT/JSON`、`REAL/DECIMAL`、`TINYINT` 宽度）。
4. 若发现列缺失（已知会缺 `tk_shop.access_token_enc`，由 `EPIC-4-01` 加）先记录在报告里不阻塞本工单。

## 涉及文件

- 新增：`.env.example`
- 改：`apps/server/src/config.ts`、`apps/server/src/db/cli.ts`、`apps/server/src/db/bootstrap.ts`（读 `mysqlUrl` 的分支占位）
- 改：`README.md`（把"照 .env.example 复制"写进从零跑通三步）
- 参考：`apps/server/src/db/schema.sqlite.sql`、`schema.mysql.sql`

## 接口契约

无 HTTP 接口。CLI：`node apps/server/dist/db/cli.js ddl-check` → 退出码 0 = 对齐，非 0 并打印差集（供 CI 用，`EPIC-9-03` 接入）。

## 验收标准

- [ ] 删除 `.env` 后按 `.env.example` 复制即可 `npm run dev` 起服务并登录 `boss`。
- [ ] `npm run build && npm run db:init && npm run db:seed` 在干净 `apps/data/` 下成功。
- [ ] `ddl-check` 报告差异为 0（`access_token_enc` 一条在白名单里，`EPIC-4-01` 完成后移出）。
- [ ] `NODE_ENV=production` + 默认 `JWT_SECRET` → 启动失败且消息含"JWT_SECRET"。
- [ ] 全仓不再有 `process.env` 的小写驼峰变量名（`grep -n "process\.env\.[a-z]*[A-Z]"` 为空）。

## 测试要求

`apps/server/tests/infra.spec.ts`：
1. `ddl-check` 纯函数版返回空差集（防止 CI 依赖外部命令）。
2. `config` 在生产模式默认密钥下抛错的单测（用 `vi.stubEnv`）。
3. `AdsBase URL` 由 `ADS_API_BASE` 生效的断言。
