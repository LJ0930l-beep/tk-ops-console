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

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * 接口限流阈值（core/rateLimit.ts 三档）。
 * 测试环境默认关闭：整套回归会从 127.0.0.1 打上千次请求，开着必然互相踩；
 * 需要验限流的 spec 自己用 createApp({ rateLimit: { enabled: true, ... } }) 显式打开。
 */
export interface RateLimitConfig {
  enabled: boolean;
  /** 全局 API：每 IP 每窗口最大请求数 */
  windowMinutes: number;
  max: number;
  /** 登录：每 IP+用户名 的失败次数上限（成功不计数） */
  loginWindowMinutes: number;
  loginMax: number;
  /** 导出/模板：整表查询，单独一档更严 */
  exportWindowMinutes: number;
  exportMax: number;
}

const rateLimit: RateLimitConfig = {
  enabled: process.env.RATE_LIMIT !== 'false' && env !== 'test',
  windowMinutes: num('RATE_LIMIT_WINDOW_MIN', 15),
  max: num('RATE_LIMIT_MAX', 600),
  loginWindowMinutes: num('RATE_LIMIT_LOGIN_WINDOW_MIN', 15),
  loginMax: num('RATE_LIMIT_LOGIN_MAX', 10),
  exportWindowMinutes: num('RATE_LIMIT_EXPORT_WINDOW_MIN', 15),
  exportMax: num('RATE_LIMIT_EXPORT_MAX', 20),
};

export const config = {
  env,
  isProd,
  rateLimit,
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
  /**
   * 单端口部署：前端产物存在就由后端顺带托管（同源，不需要 nginx）。
   * 开发模式各自跑各自的（vite 代理 /api），这里默认不影响它。
   */
  serveWeb: process.env.SERVE_WEB !== 'false',
  webDist: process.env.WEB_DIST ?? path.resolve(here, '../../web/dist'),
  /** 空库启动时是否自动灌入演示账号与数据；生产默认关闭 */
  seedDemo: (process.env.SEED_DEMO ?? (isProd ? 'false' : 'true')) !== 'false',
  /** 演示账号统一初始密码，可用环境变量覆盖以避开公开的固定口令 */
  demoPassword: process.env.DEMO_PASSWORD ?? 'Passw0rd!',
  /** mock = 不访问外网，用本地样例数据源；real = 走 TikTok Shop 开放平台 */
  tiktokMode: (process.env.TIKTOK_API_MODE ?? 'mock') as 'mock' | 'real',
  tiktokBaseUrl: process.env.TIKTOK_API_BASE ?? 'https://open-api.tiktokglobalshop.com',
  /* ---- real 模式外呼的三个上限：联调时按平台当期限流文档调，不许散回客户端里写死 ---- */
  /** 单个同步任务最多翻几页（游标不收敛时的闸门，正常店铺一页就能取完） */
  tiktokMaxPages: num('TT_MAX_PAGES', 50),
  /** 可重试错误（429/5xx/平台繁忙）的最多重试次数 */
  tiktokMaxRetry: num('TT_MAX_RETRY', 2),
  /** 单次 HTTP 超时 */
  tiktokTimeoutMs: num('TT_HTTP_TIMEOUT_MS', 15_000),
  adsBaseUrl: process.env.adsApiBase ?? 'https://business-api.tiktok.com',
  alertWebhook: process.env.ALERT_WEBHOOK ?? '',
  sampleContentDueDays: Number(process.env.SAMPLE_DUE_DAYS ?? 7),
  protectDefaultDays: Number(process.env.CREATOR_PROTECT_DAYS ?? 30),
  syncOverlapMinutes: Number(process.env.SYNC_OVERLAP_MIN ?? 5),
  /* ---- 选品流水线的超时口径（方案 11.2：每个阶段都有明确时限，写死在代码里就调不动了）---- */
  /** 阶段一：登记后多少天没进上架测试就提醒登记人 */
  selectionTestDueDays: num('SELECTION_TEST_DUE_DAYS', 7),
  /** 阶段二：测试期最长天数，满期未提交结论进 P0 */
  selectionConclusionDueDays: num('SELECTION_CONCLUSION_DUE_DAYS', 14),
  /** 阶段二：上架后多少小时做首次检测（方案 48-72h，取上限做闸门） */
  selectionFirstCheckHours: num('SELECTION_FIRST_CHECK_HOURS', 72),
  /** 阶段三：结论提交后多少天内要完成回写分流（反馈积压） */
  selectionFeedbackDueDays: num('SELECTION_FEEDBACK_DUE_DAYS', 3),
  /** 阶段四：进入销售前准备后多少天没清完清单就提醒负责人 */
  selectionPrepareDueDays: num('SELECTION_PREPARE_DUE_DAYS', 7),
  /** 看板卡片边框：停留天数达到超时阈值的这个比例即转黄（红色=已超时） */
  selectionWarnRatio: Number(process.env.SELECTION_WARN_RATIO ?? 0.7),
  /* ---- 后台任务队列（表即队列，见 services/jobs/queue.ts）---- */
  jobMaxAttempts: num('JOB_MAX_ATTEMPTS', 3),
  jobRetryBackoffSeconds: num('JOB_RETRY_BACKOFF_SEC', 120),
  jobBatchSize: num('JOB_BATCH_SIZE', 5),
  /** 在跑但超过这个时长没结束的任务，视为进程被 kill，退回队列 */
  jobStaleMinutes: num('JOB_STALE_MIN', 30),
  /**
   * 定时任务的调度时区（node-cron 不设时区时用服务器本地时区 —— 换台机器同一句表达式就换触发时刻）。
   * 数据统一存 UTC、报表按店铺时区切日，所以默认给 UTC，要改成站点时区用 JOB_TZ。
   */
  jobTimezone: process.env.JOB_TZ ?? 'UTC',
  /** 同步导出行数上限（PRD B8：一期只做同步导出，超了明确拒绝让人缩小范围） */
  exportMaxRows: num('EXPORT_MAX_ROWS', 20000),
  /** 单条记录的变更历史一次最多回几条：既是缺省值也是硬上限（历史是排查用的，不是拿来做全量导出的） */
  oplogHistoryMaxRows: num('OPLOG_HISTORY_MAX_ROWS', 50),
  /* ---- AI 助手（PRD §3.13）：出网总开关与三个上限，全部配置化，不许在客户端里写死 ---- */
  /**
   * 关掉时 /api/ai/* 一律 503「AI 能力未启用」。
   * 默认开：本项目没有内置假数据分支（用户明确定的是"没配服务商就报错"），
   * 所以真不出网的前提是"没有可用服务商配置"，而不是靠这个开关兜底。
   */
  aiEnabled: process.env.AI_ENABLED !== 'false',
  /** 单次模型调用超时：比 TikTok 同步宽，模型首 token 慢是常态 */
  aiTimeoutMs: num('AI_HTTP_TIMEOUT_MS', 45_000),
  aiMaxRetry: num('AI_MAX_RETRY', 1),
  /**
   * 一轮对话里最多允许模型回传几轮工具调用。
   * 没有这个数，模型可以一直"再查一个工具"把会话吊住并无限烧 token。
   */
  aiMaxToolRounds: num('AI_MAX_TOOL_ROUNDS', 4),
  /** 一次请求最多带多少条历史消息进模型（超了从最旧一侧裁，系统提示词与本轮问题永不裁） */
  aiHistoryLimit: num('AI_HISTORY_LIMIT', 20),
  /**
   * 允许出网的 base_url 主机白名单（逗号分隔，空 = 不限制）。
   * 存在的理由：服务商配置是界面上可写的，没有这道闸，一个被拿下的管理员账号
   * 就能把 api_key 指向自己的服务器 —— 密钥泄露不需要读接口，只需要一次"测活"。
   */
  aiAllowedHosts: (process.env.AI_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** 单次调用允许送进模型的最大字符数（提示词 + 工具返回都算），超了就截断并说明 */
  aiMaxPromptChars: num('AI_MAX_PROMPT_CHARS', 24_000),
  enableScheduler: process.env.ENABLE_SCHEDULER !== 'false',
  /**
   * 反向代理层数（nginx 等）。不设时 req.ip 就是代理自己的地址，
   * 限流会把全站用户算成同一个 key —— 部署在代理后面必须设 TRUST_PROXY=1。
   */
  trustProxy: process.env.TRUST_PROXY ?? '',
};
