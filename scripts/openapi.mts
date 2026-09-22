/**
 * OpenAPI 3.1 契约生成（docs/dev-options.md 选项 4）。
 *
 * 为什么从「源码路由清单 + 处理器源码」生成，而不是运行时扫 express 栈：
 * Express 5 把 app.use('/api', router) 的挂载前缀藏进了闭包（layer.matchers 里的 regexp 读不出来），
 * 运行时拿不到完整路径；而 route-inventory.mjs 那份清单已经是 smoke 与契约测试的打靶依据 ——
 * 再造一套「真相」只会让两份清单互相漂移。
 *
 * 能拿到真信息的部分绝不编：
 *  - path / method：来自路由清单；
 *  - 参数：从处理器源码读 qv(req,'x') / req.query.x 与 :param；
 *  - 权限：读 requireMenu('x') / requireExport 等守卫实参；
 *  - 请求体：登记 parseBody(SCHEMA, ...) 用到的 zod 变量名（x-zod-schema），
 *    字段形状仍以 zod 单点为准，这里不复制第二份表（复制必然腐化）；
 *  - 描述：取路由定义上方那段人写的注释。
 * 响应 data 的字段形状静态推不出来（各接口手写），故只给统一信封 —— 这是本契约已知的边界，
 * 记在 docs/dev-options.md 里，不要假装生成器做了它没做的事。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { collectRoutes } from './route-inventory.mjs';

const ROOT = '.';
const MODULES = 'apps/server/src/modules';
const OUT_SPEC = 'docs/openapi.json';
const OUT_PATHS = 'apps/web/src/api/paths.ts';
const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

const sources = new Map(
  readdirSync(`${ROOT}/${MODULES}`)
    .filter((f) => f.endsWith('.routes.ts'))
    .map((f) => [f, readFileSync(`${ROOT}/${MODULES}/${f}`, 'utf8')]),
);

/** 子 router 的挂载段：`systemRouter.use('/users', userRouter)` → userRouter = '/users' */
const childPrefix = {};
for (const [, src] of sources) {
  for (const m of src.matchAll(/\b(\w+Router)\.use\(\s*'([^']+)'\s*,\s*(\w+Router)\s*\)/g)) childPrefix[m[3]] = m[2];
}

/**
 * 一个文件里所有路由调用点：{ router, method, relPath, idx, eff }
 * eff 是「这条调用点在完整路径里应当匹配的后缀」：
 *  - 子 router 的 '/' 是挂载段本身（userRouter.get('/') 在 /api/system/users 上）；
 *  - 顶层 router 的 '/' 只有 /api/<模块> 这一种形态；
 *  - 其余就是相对路径（可再叠上子 router 的挂载段，用于最长匹配）。
 */
function callSites(src) {
  const re = new RegExp(`\\b(\\w+Router)\\.(${METHODS.join('|')})\\(\\s*['"\`]([^'"\`]*)['"\`]`, 'g');
  return [...src.matchAll(re)].map((m) => {
    const router = m[1];
    const rel = m[3];
    const pre = childPrefix[router] ?? '';
    if (rel === '/') {
      return { router, method: m[2], relPath: rel, idx: m.index, eff: pre || '\u0000ROOT' };
    }
    const eff = pre + rel;
    return { router, method: m[2], relPath: rel, idx: m.index, eff: eff.length > 1 ? eff : '' };
  });
}

/**
 * 清单里的完整路径 ↔ 调用点：同一 method 且「完整路径以后缀结尾」，取后缀最长的那个
 * （后缀越长意味着挂载前缀越短，就是它自己那条）。解析不出来就宁可留空，不猜。
 */
function resolve(sites, method, fullPath) {
  const hits = sites.filter((s) => {
    if (s.method !== method) return false;
    // 顶层 router 的 '/'：一个文件里可能有两个这样的 router（shopRouter / accountRouter），
    // 靠「挂载段以 router 名开头」区分，否则两边会互相抵消成「没定位到」。
    if (s.eff === '\u0000ROOT') {
      const base = s.router.replace(/Router$/, '').toLowerCase();
      return fullPath.split('/').length === 3 && fullPath.split('/')[2].toLowerCase().startsWith(base);
    }
    if (!s.eff) return false;
    return fullPath === s.eff || fullPath.endsWith(s.eff);
  });
  if (!hits.length) return null;
  const longest = Math.max(...hits.map((s) => s.eff.length));
  let best = hits.filter((s) => s.eff.length === longest);
  if (best.length > 1) {
    // 仍并列时按 router 名与模块段的亲和度收敛（shopRouter ↔ /shops、accountRouter ↔ /accounts）
    const seg = fullPath.split('/')[2]?.toLowerCase() ?? '';
    const affinity = best.filter((s) => seg.startsWith(s.router.replace(/Router$/, '').toLowerCase()));
    if (affinity.length === 1) best = affinity;
  }
  return best.length === 1 ? best[0] : null;
}

/** 从调用点到下一条路由调用点为止 = 这条路由的处理器源码区域 */
function regionOf(src, idx, sites) {
  const next = sites.map((s) => s.idx).filter((i) => i > idx).sort((a, b) => a - b)[0];
  return src.slice(idx, next ?? src.length);
}

function docAbove(src, idx) {
  const before = src.slice(0, idx);
  const end = before.lastIndexOf('*/');
  if (end < 0 || before.slice(end + 2).trim().length) return null; // 注释与定义之间不容别的东西
  const start = before.lastIndexOf('/**', end);
  if (start < 0) return null;
  const text = before
    .slice(start + 3, end)
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function queryParams(region) {
  const names = new Set();
  for (const m of region.matchAll(/\bqv\(\s*req\s*,\s*'([^']+)'/g)) names.add(m[1]);
  for (const m of region.matchAll(/\bqString\(\s*req\s*,\s*'([^']+)'/g)) names.add(m[1]);
  for (const m of region.matchAll(/req\.query\.([a-zA-Z_]\w*)/g)) names.add(m[1]);
  return [...names].sort();
}

function buildParameters(fullPath, region) {
  const out = fullPath
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((p) => ({ name: p.slice(1), in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }));
  for (const name of queryParams(region)) {
    if (name === 'page' || name === 'pageSize') {
      out.push({ name, in: 'query', required: false, schema: { type: 'integer', minimum: 1, ...(name === 'pageSize' ? { maximum: 200 } : {}) } });
    } else {
      out.push({ name, in: 'query', required: false, schema: { type: 'string' } });
    }
  }
  return out;
}

function buildResponses(region) {
  if (/\bsendTable\(|\bexportFromList\(|content-disposition/i.test(region)) {
    return {
      200: {
        description: '文件流：?format=csv 走 text/csv（带 BOM），?format=xlsx 走 ExcelJS 流式工作簿；超过 EXPORT_MAX_ROWS 直接 400，不静默截断',
        content: {
          'text/csv': { schema: { type: 'string', format: 'binary' } },
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } },
        },
      },
    };
  }
  const paged = /\bqueryPage\(|\bpageResult\(|\blist:\s/.test(region);
  return {
    200: {
      description: paged ? '统一信封，data 为分页体' : '统一信封',
      content: {
        'application/json': {
          schema: paged
            ? { type: 'object', properties: { code: { type: 'integer' }, message: { type: 'string' }, data: { $ref: '#/components/schemas/Paged' } } }
            : { $ref: '#/components/schemas/Envelope' },
        },
      },
    },
  };
}

/**
 * 守卫有三种写法，都要认，否则契约会把「有权限」的接口标成「无权限」——那比缺文档更坏：
 *  ① 路由内联：router.get('/x', requireMenu('finance'), ...)
 *  ② 文件内别名：const canWrite = requireMenu('creator')
 *  ③ 整段挂载：productRouter.use(requireMenu('product'))
 */
const aliasCache = new Map();
const routerGuard = {};
for (const [, src] of sources) {
  const menu = {};
  const guards = {};
  for (const m of src.matchAll(/\bconst (\w+)\s*=\s*requireMenu\(\s*'([^']+)'\s*\)/g)) menu[m[1]] = m[2];
  for (const m of src.matchAll(/\bconst (\w+)\s*=\s*requireExport\b/g)) guards[m[1]] = 'Export';
  aliasCache.set(src, { menu, guards });
  for (const m of src.matchAll(/\b(\w+Router)\.use\(\s*requireMenu\(\s*'([^']+)'\s*\)/g)) routerGuard[m[1]] = { ...(routerGuard[m[1]] ?? {}), menu: m[2] };
  for (const m of src.matchAll(/\b(\w+Router)\.use\(\s*requireExport\b/g)) routerGuard[m[1]] = { ...(routerGuard[m[1]] ?? {}), export: true };
  // `userRouter.use(sysOnly)`：整段挂载用的是别名守卫，不解析就会把 20 条接口标成「无权限要求」
  for (const m of src.matchAll(/\b(\w+Router)\.use\(\s*(\w+)\s*\)/g)) {
    if (menu[m[2]]) routerGuard[m[1]] = { ...(routerGuard[m[1]] ?? {}), menu: menu[m[2]] };
    if (guards[m[2]]) routerGuard[m[1]] = { ...(routerGuard[m[1]] ?? {}), export: true };
  }
}

function securityOf(src, region, routerName) {
  const al = aliasCache.get(src) ?? { menu: {}, guards: {} };
  const menus = new Set([...region.matchAll(/requireMenu\(\s*'([^']+)'/g)].map((m) => m[1]));
  for (const [alias, menu] of Object.entries(al.menu)) if (new RegExp(`\\b${alias}\\b`).test(region)) menus.add(menu);
  if (routerGuard[routerName]?.menu) menus.add(routerGuard[routerName].menu);
  const guards = new Set([...region.matchAll(/\brequire([A-Z]\w*)\b/g)].map((m) => m[1]).filter((g) => g !== 'Menu'));
  for (const [alias, g] of Object.entries(al.guards)) if (new RegExp(`\\b${alias}\\b`).test(region)) guards.add(g);
  if (routerGuard[routerName]?.export) guards.add('Export');
  return { menus: [...menus], guards: [...guards] };
}

const routes = collectRoutes(ROOT);
const paths = {};
const unresolved = [];
for (const r of routes) {
  const file = r.file.replace(`${MODULES}/`, '');
  const src = sources.get(file);
  const method = r.method.toLowerCase();
  const site = src ? resolve(callSites(src), method, r.path) : null;
  if (!site) unresolved.push(`${r.method} ${r.path}`);
  const region = site ? regionOf(src, site.idx, callSites(src)) : '';
  const { menus, guards } = securityOf(src ?? '', region, site?.router ?? '');
  const zodBody = /parseBody\(\s*([A-Za-z_]\w*)\s*,/.exec(region)?.[1];
  const op = {
    tags: [r.path.split('/')[2] ?? 'misc'],
    operationId: `${method}_${r.path.replace(/^\/api\//, '').replace(/[^a-zA-Z0-9]+/g, '_')}`,
    ...(docAbove(src ?? '', site?.idx ?? -1) && site ? { description: docAbove(src, site.idx) } : {}),
    parameters: buildParameters(r.path, region),
    security: [{ bearerAuth: [] }],
    responses: buildResponses(region),
    'x-router': site ? `${file}#${site.router}` : file,
  };
  if (menus.length) op['x-menu'] = menus;
  else if (/\bhasMenu\(|guardMenu\(/.test(region)) op['x-menu-mode'] = 'dynamic'; // 按目标资源动态把关（导入中心），静态列不出来
  if (guards.length) op['x-guards'] = guards;
  if (method !== 'get') {
    op.requestBody = {
      required: Boolean(zodBody),
      content: { 'application/json': { schema: { type: 'object' }, ...(zodBody ? { 'x-zod-schema': zodBody } : {}) } },
    };
  }
  (paths[r.path] ??= {})[method] = op;
}

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'TikTok Shop 运营后台 API',
    version: '1.0.0',
    description: [
      '由 `npm run openapi` 从 apps/server/src/modules/*.routes.ts 生成，请勿手改（改了下次就没了）。',
      '',
      '- 所有响应走统一信封 `{ code, message, data }`，`code=0` 为成功；分页接口 data 为 `{ list, total, page, pageSize }`。',
      '- 鉴权 `Authorization: Bearer <JWT>`；`x-menu` 列出该接口要求的菜单，`x-guards` 列出附加守卫（如 `Export` = 需 can_export）。',
      '- 请求体只标出后端 zod 校验器名字（`x-zod-schema`），字段形状以 zod 单点为准，不在契约里复制第二份字段表。',
      '- 数据范围（shopScope）在运行时按角色收敛，不体现在路径上：同一接口不同角色看到的行不同。',
      '- 本文件是开发期契约，不通过 HTTP 暴露（避免把内部接口面泄漏给未登录方）。',
      '- 已知边界：`data` 的字段形状未生成（各接口手写返回值），要真正类型化需要先把响应建模收敛。',
    ].join('\n'),
  },
  servers: [{ url: '/', description: '同源部署，前端 axios baseURL=/api' }],
  tags: [...new Set(routes.map((r) => r.path.split('/')[2]).filter(Boolean))].sort().map((name) => ({ name })),
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Envelope: {
        type: 'object',
        required: ['code', 'message', 'data'],
        properties: {
          code: { type: 'integer', description: '0 = 成功；非 0 与 HTTP 状态同向（400xx/401xx/403xx/404xx/429xx/500xx）' },
          message: { type: 'string', description: '可直接展示给用户的中文文案，已脱敏（不含 app_secret/sign/token）' },
          data: {},
        },
      },
      Paged: {
        type: 'object',
        required: ['list', 'total', 'page', 'pageSize'],
        properties: {
          list: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
        },
      },
    },
  },
  paths: Object.fromEntries(Object.keys(paths).sort().map((k) => [k, paths[k]])),
};

writeFileSync(`${ROOT}/${OUT_SPEC}`, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

/** 前端类型安全：endpoint 拼错从「用户点进去才 404」变成「vue-tsc 阶段就红」 */
const webPaths = [...new Set(routes.filter((r) => r.path.startsWith('/api/')).map((r) => r.path.slice(4)))].sort();
// `${base}/:id` 这种在源码里用模板拼路径的 router（库存的三张 CRUD 表共用一个循环），
// 清单只能给出字面量 `${base}/:id`；生成类型时把未知段统一降级成 ${string}，
// 宁松勿错：真正的把关在运行时权限与 zod 校验，这里只是把「段数/前缀写错」挡在编译期。
const toType = (p) => {
  const loose = p.replace(/\$\{[A-Za-z_]\w*\}/g, '${string}');
  return /[$:]\{|\$\{string\}|:[A-Za-z_]/.test(loose) ? `\`${loose.replace(/:[A-Za-z_]\w*/g, '${string}')}\`` : `'${loose}'`;
};
const ts = [
  '/**',
  ' * API 路径契约 —— 由 `npm run openapi` 从后端路由生成，请勿手改。',
  ' *',
  ' * 作用：apiGet/apiPost/apiPut/apiDelete/apiDownload 的 url 参数是字面量联合类型，',
  ' * endpoint 写错（拼错、或后端改名前端没跟）在 vue-tsc 阶段就红，而不是等用户点进页面才 404。',
  ' * 带 :param 的路径生成 `${string}` 模板字面量类型，模板串拼错段数同样过不了检查。',
  ' */',
  'export const API_PATHS = [',
  ...webPaths.map((p) => `  '${p}',`),
  '] as const;',
  '',
  'export type ApiPath =',
  ...[...new Set(webPaths.map(toType))].map((t) => `  | ${t}`),
  ';',
  '',
].join('\n');
writeFileSync(`${ROOT}/${OUT_PATHS}`, ts, 'utf8');

const ops = Object.values(spec.paths).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(`openapi: ${Object.keys(spec.paths).length} 路径 / ${ops} 操作 → ${OUT_SPEC}`);
console.log(`apipaths: ${webPaths.length} 条 → ${OUT_PATHS}`);
if (unresolved.length) {
  // 定位不到就意味着这条路由的参数/权限在契约里是空的 —— 一份「看起来全」但偷偷缺项的契约比没有更危险
  console.error(`FAIL ${unresolved.length} 条路由没定位到源码调用点（生成器的匹配规则需要补）：`);
  for (const u of unresolved) console.error(`  ${u}`);
  process.exitCode = 1;
}
