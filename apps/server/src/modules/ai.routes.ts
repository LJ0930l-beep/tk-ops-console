/**
 * AI 助手（PRD §3.13）：模型服务商配置、对话、工具与调用审计。
 *
 * 三条硬规矩在这一层就定死，不给前端绕过的余地：
 *  1. 密文列永不出接口 —— 列表/详情走 PROVIDER_COLUMNS 白名单，只回 has_key；
 *  2. 整段路由 requireMenu('ai')，没这个菜单的人连"问一句"都不行；
 *  3. 服务商增删改、设为默认、测活、每一次对话，全部 writeOpLog 留痕。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { AI_PROTOCOL, AI_TOOL_LABELS, AI_VENDOR, AI_VENDOR_PRESETS, type CurrentUser } from '@tk/shared';
import { all, get, insert, softDelete, update } from '../core/db.js';
import { notFound, ok, parseBody, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { encryptSecret, requireMenu, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';
import { config } from '../config.js';
import { PROVIDER_COLUMNS, assertBaseUrlAllowed, enabledProviders, normalizeModelInput, probeProvider, pullModels, providerView, usageSummary } from '../services/ai/registry.js';
import { AI_TOOLS } from '../services/ai/tools.js';
import { runChat } from '../services/ai/chat.js';
import { maskError } from '../core/redact.js';

const current = (req: Request): CurrentUser => (req as AuthedRequest).user;

export const aiRouter = Router();
/** 整段守卫：所有 /api/ai/* 都要 ai 菜单（openapi 生成器认这种整段写法） */
aiRouter.use(requireMenu('ai'));

const MODULE = 'AI 助手';

const providerBody = z.object({
  name: z.string().min(2).max(64),
  vendor: z.enum([AI_VENDOR.OPENAI, AI_VENDOR.DEEPSEEK, AI_VENDOR.GEMINI, AI_VENDOR.CUSTOM]).default(AI_VENDOR.CUSTOM),
  protocol: z.enum([AI_PROTOCOL.OPENAI, AI_PROTOCOL.GEMINI]).optional(),
  base_url: z.string().min(8).max(255),
  /** 默认模型；反代/网关可以先留空，靠「拉模型」从服务商那里取一份清单再定 */
  model: z.string().max(96).default(''),
  /** 除默认模型外的可选清单原文（换行/逗号/分号分隔），落库前统一成逗号分隔 */
  models: z.string().max(8000).optional(),
  /** 只在写入时出现；读接口永远不回传 */
  api_key: z.string().max(400).nullish(),
  temperature: z.number().min(0).max(2).default(0.3),
  max_output_tokens: z.number().int().min(64).max(32000).default(1024),
  price_in_per_1k: z.number().min(0).max(1000).default(0),
  price_out_per_1k: z.number().min(0).max(1000).default(0),
  supports_tools: z.union([z.literal(0), z.literal(1)]).default(1),
  enabled: z.union([z.literal(0), z.literal(1)]).default(1),
  is_default: z.union([z.literal(0), z.literal(1)]).default(0),
});

const chatBody = z.object({
  content: z.string().min(1).max(8000),
  conversation_id: z.number().int().positive().optional(),
  provider_id: z.number().int().positive().optional(),
  /** 本轮用哪个模型：只能是所选服务商清单里的名字（registry 把关），不传就用该服务商的默认模型 */
  model: z.string().max(96).optional(),
});

const providerRow = (id: number): Record<string, unknown> | undefined =>
  get<Record<string, unknown>>(`SELECT ${PROVIDER_COLUMNS}, api_key_enc FROM ai_provider WHERE id = ? AND is_deleted = 0`, id);

/** 服务商列表：ResourcePage 直接可用（返回 {list,total}），密文换成 has_key */
aiRouter.get(
  '/providers',
  wrap((req, res) => {
    const q = new Q('p.is_deleted = 0')
      .like('(p.name LIKE ? OR p.model LIKE ? OR p.models LIKE ?)', req.query.keyword)
      .eq('p.vendor', req.query.vendor)
      .eq('p.enabled', req.query.enabled);
    const page = queryPage(req, { from: 'ai_provider p', q, select: `${PROVIDER_COLUMNS}, api_key_enc`, orderBy: 'p.is_default DESC, p.id ASC' });
    ok(res, { ...page, list: page.list.map((r) => providerView(r as never)) });
  }),
);

aiRouter.get(
  '/providers/all',
  wrap((_req, res) => ok(res, enabledProviders())),
);

aiRouter.get(
  '/providers/:id',
  wrap((req, res) => {
    const row = providerRow(Number(req.params.id));
    if (!row) throw notFound('服务商不存在');
    ok(res, providerView(row as never));
  }),
);

aiRouter.post(
  '/providers',
  wrap((req, res) => {
    const user = current(req);
    const body = parseBody(providerBody, req.body ?? {});
    assertBaseUrlAllowed(body.base_url);
    /**
     * parseBody 的泛型取的是 zod 的**输入**类型，所以带 .default() 的字段在 TS 里仍是可选 ——
     * 运行时 zod 已经补过默认值，这里再 `??` 一次只为类型过关，不改变行为。
     */
    const vendor = body.vendor ?? AI_VENDOR.CUSTOM;
    const preset = AI_VENDOR_PRESETS[vendor];
    /** 厂商预设带模型名（openai/deepseek/gemini），没填就按预设；custom 网关没有预设，留空等「拉模型」 */
    const models = normalizeModelInput({ model: '', models: null }, { model: body.model || preset.model, models: body.models });
    const data = {
      name: body.name,
      vendor,
      protocol: body.protocol ?? preset.protocol,
      base_url: body.base_url,
      model: models.model,
      models: models.models,
      temperature: body.temperature ?? 0.3,
      max_output_tokens: body.max_output_tokens ?? 1024,
      price_in_per_1k: body.price_in_per_1k ?? 0,
      price_out_per_1k: body.price_out_per_1k ?? 0,
      supports_tools: body.supports_tools ?? 1,
      enabled: body.enabled ?? 1,
      is_default: body.is_default ?? 0,
      created_by: user.id,
    };
    const id = insert('ai_provider', { ...data, api_key_enc: body.api_key ? encryptSecret(body.api_key) : null });
    if (data.is_default) get<unknown>(`UPDATE ai_provider SET is_default = 0 WHERE id <> ? AND is_deleted = 0`, id);
    writeOpLog({ user_id: user.id, module: MODULE, action: 'create', target_table: 'ai_provider', target_id: id, after: { ...body, api_key: body.api_key ? '（已加密写入，不回显）' : null }, ip: req.ip });
    ok(res, { id });
  }),
);

aiRouter.put(
  '/providers/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = providerRow(id);
    if (!before) throw notFound('服务商不存在');
    const body = parseBody(providerBody.partial(), req.body ?? {});
    if (body.base_url) assertBaseUrlAllowed(body.base_url);
    const patch: Record<string, unknown> = { ...body };
    /** 模型两个字段是一套口径，必须一起归一：只改默认时清单要跟着去重，只改清单时默认不能重复出现在清单里 */
    if (body.model !== undefined || body.models !== undefined) {
      Object.assign(
        patch,
        normalizeModelInput({ model: String(before.model ?? ''), models: before.models == null ? null : String(before.models) }, body),
      );
    }
    /** 空串 = 不动密钥；显式 null = 清空（清空后这条服务商就测不了也问不了，接口会直接报"还没填 key"） */
    if (body.api_key === undefined) delete patch.api_key;
    else if (!body.api_key) patch.api_key_enc = null;
    else patch.api_key_enc = encryptSecret(body.api_key);
    delete patch.api_key;
    if (body.is_default) get<unknown>(`UPDATE ai_provider SET is_default = 0 WHERE id <> ? AND is_deleted = 0`, id);
    update('ai_provider', id, patch as Record<string, import('../core/db.js').SqlParam>);
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'ai_provider',
      target_id: id,
      before: { ...before, api_key_enc: before.api_key_enc ? '***' : null },
      after: { ...body, api_key: body.api_key ? '（已更新，不回显）' : undefined, api_key_enc: undefined },
      ip: req.ip,
    });
    ok(res, { id });
  }),
);

aiRouter.delete(
  '/providers/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const before = providerRow(id);
    if (!before) throw notFound('服务商不存在');
    softDelete('ai_provider', id);
    writeOpLog({ user_id: user.id, module: MODULE, action: 'delete', target_table: 'ai_provider', target_id: id, before: { name: before.name, model: before.model }, ip: req.ip });
    ok(res, { id });
  }),
);

/** 测活：一次最小往返，结果连同错误（脱敏后）落到该服务商上 */
aiRouter.post(
  '/providers/:id/test',
  wrap(async (req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    if (!providerRow(id)) throw notFound('服务商不存在');
    try {
      const reply = await probeProvider(id);
      update('ai_provider', id, { last_test_at: new Date().toISOString().replace('T', ' ').slice(0, 19), last_test_ok: 1, last_test_error: null });
      ok(res, { ok: true, reply });
    } catch (e) {
      const msg = maskError(e instanceof Error ? e.message : String(e)).slice(0, 300);
      update('ai_provider', id, { last_test_at: new Date().toISOString().replace('T', ' ').slice(0, 19), last_test_ok: 0, last_test_error: msg });
      ok(res, { ok: false, error: msg });
    }
  }),
);

/**
 * 拉模型：问服务商"你这里有哪些模型"，把清单并进这一行。
 * 反代/网关（如自建 Gemini 代理）后面挂了哪些模型只有它自己知道，让人手抄不现实。
 */
aiRouter.post(
  '/providers/:id/models',
  wrap(async (req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    if (!providerRow(id)) throw notFound('服务商不存在');
    const out = await pullModels(id);
    writeOpLog({
      user_id: user.id,
      module: MODULE,
      action: 'update',
      target_table: 'ai_provider',
      target_id: id,
      after: { 拉模型: `取回 ${out.fetched_total} 个，清单 ${out.models.length} 个，新增 ${out.added} 个，默认 ${out.default_model || '（无）'}` },
      ip: req.ip,
    });
    ok(res, out);
  }),
);

/** 工具清单：前端把"AI 能干什么、哪些是写入"显示出来，不让人猜 */
aiRouter.get(
  '/tools',
  wrap((_req, res) =>
    ok(res, Object.values(AI_TOOLS).map((t) => ({ name: t.name, label: AI_TOOL_LABELS[t.name], write: t.write, menu: t.menu, description: t.description }))),
  ),
);

/** 一次对话：非流式（内部系统一问一答够用，且 SSE 带不上 Authorization 头） */
aiRouter.post(
  '/chat',
  wrap(async (req, res) => {
    const user = current(req);
    const body = parseBody(chatBody, req.body ?? {});
    const out = await runChat({
      user,
      ip: req.ip,
      content: body.content,
      conversationId: body.conversation_id,
      providerId: body.provider_id,
      model: body.model,
    });
    ok(res, out);
  }),
);

aiRouter.get(
  '/conversations',
  wrap((req, res) => {
    const user = current(req);
    const q = new Q('c.is_deleted = 0').eq('c.user_id', user.id).like('c.title LIKE ?', req.query.keyword);
    ok(res, queryPage(req, { from: 'ai_conversation c', q, select: 'c.*', orderBy: 'c.last_message_at IS NULL, c.id DESC' }));
  }),
);

aiRouter.get(
  '/conversations/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const conv = get<Record<string, unknown>>(`SELECT * FROM ai_conversation WHERE id = ? AND is_deleted = 0`, id);
    if (!conv || Number(conv.user_id) !== user.id) throw notFound('会话不存在');
    const messages = all<Record<string, unknown>>(
      `SELECT id, role, content, tool_calls, tool_name, call_id, latency_ms, created_at
         FROM ai_message WHERE conversation_id = ? AND is_deleted = 0 ORDER BY id ASC`,
      id,
    );
    ok(res, { conversation: conv, messages });
  }),
);

aiRouter.delete(
  '/conversations/:id',
  wrap((req, res) => {
    const user = current(req);
    const id = Number(req.params.id);
    const conv = get<Record<string, unknown>>(`SELECT * FROM ai_conversation WHERE id = ? AND is_deleted = 0`, id);
    if (!conv || Number(conv.user_id) !== user.id) throw notFound('会话不存在');
    softDelete('ai_conversation', id);
    writeOpLog({ user_id: user.id, module: MODULE, action: 'delete', target_table: 'ai_conversation', target_id: id, before: { title: conv.title }, ip: req.ip });
    ok(res, { id });
  }),
);

/** 调用审计：只给看得到 ai 菜单的人；普通角色只看到自己的，主管/老板看全部 */
aiRouter.get(
  '/calls',
  wrap((req, res) => {
    const user = current(req);
    const mineOnly = user.data_scope === 3 && user.role_key !== 'boss';
    const q = new Q('l.is_deleted = 0')
      .eq('l.provider_id', req.query.provider_id)
      .eq('l.status', req.query.status)
      .eq('l.user_id', req.query.user_id)
      .between('l.created_at', req.query.start_date, req.query.end_date);
    if (mineOnly) q.eq('l.user_id', user.id);
    ok(res, queryPage(req, {
      from: 'ai_call_log l LEFT JOIN sys_user u ON u.id = l.user_id LEFT JOIN ai_provider p ON p.id = l.provider_id',
      select: 'l.*, u.real_name AS user_name, p.name AS provider_name',
      q,
      orderBy: 'l.id DESC',
    }));
  }),
);

aiRouter.get(
  '/calls/usage',
  wrap((req, res) => {
    const user = current(req);
    /** 与 /calls 同一条可见范围：SELF 只看自己的花费，主管/老板看全站 */
    const mineOnly = user.data_scope === 3 && user.role_key !== 'boss';
    ok(res, {
      ...usageSummary(mineOnly ? ' AND user_id = ?' : '', mineOnly ? [user.id] : []),
      scope: mineOnly ? '本人' : '全部',
      enabled: config.aiEnabled,
      allowed_hosts: config.aiAllowedHosts,
      /** 被显式允许走明文的服务商地址：界面上要能看出这条例外存不存在，它关系到密钥是否明文过网 */
      plain_http_hosts: config.aiPlainHttpHosts,
      max_tool_rounds: config.aiMaxToolRounds,
    });
  }),
);

aiRouter.get(
  '/actions',
  wrap((req, res) => {
    const user = current(req);
    const mineOnly = user.data_scope === 3 && user.role_key !== 'boss';
    const q = new Q('a.is_deleted = 0')
      .eq('a.tool_name', req.query.tool_name)
      .eq('a.status', req.query.status)
      .between('a.created_at', req.query.start_date, req.query.end_date);
    if (mineOnly) q.eq('a.user_id', user.id);
    ok(res, queryPage(req, {
      from: 'ai_action_log a LEFT JOIN sys_user u ON u.id = a.user_id',
      select: 'a.*, u.real_name AS user_name',
      q,
      orderBy: 'a.id DESC',
    }));
  }),
);
