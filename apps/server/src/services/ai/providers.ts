/**
 * 两家报文协议的适配器：OpenAI 兼容（GPT / DeepSeek / 自建网关）与 Google Gemini 原生。
 *
 * 刻意做成"一个文件、一份出网姿势"：超时、重试、脱敏、错误翻译这些如果各写一遍，
 * 一定会出现"OpenAI 那条路径把 key 写进日志、Gemini 那条没有"这种分叉。
 *
 * 密钥只在请求头里（Gemini 用 x-goog-api-key，不走 query 参数），
 * 所以它不会出现在 URL、访问日志与错误栈里；再叠加 safe() 把已知密钥整串替换 + maskError 兜底。
 */
import { config } from '../../config.js';
import { AppError } from '../../core/http.js';
import { maskError } from '../../core/redact.js';
import type { Transport } from '../tiktok/realClient.js';
import type { AiCompletion, AiMessage, AiProviderClient, AiProviderConfig, AiToolCall, AiToolSpec } from './types.js';

const httpTransport: Transport = (url, init) => fetch(url, init);

/** 服务商/网络侧失败：文案已经过 safe()，不含密钥；code 段留 HTTP 状态便于前端分色 */
export class AiApiError extends AppError {
  constructor(provider: string, status: number, message: string) {
    super(502, `${provider} 调用失败：${message}`, 50200 + (Number.isFinite(status) ? status : 0));
  }
}

/** 把服务商返回翻成人能照着做的下一步（PRD §5.3：错误不许只给一个码） */
function describeFailure(status: number, body: string): string {
  const text = body.slice(0, 300);
  if (status === 401 || status === 403) return 'API Key 无效或没有该模型的权限，请到「模型服务商」核对密钥与模型名';
  if (status === 404) return '接口地址或模型名不对（404）：自定义网关请核对 base_url 是否已经包含 /v1 这类前缀';
  if (status === 429) return '触发限流或额度用尽（429），稍后重试或换一家服务商';
  if (status >= 500) return `服务商侧异常（HTTP ${status}），稍后重试`;
  return `HTTP ${status}：${text || '服务商未返回原因'}`;
}

const isRetryable = (status: number): boolean => status === 429 || status >= 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface PostResult {
  status: number;
  json: Record<string, unknown>;
}

/** 一次 POST：超时、退避重试、非 2xx 翻译、失败文案脱敏。返回已解析的 JSON */
async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  secrets: string[],
  provider: string,
  transport: Transport,
): Promise<PostResult> {
  const attempts = Math.max(1, config.aiMaxRetry + 1);
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(Math.min(5000, 500 * 2 ** (i - 1)));
    try {
      const res = await transport(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.aiTimeoutMs),
      });
      const raw = await res.text();
      if (res.status >= 400) {
        lastError = describeFailure(res.status, safe(raw, secrets));
        if (!isRetryable(res.status)) throw new AiApiError(provider, res.status, lastError);
        continue;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new AiApiError(provider, res.status, `服务商返回的不是 JSON：${safe(raw, secrets).slice(0, 200)}`);
      }
      return { status: res.status, json };
    } catch (e) {
      if (e instanceof AiApiError) throw e;
      const name = e instanceof Error ? e.name : '';
      const msg = e instanceof Error ? e.message : String(e);
      lastError = name === 'TimeoutError' ? `请求超时（>${Math.round(config.aiTimeoutMs / 1000)}s）` : safe(msg, secrets).slice(0, 200);
      if (i === attempts - 1) break;
    }
  }
  throw new AiApiError(provider, 0, lastError || '未知网络错误');
}

/** 已知的密钥整串先替换掉，再走通用脱敏：日志、错误文案、审计表都只经过这一道出口 */
export function safe(text: string, secrets: string[]): string {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return maskError(out);
}

/** 服务商返回体里可能自带的 error.message / 顶层 message */
function errorMessage(json: Record<string, unknown>): string {
  const err = json.error;
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  if (typeof json.message === 'string') return String(json.message);
  return '';
}

/* ---------------- OpenAI 兼容协议（GPT / DeepSeek / 网关） ---------------- */

export class OpenAiProvider implements AiProviderClient {
  readonly protocol = 'openai' as const;

  constructor(private readonly cfg: AiProviderConfig, private readonly transport: Transport = httpTransport) {}

  private get endpoint(): string {
    // base_url 允许带或不带 /v1：统一在这里补齐，避免"DeepSeek 要 /v1、自建网关已经自带"两种写法各配一份
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  private toWire(messages: AiMessage[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });
        continue;
      }
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  async complete(messages: AiMessage[], tools: AiToolSpec[]): Promise<AiCompletion> {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.toWire(messages),
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxOutputTokens,
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    const { json } = await postJson(this.endpoint, { authorization: `Bearer ${this.cfg.apiKey}` }, body, [this.cfg.apiKey], this.cfg.name, this.transport);
    const err = errorMessage(json);
    if (err) throw new AiApiError(this.cfg.name, 200, safe(err, [this.cfg.apiKey]).slice(0, 240));
    const choice = (Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[])[0] : undefined) ?? {};
    const msg = (choice.message ?? {}) as Record<string, unknown>;
    const rawCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : [];
    const calls: AiToolCall[] = rawCalls.map((c, i) => {
      const fn = (c.function ?? {}) as Record<string, unknown>;
      return { id: String(c.id ?? `call_${i}`), name: String(fn.name ?? ''), arguments: String(fn.arguments ?? '{}') };
    });
    const usage = (json.usage ?? {}) as Record<string, unknown>;
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: calls,
      usage: { promptTokens: Number(usage.prompt_tokens ?? 0) || 0, completionTokens: Number(usage.completion_tokens ?? 0) || 0 },
      model: String(json.model ?? this.cfg.model),
      latencyMs: Date.now() - t0,
    };
  }
}

/* ---------------- Google Gemini 原生协议 ---------------- */

export class GeminiProvider implements AiProviderClient {
  readonly protocol = 'gemini' as const;

  constructor(private readonly cfg: AiProviderConfig, private readonly transport: Transport = httpTransport) {}

  private get endpoint(): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    return `${base}/models/${encodeURIComponent(this.cfg.model)}:generateContent`;
  }

  /**
   * Gemini 没有独立的 tool 角色：函数结果作为 user 轮次的 functionResponse 回传，
   * 而 system 提示走顶层 systemInstruction（塞进 contents 会被当成用户说的话）。
   */
  private toWire(messages: AiMessage[]): Record<string, unknown> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents: Record<string, unknown>[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        let parsed: unknown = m.content;
        try {
          parsed = JSON.parse(m.content);
        } catch {
          /* 工具返回不是 JSON 时按纯文本回传，别把整轮问死 */
        }
        contents.push({ role: 'user', parts: [{ functionResponse: { name: m.toolName ?? 'tool', response: { result: parsed } } }] });
        continue;
      }
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: parseArgs(c.arguments) } });
      if (!parts.length) parts.push({ text: '' });
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }
    return { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) };
  }

  async complete(messages: AiMessage[], tools: AiToolSpec[]): Promise<AiCompletion> {
    const t0 = Date.now();
    const wire = this.toWire(messages);
    const body: Record<string, unknown> = {
      ...wire,
      generationConfig: { temperature: this.cfg.temperature, maxOutputTokens: this.cfg.maxOutputTokens },
    };
    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const { json } = await postJson(this.endpoint, { 'x-goog-api-key': this.cfg.apiKey }, body, [this.cfg.apiKey], this.cfg.name, this.transport);
    const err = errorMessage(json);
    if (err) throw new AiApiError(this.cfg.name, 200, safe(err, [this.cfg.apiKey]).slice(0, 240));
    const candidate = (Array.isArray(json.candidates) ? (json.candidates as Record<string, unknown>[])[0] : undefined) ?? {};
    const parts = Array.isArray((candidate.content as Record<string, unknown> | undefined)?.parts)
      ? (((candidate.content as Record<string, unknown>).parts as Record<string, unknown>[]) ?? [])
      : [];
    let text = '';
    const calls: AiToolCall[] = [];
    parts.forEach((p) => {
      if (typeof p.text === 'string') text += p.text;
      const fc = p.functionCall as Record<string, unknown> | undefined;
      if (fc) calls.push({ id: `gemini_${calls.length}`, name: String(fc.name ?? ''), arguments: JSON.stringify(fc.args ?? {}) });
    });
    const blocked = String(candidate.finishReason ?? '');
    if (!text && !calls.length && blocked && blocked !== 'STOP') {
      throw new AiApiError(this.cfg.name, 200, `模型没有产出内容（finishReason=${blocked}，常见于安全策略拦截或超长上下文）`);
    }
    const usage = (json.usageMetadata ?? {}) as Record<string, unknown>;
    return {
      text,
      toolCalls: calls,
      usage: { promptTokens: Number(usage.promptTokenCount ?? 0) || 0, completionTokens: Number(usage.candidatesTokenCount ?? 0) || 0 },
      model: this.cfg.model,
      latencyMs: Date.now() - t0,
    };
  }
}

/** 工具入参：模型给的是 JSON 文本，坏掉的 JSON 不能完全靠抛异常打断整轮对话 */
export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createProviderClient(cfg: AiProviderConfig, transport: Transport = httpTransport): AiProviderClient {
  return cfg.protocol === 'gemini' ? new GeminiProvider(cfg, transport) : new OpenAiProvider(cfg, transport);
}
