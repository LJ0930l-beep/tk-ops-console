import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { all, get } from '../src/core/db.js';
import { migrate, readSchema } from '../src/db/migrate.js';
import { fetchPublicRates, InvalidRateRequestError, PublicRateSourceError, RATE_SOURCE, upsertRate } from '../src/services/rates.js';
import { ACCOUNTS, auth, boot, dataOf, login } from './helper.js';

const { http } = boot();
let financeToken = '';

beforeAll(async () => {
  financeToken = await login(http, ACCOUNTS.finance);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockRates(rows: unknown[], status = 200) {
  const fakeFetch = vi.fn(async () => new Response(JSON.stringify(rows), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fakeFetch);
  return fakeFetch;
}

function dbRate(day: string, currency: string): { rate_to_cny: number; source: number } | undefined {
  const row = get<{ rate_to_cny: number | string; source: number }>(
    `SELECT rate_to_cny, source FROM exchange_rate WHERE rate_date = ? AND currency = ? AND is_deleted = 0`, day, currency,
  );
  return row ? { rate_to_cny: Number(row.rate_to_cny), source: Number(row.source) } : undefined;
}

describe('Frankfurter v2 public FX source', () => {
  it('relabels legacy mocked source=1 rows once without changing later public rows', () => {
    const legacyDb = new DatabaseSync(':memory:');
    legacyDb.exec(readSchema());
    legacyDb.prepare(`INSERT INTO exchange_rate (rate_date, currency, rate_to_cny, source) VALUES (?, ?, ?, ?)`).run('2025-01-01', 'USD', 7.1, 1);

    migrate(legacyDb);
    expect(legacyDb.prepare(`SELECT source FROM exchange_rate WHERE rate_date = '2025-01-01' AND currency = 'USD'`).get()).toEqual({ source: 4 });

    legacyDb.prepare(`INSERT INTO exchange_rate (rate_date, currency, rate_to_cny, source) VALUES (?, ?, ?, ?)`).run('2025-01-02', 'USD', 7.2, 1);
    migrate(legacyDb);
    expect(legacyDb.prepare(`SELECT source FROM exchange_rate WHERE rate_date = '2025-01-02' AND currency = 'USD'`).get()).toEqual({ source: 1 });
    legacyDb.close();
  });

  it('requests CNY as base and stores the inverse as foreign currency to CNY', async () => {
    const fetcher = mockRates([
      { date: '2025-01-02', base: 'CNY', quote: 'USD', rate: 0.14 },
      { date: '2025-01-02', base: 'CNY', quote: 'MYR', rate: 0.62 },
    ]);

    const result = await fetchPublicRates({ date: '2025-01-02', currencies: ['usd', 'MYR'] });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe('https://api.frankfurter.dev/v2/rates');
    expect(url.searchParams.get('base')).toBe('CNY');
    expect(url.searchParams.get('quotes')).toBe('USD,MYR');
    expect(url.searchParams.get('date')).toBe('2025-01-02');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result.source).toBe('Frankfurter v2 public API');
    expect(result.rows.map((r) => [r.currency, r.rate_to_cny])).toEqual([
      ['USD', 7.142857],
      ['MYR', 1.612903],
    ]);
    expect(dbRate('2025-01-02', 'USD')).toEqual({ rate_to_cny: 7.142857, source: RATE_SOURCE.FRANKFURTER });
  });

  it('keeps a manually entered value when public rates are fetched for the same day', async () => {
    upsertRate({ rate_date: '2025-02-03', currency: 'USD', rate_to_cny: 6.88, source: RATE_SOURCE.MANUAL });
    mockRates([{ date: '2025-02-03', base: 'CNY', quote: 'USD', rate: 0.2 }]);

    const result = await fetchPublicRates({ date: '2025-02-03', currencies: ['USD'] });

    expect(result.rows[0]).toMatchObject({ rate_to_cny: 5, skipped: 'manual' });
    expect(dbRate('2025-02-03', 'USD')).toEqual({ rate_to_cny: 6.88, source: RATE_SOURCE.MANUAL });
  });

  it('validates the whole provider response before writing any rows', async () => {
    mockRates([
      { date: '2025-02-04', base: 'CNY', quote: 'USD', rate: 0.14 },
      { date: '2025-02-04', base: 'CNY', quote: 'MYR', rate: 0 },
    ]);

    await expect(fetchPublicRates({ date: '2025-02-04', currencies: ['USD', 'MYR'] })).rejects.toBeInstanceOf(PublicRateSourceError);
    expect(dbRate('2025-02-04', 'USD')).toBeUndefined();
    expect(dbRate('2025-02-04', 'MYR')).toBeUndefined();
  });

  it('rejects invalid dates, non-positive rates, incomplete pairs, and transport failures', async () => {
    await expect(fetchPublicRates({ date: '2025-02-30', currencies: ['USD'] })).rejects.toBeInstanceOf(InvalidRateRequestError);
    mockRates([{ date: '2025-02-05', base: 'CNY', quote: 'USD', rate: -1 }]);
    await expect(fetchPublicRates({ date: '2025-02-05', currencies: ['USD'] })).rejects.toBeInstanceOf(PublicRateSourceError);
    mockRates([]);
    await expect(fetchPublicRates({ date: '2025-02-06', currencies: ['USD'] })).rejects.toBeInstanceOf(PublicRateSourceError);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network details are not exposed'); }));
    await expect(fetchPublicRates({ date: '2025-02-07', currencies: ['USD'] })).rejects.toBeInstanceOf(PublicRateSourceError);
    expect(dbRate('2025-02-05', 'USD')).toBeUndefined();
    expect(dbRate('2025-02-06', 'USD')).toBeUndefined();
    expect(dbRate('2025-02-07', 'USD')).toBeUndefined();
  });

  it('rejects an impossible HTTP date as a client error before trying the provider', async () => {
    const fakeFetch = vi.fn();
    vi.stubGlobal('fetch', fakeFetch);

    const response = await http.post('/api/finance/rate/fetch').set(auth(financeToken)).send({ date: '2025-02-30', currencies: ['USD'] });

    expect(response.status).toBe(400);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('uses a finite abort timeout and surfaces provider failure as HTTP 502 without a write', async () => {
    const day = '2025-03-11';
    const aborted = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(aborted);
    const fakeFetch = vi.fn(async (_input: URL, init?: RequestInit) => {
      expect(init?.signal).toBe(aborted);
      throw new DOMException('timed out', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fakeFetch);

    const response = await http.post('/api/finance/rate/fetch').set(auth(financeToken)).send({ date: day, currencies: ['USD'] });

    expect(timeout).toHaveBeenCalledWith(8_000);
    expect(response.status).toBe(502);
    expect(response.body.message).toContain('公开汇率服务');
    expect(dbRate(day, 'USD')).toBeUndefined();
  });

  it('persists the public provenance through HTTP and exposes its label in the rate list', async () => {
    const day = '2025-03-12';
    mockRates([{ date: day, base: 'CNY', quote: 'USD', rate: 0.125 }]);

    const response = await http.post('/api/finance/rate/fetch').set(auth(financeToken)).send({ date: day, currencies: ['USD'] });
    expect(response.status).toBe(200);
    expect(dataOf<{ rows: { rate_to_cny: number; currency: string }[] }>(response.body).rows).toEqual([
      expect.objectContaining({ currency: 'USD', rate_to_cny: 8 }),
    ]);
    expect(dbRate(day, 'USD')).toEqual({ rate_to_cny: 8, source: RATE_SOURCE.FRANKFURTER });

    const list = await http.get(`/api/finance/rate?currency=USD&rate_date_from=${day}&rate_date_to=${day}`).set(auth(financeToken));
    expect(list.status).toBe(200);
    const rows = dataOf<{ list: { source_name: string }[] }>(list.body).list;
    expect(rows.some((row) => row.source_name === 'Frankfurter 公开 API')).toBe(true);
  });

  it('the HTTP refresh endpoint preserves same-day manual rates and rejects oversized currency lists', async () => {
    const day = '2025-03-13';
    const manual = await http.post('/api/finance/rate').set(auth(financeToken)).send({ rate_date: day, currency: 'USD', rate_to_cny: 6.99 });
    expect(manual.status).toBe(200);
    mockRates([{ date: day, base: 'CNY', quote: 'USD', rate: 0.2 }]);

    const refreshed = await http.post('/api/finance/rate/fetch').set(auth(financeToken)).send({ date: day, currencies: ['USD'] });
    expect(refreshed.status).toBe(200);
    expect(dataOf<{ rows: { skipped?: string }[] }>(refreshed.body).rows[0]?.skipped).toBe('manual');
    expect(dbRate(day, 'USD')).toEqual({ rate_to_cny: 6.99, source: RATE_SOURCE.MANUAL });

    const oversized = await http.post('/api/finance/rate/fetch').set(auth(financeToken)).send({ currencies: Array(101).fill('USD') });
    expect(oversized.status).toBe(400);
    expect(all<{ id: number }>(`SELECT id FROM exchange_rate WHERE rate_date = ? AND currency = 'USD'`, day)).toHaveLength(1);
  });

  it('keeps demo provenance when missing days are filled from demo seed values', async () => {
    upsertRate({ rate_date: '2025-04-10', currency: 'PHP', rate_to_cny: 0.13, source: RATE_SOURCE.DEMO });

    const response = await http.post('/api/finance/rate/fill-missing').set(auth(financeToken)).send({
      from: '2025-04-11', to: '2025-04-11', currencies: ['PHP'],
    });

    expect(response.status).toBe(200);
    expect(dbRate('2025-04-11', 'PHP')).toEqual({ rate_to_cny: 0.13, source: RATE_SOURCE.DEMO });
  });

  it('rejects invalid manual dates and non-unit CNY rates', async () => {
    const invalidDate = await http.post('/api/finance/rate').set(auth(financeToken)).send({
      rate_date: '2025-02-30', currency: 'USD', rate_to_cny: 7.2,
    });
    expect(invalidDate.status).toBe(400);

    const badCny = await http.post('/api/finance/rate').set(auth(financeToken)).send({
      rate_date: '2025-02-28', currency: 'CNY', rate_to_cny: 7.2,
    });
    expect(badCny.status).toBe(400);
    expect(dbRate('2025-02-28', 'CNY')).toBeUndefined();
  });

  it('rejects oversized or future fill-missing ranges', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const farPast = new Date(Date.parse(`${today}T00:00:00Z`) - 500 * 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const oversized = await http.post('/api/finance/rate/fill-missing').set(auth(financeToken)).send({
      from: farPast, to: today, currencies: ['USD'],
    });
    const future = await http.post('/api/finance/rate/fill-missing').set(auth(financeToken)).send({
      from: today, to: tomorrow, currencies: ['USD'],
    });
    const invalidDate = await http.post('/api/finance/rate/fill-missing').set(auth(financeToken)).send({
      from: '2025-02-30', to: '2025-03-01', currencies: ['USD'],
    });

    expect(oversized.status).toBe(400);
    expect(future.status).toBe(400);
    expect(invalidDate.status).toBe(400);
  });

  it('only carries historical rates forward, never backward from a later date', async () => {
    upsertRate({ rate_date: '2025-05-10', currency: 'JPY', rate_to_cny: 0.05, source: RATE_SOURCE.FRANKFURTER });

    const response = await http.post('/api/finance/rate/fill-missing').set(auth(financeToken)).send({
      from: '2025-05-08', to: '2025-05-11', currencies: ['JPY'],
    });

    expect(response.status).toBe(200);
    expect(dbRate('2025-05-08', 'JPY')).toBeUndefined();
    expect(dbRate('2025-05-09', 'JPY')).toBeUndefined();
    expect(dbRate('2025-05-10', 'JPY')).toEqual({ rate_to_cny: 0.05, source: RATE_SOURCE.FRANKFURTER });
    expect(dbRate('2025-05-11', 'JPY')).toEqual({ rate_to_cny: 0.05, source: RATE_SOURCE.CARRIED });
  });
});
