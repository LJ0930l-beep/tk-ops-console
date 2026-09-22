/**
 * 一键启动（scripts/launch.mjs）
 *
 * 目标：双击根目录的 start.bat 就能看到界面，不需要先读 README。
 * 三条约定值得说明，都是踩过坑之后定的：
 *  1. **绝不直接跑仓库里那份演示库**。apps/data/tk_ops.db 是 git 跟踪的固定夹具，
 *     SQLite 在 WAL 下起一次服务就会把它写脏（历史真踩过），所以这里把它复制成 runtime/tk_ops.db 再用；
 *  2. 产物没构建就先构建，然后由后端单端口托管（见 app.ts 的 serveWeb），一个进程、一个地址；
 *     要改代码就用 dev 模式，前后各自热更新；
 *  3. 关窗口 = 停服务：不写 pid 文件、不做后台守护，少一套状态就少一类「谁占着端口」的排查。
 *
 * 用法：node scripts/launch.mjs [start|dev|reset] [--build] [--no-open]
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const MODE = args.find((a) => !a.startsWith('--')) ?? 'start';
const FORCE_BUILD = args.includes('--build');
const NO_OPEN = args.includes('--no-open');
const PORT = process.env.PORT ?? '8787';
const URL = `http://127.0.0.1:${PORT}`;

const DEMO_DB = path.join(ROOT, 'apps/data/tk_ops.db');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const RUNTIME_DB = path.join(RUNTIME_DIR, 'tk_ops.db');
const WEB_DIST = path.join(ROOT, 'apps/web/dist/index.html');

const say = (m) => console.log(m);
const run = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  // node:sqlite 是后端唯一的数据驱动，22.5 之前没有这个模块
  if (major < 22 || (major === 22 && minor < 5)) {
    say(`✗ 需要 Node.js >= 22.5（当前 ${process.versions.node}）：后端用的 node:sqlite 从 22.5 才有`);
    process.exit(1);
  }
}

function ensureDeps() {
  if (existsSync(path.join(ROOT, 'node_modules'))) return;
  say('· 第一次跑：安装依赖（npm install，可能要几分钟）');
  const r = run('npm', ['install']);
  if (r.status !== 0) {
    say('✗ 依赖安装失败，请把上面的报错贴出来看');
    process.exit(1);
  }
}

/** 演示库复制一份到 runtime/，仓库里那份保持只读 */
function ensureRuntimeDb() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (existsSync(RUNTIME_DB)) return;
  if (existsSync(DEMO_DB)) {
    copyFileSync(DEMO_DB, RUNTIME_DB);
    say(`· 演示库已复制到 runtime/tk_ops.db（${path.relative(ROOT, DEMO_DB)} 保持不动）`);
    return;
  }
  // 没有可复制的夹具就由后端自己建表灌数据（prepareDatabase 对空库会自动做）
  say('· 没找到演示库，后端启动时会自建空库并灌演示数据');
}

function ensureBuild() {
  // @tk/shared 的 main/types 指向它自己的 dist（gitignore 的产物）；
  // 只判断前端产物会漏掉「web/dist 在、shared/dist 没了」这种半新半旧状态，
  // 后果是后端 tsx 起不来 / tsc 报 108 个 Cannot find module '@tk/shared'
  const sharedEntry = path.join(ROOT, 'packages/shared/dist/index.js');
  if (!FORCE_BUILD && existsSync(WEB_DIST) && existsSync(sharedEntry)) return;
  say('· 构建共享包与前后端产物（npm run build）');
  const r = run('npm', ['run', 'build']);
  if (r.status !== 0) {
    say('✗ 构建失败');
    process.exit(1);
  }
}

function openBrowser() {
  if (NO_OPEN || process.env.NO_BROWSER) return;
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL]] : process.platform === 'darwin' ? ['open', [URL]] : ['xdg-open', [URL]];
  spawn(cmd, a, { stdio: 'ignore', detached: true }).unref();
}

async function waitHealthy(seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

function serverEntry() {
  const built = path.join(ROOT, 'apps/server/dist/index.js');
  if (existsSync(built)) return { cmd: process.execPath, args: [built] };
  // 没构建（或 --no-build）就用 tsx 直跑源码；缺 tsx 时 npm 会临时装
  return { cmd: 'npx', args: ['tsx', '--disable-warning=ExperimentalWarning', 'apps/server/src/index.ts'] };
}

async function start() {
  checkNode();
  ensureDeps();
  ensureRuntimeDb();
  ensureBuild();
  const entry = serverEntry();
  say(`\n▶ 启动单端口演示环境：${URL}`);
  say('  演示账号 boss / Passw0rd!（口令是演示种子写死的，不是真实凭证）');
  say('  停止：关掉本窗口，或按 Ctrl+C\n');
  const child = spawn(entry.cmd, entry.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DB_FILE: RUNTIME_DB, PORT, HOST: process.env.HOST ?? '127.0.0.1', SERVE_WEB: 'true', SEED_DEMO: 'true' },
  });
  const kill = () => !child.killed && child.kill('SIGINT');
  process.on('SIGINT', kill);
  process.on('SIGTERM', kill);
  if (await waitHealthy()) openBrowser();
  else say('· 等了 30 秒没等到 /api/health，先看看上面的日志');
  child.on('exit', (code) => process.exit(code ?? 0));
}

function dev() {
  checkNode();
  ensureDeps();
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!existsSync(RUNTIME_DB) && existsSync(DEMO_DB)) copyFileSync(DEMO_DB, RUNTIME_DB);
  say(`\n▶ 开发模式：后端 :${PORT} + 前端 :5173（vite 代理 /api），两边都热更新`);
  say('  打开 http://localhost:5173 ，Ctrl+C 一次即停两个进程\n');
  // 开发模式仍然用 runtime 副本，避免热更新时反复写脏仓库里那份演示库
  const r = run('npm', ['run', 'dev'], { env: { ...process.env, DB_FILE: RUNTIME_DB, PORT } });
  process.exit(r.status ?? 0);
}

function reset() {
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  say('✓ 已清空 runtime/（运行时库与临时文件）。下次启动会重新从演示库复制一份干净的。');
  say('  注意：仓库里的 apps/data/tk_ops.db 全程没被写过，这是项目红线。');
}

const modes = { start, dev, reset };
if (!modes[MODE]) {
  say(`未知模式：${MODE}（可用：start / dev / reset）`);
  process.exit(1);
}
if (MODE === 'reset') reset();
else if (MODE === 'dev') dev();
else await start();
