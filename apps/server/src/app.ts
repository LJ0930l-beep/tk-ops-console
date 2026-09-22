import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import { AppError } from './core/http.js';
import { authenticate } from './core/auth.js';
import { buildRateLimiters } from './core/rateLimit.js';
import { config, type RateLimitConfig } from './config.js';
import { authRouter } from './modules/auth.routes.js';
import { systemRouter } from './modules/system.routes.js';
import { shopRouter, accountRouter } from './modules/shop.routes.js';
import { productRouter } from './modules/product.routes.js';
import { orderRouter } from './modules/order.routes.js';
import { creatorRouter } from './modules/creator.routes.js';
import { contentRouter } from './modules/content.routes.js';
import { adsRouter } from './modules/ads.routes.js';
import { financeRouter } from './modules/finance.routes.js';
import { dashboardRouter } from './modules/dashboard.routes.js';
import { stockRouter } from './modules/stock.routes.js';
import { syncRouter } from './modules/sync.routes.js';
import { importRouter } from './modules/import.routes.js';
import { actionsRouter } from './modules/actions.routes.js';

export interface AppOptions {
  /**
   * 限流覆盖：传 false 整体关闭（冒烟要一轮打上千次请求），传 partial 只调阈值（测试证明 429 真的会触发）。
   * 默认走 config.rateLimit，也就是环境变量说了算，代码里不写死数字。
   */
  rateLimit?: Partial<RateLimitConfig> | false;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  // 限流按 req.ip 计数：部署在 nginx 等代理后面时必须设 TRUST_PROXY，否则全站共用一个计数桶
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));

  // 限流挂在最前面：登录档要在 json 解析之后（按 IP+用户名计数），全局档与导出档覆盖所有 /api
  const rl = buildRateLimiters(opts.rateLimit);
  if (rl) {
    app.use('/api', rl.api);
    app.use('/api', rl.export);
    app.use('/api/auth/login', rl.login);
  }

  app.get('/api/health', (_req, res) => res.json({ code: 0, message: 'ok', data: { status: 'up', time: new Date().toISOString() } }));
  app.use('/api/auth', authRouter);

  // 以下全部需要登录
  const api = express.Router();
  api.use(authenticate);
  api.use('/system', systemRouter);
  // 路径统一挂 /api/system/*；权限不按 system 菜单，而是逐表按目标菜单把关（见 import.routes.ts 注册表）
  api.use('/system', importRouter);
  api.use('/shops', shopRouter);
  api.use('/accounts', accountRouter);
  api.use('/products', productRouter);
  api.use('/orders', orderRouter);
  api.use('/creators', creatorRouter);
  api.use('/content', contentRouter);
  api.use('/ads', adsRouter);
  api.use('/finance', financeRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/stock', stockRouter);
  api.use('/sync', syncRouter);
  api.use('/actions', actionsRouter);
  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ code: 40400, message: '接口不存在', data: null }));

  /**
   * 单端口部署：前端产物存在就顺带托管（同源，不必再摆一个 nginx）。
   * 位置有意在 /api 的 404 之后：接口路径永远优先，不会被 SPA 兜底吞掉。
   * 开发模式（vite :5173 代理 /api）不需要这里，产物没构建时这段直接不注册。
   */
  if (config.serveWeb && existsSync(config.webDist)) {
    // 产物文件名带 content hash，可以放手长缓存；index.html 不行，否则改版后用户卡在旧入口
    app.use('/assets', express.static(path.join(config.webDist, 'assets'), { maxAge: '7d', immutable: true }));
    app.use(express.static(config.webDist, { index: 'index.html' }));
    app.get(/^(?!\/api\/).*/, (_req, res, next) => {
      // 带扩展名的路径要老老实实 404：把 index.html 当缺失的图片/脚本发回去，
      // 前端只会拿到一坨 HTML 并报出看不懂的重载错误
      if (_req.path.includes('.')) return next();
      const index = path.join(config.webDist, 'index.html');
      if (!existsSync(index)) return next();
      res.sendFile(index);
    });
  }

  app.use(errorHandler);

  return app;
}

/**
 * 统一错误出口：AppError 按自身状态码返回；其它异常（含 SQL 原文、底层驱动报错）
 * 只写服务端日志，客户端一律通用文案，避免泄漏表结构与列名。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ code: err.code, message: err.message, data: null });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed|ER_DUP_ENTRY|Duplicate entry/i.test(msg)) {
    res.status(409).json({ code: 40900, message: '编号/唯一标识重复，请检查后重试', data: null });
    return;
  }
  console.error('[500]', err);
  res.status(500).json({ code: 50000, message: '服务器内部错误，请联系管理员并查看服务端日志', data: null });
}
