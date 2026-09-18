---
number: 17
epic: E5
title: 建联跟进、保护期提醒与 BD 统计条收口
labels: [backend, frontend, creator, phase-1]
blocked-by: [EPIC-5-01]
estimate: 1.5d
---

## 背景

跟进与保护期的**后端已经实现且有测试**：`POST /api/creators/outreach`（只传 `creator_id + result` 即可录入，自动补 `user_id/contact_time`；公海达人录跟进自动转私海并续期 7 天）、`GET /api/creators/outreach/due`（到点待跟进清单）、`GET /api/creators/expiring`（即将到期）、`POST /api/creators/recycle-expired`、`GET /api/creators/bd-performance`（漏斗：联系/回复/有意向/谈妥/私海数/首响时长）、`GET /api/creators/stats`。测试里也有「未来保护期不被浪费：续期在原截止日基础上 +7 天」。

所以本工单只剩两类真活：**① 把 B2 的"到期前 7 天提醒"从接口能力变成用户看得见的位置；② 手机端 10 秒录入的真实可用性（这是方案 2.2 对 BD 的核心承诺，目前页面按桌面表格写）。**

> 开工前复测：`grep -n "outreach/due\|expiring" apps/server/src/modules/creator.routes.ts`、`wc -l apps/web/src/views/creator/OutreachList.vue`。

## 具体任务

1. **续期规则核对（B2）**：确认三条都成立并在代码注释里标号：认领 `today + config.protectDefaultDays`(30)；有效跟进 `max(现有, today + 7)`；`result=6 谈妥` **不续期**而返回"去建合作单"提示（已有测试「结果=谈妥给出建合作单提示」）。若 `result=5 拒绝` 也续期 → 改为不续期（拒绝不该占保护期），并在 PRD 决策表 B2 补一句。
2. **`protect_until` 写入口审计**：全仓 `grep -n "protect_until" apps/server/src` 列出所有写入点（claim / outreach / blacklist 解除 / recycle / transfer），确保**只有 `services/creator/protect.ts` 一处计算续期公式**，其余调用它（这是 D11"同一口径只允许一处实现"在达人域的对应要求）。
3. **到期提醒可见化**：
   - `GET /api/creators/expiring?days=7` 已返回 `will_recycle` 标记 → 前端 `CreatorMine.vue` 顶部加一条 alert：「N 位达人保护期将在 7 天内到期，其中 M 位无进展将被夜间作业退回公海」，点"查看"直接把列表筛到这批人（带 `expiring=1` 参数，不靠前端过滤）。
   - 工作台待办（`EPIC-8-02`）消费同一接口，**不重复实现计数 SQL**。
4. **BD 统计条**：`OutreachList.vue` 顶部 KPI 接 `bd-performance`（本人）/`?group=1`（本组，`bd_manager`/`boss`）：今日跟进数、回复率（`result>=2` ÷ 总数）、谈妥数、平均首响时长。要求：切"本组"时下拉可指定成员（`user_id`），且非主管请求该参数 → 403。
5. **手机端 10 秒录入**（Q/方案 2.2 的硬指标）：
   - `/m/creators/outreach-new`（`EPIC-9-01` 建 `/m/*` 骨架，本工单填内容）：大号 handle 输入（扫码/粘贴均可）→ 自动带出昵称与当前状态 → 结果用大按钮（6 选 1）→ 备注可选 → 提交。目标：**从打开键盘到提交成功 ≤3 次点击 + 1 次输入**。
   - 提交成功立即返回上一条列表并局部刷新；失败保留输入内容。
   - 断网/401 时不清空表单。
6. **跟进编辑/删除权限**：后端已有"只能本人或主管"，前端把非本人的行禁用编辑按钮（而不是点了才报错）。
7. 达人在黑名单时禁止建跟进（已有测试），前端在 handle 带出时直接提示"该达人已拉黑"并给"解除"入口（主管可见）。

## 涉及文件

- 改：`apps/server/src/modules/creator.routes.ts`（`outreach` 三端点 + `expiring` + `bd-performance` 的参数审计）、`apps/server/src/services/creator/protect.ts`
- 改前端：`apps/web/src/views/creator/OutreachList.vue`、`CreatorMine.vue`，新增 `apps/web/src/views/mobile/MOutreachForm.vue`（路径以 `EPIC-9-01` 约定为准）

## 接口契约

| 项 | 定稿 |
| --- | --- |
| `POST /api/creators/outreach` | `{creator_id, channel?, summary?, result, contact_time?, next_follow_at?}`；成功响应含 `protect_until`（新值）与 `renewed:boolean` |
| `GET /api/creators/expiring` | `{list[], days, will_recycle_count}` |
| `GET /api/creators/bd-performance` | `?group=1` 仅 `bd/bd_manager?` 本组、`boss` 任意；越权 403 code 40300 |

## 验收标准

- [ ] TC-02 相关：`chenbd` 跟进后 `GET /api/creators/mine` 的 `total` 与统计条"私海数"一致；`protect_until` 在原有更晚日期时**不被缩短**（B2 断言）。
- [ ] 一条 `result=5(拒绝)` 的跟进**不延长** `protect_until`（若改口径则按改后判定）。
- [ ] `CreatorMine` 顶部 alert 数字 = `expiring?days=7` 的 `total`；点击后列表 `total` 与之相等（不能靠前端过滤当页数据）。
- [ ] 手机端表单：375px 视口下无横向滚动、主按钮可点击区域 ≥44px；从进入到提交成功实测 ≤10 秒（录制 GIF 归档到验收记录）。
- [ ] `lubd`（BD）请求 `bd-performance?user_id=<他人>` → 403；`boss` 请求同一参数 → 200 且只返回该成员。
- [ ] 达人被拉黑后在其 handle 上录跟进 → 400 且前端提示"已拉黑"，不出现"提交成功但库里没记录"。

## 测试要求

后端：`tests/creator.spec.ts` 的「建联跟进」describe 追加 ≥5 用例（拒绝不续期、expiring 计数、`will_recycle` 判定、`group` 越权、公海录跟进转私海）。前端：手机端表单至少 1 个组件测试或 Playwright 冒烟（提交后列表出现新行）。
