import { config } from './config.js';
import { setDb } from './core/db.js';
import { prepareDatabase } from './db/bootstrap.js';
import { createApp } from './app.js';
import { startScheduler } from './jobs/scheduler.js';

const db = prepareDatabase();
setDb(db);

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`[server] TikTok 运营管理后台 API → http://${config.host}:${config.port}  (mode=${config.tiktokMode})`);
});

if (config.enableScheduler) startScheduler();

const shutdown = (sig: string) => {
  console.log(`[server] ${sig} → 关闭中`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
