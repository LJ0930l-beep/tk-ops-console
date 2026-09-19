import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { AppError } from './core/http.js';
import { authenticate } from './core/auth.js';
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

export function createApp(): Express {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));

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
