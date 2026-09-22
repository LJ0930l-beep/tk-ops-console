/**
 * 打包项目源码：node scripts/pack.mjs [输出文件名]
 *
 * 用 `git archive` 而不是压缩整个目录，理由有三个：
 *  1. 它按 .gitignore 的口径给东西 —— node_modules / dist / runtime / test-results 这些
 *     「本机产物或运行时垃圾」不会混进包里（打包 30 万个小文件既慢又没意义）；
 *  2. 打出来的是**已提交的确定状态**，收件人拿到就能对上某个 commit，
 *     而不是我本机此刻的临时现场；
 *  3. 不带 .git 历史，包体小一个量级。要历史请自己 `git bundle` 或克隆。
 *
 * 注意：docs/v2-dev-doc.txt 按项目约定不进 git，所以也不在这个包里。
 * 需要它就在打包后手动补：git archive 出来的 zip 可以直接往里加文件。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const out = process.argv[2] ?? `tk-ops-console-${day}.zip`;
const target = path.isAbsolute(out) ? out : path.join(ROOT, 'outputs', out);

mkdirSync(path.dirname(target), { recursive: true });
const prefix = `tk-ops-console/`; // 解压后收进一个目录，不落一地散文件
const r = spawnSync('git', ['archive', `--prefix=${prefix}`, '--format=zip', '-o', target, 'HEAD'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (r.status !== 0) {
  console.error('✗ git archive 失败（确认仓库里已无未提交的关键改动）');
  process.exit(r.status ?? 1);
}
const { statSync } = await import('node:fs');
const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim();
console.log(`✓ ${path.relative(ROOT, target)}  ${(statSync(target).size / 1024 / 1024).toFixed(2)} MB  ← commit ${rev}`);
console.log('  收件人：解压后双击 start.bat（首次会自动 npm install + build，然后开 http://127.0.0.1:8787）');
