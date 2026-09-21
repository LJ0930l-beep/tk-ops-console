/**
 * 接口限流（三档）
 *
 * 为什么要三档而不是一档：
 *  1. **登录**最容易被打——口令爆破不需要令牌，所以只数失败次数（`skipSuccessfulRequests`），
 *     正常人输错几次不受影响，脚本连打就锁；key 用 IP+用户名，换账号不会连坐整个办公室出口 IP。
 *  2. **全局**兜住「拿令牌扫库」：内部系统一页也就十来个请求，阈值给得很宽，只为拦住遍历式抓取。
 *  3. **导出**单独一档：CSV/XLSX 是整表查询，单进程 SQLite 上并发几路就能把库拖死，
 *     所以比全局严一个数量级。
 *
 * 阈值全部来自 config（环境变量可覆盖），这里不写死任何数字；
 * `opts.rateLimit === false` 可整体关闭（压测/冒烟用），传 partial 则只覆盖其中几项（测试用）。
 *
 * 单进程内存计数，与本项目「单进程 + SQLite」的部署形态一致；
 * 真要多实例部署，得换成 Redis store（memory store 在多实例下各算各的）。
 */
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { config, type RateLimitConfig } from '../config.js';

const TOO_MANY = { code: 42900, message: '请求过于频繁，请稍后再试', data: null };

/** 统一 429 出口：沿用项目的 { code, message, data } 信封，前端 errMsg() 能直接显示 */
function handler(message: string) {
  return (_req: Request, res: Response): void => {
    res.status(429).json({ ...TOO_MANY, message });
  };
}

export interface RateLimiters {
  login: RateLimitRequestHandler;
  api: RateLimitRequestHandler;
  export: RateLimitRequestHandler;
}

/** 命中导出/模板下载的路径才计入导出档，其余请求直接跳过 */
const isExportPath = (req: Request): boolean => /\/export(?:[/?]|$)|\/import\/template(?:[/?]|$)/.test(req.originalUrl);

export function buildRateLimiters(over?: Partial<RateLimitConfig> | false): RateLimiters | null {
  if (over === false) return null;
  const c: RateLimitConfig = { ...config.rateLimit, ...(over ?? {}) };
  if (!c.enabled) return null;
  const minutes = (n: number) => Math.max(1, n) * 60_000;
  return {
    login: rateLimit({
      windowMs: minutes(c.loginWindowMinutes),
      limit: c.loginMax,
      // 只数失败：成功登录不占额度，避免一个共享出口 IP 下正常用户互相挤掉
      skipSuccessfulRequests: true,
      // IPv6 必须过 ipKeyGenerator 归一到子网，否则同一个 /64 下换地址就能绕过限制
      keyGenerator: (req) => `${ipKeyGenerator(String(req.ip ?? 'unknown'))}|${String((req.body as { username?: unknown })?.username ?? '')}`,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: handler('登录失败次数过多，请 15 分钟后再试（或联系管理员重置口令）'),
    }),
    api: rateLimit({
      windowMs: minutes(c.windowMinutes),
      limit: c.max,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: handler('接口调用过于频繁，请稍后再试'),
    }),
    export: rateLimit({
      windowMs: minutes(c.exportWindowMinutes),
      limit: c.exportMax,
      skip: (req) => !isExportPath(req),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: handler('导出任务过于频繁，请稍后再试（导出为整表查询，请缩小时间区间）'),
    }),
  };
}
