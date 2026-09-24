---
number: 35
epic: E10
title: 选品流水线（登记→上架测试→测试反馈→销售前准备→正常销售）
labels: [backend, frontend, phase-3, selection]
blocked-by: [EPIC-9-01]
estimate: 4d
status: 已交付（2026-09-25）
---

## 背景

方案第十一章把「选品」定为商品进入销售体系前的前置流水线，核心论点是一句话：
**选品流程不是一次性动作，而是一个有状态、有责任人、有超时预警的流水线**。
落地前它在系统里完全没有对应物 —— 候选品靠一张共享 Excel 传，谁登记的要测什么、测到第几天该出结论、
测试通过后要准备哪几件事，全都存在人脑里。这类流程的退化方式是「两周后没人再更新那张表」，
而且退化时界面上完全看不出来。所以这一张工单的交付物不是"多一个菜单"，而是**三道闸门 + 六条超时规则**。

## 具体任务

1. 数据层：`selection_flow`（一个候选品一行，含阶段/停留/结论/快照/清单）与 `selection_log`（阶段流转日志），
   两份方言 DDL 同步维护，公共字段约定不缺（`tests/schema-drift.spec.ts` 校验）。
2. 后端 `apps/server/src/modules/selection.routes.ts`：列表/看板/漏斗/详情/日志/导出 + 登记、编辑、
   流转、提交结论、结论落地、清单六个写接口。三道闸门全部在服务端：状态机边表、结论必须带 7 个指标、
   清单没清完不许转正常销售。
3. 规则：`SELECTION_REGISTER_STALE / TEST_OVERDUE(P0) / FIRST_CHECK / TEST_STRONG / FEEDBACK_STALE / PREPARE_OVERDUE`
   六条进 `DEFAULT_ALERT_RULES`，`target_type='selection'`，`ownerOf` 走 `selection_flow.owner_id`，
   命中即出现在今日行动中心的 P0/P1/P2 与「我的待办」。规则只检测/建议，不自动改状态。
4. 前端 `views/selection/SelectionBoard.vue`：五列看板（卡片左边框＝后端算好的超时档位）+ 顶部四步漏斗 +
   候选品列表 + 淘汰池三个页签；流转目标阶段由详情接口的 `next_stages` 驱动，前端不抄第二份状态机。
5. 演示数据：14 个候选品铺满六个阶段，每阶段刻意做出 绿/黄/红 三档停留时长，含 2 个写了原因的淘汰。

## 涉及文件

- 新增：`apps/server/src/modules/selection.routes.ts`、`apps/server/src/services/rules/selection.ts`、
  `apps/server/tests/selection.spec.ts`、`apps/web/src/views/selection/SelectionBoard.vue`、`e2e/selection.spec.ts`
- 改：`packages/shared/src/{constants,types}.ts`、`apps/server/src/{config.ts,app.ts,db/schema.*.sql,db/seed.ts}`、
  `apps/server/src/services/rules/engine.ts`、`apps/web/src/router/index.ts`、`apps/web/src/views/system/RulesCenter.vue`、
  `e2e/pages.spec.ts`、`scripts/smoke.mts`、`docs/{prd,openapi}.md/json`

## 接口契约（只列闸门相关的错误码，全量见 `docs/openapi.json`）

| 请求 | 响应 | 说明 |
| --- | --- | --- |
| `POST /api/selection/:id/stage` `to_stage=4`（当前在阶段 1） | `400 不允许从「商品选品登记」直接到「销售前准备」` | 状态机边表外一律拒 |
| `POST /api/selection/:id/stage` `to_stage=3` | `400 测试结论请走「提交测试结论」接口，需要携带数据快照` | 且 `next_stages` 不报这条边，前端不给按钮 |
| `POST /api/selection/:id/conclusion`（快照缺 `impressions/cvr`） | `400 测试数据快照缺少指标：impressions / cvr` | 「没有数据支撑的结论应拒绝提交」 |
| `POST /api/selection/:id/stage` `to_stage=5`（清单差 3 项） | `400 销售前准备清单未完成，不能转正常销售。未完成：库存确认、财务确认、合规确认` | 点名缺哪几项 |
| `PUT /api/selection/:id` 带 `stage` / `conclusion` | `200`，但两字段被剔除 | 状态只能走流转接口，否则日志会缺一条 |
| `GET /api/selection/export`（角色无 `can_export`） | `403` | 有 `selection` 菜单也不给导出 |

## 验收标准

1. `npm run test`：`apps/server/tests/selection.spec.ts` 22 例全绿，其中**闸门逐条从 HTTP 打**（不用 SQL 后门，
   后门测不到闸门）；把任一道闸门改成 `if (false)`，对应用例必须变红（已做变异验证）。
2. `npm run lint` / `npm run build` / `npm run smoke` / `npm run e2e` 全绿；`e2e/selection.spec.ts` 用浏览器走完
   登记→测试→结论→落地→清单闸门→上架 与 淘汰→捞回 两条路径；`e2e/pages.spec.ts` 覆盖 `/selection` 白屏与 5xx。
3. 方言债不涨：`tests/dialect-ratchet.spec.ts` 的 `julianday / datetime( / substr(` 三项实测值不变 ——
   超时口径的 SQL 侧只用文本比较，日期差全在 JS 里算。
4. 双击 `start.bat` 后：选品管理出现在侧边栏第一位之后、看板有 5 列且至少一张红卡在 P0 清单里能点开，
   用 `limy`（SELF 范围）登录时只看得见自己登记/负责的候选品。
