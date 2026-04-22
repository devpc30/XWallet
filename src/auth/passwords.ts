/**
 * Password hashing + strength validation.
 */

import bcrypt from 'bcrypt';

const BCRYPT_COST = 12;
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

const COMMON_PASSWORDS = [
  'password', '12345678', '123456789', 'qwerty', 'abc123', 'admin',
  'letmein', '111111', 'iloveyou', 'welcome', 'monkey', 'dragon',
  '1590320', 'passw0rd',
];

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function validatePasswordStrength(password: string): { ok: boolean; reason?: string } {
  if (typeof password !== 'string') {
    return { ok: false, reason: 'رمز نامعتبره' };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, reason: `رمز حداقل ${MIN_LENGTH} کاراکتر باشه` };
  }
  if (password.length > MAX_LENGTH) {
    return { ok: false, reason: `رمز حداکثر ${MAX_LENGTH} کاراکتر باشه` };
  }
  if (!/[A-Za-z]/.test(password)) {
    return { ok: false, reason: 'رمز باید حداقل یه حرف داشته باشه' };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, reason: 'رمز باید حداقل یه عدد داشته باشه' };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, reason: 'رمز نمی‌تونه فقط یه کاراکتر تکراری باشه' };
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.some((c) => lower.includes(c))) {
    return { ok: false, reason: 'رمز خیلی ضعیف یا رایجه' };
  }
  return { ok: true };
}
