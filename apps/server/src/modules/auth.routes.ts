import { Router } from 'express';
import { z } from 'zod';
import { get, run } from '../core/db.js';
import { AppError, ok, parseBody, unauthorized, wrap } from '../core/http.js';
import { authenticate, hashPassword, loadUser, signToken, verifyPassword, type AuthedRequest } from '../core/auth.js';
import { writeOpLog } from '../core/oplog.js';

export const authRouter = Router();

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

authRouter.post(
  '/login',
  wrap((req, res) => {
    const { username, password } = parseBody(loginSchema, req.body);
    const row = get<{ id: number; password_hash: string; status: number }>(
      `SELECT id, password_hash, status FROM sys_user WHERE username = ? AND is_deleted = 0`,
      username,
    );
    if (!row || !verifyPassword(password, row.password_hash)) throw unauthorized('账号或密码错误');
    if (row.status !== 1) throw new AppError(403, '账号已停用，请联系管理员', 40301);
    const user = loadUser(row.id);
    if (!user) throw unauthorized();
    writeOpLog({ user_id: user.id, module: 'auth', action: 'login', ip: req.ip });
    run(`UPDATE sys_user SET last_login_at = datetime('now') WHERE id = ?`, user.id);
    res.json({ code: 0, message: 'ok', data: { token: signToken({ sub: user.id, username: user.username }), user } });
  }),
);

authRouter.get('/me', authenticate, wrap((req, res) => ok(res, (req as AuthedRequest).user)));

authRouter.post(
  '/password',
  authenticate,
  wrap((req, res) => {
    const { oldPassword, newPassword } = parseBody(
      z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(8) }),
      req.body,
    );
    const user = (req as AuthedRequest).user;
    const row = get<{ password_hash: string }>(`SELECT password_hash FROM sys_user WHERE id = ?`, user.id);
    if (!row || !verifyPassword(oldPassword, row.password_hash)) throw unauthorized('原密码错误');
    run(`UPDATE sys_user SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`, hashPassword(newPassword), user.id);
    writeOpLog({ user_id: user.id, module: 'auth', action: 'update', target_table: 'sys_user', target_id: user.id });
    ok(res);
  }),
);
