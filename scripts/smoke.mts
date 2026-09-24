/**
 * 全链路冒烟：内存库起真服务，逐角色打全部 GET，再跑一遍写链路（同步 → 宽表 → 规则 → 提醒 → 导入 → 导出）。
 *
 * 为什么不用 supertest/内存请求：冒烟要验的是「真 HTTP + 真路由挂载 + 真中间件顺序」，
 * 404（前后端路径对不上）和 500（SQL/口径炸了）只有在真 listen 的 app 上才抓得准。
 * 库是 :memory:，所以跑完不碰仓库里那份演示库 apps/data/tk_ops.db。
 *
 * 用法：npm run smoke（退出码非 0 = 有 FAIL）
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { setDb } from '../apps/server/src/core/db.js';
import { migrate } from '../apps/server/src/db/migrate.js';
import { seedDemoData } from '../apps/server/src/db/seed.js';
import { createApp } from '../apps/server/src/app.js';
import { collectRoutes } from './route-inventory.mjs';

const PASSWORD = 'Passw0rd!';
const ACCOUNTS: Record<string, string> = {
  boss: 'boss',
  ops: 'limy',
  opsManager: 'wangqiang',
  bd: 'chenbd',
  content: 'yinuo',
  finance: 'finwu',
  ads: 'adskent',
  warehouse: 'whzhao',
};

/** 带参数路由的取样 SQL：从演示库里捞一个真实 id，避免用 1 猜 */
const SAMPLE_SQL: Record<string, string> = {
  '/api/system/users/:id/shops': 'SELECT id FROM sys_user WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/system/data-scope/:userId': 'SELECT id FROM sys_user WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/system/dict/:type': "SELECT dict_type AS v FROM sys_dict WHERE is_deleted = 0 ORDER BY id LIMIT 1",
  '/api/shops/:id': 'SELECT id FROM tk_shop WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/products/spu/:id': 'SELECT id FROM product_spu WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/products/spu/:id/skus': 'SELECT id FROM product_spu WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/products/sku/:id': 'SELECT id FROM product_sku WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/products/sku/:id/cost-history': 'SELECT id FROM product_sku WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/products/listing/:id': 'SELECT id FROM shop_listing WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/orders/returns/:id': 'SELECT id FROM tk_return WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/orders/:id': 'SELECT id FROM tk_order WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/orders/:id/profit': 'SELECT id FROM tk_order WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/creators/collab/:id': 'SELECT id FROM collaboration WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/creators/collab/:id/roi': 'SELECT id FROM collaboration WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/creators/:id': 'SELECT id FROM creator WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/creators/:id/outreach': 'SELECT id FROM creator WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/content/videos/:id/attribution': 'SELECT id FROM video WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/content/videos/:id': 'SELECT id FROM video WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/finance/settlement/by-order/:tk_order_id': "SELECT tk_order_id AS v FROM settlement_txn WHERE is_deleted = 0 AND IFNULL(tk_order_id,'') <> '' ORDER BY id LIMIT 1",
  '/api/finance/settlement/:id': 'SELECT id FROM settlement_txn WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/finance/profit/order/:id': 'SELECT id FROM tk_order WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/actions/events/:id': 'SELECT id FROM alert_event WHERE is_deleted = 0 ORDER BY id DESC LIMIT 1',
  '/api/actions/analytics/live/:id/minutes': 'SELECT id FROM live_session WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/selection/:id': 'SELECT id FROM selection_flow WHERE is_deleted = 0 ORDER BY id LIMIT 1',
  '/api/selection/:id/logs': 'SELECT id FROM selection_flow WHERE is_deleted = 0 ORDER BY id LIMIT 1',
};

const day = (offset: number): string => {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
};

type Row = { route: string; role: string; status: number; note: string };
const fails: Row[] = [];
const warns: Row[] = [];
const denied: Record<string, number> = {};
let checks = 0;

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
setDb(db);
migrate(db);
seedDemoData({});

// 冒烟一轮要打上千次请求，全局限流（默认 600/15min）会把自己拦下来，所以扫描阶段关掉，
// 末尾再单独用一套极小阈值证明限流在真 HTTP 上确实生效。
const server = createApp({ rateLimit: false }).listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 导出接口回 CSV，不是 JSON */
  }
  return { status: res.status, body: parsed, text };
}

const sample = (sql: string): string | null => {
  try {
    const row = db.prepare(sql).get() as { id?: number; v?: string } | undefined;
    return row ? String(row.id ?? row.v ?? '') : null;
  } catch {
    return null;
  }
};

/** 演示数据的订单窗口：默认区间要对准它，否则所有按日期的报表都会「0 行」假绿 */
const WIN = db.prepare(`SELECT MIN(date(order_time)) AS lo, MAX(date(order_time)) AS hi FROM tk_order WHERE is_deleted = 0`).get() as {
  lo: string | null;
  hi: string | null;
};
/** 通用查询兜底：分页 + 区间 + 维度 + 常见必填 id，路由不认的参数会被忽略 */
const DEFAULT_QUERY = [
  'page=1',
  'pageSize=5',
  `from=${WIN.lo ?? day(-30)}`,
  `to=${WIN.hi ?? day(0)}`,
  'table=creator',
  'dim=creator',
  `sku_id=${sample('SELECT id FROM product_sku WHERE is_deleted = 0 ORDER BY id LIMIT 1') ?? 1}`,
  `spu_id=${sample('SELECT id FROM product_spu WHERE is_deleted = 0 ORDER BY id LIMIT 1') ?? 1}`,
  `shop_id=${sample('SELECT id FROM tk_shop WHERE is_deleted = 0 ORDER BY id LIMIT 1') ?? 1}`,
  `warehouse_id=${sample('SELECT id FROM warehouse WHERE is_deleted = 0 ORDER BY id LIMIT 1') ?? 1}`,
].join('&');

/* ---------- ① 登录：九个演示账号 ---------- */
const tokens: Record<string, string> = {};
for (const [role, username] of Object.entries(ACCOUNTS)) {
  const res = await call('POST', '/api/auth/login', undefined, { username, password: PASSWORD });
  const token = (res.body as { data?: { token?: string } })?.data?.token;
  if (res.status !== 200 || !token) {
    fails.push({ route: '/api/auth/login', role, status: res.status, note: `登录失败 ${username}` });
    continue;
  }
  tokens[role] = token;
  const me = await call('GET', '/api/auth/me', token);
  checks++;
  if (me.status !== 200) fails.push({ route: '/api/auth/me', role, status: me.status, note: 'me 取不到' });
}

/* ---------- ② 逐角色打全部静态 GET ---------- */
const routes = (collectRoutes() as { method: string; path: string; dynamic: boolean }[]).filter(
  (r) => r.method === 'GET' && !r.path.includes('${'),
);
const statics = routes.filter((r) => !r.dynamic);
const dynamics = routes.filter((r) => r.dynamic);

for (const r of statics) {
  for (const [role, token] of Object.entries(tokens)) {
    const sep = r.path.includes('?') ? '&' : '?';
    const res = await call('GET', `${r.path}${sep}${DEFAULT_QUERY}`, token);
    checks++;
    if (res.status === 200) continue;
    if (res.status === 403) {
      denied[role] = (denied[role] ?? 0) + 1;
      continue;
    }
    const note = String((res.body as { message?: string })?.message ?? res.text).slice(0, 120);
    if (res.status === 400 || res.status === 422) warns.push({ route: r.path, role, status: res.status, note });
    // 404 分两种：'接口不存在' = 路由真的没挂（前后端路径对不上，必须修）；
    // 其余是数据范围/资源不存在（带 shop_id 打越权店铺时的正常拒绝），按拦截计数。
    else if (res.status === 404 && !note.includes('接口不存在')) denied[role] = (denied[role] ?? 0) + 1;
    else fails.push({ route: r.path, role, status: res.status, note });
  }
}

/* ---------- ③ 带参数 GET：boss 全量 + 受限角色验越权 ---------- */
for (const r of dynamics) {
  const sql = SAMPLE_SQL[r.path];
  const v = sql ? sample(sql) : null;
  if (!v) {
    warns.push({ route: r.path, role: 'boss', status: 0, note: '演示库无样本数据，跳过' });
    continue;
  }
  const path = r.path.replace(/:[A-Za-z_]+/, encodeURIComponent(v));
  const res = await call('GET', `${path}?${DEFAULT_QUERY}`, tokens.boss);
  checks++;
  if (res.status !== 200 && res.status !== 403) {
    fails.push({ route: path, role: 'boss', status: res.status, note: String((res.body as { message?: string })?.message ?? '').slice(0, 120) });
  }
  // 越权探针：BD（SELF 范围）读达人详情，要么 403/404，要么读到的必须是自己名下的
  if (r.path === '/api/creators/:id' && tokens.bd) {
    const p = await call('GET', `${path}?${DEFAULT_QUERY}`, tokens.bd);
    checks++;
    if (p.status === 200) {
      const owner = (p.body as { data?: { owner_id?: number } })?.data?.owner_id;
      const bdId = (await call('GET', '/api/auth/me', tokens.bd)).body as { data?: { id?: number } };
      if (owner !== undefined && bdId.data?.id !== undefined && owner !== bdId.data.id) {
        fails.push({ route: path, role: 'bd', status: 200, note: `越权：读到 owner_id=${owner} 的达人` });
      }
    }
  }
}

/* ---------- ④ 写链路：同步 → 宽表 → 规则 → 提醒 → 导入 → 导出 ---------- */
const chain: string[] = [];
async function step(name: string, method: string, path: string, body?: unknown, token = tokens.boss): Promise<unknown> {
  const res = await call(method, path, token, body);
  checks++;
  const data = (res.body as { data?: unknown })?.data;
  chain.push(`${res.status === 200 ? '✓' : '✗'} ${name} → ${res.status}`);
  if (res.status !== 200) {
    fails.push({ route: `${method} ${path}`, role: 'chain', status: res.status, note: String((res.body as { message?: string })?.message ?? '').slice(0, 160) });
  }
  return data;
}

const syncAll = (await step('同步一键补跑', 'POST', '/api/sync/run', { task_type: 'all' })) as { summary?: Record<string, number> };
chain.push(`  summary ${JSON.stringify(syncAll?.summary ?? {})}`);
const agg = (await step('宽表重建（派生汇总）', 'POST', '/api/sync/run', { task_type: 'aggregate' })) as { inserted?: number; updated?: number };
chain.push(`  aggregate ${JSON.stringify(agg ?? {})}`);
// 异步链路：入队 → 催一轮 → 回查状态。少了这一段，队列只有单测覆盖，真实 HTTP 上没人证明它能跑完。
const qJob = (await step('异步排队同步（async:true）', 'POST', '/api/sync/run', { task_type: 'aggregate', async: true })) as { job_id?: number; shop_ids?: number[] };
const jobId = Number(qJob?.job_id ?? 0);
chain.push(`  入队 job #${jobId}（${qJob?.shop_ids?.length ?? '?'} 家店，接口立刻返回不等执行）`);
const drained = (await step('队列催一轮', 'POST', '/api/system/jobs/drain', {})) as { claimed?: number; done?: number; failed?: number };
chain.push(`  drain claimed=${drained?.claimed} done=${drained?.done} failed=${drained?.failed}`);
if (jobId) {
  const j = (await step('回查后台任务', 'GET', `/api/system/jobs/${jobId}`)) as { status?: number; job_type?: string; result?: unknown };
  chain.push(`  job #${jobId} ${j?.job_type} status=${j?.status}（0 待跑 / 1 在跑 / 2 成功 / 3 失败）`);
  if (Number(j?.status) !== 2) fails.push({ route: `GET /api/system/jobs/${jobId}`, role: 'chain', status: 200, note: `异步同步没跑成功（status=${j?.status}）` });
}
const evalOut = (await step('规则评估', 'POST', '/api/actions/evaluate?end=' + day(0))) as Record<string, unknown>;
chain.push(`  evaluate ${JSON.stringify(evalOut ?? {})}`);
const today = (await step('今日行动中心', 'GET', '/api/actions/today')) as { p0?: unknown[]; p1?: unknown[]; p2?: unknown[]; mine?: unknown[] };
chain.push(`  today p0=${today?.p0?.length ?? 0} p1=${today?.p1?.length ?? 0} p2=${today?.p2?.length ?? 0} mine=${today?.mine?.length ?? 0}`);
// 提醒 inbox 现在只有写接口会生成（GET 不再顺手改库），所以先 POST 同步一次再看列表
await step('提醒同步（生成/失效）', 'POST', '/api/actions/notifications/sync', {});
const notes = (await step('提醒列表', 'GET', '/api/actions/notifications')) as { list?: { id: number }[] };
const noteId = notes?.list?.[0]?.id;
if (noteId) await step('提醒置已读', 'POST', `/api/actions/notifications/${noteId}/read`, {});
const events = (await step('预警事件', 'GET', '/api/actions/events')) as { list?: { id: number }[] };
const eventId = events?.list?.[0]?.id;
if (eventId) await step('事件处置', 'POST', `/api/actions/events/${eventId}/handle`, { action_type: 'note', note: '冒烟测试处置' });

const tables = (await step('导入表清单', 'GET', '/api/system/import/tables')) as { table: string }[];
chain.push(`  importable=${(tables ?? []).map((t) => t.table).join('/')}`);
const before = sample('SELECT COUNT(*) AS v FROM creator WHERE is_deleted = 0') ?? '0';
const imp = (await step('导入达人（web 抓取口径）', 'POST', '/api/system/import', {
  table: 'creator',
  source: 'web',
  rows: [
    { handle: '@smoketest_a', nickname: '冒烟A', region: 'MY', followers: '12000', avg_views: '3000' },
    { handle: 'smoketest_b', nickname: '冒烟B', region: 'TH', followers: '8000' },
  ],
})) as Record<string, unknown>;
chain.push(`  import ${JSON.stringify(imp ?? {})}`);
const imported = db.prepare("SELECT COUNT(*) AS c, SUM(source = 2) AS web FROM creator WHERE handle IN ('smoketest_a','smoketest_b')").get() as { c: number; web: number };
chain.push(`  落库 ${imported.c} 行（source=web/manual 计 ${imported.web}）`);
if (imported.c !== 2) fails.push({ route: 'POST /api/system/import', role: 'chain', status: 200, note: `导入后只查到 ${imported.c}/2 行` });
if (String(before) === String(sample('SELECT COUNT(*) AS v FROM creator WHERE is_deleted = 0'))) {
  warns.push({ route: 'POST /api/system/import', role: 'chain', status: 200, note: '达人数未变化（可能命中 upsert 更新）' });
}

/* 导出：CSV 必须 200 + BOM；XLSX 必须 200 + PK 魔数（真的能打开的 Excel，不是 200 就算过） */
/** 导出面自动从路由清单里发现（新增导出接口不必再回来改这份硬编码清单） */
const exportPaths = (collectRoutes() as { method: string; path: string }[])
  .filter((r) => r.method === 'GET' && /\/export(?:[/?]|$)/.test(r.path))
  .map((r) => r.path)
  .sort();
if (exportPaths.length < 10) fails.push({ route: '导出面覆盖', role: 'chain', status: 0, note: `只发现 ${exportPaths.length} 个导出接口，路由清单解析可能漏了` });
for (const p of exportPaths) {
  for (const format of ['csv', 'xlsx'] as const) {
    const res = await fetch(`${BASE}${p}?format=${format}&${DEFAULT_QUERY}`, { headers: { authorization: `Bearer ${tokens.boss}` } });
    const buf = Buffer.from(await res.arrayBuffer());
    checks++;
    const magic = format === 'xlsx' ? buf.subarray(0, 2).toString() === 'PK' : buf[0] === 0xef && buf[1] === 0xbb;
    const tag = res.status === 200 && magic ? '✓' : '✗';
    chain.push(`${tag} 导出 ${p} [${format}] → ${res.status} ${buf.length}B 魔数${magic ? '正确' : '不对'}`);
    if (res.status !== 200) fails.push({ route: `${p}?format=${format}`, role: 'boss', status: res.status, note: '导出失败' });
    else if (!magic) fails.push({ route: `${p}?format=${format}`, role: 'boss', status: 200, note: `文件头不对（${format} 应为 ${format === 'xlsx' ? 'PK' : 'UTF-8 BOM'}）` });
    else if (buf.length < 10) warns.push({ route: `${p}?format=${format}`, role: 'boss', status: 200, note: `导出内容过短（${buf.length}B）` });
  }
}
const tpl = await call('GET', `/api/system/import/template?table=creator&${DEFAULT_QUERY}`, tokens.boss);
checks++;
chain.push(`${tpl.status === 200 && tpl.text.length > 0 ? '✓' : '✗'} 导入模板 /api/system/import/template → ${tpl.status} ${tpl.text.length}B`);
if (tpl.status !== 200) fails.push({ route: '/api/system/import/template', role: 'boss', status: tpl.status, note: '模板下载失败' });

/* 切日：利润日报与看板趋势必须落在请求区间内，且都按店铺时区归日 */
const win = WIN;
if (!win.lo || !win.hi) {
  fails.push({ route: '切日口径', role: 'chain', status: 0, note: '演示库没有订单，无法验证切日' });
} else {
  const qs = `from=${win.lo}&to=${win.hi}`;
  const profit = (await step(`利润日报（切日 ${win.lo}~${win.hi}）`, 'GET', `/api/finance/profit/report?${qs}`)) as { list?: unknown[]; total?: Record<string, unknown>; rate_missing?: unknown; sum_check?: unknown };
  chain.push(`  report rows=${profit?.list?.length ?? 0} rate_missing=${JSON.stringify(profit?.rate_missing ?? null)} sum_check=${JSON.stringify(profit?.sum_check ?? null)}`);
  if (!profit?.list?.length) fails.push({ route: '/api/finance/profit/report', role: 'chain', status: 200, note: '订单区间内利润日报为空' });
  const trend = (await step('看板趋势（切日口径）', 'GET', `/api/dashboard/trend?${qs}`)) as { gmv_trend?: { date?: string }[] };
  const rows = trend?.gmv_trend ?? [];
  const outOfRange = rows.filter((x) => x.date && (x.date < win.lo! || x.date > win.hi!));
  if (outOfRange.length) fails.push({ route: '/api/dashboard/trend', role: 'chain', status: 200, note: `${outOfRange.length} 个日期落在请求区间外` });
  chain.push(`  trend days=${rows.length}（${rows[0]?.date ?? '-'} ~ ${rows[rows.length - 1]?.date ?? '-'}）`);
  if (!rows.length) fails.push({ route: '/api/dashboard/trend', role: 'chain', status: 200, note: '订单区间内趋势为空' });
}

/* ---------- ⑤ 前端下拉/表单里写死的枚举，必须被后端接受（契约漂移探测器） ---------- */
const vue = readFileSync(new URL('../apps/web/src/views/system/SyncLogList.vue', import.meta.url), 'utf8');
const optsBlock = vue.slice(vue.indexOf('const RUN_TASK_OPTIONS'), vue.indexOf('const STATUS_OPTIONS'));
const taskOptions = [...optsBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((v) => v !== 'value' && v !== 'label');
chain.push(`  前端同步任务下拉 ${taskOptions.length} 项：${taskOptions.join('/')}`);
for (const t of taskOptions) {
  const res = await call('POST', '/api/sync/run', tokens.boss, { task_type: t });
  checks++;
  if (res.status === 200) chain.push(`  ✓ task_type=${t} → 200`);
  else {
    chain.push(`  ✗ task_type=${t} → ${res.status} ${String((res.body as { message?: string })?.message ?? '').slice(0, 80)}`);
    fails.push({ route: `POST /api/sync/run {task_type:${t}}`, role: 'chain', status: res.status, note: '前端下拉里有、后端 enum 不认' });
  }
}

/* ---------- ⑥ 限流：三档各起一套极小阈值的服务，证明真 HTTP 上会回 429 ---------- */
/** 每档一个独立 app（限流计数在内存里，实例之间互不影响），避免前一档的请求把后一档的额度吃掉 */
async function withLimitedApp(cfg: Record<string, unknown>, run: (call: typeof rlCall, base: string) => Promise<void>): Promise<void> {
  const srv = createApp({ rateLimit: { enabled: true, windowMinutes: 15, loginWindowMinutes: 15, exportWindowMinutes: 15, ...cfg } }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* 429 也可能没有 JSON 体 */
    }
    return { status: res.status, json };
  };
  try {
    await run(call, base);
  } finally {
    srv.close();
  }
}
type rlCall = (method: string, path: string, token?: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

await withLimitedApp({ max: 3, loginMax: 100, exportMax: 100 }, async (call) => {
  const tok = (await call('POST', '/api/auth/login', undefined, { username: 'boss', password: PASSWORD })).json as { data?: { token?: string } };
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await call('GET', '/api/dashboard/summary', tok?.data?.token)).status);
  checks++;
  chain.push(`${statuses.includes(429) ? '✓' : '✗'} 全局档限流（阈值 3）→ ${statuses.join(',')}`);
  if (!statuses.includes(429)) fails.push({ route: 'GET /api/dashboard/summary', role: 'chain', status: 200, note: '超过全局阈值仍未 429' });
});

await withLimitedApp({ max: 1000, loginMax: 2, exportMax: 100 }, async (call) => {
  const bad = { username: 'boss', password: 'wrong-password' };
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) seen.push((await call('POST', '/api/auth/login', undefined, bad)).status);
  const blocked = seen.includes(429);
  checks++;
  // 换账号仍能登录：key 是 IP+用户名，锁住一个不该连坐别人
  const other = await call('POST', '/api/auth/login', undefined, { username: 'finwu', password: PASSWORD });
  chain.push(`${blocked && other.status === 200 ? '✓' : '✗'} 登录爆破被拦（阈值 2）→ ${seen.join(',')}；换账号 finwu → ${other.status}`);
  if (!blocked) fails.push({ route: 'POST /api/auth/login', role: 'chain', status: 200, note: '连续失败登录未被限流' });
  if (other.status !== 200) fails.push({ route: 'POST /api/auth/login', role: 'chain', status: other.status, note: 'boss 被锁后 finwu 也登不进来（限流 key 连坐）' });
});

await withLimitedApp({ max: 1000, loginMax: 100, exportMax: 1 }, async (call) => {
  const tok = ((await call('POST', '/api/auth/login', undefined, { username: 'boss', password: PASSWORD })).json as { data?: { token?: string } })?.data?.token;
  const first = await call('GET', '/api/orders/export', tok);
  const second = await call('GET', '/api/orders/export', tok);
  const list = await call('GET', '/api/orders?page=1&pageSize=5', tok);
  checks++;
  const good = first.status === 200 && second.status === 429 && list.status === 200;
  chain.push(`${good ? '✓' : '✗'} 导出单独一档（阈值 1）→ 首次 ${first.status}、第二次 ${second.status}、普通列表 ${list.status}`);
  if (!good)
    fails.push({
      route: 'GET /api/orders/export',
      role: 'chain',
      status: second.status,
      note: `导出档限流不符合预期（${first.status}/${second.status}/${list.status}）`,
    });
});

/* ---------- 输出 ---------- */
server.close();
const denyTotal = Object.values(denied).reduce((a, b) => a + b, 0);
console.log(`\n冒烟：${checks} 次请求，静态 GET ${statics.length} 条 × ${Object.keys(tokens).length} 角色，带参 GET ${dynamics.length} 条`);
console.log(`403（越权拦截，符合预期）共 ${denyTotal} 次：${JSON.stringify(denied)}`);
console.log('\n写链路：');
for (const line of chain) console.log('  ' + line);
if (warns.length) {
  console.log(`\nWARN ${warns.length} 条（参数/数据缺失，不算失败）：`);
  const seen = new Set<string>();
  for (const w of warns) {
    const k = `${w.route} ${w.status} ${w.note}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${w.route} [${w.role}] ${w.status} — ${w.note}`);
  }
}
if (fails.length) {
  console.log(`\nFAIL ${fails.length} 条：`);
  const seen = new Set<string>();
  for (const f of fails) {
    const k = `${f.route} ${f.status} ${f.note}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${f.route} [${f.role}] ${f.status} — ${f.note}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nFAIL 0 条：无 404、无 500，写链路全通。');
}
db.close();
