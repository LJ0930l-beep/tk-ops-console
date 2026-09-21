/**
 * 对外文案兜底脱敏：同步日志/上游报错可能整段带出凭证，任何回给前端的错误文案都要先过这里。
 * 与 services/tiktok/realClient.ts 的 safe() 同一思路，但这里面向的是「已经落库的字符串」。
 */
export function maskError(text: string): string {
  return String(text ?? '')
    .replace(/(app[_-]?secret|access[_-]?token|app[_-]?key|password|sign|token)\s*[=:]\s*[^\s,&"']+/gi, '$1=***')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***')
    .slice(0, 300);
}
