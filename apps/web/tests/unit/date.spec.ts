import { describe, expect, it } from 'vitest';
import { parseUtcTimestamp } from '../../src/utils/date';

describe('parseUtcTimestamp', () => {
  it('treats a database timestamp without an offset as UTC', () => {
    expect(parseUtcTimestamp('2026-09-20 12:34:56')).toBe(Date.parse('2026-09-20T12:34:56Z'));
  });

  it('preserves an explicit timezone offset', () => {
    expect(parseUtcTimestamp('2026-09-20T12:34:56+08:00')).toBe(Date.parse('2026-09-20T04:34:56Z'));
  });

  it('returns NaN for missing or invalid timestamps', () => {
    expect(parseUtcTimestamp(null)).toBeNaN();
    expect(parseUtcTimestamp('not a date')).toBeNaN();
  });
});
