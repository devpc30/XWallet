/**
 * JWT signing/verification with DB-backed session revocation.
 *
 * هر توکن یه jti (UUID) داره که به row تو admin_sessions متصله.
 * verifyToken علاوه بر signature، چک می‌کنه session revoke نشده باشه.
 */

import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';

const EXPIRY_HOURS = 8;

function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET باید تنظیم شده و حداقل ۳۲ کاراکتر باشه');
  }
  return s;
}

export type AdminRole = 'super_admin' | 'admin';

export interface TokenPayload {
  sub: number;
  role: AdminRole;
  mustChangePassword: boolean;
  jti: string;
  iat?: number;
  exp?: number;
}

export interface SignContext {
  ip?: string | null;
  userAgent?: string | null;
}

export async function signToken(
  adminId: number,
  role: AdminRole,
  mustChangePassword: boolean,
  ctx: SignContext = {}
): Promise<{ token: string; expiresAt: Date; jti: string }> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000);

  await pool.query(
    `INSERT INTO admin_sessions (admin_id, jti, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminId, jti, ctx.ip ?? null, ctx.userAgent ?? null, expiresAt]
  );

  const payload = {
    sub: adminId,
    role,
    mustChangePassword,
    jti,
  };
  const token = jwt.sign(payload, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: `${EXPIRY_HOURS}h`,
  });

  return { token, expiresAt, jti };
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const payload = jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
  }) as unknown as TokenPayload;

  if (!payload.jti || typeof payload.sub !== 'number') {
    throw new Error('malformed token');
  }

  const res = await pool.query<{ revoked: boolean; expires_at: Date; admin_id: string }>(
    `SELECT s.revoked, s.expires_at, s.admin_id
     FROM admin_sessions s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.jti = $1 AND a.is_active = true`,
    [payload.jti]
  );

  if (res.rows.length === 0) throw new Error('session not found');
  const row = res.rows[0];
  if (row.revoked) throw new Error('session revoked');
  if (new Date(row.expires_at) < new Date()) throw new Error('session expired');

  return payload;
}

export async function revokeSession(jti: string): Promise<void> {
  await pool.query(
    `UPDATE admin_sessions SET revoked = true WHERE jti = $1`,
    [jti]
  );
}

export async function revokeAllSessionsForAdmin(adminId: number): Promise<void> {
  await pool.query(
    `UPDATE admin_sessions
     SET revoked = true
     WHERE admin_id = $1 AND revoked = false`,
    [adminId]
  );
}

export async function cleanupExpiredSessions(): Promise<number> {
  const res = await pool.query(
    `DELETE FROM admin_sessions
     WHERE expires_at < NOW() - INTERVAL '7 days'`
  );
  return res.rowCount ?? 0;
}
