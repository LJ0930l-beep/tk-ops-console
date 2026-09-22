/**
 * OpenAPI 契约漂移门禁（docs/dev-options.md 选项 4）
 *
 * 钉住三件只有「契约」这一层能发现的问题：
 *  1. 有人加了接口没跑 `npm run openapi` —— 契约与路由清单当场对不上；
 *  2. 有人新加了一个**写接口却没挂权限守卫** —— 白名单之外一律要求 x-menu；
 *     这类问题单接口测试永远抓不到（测试用的账号本来就有权），只有静态契约能看见。
 *  3. 导出接口没写 x-guards: ['Export'] —— 意味着 can_export 形同虚设。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error 纯 JS 脚本，无类型声明
import { collectRoutes } from '../../../scripts/route-inventory.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');

interface Op {
  'x-menu'?: string[];
  'x-menu-mode'?: string;
  'x-guards'?: string[];
  'x-router'?: string;
  security?: unknown[];
  responses: Record<string, unknown>;
  parameters?: { name: string; in: string }[];
}
const spec = JSON.parse(readFileSync(`${ROOT}/docs/openapi.json`, 'utf8')) as {
  paths: Record<string, Record<string, Op>>;
  components: { securitySchemes: Record<string, unknown> };
};
const routes = collectRoutes(ROOT) as { method: string; path: string }[];
const ops = Object.entries(spec.paths).flatMap(([path, byMethod]) =>
  Object.entries(byMethod).map(([method, op]) => ({ path, method: method.toUpperCase(), ...op })),
);

/** 无菜单归属但合理存在过的写接口：登录本身要对所有人开放，改密是本人自助（后端按 token 里的 user id 收口） */
const PUBLIC_WRITE_ALLOWLIST = ['POST /api/auth/login', 'POST /api/auth/password'];

describe('OpenAPI 契约', () => {
  it('契约与路由清单同步（加了接口要跑 npm run openapi）', () => {
    const inSpec = new Set(ops.map((o) => `${o.method} ${o.path}`));
    const missing = routes.map((r) => `${r.method} ${r.path}`).filter((k) => !inSpec.has(k));
    expect(missing, `契约里没有这些接口（docs/openapi.json 过期了）：${missing.join(' , ')}`).toEqual([]);
    expect(ops.length).toBeGreaterThanOrEqual(200);
  });

  it('每个操作都要求登录，且都写了成功响应', () => {
    const bad = ops.filter((o) => !o.security?.length || !o.responses?.['200']);
    expect(bad.map((o) => `${o.method} ${o.path}`)).toEqual([]);
    expect(spec.components.securitySchemes.bearerAuth).toBeTruthy();
  });

  it('写接口必须有菜单权限（或显式登记为公开/按目标资源动态把关）', () => {
    const naked = ops
      .filter((o) => o.method !== 'GET')
      .filter((o) => !o['x-menu']?.length && o['x-menu-mode'] !== 'dynamic' && !PUBLIC_WRITE_ALLOWLIST.includes(`${o.method} ${o.path}`))
      .map((o) => `${o.method} ${o.path}（${o['x-router'] ?? '?'}）`);
    expect(naked, `这些写接口没挂 requireMenu：${naked.join(' , ')}`).toEqual([]);
  });

  it('导出接口一律吃 can_export，不只是菜单权限', () => {
    const exports = ops.filter((o) => /\/export\b|\/export\//.test(o.path));
    expect(exports.length).toBeGreaterThanOrEqual(13);
    const missing = exports.filter((o) => !o['x-guards']?.includes('Export')).map((o) => `${o.method} ${o.path}`);
    expect(missing, `导出接口没标 requireExport：${missing.join(' , ')}`).toEqual([]);
  });

  it('带 :id 的接口在契约里就有 path 参数声明（前端拼 URL 有据可依）', () => {
    const bad = ops
      .filter((o) => /:\w+/.test(o.path))
      .filter((o) => {
        const names = new Set((o.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name));
        return [...o.path.matchAll(/:(\w+)/g)].some((m) => !names.has(m[1]));
      })
      .map((o) => `${o.method} ${o.path}`);
    expect(bad).toEqual([]);
  });

  it('前端 api/paths.ts 由同一份清单生成（不是手写第二张表）', () => {
    const ts = readFileSync(`${ROOT}/apps/web/src/api/paths.ts`, 'utf8');
    const declared = [...ts.matchAll(/^ {2}'([^']+)'|^ {2}`([^`]+)`/gm)].map((m) => m[1] ?? m[2]);
    expect(declared.length).toBeGreaterThan(150);
    const apiPaths = new Set(routes.filter((r) => r.path.startsWith('/api/')).map((r) => r.path.slice(4)));
    const stale = declared.filter((d) => !d.includes('${string}') && !apiPaths.has(d));
    expect(stale, `前端路径表里有后端不存在的 endpoint：${stale.join(' , ')}`).toEqual([]);
  });
});
