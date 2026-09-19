/** 纯计算函数：金额口径统一在此处定义，服务端与前端共用 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** 安全数值：null/undefined/NaN → 0 */
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** 人民币成本：采购成本 + 头程成本 */
export const unitCostCny = (sku: { purchase_cost: number; first_leg_cost: number }): number =>
  round2(num(sku.purchase_cost) + num(sku.first_leg_cost));

/** 单笔预估毛利 = 实收折算人民币 − 成本快照 − 预估达人佣金折算 */
export function estItemProfitCny(input: {
  item_amount: number;
  currency: string;
  cost_snapshot: number;
  est_commission: number;
  commission_currency?: string;
  rate_to_cny: number;
}): number {
  const rate = num(input.rate_to_cny) || 1;
  const incomeCny = round2(num(input.item_amount) * (input.currency === 'CNY' ? 1 : rate));
  const commissionCny = round2(
    num(input.est_commission) * (input.commission_currency === 'CNY' || !input.commission_currency ? 1 : rate),
  );
  return round2(incomeCny - num(input.cost_snapshot) - commissionCny);
}

/** 达人/合作投产比 = 带货净 GMV ÷（样品成本 + 寄样运费 + 坑位费 + 达人佣金），全部人民币口径 */
export function collabRoi(input: {
  net_gmv_cny: number;
  sample_cost: number;
  sample_shipping: number;
  fixed_fee_cny: number;
  commission_cny: number;
}): number | null {
  const cost = num(input.sample_cost) + num(input.sample_shipping) + num(input.fixed_fee_cny) + num(input.commission_cny);
  if (cost <= 0) return null;
  return round2(num(input.net_gmv_cny) / cost);
}

/** 广告 ROI = GMV ÷ 消耗 */
export const adRoi = (spend: number, gmv: number): number | null => (num(spend) > 0 ? round2(num(gmv) / num(spend)) : null);

export const profitRate = (profit: number, base: number): number => (num(base) > 0 ? round2((num(profit) / num(base)) * 100) : 0);

/** 从 TikTok 视频链接解析视频 ID：/video(数字) 或 v(数字) */
export function parseVideoId(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/(?:video|v)\/(\d{6,})/i) || url.match(/[?&]item_id=(\d{6,})/i) || url.match(/^(\d{12,})$/);
  return m ? m[1] : null;
}

/** @用户名归一化：小写 + 去掉前导 @ 与空白 */
export function normalizeHandle(handle: string): string {
  return (handle || '').trim().toLowerCase().replace(/^@+/, '');
}

/** 合作编号 / 结算对账用 */
export function buildCollabNo(date: Date, seq: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `CB${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${String(seq).padStart(4, '0')}`;
}

/** 报表切日：UTC 时间字符串 + 站点时区偏移分钟 → 自然日 YYYY-MM-DD */
export function statDate(isoUtc: string | null, tzOffsetMinutes: number): string {
  if (!isoUtc) return '';
  const t = parseUtcMs(isoUtc);
  if (t === null) return isoUtc.slice(0, 10);
  return new Date(t + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** 站点默认 UTC 偏移（分钟），用于报表切日 */
export const REGION_TZ_OFFSET: Record<string, number> = {
  US: -240, UK: 0, ID: -420, MY: -480, TH: -420, VN: -420, PH: -480, SG: -480, MX: -360, CN: -480,
};

/* ==================== IANA 时区切日（含夏令时） ====================
 * 站点固定偏移在夏令时切换的那一天会错日（美国 3 月第二个周日 / 11 月第一个周日），
 * 而 tk_shop.timezone 存的是 IANA 时区名，报表必须以它为准（PRD §3 切日口径）。
 * Intl 不认的时区（脏数据、老库只有 region）退回固定偏移，绝不抛错打断报表。
 */

function parseUtcMs(isoUtc: string): number | null {
  const normalized = isoUtc.endsWith('Z') || isoUtc.includes('T') ? isoUtc : `${isoUtc.replace(' ', 'T')}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

type ZoneParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat | null>();

function partsFormatter(tz: string): Intl.DateTimeFormat | null {
  if (partsFormatters.has(tz)) return partsFormatters.get(tz) ?? null;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    f = null; // 非法 IANA 名：缓存 null，避免每行重复抛错
  }
  partsFormatters.set(tz, f);
  return f;
}

function zoneParts(tz: string, atMs: number): ZoneParts | null {
  const f = partsFormatter(tz);
  if (!f) return null;
  const raw: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(atMs))) if (part.type !== 'literal') raw[part.type] = part.value;
  const year = Number(raw.year);
  if (!Number.isFinite(year)) return null;
  return {
    year,
    month: Number(raw.month) || 1,
    day: Number(raw.day) || 1,
    hour: Number(raw.hour) || 0,
    minute: Number(raw.minute) || 0,
    second: Number(raw.second) || 0,
  };
}

/** 该 UTC 时刻在指定时区的 UTC 偏移分钟（含夏令时）；时区不可用返回 null */
export function zoneOffsetMinutes(tz: string | null | undefined, atMs: number): number | null {
  if (!tz) return null;
  const p = zoneParts(tz, atMs);
  if (!p) return null;
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((localAsUtc - Math.floor(atMs / 1000) * 1000) / 60_000);
}

/** 按店铺 IANA 时区取自然日 YYYY-MM-DD（含夏令时）；时区非法时用 fallbackOffsetMinutes */
export function statDateInZone(isoUtc: string | null, tz: string | null | undefined, fallbackOffsetMinutes = 0): string {
  if (!isoUtc) return '';
  const t = parseUtcMs(isoUtc);
  if (t === null) return isoUtc.slice(0, 10);
  const p = tz ? zoneParts(tz, t) : null;
  if (p) return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return statDate(isoUtc, fallbackOffsetMinutes);
}

/** 某自然日 00:00 在指定时区对应的 UTC 毫秒（两次修正处理夏令时边界）；时区非法时用 fallbackOffsetMinutes */
export function zoneDayStartUtc(day: string, tz: string | null | undefined, fallbackOffsetMinutes = 0): number {
  const base = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(base)) return NaN;
  const first = zoneOffsetMinutes(tz, base) ?? fallbackOffsetMinutes;
  const second = zoneOffsetMinutes(tz, base - first * 60_000);
  return base - (second ?? first) * 60_000;
}

/** 时区不可识别（脏数据）时为真，调用方可据此提示 */
export const isUsableZone = (tz: string | null | undefined): boolean => !!tz && partsFormatter(tz) !== null;

