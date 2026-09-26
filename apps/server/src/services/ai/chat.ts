/**
 * 一轮对话的编排：取服务商 → 带工具问模型 → 执行工具 → 回灌 → 直到给出文本答案或用完轮数。
 *
 * 落库三件事，缺一不可：
 *  - ai_message：用户/助手/工具三种消息原样存，前端刷新后能看到完整因果；
 *  - ai_call_log：每次出网一条（token、耗时、估算花费、失败原因脱敏后）；
 *  - ai_action_log：只有**写工具**才落，记的是"哪条消息让 AI 用哪个工具改了什么"。
 *
 * 权限上没有"AI 身份"这回事：工具执行时传的是发起对话那个人的 user，
 * 所以他在界面上做不到的事，AI 也做不到。
 */
import { AI_ACTION_STATUS, AI_CALL_STATUS, AI_MESSAGE_ROLE, type CurrentUser } from '@tk/shared';
import { config } from '../../config.js';
import type { Transport } from '../tiktok/realClient.js';
import { AppError, badRequest, notFound } from '../../core/http.js';
import { all, get, insert, update } from '../../core/db.js';
import { maskError } from '../../core/redact.js';
import { providerClient } from './registry.js';
import { runTool, systemPrompt, toolSpecs, toolsFor, isWriteTool } from './tools.js';
import type { AiMessage } from './types.js';

interface ConversationRow {
  id: number;
  user_id: number;
  title: string;
  provider_id: number | null;
  model: string | null;
  message_count: number;
}

export interface ChatResult {
  conversation_id: number;
  provider: { id: number; name: string; model: string };
  messages: Record<string, unknown>[];
  usage: { prompt_tokens: number; completion_tokens: number; cost_cny: number; rounds: number };
}

/** 会话归属：不是自己的会话就当不存在（不区分 403/404，免得探测别人的会话 ID） */
function loadConversation(id: number, user: CurrentUser): ConversationRow {
  const row = get<ConversationRow>(`SELECT * FROM ai_conversation WHERE id = ? AND is_deleted = 0`, id);
  if (!row || Number(row.user_id) !== user.id) throw notFound('会话不存在');
  return row;
}

function titleOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return (one.slice(0, 40) || '新对话') + (one.length > 40 ? '…' : '');
}

/** 历史裁剪：从最旧一侧丢，但系统提示与本轮提问永不丢；总量再按字符数兜一刀 */
function trimHistory(messages: AiMessage[], maxChars: number): AiMessage[] {
  const system = messages.filter((m) => m.role === AI_MESSAGE_ROLE.SYSTEM);
  const rest = messages.filter((m) => m.role !== AI_MESSAGE_ROLE.SYSTEM);
  const last = rest[rest.length - 1];
  const body = rest.slice(0, -1);
  let keep = body.length > config.aiHistoryLimit ? body.slice(-config.aiHistoryLimit) : body;
  const size = (arr: AiMessage[]): number => arr.reduce((s, m) => s + m.content.length + JSON.stringify(m.toolCalls ?? '').length, 0);
  while (keep.length > 2 && size(keep) + size(system) + (last?.content.length ?? 0) > maxChars) keep = keep.slice(1);
  return [...system, ...keep, ...(last ? [last] : [])];
}

function estimateCost(cfg: { priceInPer1k: number; priceOutPer1k: number }, inTok: number, outTok: number): number {
  return Math.round(((inTok / 1000) * cfg.priceInPer1k + (outTok / 1000) * cfg.priceOutPer1k) * 10000) / 10000;
}

export async function runChat(input: {
  user: CurrentUser;
  ip?: string;
  content: string;
  conversationId?: number;
  providerId?: number;
  /** 只给测试注入桩 transport 用；生产不传，走真实 fetch */
  transport?: Transport;
}): Promise<ChatResult> {
  if (!config.aiEnabled) throw new AppError(503, 'AI 能力已关闭（AI_ENABLED=false）');
  const content = String(input.content ?? '').trim();
  if (!content) throw badRequest('消息不能为空');
  if (content.length > 8000) throw badRequest('单条消息最长 8000 字，请先精简或分几条问');

  const { provider, client, cfg } = providerClient(input.providerId, input.transport);

  let conv: ConversationRow;
  if (input.conversationId) {
    conv = loadConversation(input.conversationId, input.user);
  } else {
    const id = insert('ai_conversation', {
      user_id: input.user.id,
      title: titleOf(content),
      provider_id: provider.id,
      model: cfg.model,
      message_count: 0,
      created_by: input.user.id,
    });
    conv = loadConversation(id, input.user);
  }

  const specs = toolSpecs(toolsFor(input.user));
  const history = all<Record<string, unknown>>(
    `SELECT role, content, tool_calls FROM ai_message WHERE conversation_id = ? AND is_deleted = 0 ORDER BY id ASC`,
    conv.id,
  );
  const messages: AiMessage[] = [{ role: AI_MESSAGE_ROLE.SYSTEM, content: systemPrompt(input.user, []) }];
  for (const h of history) {
    const role = String(h.role) as AiMessage['role'];
    let toolCalls: AiMessage['toolCalls'];
    if (h.tool_calls) {
      try {
        toolCalls = JSON.parse(String(h.tool_calls)) as AiMessage['toolCalls'];
      } catch {
        toolCalls = undefined;
      }
    }
    messages.push({ role, content: String(h.content ?? ''), toolCalls: toolCalls?.length ? toolCalls : undefined });
  }
  messages.push({ role: AI_MESSAGE_ROLE.USER, content });

  insert('ai_message', {
    conversation_id: conv.id,
    role: AI_MESSAGE_ROLE.USER,
    content,
    created_by: input.user.id,
  });

  const created: Record<string, unknown>[] = [];
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  let modelCalls = 0;
  let answered = false;
  let lastCallId = 0;

  for (let round = 0; round < config.aiMaxToolRounds; round++) {
    const prompt = trimHistory(messages, config.aiMaxPromptChars);
    let completion;
    try {
      completion = await client.complete(prompt, cfg.supportsTools ? specs : []);
      modelCalls++;
    } catch (e) {
      const msg = maskError(e instanceof Error ? e.message : String(e)).slice(0, 300);
      lastCallId = insert('ai_call_log', {
        user_id: input.user.id,
        provider_id: provider.id,
        conversation_id: conv.id,
        model: cfg.model,
        status: AI_CALL_STATUS.FAILED,
        error_msg: msg,
        created_by: input.user.id,
      });
      throw new AppError(502, msg);
    }
    inTok += completion.usage.promptTokens;
    outTok += completion.usage.completionTokens;
    const one = estimateCost(cfg, completion.usage.promptTokens, completion.usage.completionTokens);
    cost = Math.round((cost + one) * 10000) / 10000;
    lastCallId = insert('ai_call_log', {
      user_id: input.user.id,
      provider_id: provider.id,
      conversation_id: conv.id,
      model: completion.model || cfg.model,
      status: AI_CALL_STATUS.SUCCESS,
      prompt_tokens: completion.usage.promptTokens,
      completion_tokens: completion.usage.completionTokens,
      latency_ms: completion.latencyMs,
      cost_cny: one,
      tool_count: completion.toolCalls.length,
      created_by: input.user.id,
    });

    const assistant: AiMessage = {
      role: AI_MESSAGE_ROLE.ASSISTANT,
      content: completion.text,
      toolCalls: completion.toolCalls.length ? completion.toolCalls : undefined,
    };
    insert('ai_message', {
      conversation_id: conv.id,
      role: AI_MESSAGE_ROLE.ASSISTANT,
      content: completion.text,
      tool_calls: completion.toolCalls.length ? JSON.stringify(completion.toolCalls) : null,
      call_id: lastCallId,
      prompt_tokens: completion.usage.promptTokens,
      completion_tokens: completion.usage.completionTokens,
      latency_ms: completion.latencyMs,
      created_by: input.user.id,
    });
    messages.push(assistant);
    created.push({
      role: AI_MESSAGE_ROLE.ASSISTANT,
      content: completion.text,
      tool_calls: completion.toolCalls.length ? completion.toolCalls : null,
      call_id: lastCallId,
      latency_ms: completion.latencyMs,
    });

    if (!completion.toolCalls.length) {
      answered = true;
      break;
    }

    for (const call of completion.toolCalls) {
      const args = (() => {
        try {
          return JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const result = await runTool({ user: input.user, ip: input.ip, callId: lastCallId, conversationId: conv.id }, call.name, args);
      if (isWriteTool(call.name)) {
        insert('ai_action_log', {
          call_id: lastCallId,
          conversation_id: conv.id,
          user_id: input.user.id,
          tool_name: call.name,
          status: result.ok ? AI_ACTION_STATUS.EXECUTED : AI_ACTION_STATUS.REJECTED,
          arguments: call.arguments,
          result: JSON.stringify(result.payload).slice(0, 4000),
          target_table: call.name === 'create_outreach' ? 'creator_outreach' : 'alert_event',
          target_id: Number(result.payload.outreach_id ?? result.payload.action_id ?? args.event_id ?? 0) || null,
          error_msg: result.ok ? null : maskError(String(result.payload.error ?? '')).slice(0, 300),
          created_by: input.user.id,
        });
      }
      const toolText = JSON.stringify(result.payload);
      insert('ai_message', {
        conversation_id: conv.id,
        role: AI_MESSAGE_ROLE.TOOL,
        content: toolText,
        tool_name: call.name,
        call_id: lastCallId,
        created_by: input.user.id,
      });
      messages.push({ role: AI_MESSAGE_ROLE.TOOL, content: toolText, toolCallId: call.id, toolName: call.name });
      created.push({ role: AI_MESSAGE_ROLE.TOOL, tool_name: call.name, content: toolText, ok: result.ok });
    }
  }

  /** 轮数用完还没拿到纯文本答案 = 模型一直在调工具，得说明为什么就此收口 */
  if (!answered) {
    const note = `（已达到单次提问的工具调用上限 ${config.aiMaxToolRounds} 轮，先按已有信息回答）`;
    insert('ai_message', { conversation_id: conv.id, role: AI_MESSAGE_ROLE.ASSISTANT, content: note, created_by: input.user.id });
    created.push({ role: AI_MESSAGE_ROLE.ASSISTANT, content: note, tool_calls: null });
  }

  const count = Number(get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_message WHERE conversation_id = ? AND is_deleted = 0`, conv.id)?.n ?? 0);
  update('ai_conversation', conv.id, {
    message_count: count,
    last_message_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    provider_id: provider.id,
    model: cfg.model,
  });

  return {
    conversation_id: conv.id,
    provider: { id: provider.id, name: provider.name, model: cfg.model },
    messages: created,
    usage: { prompt_tokens: inTok, completion_tokens: outTok, cost_cny: cost, rounds: modelCalls },
  };
}
