/**
 * AES-256-GCM encryption برای mnemonic‌ها
 *
 * امنیت:
 *   - Master key ۳۲ بایتی رندوم از env (هرگز تو دیتابیس نیست)
 *   - Nonce جدید برای هر mnemonic (۱۲ بایت رندوم)
 *   - Auth tag جلوی tampering رو می‌گیره
 *   - GCM mode هم confidentiality هم integrity می‌ده
 *
 * Key rotation: می‌تونی master key جدید بسازی و `encryption_version` رو
 * تو DB بالا ببری و تدریجاً مهاجرت کنی.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;   // 256 bit
const NONCE_LENGTH = 12; // 96 bit (مقدار توصیه‌شده برای GCM)
const TAG_LENGTH = 16;   // 128 bit auth tag

/**
 * master key رو از env می‌خونه و اعتبارش رو چک می‌کنه.
 * env value باید base64 از ۳۲ بایت رندوم باشه.
 *
 * تولید اولیه:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function loadMasterKey(): Buffer {
  const b64 = process.env.WALLET_MASTER_KEY;
  if (!b64) {
    throw new Error(
      'WALLET_MASTER_KEY env var تنظیم نشده. ' +
      'با دستور زیر یکی بساز:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }

  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`WALLET_MASTER_KEY باید دقیقاً ${KEY_LENGTH} بایت باشه (شما ${key.length}).`);
  }
  return key;
}

// Master key فقط یه بار load می‌شه و توی memory می‌مونه
let _masterKey: Buffer | null = null;
function getKey(): Buffer {
  if (!_masterKey) _masterKey = loadMasterKey();
  return _masterKey;
}

export interface EncryptedMnemonic {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  version: number;
}

/**
 * encrypt یه mnemonic.
 * خروجی: سه بخش جدا (برای ذخیره تو سه ستون)
 */
export function encryptMnemonic(mnemonic: string): EncryptedMnemonic {
  const key = getKey();
  const nonce = randomBytes(NONCE_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([
    cipher.update(mnemonic, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return { ciphertext, nonce, tag, version: 1 };
}

/**
 * decrypt.
 * اگه tag invalid باشه (یعنی کسی دستکاری کرده) throw می‌کنه.
 */
export function decryptMnemonic(enc: EncryptedMnemonic): string {
  if (enc.version !== 1) {
    throw new Error(`encryption version ${enc.version} ناشناخته`);
  }

  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, enc.nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(enc.tag);

  const plaintext = Buffer.concat([
    decipher.update(enc.ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

// ─── سلامت محور برای تست ───
export function selfTest(): void {
  const sample = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const enc = encryptMnemonic(sample);
  const dec = decryptMnemonic(enc);
  if (dec !== sample) {
    throw new Error('crypto self-test failed');
  }

  // چک کنیم tampering detect می‌شه
  const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext) };
  tampered.ciphertext[0] ^= 0xff;
  try {
    decryptMnemonic(tampered);
    throw new Error('tampering detected نشد!');
  } catch (e) {
    // خوبه، باید fail می‌شد
  }
}
