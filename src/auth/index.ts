/**
 * Authentication utilities
 *   - hashPassword / verifyPassword (bcrypt cost 12)
 *   - signToken / verifyToken (JWT با HS256)
 *   - authGuard middleware برای Fastify
 */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';

const BCRYPT_COST = 12;

// JWT secret از env (base64 از ۳۲ بایت رندوم)
// تولید:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET باید تنظیم شده و حداقل ۳۲ کاراکتر باشه');
  }
  return s;
}

// ─── Password ───
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 4) throw new Error('رمز نمی‌تونه خیلی کوتاه باشه');
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ─── JWT ───
export interface TokenPayload {
  adminId: number;
  username: string;
  role: string;
  mustChangePassword: boolean;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: '8h',
  });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as TokenPayload;
}

// ─── Fastify middleware ───

// Session token از cookie می‌خونیم (httpOnly) — امن‌تر از localStorage
const COOKIE_NAME = 'admin_session';

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 60 * 60 * 8, // 8 hours
};

export function setAuthCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, cookieOptions);
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: TokenPayload;
  }
}

/**
 * middleware: احراز هویت. اگه token نداشت یا invalid بود 401 می‌ده.
 * اگه must_change_password=true و route !== /auth/change-password → 403.
 */
export async function authGuard(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const token = request.cookies[COOKIE_NAME];

  if (!token) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }

  try {
    const payload = verifyToken(token);
    request.admin = payload;

    // اگه باید رمز عوض کنه، فقط اجازه‌ی change-password و logout داریم
    const allowedWithMustChange = ['/auth/change-password', '/auth/logout', '/auth/me'];
    if (
      payload.mustChangePassword &&
      !allowedWithMustChange.includes(request.routeOptions.url ?? '')
    ) {
      return reply.code(403).send({
        error: 'must_change_password',
        message: 'باید اول رمز پیش‌فرض رو عوض کنی',
      });
    }
  } catch {
    return reply.code(401).send({ error: 'invalid_token' });
  }
}
