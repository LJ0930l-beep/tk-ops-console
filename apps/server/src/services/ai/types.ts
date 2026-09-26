/** AI 模块内部共用的数据形状：适配器与编排层之间只认这几个结构 */

export type AiRole = 'system' | 'user' | 'assistant' | 'tool';

/** 交给模型的一个工具：parameters 是 JSON Schema，两家协议各自翻译 */
export interface AiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 模型发起的一次工具调用（arguments 是 JSON 原文，可能不合法 —— 执行前要自己校验） */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiMessage {
  role: AiRole;
  content: string;
  /** role=assistant 时可能有；表示这条回复同时要调工具 */
  toolCalls?: AiToolCall[];
  /** role=tool 时必填：这条结果是回给哪一次调用的 */
  toolCallId?: string;
  toolName?: string;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 一次模型往返的归一结果：两家协议的差异到 this 为止 */
export interface AiCompletion {
  text: string;
  toolCalls: AiToolCall[];
  usage: AiUsage;
  model: string;
  latencyMs: number;
}

/** 从库里解好密的服务商配置（含明文 key，只在内存里活一次调用的时间） */
export interface AiProviderConfig {
  id: number;
  name: string;
  protocol: 'openai' | 'gemini';
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  priceInPer1k: number;
  priceOutPer1k: number;
}

export interface AiProviderClient {
  /** tools 为空数组表示这轮不给模型任何工具（例如 supports_tools=0 的模型） */
  complete(messages: AiMessage[], tools: AiToolSpec[]): Promise<AiCompletion>;
  /** 服务商是否配了函数调用能力：Gemini 用 functionDeclarations，OpenAI 用 tools */
  readonly protocol: 'openai' | 'gemini';
}
