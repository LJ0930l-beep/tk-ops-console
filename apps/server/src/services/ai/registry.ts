/**
 * 服务商配置的读取与解析。
 *
 * 两条规矩是从 tk_shop 凭证那套照搬过来的：
 *  1. 密文列 `api_key_enc` 永远不出接口 —— 列表/详情走字段白名单，只回 has_key；
 *  2. base_url 是界面上可写的，所以出网前必须过协议与主机白名单，
 *     否则一个被盗用的管理员账号只要"测活"一次，就能把 API Key 送到攻击者的服务器。
 */
import { config } from '../../config.js';
import { badRequest, AppError } from '../../core/http.js';
import { decryptSecret } from '../../core/auth.js';
import { get, all, update } from '../../core/db.js';
import { createProviderClient, listModelNames } from './providers.js';
import type { AiProviderClient, AiProviderConfig } from './types.js';
import type { Transport } from '../tiktok/realClient.js';

/** 列表与详情共用的字段白名单：这里没列出来的键（含密文）不会出现在任何响应里 */
export const PROVIDER_COLUMNS = `id, name, vendor, protocol, base_url, model, models, temperature, max_output_tokens,
  price_in_per_1k, price_out_per_1k, supports_tools, enabled, is_default,
  last_test_at, last_test_ok, last_test_error, created_by, created_at, updated_at, is_deleted`;

export interface ProviderRow extends Record<string, unknown> {
  id: number;
  name: string;
  vendor: string;
  protocol: string;
  base_url: string;
  model: string;
  /** 可选模型清单原文（逗号分隔）：反代/网关一家挂几十个模型时用它，`model` 只是默认那一个 */
  models: string | null;
  temperature: number;
  max_output_tokens: number;
  price_in_per_1k: number;
  price_out_per_1k: number;
  enabled: number;
  is_default: number;
  supports_tools: number;
}

/** 清单最多留多少个：反代一次能拉出上百个名字，全存下来既没意义又撑爆列 */
export const MAX_MODELS = 60;

/**
 * 模型清单的唯一解析口径：界面上可以按行/逗号/分号粘贴，拉取接口也写这一份。
 * 去重保序（默认模型排到最前），并截到 MAX_MODELS 个。
 */
export function parseModels(row: { model?: string | null; models?: string | null }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: unknown): void => {
    const name = String(v ?? '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  const def = String(row.model ?? '').trim();
  push(def);
  for (const piece of String(row.models ?? '').split(/[\n,;，；、]/)) push(piece);
  return out.slice(0, MAX_MODELS);
}

/** 存进 `models` 列的原文：默认模型不重复存（读的时候本来就会带上） */
export function modelsColumn(row: { model?: string | null }, list: string[]): string {
  const def = String(row.model ?? '').trim();
  return list.filter((m) => m && m !== def).join(',');
}

/**
 * 存储口径的唯一归一处：界面上模型清单可以整段粘贴（换行/逗号/分号/顿号分隔），
 * 落库固定为「model = 默认那一个，models = 其余的、不含默认」。
 * 默认留空时取清单第一个 —— 反代场景下人常常只知道有哪些模型，不知道该默认用哪个。
 */
export function normalizeModelInput(
  cur: Pick<ProviderRow, 'model' | 'models'>,
  body: { model?: string; models?: string },
): { model: string; models: string } {
  const def = String(body.model ?? cur.model ?? '').trim();
  const list = parseModels({ model: def, models: body.models === undefined ? String(cur.models ?? '') : body.models });
  const model = def || list[0] || '';
  return { model, models: modelsColumn({ model }, list) };
}

/**
 * 把存储的两列（model + models）摊成一个数组和一个个数。
 * 前端只读这个结果，不再自己拆字符串 —— 拆法（分隔符、去重、默认排最前）只能有一份。
 */
function withModels<T extends { model?: string | null; models?: string | null }>(row: T): T & { model_list: string[]; model_count: number } {
  const list = parseModels(row);
  return { ...row, model_list: list, model_count: list.length };
}

/** 给前端看的一行：密文换成 has_key 布尔，长度都不给 */
export function providerView(row: ProviderRow & { api_key_enc?: string | null }): Record<string, unknown> {
  const { api_key_enc: enc, ...rest } = row;
  return withModels({ ...rest, has_key: Boolean(enc) });
}

/**
 * base_url 校验：只允许 https（本机回环例外，方便对着本地代理/自建网关调），
 * 且当 AI_ALLOWED_HOSTS 配置了就必须命中白名单。
 */
export function assertBaseUrlAllowed(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !local) throw badRequest(`服务商地址必须是 https（当前 ${url.protocol}//${url.host}）；本机调试可用 127.0.0.1`);
  if (config.aiAllowedHosts.length && !config.aiAllowedHosts.includes(url.hostname.toLowerCase())) {
    throw badRequest(`服务商域名 ${url.hostname} 不在 AI_ALLOWED_HOSTS 白名单内（当前允许：${config.aiAllowedHosts.join(' / ')}）`);
  }
  return url;
}

function rowToConfig(row: ProviderRow, apiKey: string): AiProviderConfig {
  return {
    id: Number(row.id),
    name: row.name,
    protocol: row.protocol === 'gemini' ? 'gemini' : 'openai',
    baseUrl: row.base_url,
    model: String(row.model ?? '').trim() || parseModels(row)[0] || '',
    apiKey,
    temperature: Number(row.temperature ?? 0.3),
    maxOutputTokens: Number(row.max_output_tokens ?? 1024),
    supportsTools: Number(row.supports_tools) === 1,
    priceInPer1k: Number(row.price_in_per_1k ?? 0),
    priceOutPer1k: Number(row.price_out_per_1k ?? 0),
  };
}

/**
 * 挑出这一行并做完通用检查（存在 / 启用 / 有密钥 / 地址合法），不碰模型名。
 * 三种"用不了"分开报：一家都没配 / 配了但没填 key / 指定的那家被停用 —— 文案要能直接照着做。
 * 明文 key 只在这个返回值里活一次调用的时间，绝不挂回 row（row 会被 providerView 整体下发）。
 */
function resolveRow(id?: number): { row: ProviderRow; apiKey: string } {
  const row = id
    ? get<ProviderRow>(`SELECT ${PROVIDER_COLUMNS}, api_key_enc FROM ai_provider WHERE id = ? AND is_deleted = 0`, id)
    : get<ProviderRow>(
        `SELECT ${PROVIDER_COLUMNS}, api_key_enc FROM ai_provider
          WHERE enabled = 1 AND is_deleted = 0 ORDER BY is_default DESC, id ASC LIMIT 1`,
      );
  if (!row) {
    throw new AppError(
      409,
      id
        ? `指定的模型服务商（#${id}）不存在或已停用`
        : '还没有可用的模型服务商：请到「AI 助手 → 模型服务商」新增一家（OpenAI / DeepSeek / Gemini / 自定义网关）并填 API Key',
    );
  }
  if (Number(row.enabled) !== 1) throw new AppError(409, `服务商「${row.name}」已停用，请到「模型服务商」重新启用或换一家`);
  const apiKey = decryptSecret(String(row.api_key_enc ?? ''));
  if (!apiKey) throw new AppError(409, `服务商「${row.name}」还没有填 API Key：到「模型服务商」编辑该条，填入密钥后再试`);
  assertBaseUrlAllowed(row.base_url);
  return { row, apiKey };
}

/**
 * 选出这次要用的服务商；传 id 就用它（必须启用），不传就取默认那家、再退到任一启用家。
 *
 * `model` 是按本轮选模型用的（反代一家挂几十个模型），只接受该服务商清单里的名字：
 * 放过任意字符串就等于把这条路由变成打别人家的代理。
 */
export function resolveProvider(id?: number, model?: string): { row: ProviderRow; cfg: AiProviderConfig } {
  const { row, apiKey } = resolveRow(id);
  const cfg = rowToConfig(row, apiKey);
  if (!cfg.model) {
    throw new AppError(409, `服务商「${row.name}」还不知道要调哪个模型：到「模型服务商」点「拉模型」从服务商取一份清单，或手工填一个模型名`);
  }
  const want = String(model ?? '').trim();
  if (want && want !== cfg.model) {
    const options = parseModels(row);
    if (!options.includes(want)) {
      throw badRequest(`服务商「${row.name}」的清单里没有模型 ${want}，可选：${options.slice(0, 12).join(' / ')}${options.length > 12 ? ' …' : ''}（要加别的模型到「模型服务商」里点「拉模型」）`);
    }
    cfg.model = want;
  }
  return { row, cfg };
}

/** 建一个能用的客户端；transport 参数只给测试注入桩用，生产不传 */
export function providerClient(
  id: number | undefined,
  transport?: Transport,
  model?: string,
): { provider: ProviderRow; client: AiProviderClient; cfg: AiProviderConfig } {
  const { row, cfg } = resolveProvider(id, model);
  return { provider: row, client: createProviderClient(cfg, transport), cfg };
}

/** 一次最小往返，用来验证"密钥 + 地址 + 模型名"三件是否同时对：界面上的「测活」按钮 */
export async function probeProvider(id: number, transport?: Transport): Promise<string> {
  const { client, cfg } = providerClient(id, transport);
  const done = await client.complete([{ role: 'user', content: '只回复两个字：正常' }], []);
  const text = (done.text || '').trim().slice(0, 60);
  if (!text && !done.toolCalls.length) throw new AppError(502, `${cfg.name} 返回了空内容，请检查模型名是否支持对话`);
  return text || '（模型只回了工具调用，未回文本）';
}

/**
 * 拉一次服务商自己的模型清单并写回这一行 —— 反代/网关后面挂了哪些模型只有它自己知道，
 * 让人手抄几十个名字不现实。取"已有 ∪ 拉到"的并集（保序、截到 MAX_MODELS），
 * 默认模型保持原值；原值为空或已不在清单里才换并集第一个，不猜用户想要哪个。
 * 走 resolveRow 而不是 resolveProvider：新建的服务商常常还没填模型名，正是这一步要把它填上。
 */
export async function pullModels(
  id: number,
  transport?: Transport,
): Promise<{ models: string[]; default_model: string; fetched_total: number; added: number; truncated: boolean }> {
  const { row, apiKey } = resolveRow(id);
  const cfg = rowToConfig(row, apiKey);
  const known = parseModels(row);
  const fetched = await listModelNames(cfg, transport);
  if (!fetched.length) throw new AppError(502, `${cfg.name} 的 /models 没返回任何模型：有的网关没开这个接口，请手工填模型名`);
  const merged = parseModels({ model: row.model, models: modelsColumn(row, [...known, ...fetched]) });
  const def = String(row.model ?? '').trim();
  const defaultModel = merged.includes(def) ? def : merged[0] ?? '';
  update('ai_provider', id, { model: defaultModel, models: modelsColumn({ model: defaultModel }, merged) });
  return {
    models: merged,
    default_model: defaultModel,
    fetched_total: fetched.length,
    added: merged.length - known.length,
    truncated: fetched.length > MAX_MODELS,
  };
}

/** 用量汇总（审计页顶上的三块卡）：调用次数 / token / 估算花费，按当前数据范围算 */
export function usageSummary(where: string, params: unknown[]): { calls: number; ok: number; tokens: number; cost_cny: number } {
  const row = get<Record<string, number>>(
    `SELECT COUNT(*) AS calls,
            SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS ok,
            SUM(prompt_tokens + completion_tokens) AS tokens,
            ROUND(SUM(cost_cny), 4) AS cost_cny
       FROM ai_call_log WHERE is_deleted = 0 ${where}`,
    ...(params as never[]),
  );
  return {
    calls: Number(row?.calls ?? 0),
    ok: Number(row?.ok ?? 0),
    tokens: Number(row?.tokens ?? 0),
    cost_cny: Number(row?.cost_cny ?? 0),
  };
}

/** 启用的服务商清单（下拉用，不含任何密钥字段）：对话页要靠这里的 model_list 摆出可选模型 */
export function enabledProviders(): Record<string, unknown>[] {
  return all<Record<string, unknown>>(
    `SELECT ${PROVIDER_COLUMNS} FROM ai_provider WHERE enabled = 1 AND is_deleted = 0 ORDER BY is_default DESC, id ASC`,
  ).map((row) => withModels(row as { model?: string | null; models?: string | null }));
}
