import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';

/** 开发/测试用的固定回退值：生产环境一律禁用，缺失即拒绝启动 */
const DEV_FALLBACK = 'tk-ops-console-dev-secret-change-me';

function required(name: string, value: string | undefined, minLen: number): string {
  const v = (value ?? '').trim();
  if (v.length >= minLen) return v;
  throw new Error(
    `[config] 生产环境必须设置环境变量 ${name}（至少 ${minLen} 位随机串）。` +
      ` 生成方式：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
  );
}

const devSecret = DEV_FALLBACK;
if (!isProd && !process.env.JWT_SECRET) {
  console.warn('[config] 警告：使用内置开发 JWT 密钥，仅限本地/演示环境；生产必须设置 JWT_SECRET');
}

export const config = {
  env,
  isProd,
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  jwtSecret: isProd ? required('JWT_SECRET', process.env.JWT_SECRET, 32) : process.env.JWT_SECRET || devSecret,
  /**
   * 店铺接口凭证的 AES-GCM 密钥，与 JWT 签名密钥分离（避免一把钥匙泄漏即同时伪造令牌与解密凭证）。
   * 非生产环境回退到 jwtSecret，保持与既有演示库密文的兼容。
   */
  credKey: isProd ? required('CRED_ENC_KEY', process.env.CRED_ENC_KEY, 32) : process.env.CRED_ENC_KEY || process.env.JWT_SECRET || devSecret,
  jwtTtlSeconds: Number(process.env.JWT_TTL ?? 60 * 60 * 8),
  dbFile: process.env.DB_FILE ?? path.resolve(here, '../../data/tk_ops.db'),
  /** 空库启动时是否自动灌入演示账号与数据；生产默认关闭 */
  seedDemo: (process.env.SEED_DEMO ?? (isProd ? 'false' : 'true')) !== 'false',
  /** 演示账号统一初始密码，可用环境变量覆盖以避开公开的固定口令 */
  demoPassword: process.env.DEMO_PASSWORD ?? 'Passw0rd!',
  /** mock = 不访问外网，用本地样例数据源；real = 走 TikTok Shop 开放平台 */
  tiktokMode: (process.env.TIKTOK_API_MODE ?? 'mock') as 'mock' | 'real',
  tiktokBaseUrl: process.env.TIKTOK_API_BASE ?? 'https://open-api.tiktokglobalshop.com',
  adsBaseUrl: process.env.adsApiBase ?? 'https://business-api.tiktok.com',
  alertWebhook: process.env.ALERT_WEBHOOK ?? '',
  sampleContentDueDays: Number(process.env.SAMPLE_DUE_DAYS ?? 7),
  protectDefaultDays: Number(process.env.CREATOR_PROTECT_DAYS ?? 30),
  syncOverlapMinutes: Number(process.env.SYNC_OVERLAP_MIN ?? 5),
  enableScheduler: process.env.ENABLE_SCHEDULER !== 'false',
};
