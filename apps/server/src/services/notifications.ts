import { all, run, tx } from '../core/db.js';

interface DueEventRow {
  id: number;
  owner_id: number;
  due_at: string;
  assignment_cycle: number;
}

const stampUtc = (date: Date): string => date.toISOString().replace('T', ' ').slice(0, 19);

/**
 * Create one inbox item for each currently overdue, assigned alert and expire
 * notifications whose event was transferred, rescheduled, closed, or deleted.
 * The assignment cycle is the latest transfer action ID, so transfer-away and
 * transfer-back can create a fresh reminder without allowing cron duplicates.
 */
export function reconcileDueAlertNotifications(now = new Date(), eventId?: number): { created: number; staled: number } {
  const nowText = stampUtc(now);
  const eventFilter = eventId === undefined ? '' : ' AND alert_event_id = ?';
  const eventParams = eventId === undefined ? [] : [eventId];
  return tx(() => {
    const stale = run(
      `UPDATE user_notification
          SET stale_at = ?, updated_at = ?
        WHERE is_deleted = 0 AND stale_at IS NULL${eventFilter}
          AND NOT EXISTS (
            SELECT 1
              FROM alert_event ae
              JOIN sys_user u ON u.id = ae.owner_id AND u.status = 1 AND u.is_deleted = 0
             WHERE ae.id = user_notification.alert_event_id
               AND ae.is_deleted = 0
               AND ae.status IN (0, 1)
               AND ae.owner_id = user_notification.recipient_id
               AND ae.due_at = user_notification.due_at_snapshot
               AND datetime(ae.due_at) <= datetime(?)
               AND user_notification.assignment_cycle = COALESCE((
                 SELECT MAX(oa.id) FROM operation_action oa
                  WHERE oa.alert_event_id = ae.id AND oa.action_type = 'transfer' AND oa.is_deleted = 0
               ), 0)
          )`,
      nowText,
      nowText,
      ...eventParams,
      nowText,
    );

    const dueEvents = all<DueEventRow>(
      `SELECT ae.id, ae.owner_id, ae.due_at,
              COALESCE((SELECT MAX(oa.id) FROM operation_action oa
                         WHERE oa.alert_event_id = ae.id AND oa.action_type = 'transfer' AND oa.is_deleted = 0), 0) AS assignment_cycle
         FROM alert_event ae
         JOIN sys_user u ON u.id = ae.owner_id AND u.status = 1 AND u.is_deleted = 0
        WHERE ae.is_deleted = 0 AND ae.status IN (0, 1)
          AND ae.owner_id IS NOT NULL AND ae.due_at IS NOT NULL
          AND datetime(ae.due_at) <= datetime(?)${eventId === undefined ? '' : ' AND ae.id = ?'}
        ORDER BY ae.due_at ASC, ae.id ASC`,
      nowText,
      ...eventParams,
    );

    let created = 0;
    for (const event of dueEvents) {
      created += run(
        `INSERT OR IGNORE INTO user_notification
           (recipient_id, alert_event_id, notification_type, due_at_snapshot, assignment_cycle, created_at, updated_at)
         VALUES (?, ?, 'alert_due', ?, ?, ?, ?)`,
        event.owner_id,
        event.id,
        event.due_at,
        event.assignment_cycle,
        nowText,
        nowText,
      ).changes;
    }
    return { created, staled: stale.changes };
  });
}
