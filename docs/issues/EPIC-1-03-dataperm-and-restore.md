---
number: 4
epic: E1
title: 数据范围与审计加固：密文不出接口、软删可恢复、登录失败锁定
labels: [backend, security, system, phase-1]
blocked-by: [EPIC-1-01]
estimate: 1.5d
---

## 背景

三个已核实缺陷（PRD §1.5）：
- **D2**：`GET /api/shops` 的 `select: 's.*'`（`shop.routes.ts:57`）会把 `app_key_enc`、`app_secret_enc` 密文原样吐给浏览器；`GET /api/shops/all` 完全没有数据范围过滤（`shop.routes.ts:65-70` 直接 `queryList({from:'tk_shop', q:new Q('is_deleted = 0')})`），任何登录用户能拿全部店名与币种。
- **D14**：软删只打标记（`softDelete()`）但没有任何恢复入口与回收站页面，误删只能改库；且 MySQL 侧无部分唯一索引（`ux_*  WHERE is_deleted = 0` 只在 SQLite 成立），恢复时必须撞唯一键。
- 登录侧无失败次数限制（`auth.routes.ts` 47 行只有 `verifyPassword` + `signToken`），Q12 允许手机访问后台后，暴力尝试面变大。
- 另外 `writeOpLog` 目前只被部分模块调用，需要一次覆盖率审计。

## 具体任务

1. **列白名单**：`tk_shop` 的列表/详情统一走 `SHOP_COLUMNS`（不含 `app_key_enc/app_secret_enc/access_token_enc/shop_cipher`）。凭证状态只回显布尔与长度提示（如 `has_credential: true`、`token_expire_at`），密文任何角色都不出接口。
2. **`/api/shops/all` 范围化**：加 `shopScope` 过滤（保留现有列裁剪与 `limit 200`），并保留 `/shops/mine` 作为前端唯一下拉来源（二者返回字段对齐）。
3. **回收站与恢复**：
   - `GET /api/system/recycle?table=&page=`：列出 `is_deleted=1` 的行（表必须在白名单内，`sys_*` 与 `tk_order/tk_order_item` 除外）+ 删除人/删除时间（从 `sys_op_log(action='delete')` 反查）。
   - `POST /api/system/restore {table, id}`：需 `system` 菜单；恢复前用同唯一键探测活跃行，命中 → 409 `code:40900`「已存在同编号的未删除记录，请先处理」；成功则 `is_deleted=0` + `updated_at` + 写日志（`action='update'`，`after={restored:true}`）。
   - 前端：系统设置下新增「回收站」页（表格 + 恢复按钮 + 二次确认）。
4. **登录失败锁定**：`sys_user` 不加列，用内存 + 库双写策略：连续失败 5 次（同 username，15 分钟窗口）→ 该账号 15 分钟内禁止登录并 403 `code:40310`；成功登录清零；写 `sys_op_log(action='login')`（含 `success:0/1`、`ip`）。实现放 `core/auth.ts` 旁边的 `loginGuard`，重启即清空可接受（写注释说明）。
5. **日志覆盖率审计**：脚本 `node scripts/audit-oplog.mjs` 扫 `modules/*.routes.ts` 里的 `router.post/put/delete`，输出未调用 `writeOpLog|logIfChanged` 的行号清单；本工单把清单补成 0（在响应 `ok()` 之前写日志）。

## 涉及文件

- 改：`apps/server/src/modules/shop.routes.ts`、`system.routes.ts`、`auth.routes.ts`、`core/auth.ts`（新增 `loginGuard`）
- 新增：`apps/web/src/views/system/RecycleList.vue` + 路由、`scripts/audit-oplog.mjs`
- 参考：`core/db.ts:60`（`softDelete`）、`core/oplog.ts:16`（`writeOpLog`）、`app.ts:50`（UNIQUE→409）

## 接口契约

| method + path | 说明 |
| --- | --- |
| `GET /api/system/recycle` | `{list:[{id,table,label,deleted_by,deleted_at}],total,...}` |
| `POST /api/system/restore` | 409 冲突 / 200 `{table,id}` |
| `POST /api/auth/login` | 失败 5 次后 403 `code:40310`，`message` 含剩余等待分钟数 |

## 验收标准

- [ ] `curl /api/shops` 与 `/api/shops/1` 响应体里 grep 不到 `app_key_enc|app_secret_enc|shop_cipher`（boss 也不行）。
- [ ] `limy`（`data_scope=4`，仅店 1）调 `/api/shops/all` → 只返回 1 家店。
- [ ] 删除一个 `product_sku` → 回收站可见 → 恢复成功且成本字段不变；先手工再建一个同 `sku_code` 再恢复 → 409。
- [ ] `tk_order` 与 `sys_op_log` 不在回收站白名单内（`/recycle?table=tk_order` → 400）。
- [ ] 连错密码 5 次 → 第 6 次 403 `code:40310`；15 分钟窗口内正确密码也拒；`sys_op_log` 有 6 条 login 记录（第 6 条 `success:0` 且 reason=locked）。
- [ ] `node scripts/audit-oplog.mjs` 输出 `0 missing`。

## 测试要求

`apps/server/tests/hardening.spec.ts`：密文不出接口（对全部 `tk_shop` 路由做 JSON 深度 key 检查）、`/shops/all` 范围、restore 正常与 409、登录锁定 5 次阈值与解锁（注入假时钟）、日志审计脚本（对 fixture 目录跑）。
