/**
 * 路由清单：扫 apps/server/src/modules/*.routes.ts，按 app.ts 的挂载前缀还原成完整路径。
 * 用途：① 全链路冒烟的打靶清单；② 与前端实际调用路径做契约比对（404 就是这么抓出来的）。
 * 输出 JSON：[{ method, path, file, dynamic }]
 */
import { readFileSync, readdirSync } from 'node:fs';

const MODULES = 'apps/server/src/modules';

export function collectRoutes(root = '.') {
  const app = readFileSync(`${root}/apps/server/src/app.ts`, 'utf8');
  // app.use('/api/auth', r) 已经是完整路径；api.use('/system', r) 还要补上 /api 这层
  const mounts = [...app.matchAll(/\b(app|api)\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)]
    .filter((m) => m[3] !== 'authenticate')
    .map((m) => ({ prefix: (m[1] === 'api' ? '/api' : '') + m[2], router: m[3] }));

  const sources = new Map();
  for (const f of readdirSync(`${root}/${MODULES}`).filter((x) => x.endsWith('.routes.ts'))) {
    sources.set(f, readFileSync(`${root}/${MODULES}/${f}`, 'utf8'));
  }

  const routes = [];
  for (const { prefix, router } of mounts) {
    const entry = [...sources].find(([, src]) => new RegExp(`export const ${router}\\b`).test(src));
    if (!entry) continue;
    const [file, src] = entry;
    const re = new RegExp(`\\b${router}\\.(get|post|put|delete|patch)\\(\\s*['"\`]([^'"\`]*)['"\`]`, 'g');
    for (const m of src.matchAll(re)) {
      const path = (prefix + m[2]).replace(/\/$/, '') || prefix;
      routes.push({ method: m[1].toUpperCase(), path, file: `${MODULES}/${file}`, dynamic: path.includes(':') });
    }
    // 模块内部再挂子 router 的情况（system.routes.ts 里 systemRouter.use('/users', userRouter)）
    const subRe = new RegExp(`\\b${router}\\.use\\(\\s*'([^']+)'\\s*,\\s*(\\w+)\\s*\\)`, 'g');
    for (const s of src.matchAll(subRe)) {
      const subRe2 = new RegExp(`\\b${s[2]}\\.(get|post|put|delete|patch)\\(\\s*['"\`]([^'"\`]*)['"\`]`, 'g');
      for (const m of src.matchAll(subRe2)) {
        const path = (prefix + s[1] + m[2]).replace(/\/$/, '');
        routes.push({ method: m[1].toUpperCase(), path, file: `${MODULES}/${file}`, dynamic: path.includes(':') });
      }
    }
  }
  return routes;
}

if (process.argv[1] && process.argv[1].endsWith('route-inventory.mjs')) {
  const routes = collectRoutes();
  const seen = new Set();
  const uniq = routes.filter((r) => !seen.has(r.method + r.path) && seen.add(r.method + r.path));
  console.log(JSON.stringify(uniq, null, 1));
  console.error(`total ${uniq.length}（GET ${uniq.filter((r) => r.method === 'GET').length}，带参数 ${uniq.filter((r) => r.dynamic).length}）`);
}
