---
number: 36
epic: E11
title: AI 助手（模型服务商接入 + 对话 + 白名单工具写入）
labels: [backend, frontend, phase-3, ai]
blocked-by: [EPIC-9-01]
estimate: 4d
status: 已交付（2026-09-26）
---

## 背景

系统里的经营数据已经能查、能算、能出图，但"为什么这个数字不对、下一步该做什么"仍然靠人在十几个页面之间
自己拼。用户要的是**先把 AI 的位置预留出来并真的能对话**，而不是做一个演示用的聊天框。

开工前用四个问题定了边界，这四条是这一张工单的全部设计约束（写在 `docs/prd.md` §3.13 与
`docs/development-standards.md` §15，改任何一条都要回来改这里）：

1. 能力形态：**接一个 chat**（不是先做"经营诊断/文案生成"等垂直功能）。所以工具层是通用白名单，
   业务功能以后在工具清单上长出来，而不是另起一套接口。
2. 配置位置：服务商与密钥**进数据库 + 管理界面**（与 TikTok 店铺凭证同一套路），不写死在 env。
3. 无 key 时：**没配就报错，不做 mock**。产品代码里没有假数据分支。
4. 权限边界：**允许 AI 直接写业务数据** —— 但只走白名单工具，且用的是发起对话那个人自己的权限。
   这一条与项目原有红线（规则引擎只发现/建议、不代执行）相反，是用户明确改的，
   所以补偿措施（可回滚路径 + 三处留痕 + 名单不含不可逆操作）必须一起看住。

## 具体任务

1. 数据层（两份方言 DDL 同步，`tests/schema-drift.spec.ts` 校验列集合一致）：
   `ai_provider`（含 `api_key_enc` 密文列）、`ai_conversation`、`ai_message`、`ai_call_log`、`ai_action_log`；
   `migrateAiMenu()` 给老库所有有 `dashboard` 菜单的角色补 `ai` 菜单（内容判定幂等，可反复执行）。
2. 服务商适配 `services/ai/`：`providers.ts` 一份出网姿势（超时 / 退避重试 / `safe()`+`maskError()` 脱敏 /
   错误翻译成人话）+ 两个协议实现（OpenAI 兼容、Gemini 原生）；`registry.ts` 负责解密、字段白名单、
   `base_url` 的 https 与主机白名单校验、服务商选择与测活。厂商预设 `AI_VENDOR_PRESETS` 覆盖
   OpenAI / DeepSeek / Gemini / 自定义网关。
3. 工具白名单 `services/ai/tools.ts`：读工具 `get_dashboard` / `get_profit_report` / `list_alerts`
   全部复用现有 service（不写第二套口径）；写工具 `record_alert_action`（复用 `handleEvent`）与
   `create_outreach`（把原先内联在 `creator.routes` 的跟进写入抽成 `services/creator/outreach.ts`，
   界面与 AI 共用同一个 `recordOutreach()`）。`eventScope()` 同步搬到规则引擎，保证"界面看不见的预警
   AI 也查不到、更处理不了"。
4. 对话编排 `services/ai/chat.ts`：会话归属、历史裁剪（系统提示与本轮提问永不裁）、多轮工具循环、
   三处落库（`ai_message` / `ai_call_log` / `ai_action_log`）、轮数用完必须留说明。
5. 后端 `modules/ai.routes.ts` 15 个端点，整段 `requireMenu('ai')`；`npm run openapi` 重生成契约与 `ApiPath`。
6. 前端三页：`views/ai/ChatView.vue`（会话列表 + 消息流 + 工具卡片 + 用量；未配置时把入口指到配置页并禁用输入）、
   `ProviderList.vue`（ResourcePage CRUD + 厂商预设联动 + 测活）、`AiAudit.vue`（用量卡 + 出网调用/AI 写入两页签）。
7. 测试：`tests/ai.spec.ts` 14 例（注入桩 transport 离线对拍两家协议报文、工具循环与写库留痕、
   白名单外工具不执行、越权写入被拒且留痕、密钥不出接口也不出错误文案、连不上服务商时文案要指向 base_url、
   问"本月"要按自然月取数而不是近 30 天、处置预警的审计行指向被改的那条预警、轮数上限）；
   `e2e/ai.spec.ts` 3 例（未配置报错面、新建服务商后密钥读不回来、测活失败要回原因）；
   `e2e/pages.spec.ts` 纳入 3 个新页面。

## 验收

- 没配服务商：对话页给出"去模型服务商配一家"的可读提示并禁用输入框，接口 409 而不是 500。
- 配好服务商（真实 key）后：问"最近哪个店在亏钱"，AI 必须调 `get_profit_report` 现取数据再回答，
  `ai_call_log` 有对应记录；让它把某条预警标为已处理，`alert_event`/`operation_action`/`sys_op_log`/`ai_action_log`
  四处都要能看到同一件事，且操作人是发起对话的那个人。
- 让 AI 删订单/改价：模型侧没有这个工具，回答里必须明说系统不开放给 AI 执行。
- 全部门禁绿：lint、后端单测、前端单测、build、smoke（8 角色 × 全路由）、e2e。

## 已知不做 / 后续

- 流式输出（SSE）：`EventSource` 带不上 `Authorization` 头，要先改鉴权方式，另开工单。
- 更多写工具（费用登记、候选品登记、寄样单）：都要先把 route 里的内联写入抽成 service，再进名单。
- 花费预算与限流（按人按天封顶）：目前只有 `ai_call_log` 可查，没有硬闸门。
- 真实服务商联调：与 TikTok real 模式同一类阻塞 —— 需要用户提供 key，CI 里不配。
