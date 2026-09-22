import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * 端到端门禁（docs/dev-options.md 选项 5）。
 *
 * 红线：只跑在自己的临时库上。库文件放在 node_modules/.cache 下，
 * 绝不允许指到仓库里那份演示库 apps/data/tk_ops.db（那是项目红线，也是过往真踩过的坑）。
 * 服务端 prepareDatabase() 对空库会自动建表 + 灌演示数据，所以每次运行都是干净且可复现的。
 */
export const E2E_DB = path.resolve('node_modules/.cache/tk-e2e/tk_ops.db');
mkdirSync(path.dirname(E2E_DB), { recursive: true });
// 删不掉 = 上一轮的 e2e 服务端还开着（Windows 会锁住库文件），那种情况下库里已经有演示数据，
// 直接复用即可；真要干净重跑就先停掉 8787 上的进程。
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(E2E_DB + suffix, { force: true });
  } catch {
    /* 被活着的服务端占用，忽略 */
  }
}

const WEB = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? '5273'}`;
const API = 'http://127.0.0.1:8787';

export default defineConfig({
  testDir: './e2e',
  // 给了 E2E_BASE_URL 就是「打一个已经在跑的目标」——用来验单端口部署出来的构建产物，
  // 这时不能再让 Playwright 另起一套 dev 服务器（那会验到另一份代码）
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: 'npm run dev:server',
          url: `${API}/api/health`,
          // 调度器关掉：cron 会在测试中途改宽表/规则状态，断言就没有确定性了。
          // 限流阈值放宽：一条 e2e 序列要登录十几次、遍历 36 个页面（每个页面还发若干请求），
          // 默认的登录 10 次/15 分钟与全局 600 次/15 分钟都会把测试锁在门外。
          // 限流本身由 apps/server/tests/rate-limit.spec.ts 在 HTTP 层守，不靠 e2e 证明。
          env: {
            DB_FILE: E2E_DB,
            PORT: '8787',
            TIKTOK_API_MODE: 'mock',
            SEED_DEMO: 'true',
            ENABLE_SCHEDULER: 'false',
            RATE_LIMIT_LOGIN_MAX: '500',
            RATE_LIMIT_MAX: '100000',
          },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
        {
          command: 'npm run dev:web',
          url: WEB,
          env: { WEB_PORT: process.env.WEB_PORT ?? '5273' },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
      ],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // 一份服务端进程 + 一份库：并行会互相写同一行数据，假红比慢更糟
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:server',
      url: `${API}/api/health`,
      // 调度器关掉：cron 会在测试中途改宽表/规则状态，断言就没有确定性了。
      // 限流阈值放宽：一条 e2e 序列要登录十几次、遍历 36 个页面（每个页面还发若干请求），
      // 默认的登录 10 次/15 分钟与全局 600 次/15 分钟都会把测试锁在门外。
      // 限流本身由 apps/server/tests/rate-limit.spec.ts 在 HTTP 层守，不靠 e2e 证明。
      env: {
        DB_FILE: E2E_DB,
        PORT: '8787',
        TIKTOK_API_MODE: 'mock',
        SEED_DEMO: 'true',
        ENABLE_SCHEDULER: 'false',
        RATE_LIMIT_LOGIN_MAX: '500',
        RATE_LIMIT_MAX: '100000',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev:web',
      url: WEB,
      env: { WEB_PORT: process.env.WEB_PORT ?? '5273' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
