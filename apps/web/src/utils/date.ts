/** Parse backend UTC timestamps that omit a timezone suffix as UTC, never local time. */
export function parseUtcTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.trim().replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized);
  return Date.parse(hasTimezone ? normalized : `${normalized}Z`);
}

export function formatUtcTimestamp(value: string | null | undefined): string {
  const timestamp = parseUtcTimestamp(value);
  if (!Number.isFinite(timestamp)) return value ?? '';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
}
