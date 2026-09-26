/**
 * AI 助手回归（PRD §3.13）。
 *
 * 产品里没有 mock 服务商（用户明确定的是"没配就报错"），所以这里验"真出网"的那几条用例
 * 全部**注入桩 transport**：桩只替掉 fetch 这一层，报文形态、工具循环、落库、脱敏
 * 走的都是生产代码。这样 CI 不需要任何真实 key，也不会因为网络抖动变 flaky。
 *
 * 六件必须钉死的事：
 *  1. 没配服务商 → 明确可读的 409，不是一句 undefined；
 *  2. API Key 永不出接口、永不出错误文案（含服务商把 key 回显在 401 body 里的情况）；
 *  3. 工具白名单之外的名字不执行；
 *  4. 写工具真的写进业务表，并且 op_log + ai_action_log 两处留痕、操作人是发起对话的人；
 *  5. 没有对应菜单的人，AI 也替他写不了（越权返回被拒且留痕）；
 *  6. 两家协议的报文形状各自对拍（systemInstruction / functionDeclarations / x-goog-api-key）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { all, get, insert } from '../src/core/db.js';
import { encryptSecret, loadUser } from '../src/core/auth.js';
import type { RawResponse, Transport } from '../src/services/tiktok/realClient.js';
import { runChat } from '../src/services/ai/chat.js';
import { ACCOUNTS, auth, boot, DEFAULT_PASSWORD, login } from './helper.js';

let ctx: ReturnType<typeof boot>;
const token: Record<string, string> = {};
const KEY = 'sk-unit-test-secret-0123456789';

beforeAll(async () => {
  ctx = boot();
  for (const [k, u] of Object.entries(ACCOUNTS)) token[k] = await login(ctx.http, u, DEFAULT_PASSWORD);
});

/** 一帧 OpenAI chat/completions 响应 */
const oaReply = (content: string | null, toolCalls: { id: string; name: string; arguments: string }[] = []) => ({
  model: 'gpt-4o-mini-test',
  choices: [{ message: { content, ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 21, completion_tokens: 7 },
});

/** 一帧 Gemini generateContent 响应 */
const gmReply = (text: string | null, fn?: { name: string; args: Record<string, unknown> }) => ({
  candidates: [{ content: { parts: [...(text ? [{ text }] : []), ...(fn ? [{ functionCall: { name: fn.name, args: fn.args } }] : [])] }, finishReason: fn ? 'STOP' : 'STOP' }],
  usageMetadata: { promptTokenCount: 33, candidatesTokenCount: 5 },
});

interface Captured { url: string; body: Record<string, unknown>; headers: Record<string, string> }

/** 按脚本依次回帧；最后一帧会被重复使用（防止断言时才发现步数不够） */
function stubTransport(replies: ((req: Record<string, unknown>) => unknown)[]): { transport: Transport; calls: Captured[] } {
  const calls: Captured[] = [];
  const transport: Transport = async (url, init) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    const i = calls.length;
    calls.push({ url, body, headers: init.headers });
    const payload = replies[Math.min(i, replies.length - 1)](body);
    const raw: RawResponse = { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
    return raw;
  };
  return { transport, calls };
}

function addProvider(name = '单测 GPT', over: Record<string, unknown> = {}): number {
  return insert('ai_provider', {
    name,
    vendor: 'openai',
    protocol: 'openai',
    base_url: 'https://api.unit-test.invalid/v1',
    model: 'gpt-4o-mini-test',
    api_key_enc: encryptSecret(KEY),
    temperature: 0.2,
    max_output_tokens: 512,
    price_in_per_1k: 1,
    price_out_per_1k: 2,
    supports_tools: 1,
    enabled: 1,
    is_default: 1,
    created_by: 1,
    ...over,
  });
}

describe('服务商配置与密钥边界', () => {
  it('一家都没配时，对话给出能照着做的下一步而不是崩', async () => {
    const res = await ctx.http.post('/api/ai/chat').set(auth(token.boss)).send({ content: '现在哪个店在亏钱' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/模型服务商/);
    expect(res.body.message).toMatch(/API Key/);
  });

  it('Key 只进不出：列表与详情里既无明文也无密文列', async () => {
    const id = addProvider('密钥不外泄');
    const list = await ctx.http.get('/api/ai/providers').set(auth(token.boss));
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('api_key_enc');
    const one = JSON.stringify((await ctx.http.get(`/api/ai/providers/${id}`).set(auth(token.boss))).body);
    expect(one).not.toContain(KEY);
    expect(one).toContain('"has_key":true');
  });

  it('非 https 的服务商地址直接拒（防止把 key 送到明文端口）', async () => {
    const res = await ctx.http.post('/api/ai/providers').set(auth(token.boss)).send({
      name: '明文地址', vendor: 'custom', base_url: 'http://evil.example.com/v1', model: 'x', api_key: KEY,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/https/);
  });

  it('服务商把 key 回显在 401 报文里，也不许流进错误文案', async () => {
    const id = addProvider('401 回显');
    const transport: Transport = async () => ({
      status: 401,
      headers: { get: () => null },
      text: async () => `bad key: ${KEY}`,
    });
    await expect(runChat({ user: loadUser(1)!, content: 'hi', providerId: id, transport })).rejects.toThrow(/API Key 无效/);
    const err = String(all<Record<string, unknown>>(`SELECT error_msg FROM ai_call_log WHERE provider_id = ? ORDER BY id DESC`, id)[0]?.error_msg ?? '');
    expect(err).not.toContain(KEY);
    expect(err).toMatch(/API Key 无效|401/);
  });
});

describe('对话与工具循环（OpenAI 兼容协议）', () => {
  it('模型先调工具再回答：两轮出网、消息与审计都落库、第二轮带上工具结果', async () => {
    const id = addProvider('工具循环');
    const user = loadUser(1)!;
    const { transport, calls } = stubTransport([
      () => oaReply(null, [{ id: 'c1', name: 'get_dashboard', arguments: '{"days":7}' }]),
      () => oaReply('近 7 天贡献毛利为负，主要是广告消耗盖过了返点。'),
    ]);
    const out = await runChat({ user, content: '最近赚钱吗', providerId: id, transport });

    expect(out.usage.rounds).toBe(2);
    expect(out.usage.prompt_tokens).toBe(42);
    expect(out.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(String(out.messages[2].content)).toMatch(/贡献毛利/);

    // 两次真实出网，第二次的 messages 里必须带上 role=tool 的结果
    expect(calls.length).toBe(2);
    const wire2 = JSON.stringify(calls[1].body.messages);
    expect(wire2).toContain('"role":"tool"');
    expect(wire2).toContain('tool_call_id');
    // 第一次必须把工具清单发出去，否则模型无从调用
    expect(JSON.stringify(calls[0].body.tools)).toContain('get_dashboard');
    // 系统提示里写死了口径与红线
    expect(String((calls[0].body.messages as Record<string, unknown>[])[0].content)).toMatch(/品牌返点/);

    expect(Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_call_log WHERE provider_id = ?`, id)?.n)).toBe(2);
    const roles = all<{ role: string }>(`SELECT role FROM ai_message WHERE conversation_id = ? ORDER BY id`, out.conversation_id).map((r) => r.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const conv = get<{ message_count: number; title: string }>(`SELECT message_count, title FROM ai_conversation WHERE id = ?`, out.conversation_id)!;
    expect(Number(conv.message_count)).toBe(4);
    expect(conv.title).toBe('最近赚钱吗');
  });

  it('白名单之外的工具名不执行，只回一句"不存在"', async () => {
    const id = addProvider('幻觉工具');
    const { transport } = stubTransport([
      () => oaReply(null, [{ id: 'x1', name: 'delete_all_orders', arguments: '{}' }]),
      () => oaReply('这个操作系统不开放。'),
    ]);
    const out = await runChat({ user: loadUser(1)!, content: '把订单删了', providerId: id, transport });
    const toolMsg = out.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/不存在/);
    expect(all(`SELECT * FROM ai_action_log WHERE tool_name = 'delete_all_orders'`)).toHaveLength(0);
  });

  it('写工具真的写：业务表 + op_log + ai_action_log 三处留痕，操作人是发起对话的人', async () => {
    const id = addProvider('写入留痕');
    const creator = get<{ id: number; handle: string }>(`SELECT id, handle FROM creator WHERE is_deleted = 0 AND pool_status = 1 LIMIT 1`)!;
    expect(creator).toBeTruthy();
    const user = loadUser(1)!;
    const { transport } = stubTransport([
      () => oaReply(null, [{ id: 'w1', name: 'create_outreach', arguments: JSON.stringify({ creator_id: creator.id, result: 6, summary: '谈妥，佣金 15%' }) }]),
      () => oaReply('已登记跟进并把达人转入你的私海。'),
    ]);
    const out = await runChat({ user, content: `帮我把 @${creator.handle} 的跟进记一下：谈妥`, providerId: id, transport });

    const row = get<{ id: number; user_id: number; result: number }>(
      `SELECT id, user_id, result FROM creator_outreach WHERE creator_id = ? ORDER BY id DESC LIMIT 1`, creator.id,
    )!;
    expect(Number(row.user_id)).toBe(user.id);
    expect(Number(row.result)).toBe(6);
    const logs = all<{ id: number; user_id: number }>(`SELECT id, user_id FROM sys_op_log WHERE target_table = 'creator_outreach' AND target_id = ?`, Number(row.id));
    expect(logs.length).toBeGreaterThan(0);
    expect(Number(logs[0].user_id)).toBe(user.id);
    const action = get<{ status: number; tool_name: string; target_table: string; target_id: number }>(
      `SELECT status, tool_name, target_table, target_id FROM ai_action_log WHERE conversation_id = ?`, out.conversation_id,
    )!;
    expect(action.tool_name).toBe('create_outreach');
    expect(Number(action.status)).toBe(1);
    expect(action.target_table).toBe('creator_outreach');
    expect(Number(action.target_id)).toBe(Number(row.id));
    // 公海达人被跟进后应转入本人私海（与界面快捷录入同一效果）
    expect(Number(get<{ pool_status: number }>(`SELECT pool_status FROM creator WHERE id = ?`, creator.id)?.pool_status)).toBe(2);
  });

  it('没有达人菜单的人，AI 也替他写不了建联跟进（并留一条"被拒"）', async () => {
    const id = addProvider('越权写入');
    const editor = loadUser(all<{ id: number }>(`SELECT id FROM sys_user WHERE username = 'yinuo'`)[0].id)!;
    expect(editor.menu_perms.includes('creator')).toBe(false);
    const creator = get<{ id: number }>(`SELECT id FROM creator WHERE is_deleted = 0 LIMIT 1`)!;
    const { transport } = stubTransport([
      () => oaReply(null, [{ id: 'p1', name: 'create_outreach', arguments: JSON.stringify({ creator_id: creator.id, result: 3 }) }]),
      () => oaReply('你没这个权限。'),
    ]);
    const out = await runChat({ user: editor, content: '记一条跟进', providerId: id, transport });
    const action = get<{ status: number; error_msg: string }>(`SELECT status, error_msg FROM ai_action_log WHERE conversation_id = ?`, out.conversation_id)!;
    expect(Number(action.status)).toBe(2);
    expect(String(action.error_msg)).toMatch(/菜单|越权/);
    expect(Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM creator_outreach WHERE creator_id = ? AND user_id = ?`, creator.id, editor.id)?.n)).toBe(0);
  });

  it('用完工具轮数还没答完，也要留下一条能看懂的说明而不是空回复', async () => {
    const id = addProvider('轮数上限');
    const { transport } = stubTransport([() => oaReply(null, [{ id: 'loop', name: 'get_dashboard', arguments: '{}' }])]);
    const out = await runChat({ user: loadUser(1)!, content: '一直查', providerId: id, transport });
    expect(out.usage.rounds).toBeGreaterThanOrEqual(1);
    expect(String(out.messages[out.messages.length - 1].content)).toMatch(/工具调用上限/);
  });
});

describe('Gemini 协议对拍', () => {
  it('走 generateContent、密钥在头不在 URL、system 进 systemInstruction、工具进 functionDeclarations', async () => {
    const gid = insert('ai_provider', {
      name: '单测 Gemini', vendor: 'gemini', protocol: 'gemini',
      base_url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash',
      api_key_enc: encryptSecret(KEY), temperature: 0.2, max_output_tokens: 512,
      price_in_per_1k: 0, price_out_per_1k: 0, supports_tools: 1, enabled: 1, is_default: 0, created_by: 1,
    });
    const { transport, calls } = stubTransport([
      () => gmReply(null, { name: 'list_alerts', args: { limit: 3 } }),
      () => gmReply('有 3 条 P0 未闭环。'),
    ]);
    const out = await runChat({ user: loadUser(1)!, content: '现在有什么要紧事', providerId: gid, transport });

    expect(calls[0].url).toMatch(/\/models\/gemini-2\.5-flash:generateContent$/);
    expect(calls[0].url).not.toContain(KEY);
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0].body.systemInstruction).toBeTruthy();
    expect(JSON.stringify(calls[0].body.tools)).toContain('functionDeclarations');
    // 第二轮：函数结果以 user 轮次的 functionResponse 回传（Gemini 没有 tool 角色）
    const second = JSON.stringify(calls[1].body.contents);
    expect(second).toContain('functionResponse');
    expect(out.messages[out.messages.length - 1].role).toBe('assistant');
  });
});

describe('菜单与契约', () => {
  it('没有 ai 菜单的人连 /api/ai/tools 都进不来', async () => {
    // 演示库的角色默认带 ai（DEFAULT_ROLES + migrateAiMenu），这里模拟管理员手工收回
    const withAi = get<{ menu_perms: string }>(`SELECT menu_perms FROM sys_role WHERE role_key = 'content'`)!;
    expect(JSON.parse(String(withAi.menu_perms)) as string[]).toContain('ai');
    ctx.db.exec(`UPDATE sys_role SET menu_perms = '["dashboard","content"]' WHERE role_key = 'content'`);
    const fresh = await login(ctx.http, ACCOUNTS.content, DEFAULT_PASSWORD);
    expect((await ctx.http.get('/api/ai/tools').set(auth(fresh))).status).toBe(403);
    expect((await ctx.http.post('/api/ai/chat').set(auth(fresh)).send({ content: 'hi' })).status).toBe(403);
  });
});
