import { all, get } from '../core/db.js';
import { sendAlert } from '../core/oplog.js';

/** 定时任务：订单增量同步 / 结算同步 / 保护期回收 / 寄样超期 / 授权到期 / 汇总刷新 */
export function startScheduler(): void {
  void all; void get; void sendAlert;
  console.log('[jobs] scheduler 待接入（由 sync/content 模块提供具体任务）');
}
