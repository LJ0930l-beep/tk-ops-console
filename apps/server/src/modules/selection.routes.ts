/**
 * 选品管理（方案第十一章：候选品从登记到正式销售的五阶段流水线）
 * 挂载点：/api/selection
 *
 * 这一章的核心不是又一张表，而是「有状态、有责任人、有超时预警的流水线」，
 * 所以后端必须守住三条硬规则，否则一周后就退化成一张谁都不维护的选品 Excel：
 *  1. 阶段只能按状态机规定的边流转（POST /:id/stage 是唯一改 stage 的入口，编辑接口改不动它）；
 *  2. 测试结论必须携带完整数据快照 —— 「没有数据支撑的测试结论，后台应拒绝提交」；
 *  3. 销售前准备清单没全部勾完，不允许进入「正常销售」。
 *
 * 超时天数全部来自 config（SELECTION_*），看板卡片颜色也只是阈值的投影，
 * 前端不自己算「该不该红」，避免两处口径漂移。
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  SELECTION_BOARD_STAGES,
  SELECTION_CHECKLIST,
  SELECTION_CHECKLIST_KEYS,
  SELECTION_CONCLUSION,
  SELECTION_CONCLUSION_LABELS,
  SELECTION_METRICS,
  SELECTION_SOURCES,
  SELECTION_STAGE,
  SELECTION_STAGE_LABELS,
  breakevenRoas,
  num,
  round2,
  type CurrentUser,
  type SelectionBoardCard,
  type SelectionSnapshot,
} from '@tk/shared';
import { all, get, insert, softDelete, tx, update } from '../core/db.js';
import { config } from '../config.js';
import { badRequest, notFound, ok, parseBody, qv, wrap } from '../core/http.js';
import { Q, queryPage } from '../core/query.js';
import { exportFromList } from '../core/export.js';
import { requireExport, requireMenu, shopScope, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';

const MODULE = '选品管理';

export const selectionRouter = Router();

const current = (req: object): CurrentUser => (req as AuthedRequest).user;
const canWrite = requireMenu('selection');

const FROM = `selection_flow t
  LEFT JOIN sys_user ow ON ow.id = t.owner_id
  LEFT JOIN sys_user rg ON rg.id = t.registered_by
  LEFT JOIN tk_shop sh ON sh.id = t.shop_id`;
const SELECT = `t.*, ow.real_name AS owner_name, rg.real_name AS registered_name, sh.shop_name AS shop_name`;

/** 状态机允许的边。不在表里的组合一律 400，比「前端不给点」可靠 */
const EDGES: Record<number, number[]> = {
  [SELECTION_STAGE.REGISTERED]: [SELECTION_STAGE.TESTING, SELECTION_STAGE.ELIMINATED],
  // 2→3 不在这张表里：那一跳由「提交测试结论」接口产生（必须带数据快照），next_stages 里给出就等于邀请用户点一个必然 400 的按钮
  [SELECTION_STAGE.TESTING]: [SELECTION_STAGE.ELIMINATED],
  [SELECTION_STAGE.FEEDBACK]: [SELECTION_STAGE.PREPARING, SELECTION_STAGE.TESTING, SELECTION_STAGE.ELIMINATED],
  [SELECTION_STAGE.PREPARING]: [SELECTION_STAGE.SELLING, SELECTION_STAGE.ELIMINATED],
  [SELECTION_STAGE.SELLING]: [],
  [SELECTION_STAGE.ELIMINATED]: [SELECTION_STAGE.REGISTERED], // 淘汰池允许重新捞回登记（复盘后换打法）
};

const stageName = (s: number): string => SELECTION_STAGE_LABELS[s] ?? `阶段${String(s)}`;

const utcDay = (v: unknown): number => {
  const t = Date.parse(`${String(v ?? '').trim().replace(' ', 'T')}${/[Zz]|[+-]\d\d:?\d\d$/.test(String(v ?? '')) ? '' : 'Z'}`);
  return Number.isNaN(t) ? Number.NaN : Math.floor(t / 86_400_000);
};

/** 阶段停留天数（UTC 日历日差）；时间缺失按 0 天，不猜 */
const dwellDays = (fromIso: unknown, nowMs: number): number => {
  const a = utcDay(fromIso);
  if (Number.isNaN(a)) return 0;
  return Math.max(0, Math.floor(nowMs / 86_400_000) - a);
};

/**
 * 每个阶段的超时口径（方案 11.2 的「超时规则」逐条落到配置）：
 * 阶段二用测试开始时间算，其它阶段用进入阶段的时间算。
 */
function dueDaysOf(row: { stage: number; stage_entered_at?: string | null; test_started_at?: string | null }): number | null {
  switch (Number(row.stage)) {
    case SELECTION_STAGE.REGISTERED:
      return config.selectionTestDueDays;
    case SELECTION_STAGE.TESTING:
      return config.selectionConclusionDueDays;
    case SELECTION_STAGE.FEEDBACK:
      return config.selectionFeedbackDueDays;
    case SELECTION_STAGE.PREPARING:
      return config.selectionPrepareDueDays;
    default:
      return null;
  }
}

function dwellOf(row: { stage: number; stage_entered_at?: string | null; test_started_at?: string | null }, nowMs: number): number {
  const clock = Number(row.stage) === SELECTION_STAGE.TESTING ? row.test_started_at || row.stage_entered_at : row.stage_entered_at;
  return dwellDays(clock, nowMs);
}

/** 卡片边框三档：绿（正常）/ 黄（接近超时）/ 红（已超时）。比例走配置 */
function levelOf(dwell: number, due: number | null): 'ok' | 'warn' | 'over' {
  if (!due || due <= 0) return 'ok';
  if (dwell > due) return 'over';
  if (dwell >= due * config.selectionWarnRatio) return 'warn';
  return 'ok';
}

/**
 * 「超时」的时间戳边界：UTC 日历天零点往前 due 天。
 * 与 dwellDays + levelOf 用同一把尺子（日历天差，不是滚动 24 小时），否则列表与卡片会各说一套。
 */
const overdueCutoff = (dueDays: number): string =>
  new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - dueDays * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

const parseJson = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined || v === '') return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};

const toCard = (row: Record<string, unknown>, nowMs: number): SelectionBoardCard => {
  const r = row as unknown as SelectionBoardCard;
  const due = dueDaysOf(r);
  const dwell = dwellOf(r, nowMs);
  return { ...r, dwell_days: dwell, due_days: due, overdue_level: levelOf(dwell, due) };
};

/** 候选品唯一标识：SEL-年份-4 位序号。撞号（并发登记）时顺延重试，不静默失败 */
function nextCode(): string {
  const year = new Date().getUTCFullYear();
  const maxId = Number(get<{ c: number }>(`SELECT COALESCE(MAX(id), 0) AS c FROM selection_flow`)?.c ?? 0);
  return `SEL-${year}-${String(maxId + 1).padStart(4, '0')}`;
}

/**
 * 选品的数据范围口径：已经指定测试店铺的，按店铺范围收敛；
 * 还没分店铺的候选品只是登记人手里的草稿，直接套 shopScope 会让 SELF/SHOPS 用户连自己登记的品都看不见
 * （shop_id 为 NULL 不满足任何 IN 条件），那这一条流水线在第一步就断了。
 */
function selectionScope(user: CurrentUser): { sql: string; params: number[] } {
  const scope = shopScope(user, 't.shop_id');
  if (!scope.sql) return { sql: '', params: [] };
  return {
    sql: `((t.shop_id IS NULL AND (t.owner_id = ? OR t.registered_by = ?)) OR (${scope.sql.replace(/^\s*AND\s+/i, '')}))`,
    params: [user.id, user.id, ...scope.params],
  };
}

/** 列表与看板共用同一套筛选 + 数据范围，避免「看板看得见、导出少一批」 */
function selectionQ(req: Request): Q {
  const user = current(req);
  const q = new Q('t.is_deleted = 0');
  const scope = selectionScope(user);
  if (scope.sql) q.and(scope.sql, ...scope.params);
  const stage = qv(req, 'stage');
  if (stage !== '' && stage !== undefined && !Number.isNaN(Number(stage))) q.and('t.stage = ?', Number(stage));
  const owner = qv(req, 'owner_id');
  if (owner !== '' && !Number.isNaN(Number(owner))) q.and('t.owner_id = ?', Number(owner));
  const shop = qv(req, 'shop_id');
  if (shop !== '' && !Number.isNaN(Number(shop))) q.and('t.shop_id = ?', Number(shop));
  const source = qv(req, 'source');
  if (source) q.and('t.source = ?', source);
  const conclusion = qv(req, 'conclusion');
  if (conclusion !== '' && conclusion !== undefined && !Number.isNaN(Number(conclusion))) q.and('t.conclusion = ?', Number(conclusion));
  const keyword = qv(req, 'keyword');
  if (keyword) q.and('(t.name LIKE ? OR t.code LIKE ? OR t.brand_name LIKE ? OR t.category LIKE ?)', `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  const overdueOnly = qv(req, 'overdue');
  if (overdueOnly === '1' || overdueOnly === 'true') {
    // 「只看超时」必须与看板卡片同口径（停留日历天 > 阈值）。时间边界在 JS 里算成 'YYYY-MM-DD HH:MM:SS'，
    // SQL 只做文本比较：用 SQLite 的日期函数（ julianday 那一类）会把这条查询钉死在单一方言上，棘轮会红。
    const clocks: [number, string, number][] = [
      [SELECTION_STAGE.REGISTERED, 't.stage_entered_at', config.selectionTestDueDays],
      [SELECTION_STAGE.TESTING, 'COALESCE(t.test_started_at, t.stage_entered_at)', config.selectionConclusionDueDays],
      [SELECTION_STAGE.FEEDBACK, 't.stage_entered_at', config.selectionFeedbackDueDays],
      [SELECTION_STAGE.PREPARING, 't.stage_entered_at', config.selectionPrepareDueDays],
    ];
    q.and(
      `(${clocks.map(([stage, clock]) => `(t.stage = ${String(stage)} AND ${clock} IS NOT NULL AND ${clock} < ?)`).join(' OR ')})`,
      ...clocks.map(([, , due]) => overdueCutoff(due)),
    );
  }
  return q;
}

const row = (id: number): Record<string, unknown> | null =>
  get<Record<string, unknown>>(`SELECT ${SELECT} FROM ${FROM} WHERE t.id = ? AND t.is_deleted = 0`, id) ?? null;

/** 范围内的候选品；范围外一律 404（不区分「没有」和「不许看」，避免用报错摸 ID） */
function visibleRow(req: Request): Record<string, unknown> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('候选品 ID 不合法');
  // 数据范围直接进 SQL，不能拿 scope.params 去 includes(shopId) 比对（那是同一类越权读的老毛病）
  const q = new Q('t.is_deleted = 0');
  q.and('t.id = ?', id);
  const scope = selectionScope(current(req));
  if (scope.sql) q.and(scope.sql, ...scope.params);
  const found = get<Record<string, unknown>>(`SELECT ${SELECT} FROM ${FROM}${q.whereSql}`, ...q.params);
  if (!found) throw notFound('候选品不存在或不在你的数据范围内');
  return found;
}

/* ---------------- 查询 ---------------- */

selectionRouter.get(
  '/',
  requireMenu('selection'),
  wrap((req, res) => {
    const page = queryPage<Record<string, unknown>>(req, {
      from: FROM,
      q: selectionQ(req),
      select: SELECT,
      orderBy: `CASE WHEN t.stage = ${SELECTION_STAGE.ELIMINATED} THEN 1 ELSE 0 END, t.stage_entered_at ASC, t.id DESC`,
    });
    const nowMs = Date.now();
    ok(res, { ...page, list: page.list.map((r) => toCard(r, nowMs)) });
  }),
);

/** 看板：五列 + 每张卡的停留天数与超时档位 */
selectionRouter.get(
  '/board',
  requireMenu('selection'),
  wrap((req, res) => {
    const nowMs = Date.now();
    const q = selectionQ(req);
    q.and('t.stage <> ?', SELECTION_STAGE.ELIMINATED);
    const rows = all<Record<string, unknown>>(`SELECT ${SELECT} FROM ${FROM}${q.whereSql} ORDER BY t.stage ASC, t.stage_entered_at ASC, t.id DESC`, ...q.params);
    const cards = rows.map((r) => toCard(r, nowMs));
    const columns = SELECTION_BOARD_STAGES.map((stage) => ({
      stage,
      title: stageName(stage),
      cards: cards.filter((c) => Number(c.stage) === stage),
      over: cards.filter((c) => Number(c.stage) === stage && c.overdue_level === 'over').length,
    }));
    ok(res, { columns, thresholds: thresholds() });
  }),
);

const thresholds = () => ({
  test_due_days: config.selectionTestDueDays,
  conclusion_due_days: config.selectionConclusionDueDays,
  feedback_due_days: config.selectionFeedbackDueDays,
  prepare_due_days: config.selectionPrepareDueDays,
  first_check_hours: config.selectionFirstCheckHours,
  warn_ratio: config.selectionWarnRatio,
});

/** 顶部漏斗：登记数 → 测试数 → 通过数 → 上架数（方案 11.3 用来判断通过率是否健康） */
selectionRouter.get(
  '/funnel',
  requireMenu('selection'),
  wrap((req, res) => {
    const q = selectionQ(req);
    const agg = get<Record<string, number>>(
      `SELECT
         COUNT(*) AS registered,
         SUM(t.stage IN (2,3,4,5)) AS tested,
         SUM(t.conclusion = ${SELECTION_CONCLUSION.PASS} OR t.stage IN (4,5)) AS passed,
         SUM(t.stage = 5) AS selling,
         SUM(t.stage = 6) AS eliminated,
         SUM(t.stage = 1) AS stage_1, SUM(t.stage = 2) AS stage_2, SUM(t.stage = 3) AS stage_3, SUM(t.stage = 4) AS stage_4
       FROM ${FROM}${q.whereSql}`,
      ...q.params,
    ) ?? {};
    const n = (k: string) => Number(agg[k] ?? 0);
    const registered = n('registered');
    const tested = n('tested');
    const passed = n('passed');
    const selling = n('selling');
    const rate = (a: number, b: number) => (b > 0 ? round2(a / b) : 0);
    ok(res, {
      steps: [
        { key: 'registered', label: '登记', value: registered },
        { key: 'tested', label: '进入测试', value: tested, rate: rate(tested, registered) },
        { key: 'passed', label: '测试通过', value: passed, rate: rate(passed, tested) },
        { key: 'selling', label: '上架销售', value: selling, rate: rate(selling, passed) },
      ],
      eliminated: n('eliminated'),
      pass_rate: rate(selling, registered),
      levels: { stage_1: n('stage_1'), stage_2: n('stage_2'), stage_3: n('stage_3'), stage_4: n('stage_4') },
      thresholds: thresholds(),
    });
  }),
);

selectionRouter.get(
  '/checklist-def',
  requireMenu('selection'),
  wrap((_req, res) => ok(res, SELECTION_CHECKLIST)),
);

selectionRouter.get(
  '/export',
  requireMenu('selection'),
  requireExport,
  wrap((req, res) => {
    exportFromList(req, res, {
      module: MODULE,
      targetTable: 'selection_flow',
      filename: `selection-${String(qv(req, 'stage') ?? 'all')}`,
      from: FROM,
      select: SELECT,
      q: selectionQ(req),
      orderBy: 't.stage ASC, t.stage_entered_at ASC',
      columns: [
        'code', 'name', 'category', 'brand_name', 'source', 'stage_label', 'dwell_days', 'due_days', 'overdue_level',
        'shop_name', 'owner_name', 'registered_name', 'list_price', 'planned_discount', 'rebate_rate', 'commission_rate',
        'logistics_rate', 'est_margin', 'breakeven_roas',
        'conclusion_label', 'reject_reason', 'test_ctr', 'test_cvr', 'test_gmv', 'test_net_margin', 'checklist_done', 'code_spu',
      ],
      decorate: (r) => {
        const nowMs = Date.now();
        const c = toCard(r, nowMs);
        const snap = parseJson<Partial<SelectionSnapshot>>(c.test_snapshot, {});
        const done = parseJson<Record<string, { done?: number }>>(c.checklist, {});
        return {
          ...c,
          stage_label: stageName(Number(c.stage)),
          conclusion_label: SELECTION_CONCLUSION_LABELS[Number(c.conclusion)] ?? String(c.conclusion),
          dwell_days: c.dwell_days,
          due_days: c.due_days ?? '',
          overdue_level: c.overdue_level,
          reject_reason: c.conclusion_note ?? '',
          test_ctr: snap.ctr ?? '',
          test_cvr: snap.cvr ?? '',
          test_gmv: snap.gmv ?? '',
          test_net_margin: snap.net_margin ?? '',
          checklist_done: `${SELECTION_CHECKLIST_KEYS.filter((k) => Number(done[k]?.done)).length}/${String(SELECTION_CHECKLIST_KEYS.length)}`,
          code_spu: c.spu_id ? `SPU#${String(c.spu_id)}` : '',
        };
      },
      filters: { stage: qv(req, 'stage'), owner_id: qv(req, 'owner_id'), keyword: qv(req, 'keyword') },
    });
  }),
);

selectionRouter.get(
  '/:id/logs',
  requireMenu('selection'),
  wrap((req, res) => {
    const found = visibleRow(req);
    const list = all<Record<string, unknown>>(
      `SELECT l.*, u.real_name AS operator_name
         FROM selection_log l LEFT JOIN sys_user u ON u.id = l.operator_id
        WHERE l.selection_id = ? AND l.is_deleted = 0 ORDER BY l.id DESC`,
      Number(found.id),
    );
    ok(res, list);
  }),
);

selectionRouter.get(
  '/:id',
  requireMenu('selection'),
  wrap((req, res) => {
    const found = visibleRow(req);
    ok(res, {
      ...toCard(found, Date.now()),
      snapshot: parseJson<Partial<SelectionSnapshot>>(found.test_snapshot, {}),
      checklist: parseJson<Record<string, { done?: number; owner?: number | null; due?: string | null }>>(found.checklist, {}),
      checklist_def: SELECTION_CHECKLIST,
      next_stages: EDGES[Number(found.stage)] ?? [],
    });
  }),
);

/* ---------------- 写入 ---------------- */

/** 比率一律 0-1 小数：报错要说清"0.18 = 18%"，否则一定有人填 18 */
const rateField = (label: string) => z.number().min(0, `${label}不能为负`).max(1, `${label}要用小数填写：0.18 = 18%`).default(0);

/**
 * 预估贡献毛利率 = 返点率 − 达人佣金率 − 物流费率（都按占实收的比例）。
 * 我们不出货款，所以这里没有「采购价」的位置。返点与佣金若是同一笔钱的两种说法，
 * 只能记一次（把佣金率填 0，或把返点率填成净分成）—— 双记会凭空造出一块成本。
 */
function marginOf(v: {
  rebate_rate?: number | null;
  commission_rate?: number | null;
  logistics_rate?: number | null;
}): number {
  return Math.round((num(v.rebate_rate) - num(v.commission_rate) - num(v.logistics_rate)) * 10000) / 10000;
}

const registerBody = z.object({
  name: z.string().min(1, '商品名称必填').max(200),
  image_url: z.string().max(512).optional().nullable(),
  category: z.string().max(64).optional().nullable(),
  brand_name: z.string().max(128).optional().nullable(),
  list_price: z.number().min(0, '建议售价不能为负').default(0),
  planned_discount: rateField('计划折扣率'),
  rebate_rate: rateField('品牌返点率'),
  commission_rate: rateField('计划达人佣金率'),
  logistics_rate: rateField('计划物流费率'),
  source: z.enum([...SELECTION_SOURCES]).optional().nullable(),
  shop_id: z.number().int().positive().optional().nullable(),
  owner_id: z.number().int().positive().optional().nullable(),
  remark: z.string().max(512).optional().nullable(),
});

/** 登记：自动生成候选品 ID + 预估盈亏平衡 ROAS，进「待上架测试」队列（方案 11.2 阶段一） */
selectionRouter.post(
  '/',
  canWrite,
  wrap((req, res) => {
    const body = parseBody(registerBody, req.body);
    const user = current(req);
    if (body.shop_id) assertShopVisible(req, body.shop_id);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const margin = marginOf(body);
    // 盈亏平衡 ROAS = 1 / 贡献毛利率；毛利率 ≤ 0 时不存在平衡点，留 0 让界面明说「无平衡点」
    const breakeven = breakevenRoas(margin) ?? 0;
    const cols = {
      code: nextCode(),
      name: body.name,
      image_url: body.image_url ?? null,
      category: body.category ?? null,
      brand_name: body.brand_name ?? null,
      list_price: body.list_price,
      planned_discount: body.planned_discount,
      rebate_rate: body.rebate_rate,
      commission_rate: body.commission_rate,
      logistics_rate: body.logistics_rate,
      est_margin: margin,
      breakeven_roas: breakeven,
      source: body.source ?? null,
      shop_id: body.shop_id ?? null,
      stage: SELECTION_STAGE.REGISTERED,
      stage_entered_at: now,
      owner_id: body.owner_id ?? user.id,
      registered_by: user.id,
      conclusion: SELECTION_CONCLUSION.PENDING,
      checklist: JSON.stringify(Object.fromEntries(SELECTION_CHECKLIST_KEYS.map((k) => [k, { done: 0 }]))),
      test_snapshot: '{}',
      remark: body.remark ?? null,
      created_by: user.id,
    };
    let id = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        id = Number(tx(() => {
          const newId = Number(insert('selection_flow', cols as never));
          // 流水线的第一行也要留痕：from_stage = 0 表示「登记前」，回溯时看得出是谁什么时候捞进来的
          insert('selection_log', {
            selection_id: newId,
            from_stage: 0,
            to_stage: SELECTION_STAGE.REGISTERED,
            action: 'register',
            operator_id: user.id,
            created_by: user.id,
            note: `登记候选品 ${cols.code}（来源：${String(cols.source ?? '未填')}）`,
            created_at: now,
          } as never);
          return newId;
        }));
        break;
      } catch (e) {
        if (!/UNIQUE|ux_selection_code/i.test(String((e as Error)?.message ?? ''))) throw e;
        cols.code = nextCode();
      }
    }
    if (!id) throw badRequest('候选品编号生成冲突，请重试');
    writeOpLog({ user_id: user.id, module: MODULE, action: 'create', target_table: 'selection_flow', target_id: id, after: { code: cols.code, name: cols.name, stage: 1, breakeven_roas: breakeven }, ip: req.ip });
    ok(res, { id, ...cols }, `候选品 ${cols.code} 已登记，进入待上架测试队列`);
  }),
);

const editBody = registerBody.partial().extend({
  spu_id: z.number().int().positive().optional().nullable(),
  test_started_at: z.string().max(32).optional().nullable(),
});

/** 编辑基础信息。stage / conclusion 不在这里改 —— 状态只能走流转接口，否则日志会缺 */
selectionRouter.put(
  '/:id',
  canWrite,
  wrap((req, res) => {
    const found = visibleRow(req);
    const body = parseBody(editBody, req.body);
    const patch: Record<string, unknown> = { ...body, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) };
    delete (patch as { stage?: unknown }).stage;
    delete (patch as { conclusion?: unknown }).conclusion;
    // 毛利率与盈亏平衡 ROAS 是推出来的，不接受手填（跟 stage 一样，只能经公式变）
    delete (patch as { est_margin?: unknown }).est_margin;
    delete (patch as { breakeven_roas?: unknown }).breakeven_roas;
    if (body.shop_id) assertShopVisible(req, body.shop_id);
    if (body.rebate_rate !== undefined || body.commission_rate !== undefined || body.logistics_rate !== undefined) {
      const margin = marginOf({
        rebate_rate: body.rebate_rate ?? num(found.rebate_rate),
        commission_rate: body.commission_rate ?? num(found.commission_rate),
        logistics_rate: body.logistics_rate ?? num(found.logistics_rate),
      });
      patch.est_margin = margin;
      patch.breakeven_roas = breakevenRoas(margin) ?? 0;
    }
    update('selection_flow', Number(found.id), patch as never);
    writeOpLog({ user_id: current(req).id, module: MODULE, action: 'update', target_table: 'selection_flow', target_id: Number(found.id), before: found, after: patch, ip: req.ip });
    ok(res, row(Number(found.id)), '已保存');
  }),
);

const stageBody = z.object({
  to_stage: z.union([z.number().int(), z.string()]).pipe(z.coerce.number().int()),
  note: z.string().max(512).optional().nullable(),
  shop_id: z.number().int().positive().optional().nullable(),
  spu_id: z.number().int().positive().optional().nullable(),
  owner_id: z.number().int().positive().optional().nullable(),
});

/** 结论提交：阶段二 → 阶段三，必须带齐 7 个测试指标（方案 11.2 阶段三的关键原则） */
const conclusionBody = z.object({
  conclusion: z.union([z.number().int(), z.string()]).pipe(z.coerce.number().int()),
  note: z.string().min(1, '必须写明通过/不通过原因').max(1000),
  adjustments: z.string().max(1000).optional().nullable(),
  snapshot: z.record(z.unknown()),
});

const checklistBody = z.record(
  z.object({ done: z.number().int().min(0).max(1).optional(), owner: z.number().int().optional().nullable(), due: z.string().max(32).optional().nullable() }).partial(),
);

function assertShopVisible(req: Request, shopId: number): void {
  const scope = shopScope(current(req), 's.id');
  const hit = get<{ id: number }>(`SELECT s.id FROM tk_shop s WHERE s.id = ? AND s.is_deleted = 0 ${scope.sql}`, shopId, ...scope.params);
  if (!hit) throw notFound('店铺不存在或不在你的数据范围内');
}

/** 唯一能改 stage 的入口：校验状态机边、按结论分流、写流转日志 */
selectionRouter.post(
  '/:id/stage',
  canWrite,
  wrap((req, res) => {
    const found = visibleRow(req);
    const body = parseBody(stageBody, req.body);
    const from = Number(found.stage);
    const to = Number(body.to_stage);
    if (!SELECTION_STAGE_LABELS[to]) throw badRequest(`未知阶段：${String(to)}`);
    // 放在状态机判定之前：这一跳的「不行」有具体原因（要去提交结论），比「不允许」有用
    if (to === SELECTION_STAGE.FEEDBACK) throw badRequest('测试结论请走「提交测试结论」接口，需要携带数据快照');
    if (!(EDGES[from] ?? []).includes(to)) throw badRequest(`不允许从「${stageName(from)}」直接到「${stageName(to)}」`);

    const user = current(req);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const patch: Record<string, unknown> = { stage: to, stage_entered_at: now, updated_at: now };
    let note = body.note ?? '';

    if (to === SELECTION_STAGE.TESTING) {
      if (!body.shop_id) throw badRequest('进入上架测试必须指定测试店铺');
      assertShopVisible(req, body.shop_id);
      patch.shop_id = body.shop_id;
      patch.test_started_at = now;
      if (from === SELECTION_STAGE.FEEDBACK) {
        // 需调整后复测：调整项必须写清楚，否则复测和上次没有区别
        if (!String(found.adjustments ?? '').trim()) throw badRequest('复测必须先填写建议调整项');
        note = `${note}（复测：${String(found.adjustments)}）`;
      }
    }
    if (to === SELECTION_STAGE.PREPARING) {
      if (Number(found.conclusion) !== SELECTION_CONCLUSION.PASS) throw badRequest('只有结论为「通过」的候选品能进入销售前准备');
    }
    if (to === SELECTION_STAGE.SELLING) {
      const done = parseJson<Record<string, { done?: number }>>(found.checklist, {});
      const missing = SELECTION_CHECKLIST.filter((c) => !Number(done[c.key]?.done));
      if (missing.length) throw badRequest(`销售前准备清单未完成，不能转正常销售。未完成：${missing.map((m) => m.label).join('、')}`);
      patch.selling_at = now;
      if (body.spu_id) patch.spu_id = body.spu_id;
      else if (!found.spu_id) throw badRequest('转正常销售必须关联商品 SPU（数据不重复录入，只做工单流转）');
    }
    if (to === SELECTION_STAGE.ELIMINATED) {
      if (!note.trim()) throw badRequest('淘汰必须写明原因，供后续选品参考');
      patch.reject_reason = note;
    }
    if (body.owner_id) patch.owner_id = body.owner_id;

    tx(() => {
      update('selection_flow', Number(found.id), patch as never);
      insert('selection_log', {
        selection_id: Number(found.id),
        from_stage: from,
        to_stage: to,
        action: 'transition',
        operator_id: user.id,
        note,
        created_at: now,
      } as never);
    });
    writeOpLog({ user_id: user.id, module: MODULE, action: 'update', target_table: 'selection_flow', target_id: Number(found.id), before: { stage: from }, after: { stage: to, ...patch }, ip: req.ip });
    ok(res, toCard(row(Number(found.id)) ?? {}, Date.now()), `已流转到「${stageName(to)}」`);
  }),
);

selectionRouter.post(
  '/:id/conclusion',
  canWrite,
  wrap((req, res) => {
    const found = visibleRow(req);
    const body = parseBody(conclusionBody, req.body);
    const user = current(req);
    if (Number(found.stage) !== SELECTION_STAGE.TESTING) throw badRequest(`只有「${stageName(SELECTION_STAGE.TESTING)}」阶段能提交测试结论，当前在「${stageName(Number(found.stage))}」`);
    const allowed: number[] = [SELECTION_CONCLUSION.PASS, SELECTION_CONCLUSION.FAIL, SELECTION_CONCLUSION.RETEST];
    if (!allowed.includes(Number(body.conclusion))) {
      throw badRequest('测试结论只能是 通过 / 不通过 / 需调整后复测');
    }
    // 「没有数据支撑的测试结论，后台应拒绝提交」—— 缺指标或值不是数字都拒绝，并把缺哪几个说清楚
    const snap = body.snapshot as Record<string, unknown>;
    const missing = SELECTION_METRICS.filter((m) => snap[m] === undefined || snap[m] === null || Number.isNaN(Number(snap[m])));
    if (missing.length) throw badRequest(`测试数据快照缺少指标：${missing.join(' / ')}`);
    const snapshot: Record<string, number> = {};
    for (const m of SELECTION_METRICS) snapshot[m] = Number(snap[m]);
    if (body.conclusion === SELECTION_CONCLUSION.RETEST && !String(body.adjustments ?? '').trim()) {
      throw badRequest('结论为「需调整后复测」时必须写明调整项（价格/主图/标题/详情页/规格）');
    }
    if (body.conclusion === SELECTION_CONCLUSION.FAIL && !String(body.note ?? '').trim()) {
      throw badRequest('结论为「不通过」时必须写明淘汰原因');
    }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const from = Number(found.stage);
    const patch = {
      stage: SELECTION_STAGE.FEEDBACK,
      stage_entered_at: now,
      updated_at: now,
      conclusion: body.conclusion,
      conclusion_note: body.note,
      adjustments: body.adjustments ?? null,
      test_snapshot: JSON.stringify(snapshot),
    };
    tx(() => {
      update('selection_flow', Number(found.id), patch as never);
      insert('selection_log', {
        selection_id: Number(found.id),
        from_stage: from,
        to_stage: SELECTION_STAGE.FEEDBACK,
        action: 'submit_conclusion',
        operator_id: user.id,
        note: `结论=${String(body.conclusion)}；快照=${JSON.stringify(snapshot)}`,
        created_at: now,
      } as never);
    });
    writeOpLog({ user_id: user.id, module: MODULE, action: 'update', target_table: 'selection_flow', target_id: Number(found.id), before: { conclusion: found.conclusion }, after: { conclusion: body.conclusion, stage: SELECTION_STAGE.FEEDBACK }, ip: req.ip });
    const next = body.conclusion === SELECTION_CONCLUSION.PASS ? '进入销售前准备' : body.conclusion === SELECTION_CONCLUSION.RETEST ? '回到待上架测试（复测）' : '移入淘汰池';
    ok(res, toCard(row(Number(found.id)) ?? {}, Date.now()), `测试结论已记录，下一步应${next}`);
  }),
);

/** 结论落地：阶段三按结论分流（通过→准备 / 不通过→淘汰 / 复测→回测试） */
selectionRouter.post(
  '/:id/conclusion/confirm',
  canWrite,
  wrap((req, res) => {
    const found = visibleRow(req);
    if (Number(found.stage) !== SELECTION_STAGE.FEEDBACK) throw badRequest('只有「测试反馈」阶段需要确认落地');
    const c = Number(found.conclusion);
    const to = c === SELECTION_CONCLUSION.PASS ? SELECTION_STAGE.PREPARING : c === SELECTION_CONCLUSION.RETEST ? SELECTION_STAGE.TESTING : SELECTION_STAGE.ELIMINATED;
    const user = current(req);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const patch: Record<string, unknown> = { stage: to, stage_entered_at: now, updated_at: now };
    if (to === SELECTION_STAGE.ELIMINATED) patch.reject_reason = found.conclusion_note;
    if (to === SELECTION_STAGE.TESTING) {
      patch.test_started_at = now;
      if (!String(found.adjustments ?? '').trim()) throw badRequest('复测必须先填写调整项');
    }
    tx(() => {
      update('selection_flow', Number(found.id), patch as never);
      insert('selection_log', {
        selection_id: Number(found.id),
        from_stage: SELECTION_STAGE.FEEDBACK,
        to_stage: to,
        action: 'confirm_conclusion',
        operator_id: user.id,
        note: `按结论 ${String(c)} 落地`,
        created_at: now,
      } as never);
    });
    writeOpLog({ user_id: user.id, module: MODULE, action: 'update', target_table: 'selection_flow', target_id: Number(found.id), before: { stage: SELECTION_STAGE.FEEDBACK }, after: { stage: to }, ip: req.ip });
    ok(res, toCard(row(Number(found.id)) ?? {}, Date.now()), `已按结论流转到「${stageName(to)}」`);
  }),
);

/** 销售前准备清单：每项可指定责任人与时限；全部完成才允许转正常销售（校验在 stage 接口） */
selectionRouter.put(
  '/:id/checklist',
  canWrite,
  wrap((req, res) => {
    const found = visibleRow(req);
    const body = parseBody(checklistBody, req.body);
    const unknown = Object.keys(body).filter((k) => !SELECTION_CHECKLIST_KEYS.includes(k as never));
    if (unknown.length) throw badRequest(`未知清单项：${unknown.join(' / ')}`);
    if (Number(found.stage) !== SELECTION_STAGE.PREPARING) throw badRequest('只有「销售前准备」阶段需要维护清单');
    const merged = { ...parseJson<Record<string, { done?: number; owner?: number | null; due?: string | null }>>(found.checklist, {}) };
    for (const [k, v] of Object.entries(body)) merged[k] = { ...(merged[k] ?? {}), ...v };
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    update('selection_flow', Number(found.id), { checklist: JSON.stringify(merged), updated_at: now } as never);
    writeOpLog({ user_id: current(req).id, module: MODULE, action: 'update', target_table: 'selection_flow', target_id: Number(found.id), before: { checklist: found.checklist }, after: { checklist: merged }, ip: req.ip });
    const done = SELECTION_CHECKLIST_KEYS.filter((k) => Number(merged[k]?.done)).length;
    ok(res, { checklist: merged, done, total: SELECTION_CHECKLIST_KEYS.length }, `清单进度 ${String(done)}/${String(SELECTION_CHECKLIST_KEYS.length)}`);
  }),
);

selectionRouter.delete(
  '/:id',
  canWrite,
  wrap((req, res) => {
    const found = visibleRow(req);
    softDelete('selection_flow', Number(found.id));
    writeOpLog({ user_id: current(req).id, module: MODULE, action: 'delete', target_table: 'selection_flow', target_id: Number(found.id), before: { code: found.code }, ip: req.ip });
    ok(res, { id: found.id }, '已删除');
  }),
);
