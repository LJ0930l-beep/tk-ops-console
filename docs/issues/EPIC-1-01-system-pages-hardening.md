---
number: 2
epic: E1
title: 系统设置五页联调收口与一键交接
labels: [frontend, backend, system, phase-1]
blocked-by: [EPIC-0-01]
estimate: 2d
---

## 背景

`system.routes.ts`（324 行）后端已实现：员工、角色、操作日志、同步监控、字典，且已有 `POST /api/system/transfer-creator`（BD 离职一键交接，方案 8.2 硬规则）。前端 `views/system/{UserList,RoleList,OpLogList,SyncLogList,DictList}.vue` 五个文件已存在（基座 commit 之后并行开发产出），但从未与后端逐字段对过：角色页能否改 `menu_perms`、员工页的"授权店铺"多选、同步监控页的"立即重跑"按钮（后端 `sync` 还是 2 行桩）、日志页的 JSON diff 展开，都属于"页面有、契约未必对"。
`MainLayout.vue` 的红点计数已修好（PRD D7），它依赖 `GET /api/system/synclog/health` 返回**数组**且每项含 `status`。

## 具体任务

1. 逐页核对并按 PRD §3.10 补齐：
   - 员工页：`username` 编辑态禁用（后端 `userBody.partial().omit({username:true})`）；新建必填密码（8~64，缺失 400「新建员工必须提供初始密码（至少 8 位）」）；`shop_ids` 多选仅当所选角色 `data_scope=4 指定店铺` 时显示并必填；状态用"停用"按钮走 `POST /api/system/users/:id/deactivate`（不是删除）。
   - 角色页：`menu_perms` 10 个一级 key 多选（`GET /api/system/menus` 拿中文名）；保存前二次确认必须展示"该角色下 N 个用户将立即变化"（`user_count` 字段）；`data_scope` 与三个开关的中文说明。
   - 操作日志页：只读；`before_after` 折叠展开为左右 diff；筛选含 `user_id/module/action/target_table/start_date/end_date`。
   - 同步监控页：列按 PRD §3.10；「立即重跑」按钮在 `POST /api/sync/run` 未实现前必须 disabled + tooltip「待 EPIC-4-02」（不许静默 404）。
   - 字典页：6 个 `dict_type` 的分组维护，`(dict_type,dict_value)` 冲突提示 409。
2. 一键交接（`transfer-creator`）做进 UI：入口在员工页行操作（仅 `bd/bd_manager/boss` 可见），弹窗选人 → 预览"将转移 N 个达人、M 张合作单"（调 `GET /api/creators/transfer-preview?from_user_id=` 若后端无则本工单补只读接口）→ 确认执行 → 展示返回 `{creators, collabs}`。
3. 前端所有系统页统一 `requireMenu('system')` 的显隐：`menu_perms` 不含 `system` 的角色左侧菜单不出现，直接访问路由要跳 `/403`。

## 涉及文件

- 改：`apps/web/src/views/system/*.vue`（5 个）、`apps/web/src/router/index.ts`、`apps/web/src/layouts/MainLayout.vue`
- 改：`apps/server/src/modules/system.routes.ts`（补 `transfer-preview`、`menus` 若缺）、`apps/server/src/modules/auth.routes.ts`（确认 `me` 返回 `menu_perms` 与三个开关）
- 参考：`apps/web/src/components/ResourcePage.vue`（`columns/searchFields/formFields/slots` 约定）

## 接口契约

| method + path | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/system/users` | system | 分页；含 `role_name/role_key/shop_count/last_login_at` |
| `POST /api/system/users` / `PUT /:id` | system | 见上；`after.password` 必须为 `'***'` |
| `POST /api/system/users/:id/deactivate` | system | 软停用，不删行 |
| `GET /api/system/roles` / `POST` / `PUT /:id` | system | `role_key` UNIQUE → 409 |
| `GET /api/system/oplog` | system | 只读，无 PUT/DELETE |
| `GET /api/system/synclog`、`/api/system/synclog/health` | 登录（health）/ system（列表） | health 返回数组且每项含 `status`（红点依赖） |
| `GET/POST/PUT /api/system/dict`、`GET /api/system/dict/:type` | 管理需 system / 下拉仅需登录 |  |
| `POST /api/system/transfer-creator` | boss/bd_manager | `{from_user_id,to_user_id}` → `{creators,collabs}`，1 条汇总日志 |

## 验收标准

- [ ] 以 `limy`（运营，`menu_perms` 无 `system`）登录：左侧无"系统设置"，手敲 `#/system/users` 进 403 页，接口直连 403 `code:40300`。
- [ ] 以 `boss` 登录：五页可增改（日志页只读），字典冲突显示 409 文案。
- [ ] 新建员工不填密码 → 400 且消息含"初始密码"；`username` 在编辑态不可改。
- [ ] 给 `bd` 角色勾掉 `content` 菜单后，`chenbd` 刷新页面左侧菜单立即少一项（提示生效范围含 N 个账号）。
- [ ] 交接 `chenbd → lubd`：返回 `{creators:4, collabs:5}`（演示数据），日志只 1 条且 `before_after` 含 from/to。
- [ ] 「立即重跑」按钮为 disabled 且提示待 `EPIC-4-02`，无 404 请求。

## 测试要求

`apps/server/tests/system.spec.ts`：五页 list 200 + 分页字段齐全；`oplog` 无 PUT/DELETE 路由（404/405）；`transfer-creator` 后 `creator.owner_id` 全改、`collaboration.owner_id` 全改、`creator_outreach.user_id` **不改**、日志 1 条；密码掩码断言（`after` 内无 `password` 明文）。
`apps/web/tests/unit/system.spec.ts`：`UserList` 在 `editing=true` 时 `username` 输入框 disabled。
