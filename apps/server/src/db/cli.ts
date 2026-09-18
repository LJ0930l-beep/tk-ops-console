import { setDb } from '../core/db.js';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { openDb } from './bootstrap.js';
import { seedDemoData } from './seed.js';

const db = openDb();
setDb(db);

const [cmd] = process.argv.slice(2);
const count = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);

switch (cmd) {
  case 'init':
    migrate(db);
    console.log(`[db] 建表完成 → ${config.dbFile}`);
    break;
  case 'seed':
    migrate(db);
    seedDemoData({ reset: true });
    console.log(
      `[db] 演示数据已重置：用户 ${count('sys_user')} / 店铺 ${count('tk_shop')} / 订单 ${count('tk_order')} / 明细 ${count('tk_order_item')} / 达人 ${count('creator')} / 合作单 ${count('collaboration')} / 视频 ${count('video')} / 结算流水 ${count('settlement_txn')}`,
    );
    break;
  case 'status': {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
    for (const t of tables) console.log(`${t.name.padEnd(20)} ${count(t.name)}`);
    console.log(`共 ${tables.length} 张表`);
    break;
  }
  default:
    console.log('用法: node dist/db/cli.js [init|seed|status]');
}
