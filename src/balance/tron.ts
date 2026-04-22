/**
 * TRON + USDT-TRC20 balance checker.
 *
 * از credentials-service استفاده می‌کنه:
 *   - اگه هیچ کلیدی تو DB نباشه، fallback به free tier (بدون header)
 *   - اگه یکی بیشتر باشه، round-robin می‌کنه
 *   - روی 429 اون کلید رو برای ۶۰ ثانیه skip می‌کنه
 */

import {
  pickCredential,
  markSuccess,
  markRateLimited,
  markError,
} from '../services/credentials-service.js';

const TRON_API = process.env.TRON_API ?? 'https://api.trongrid.io';
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export interface TronBalanceResult {
  address: string;
  trx: bigint;   // sun
  usdt: bigint;  // smallest
}

export async function getTronBalance(address: string): Promise<TronBalanceResult> {
  const cred = await pickCredential('trongrid');
  const headers: Record<string, string> = {};
  if (cred) headers['TRON-PRO-API-KEY'] = cred.value;

  const res = await fetch(`${TRON_API}/v1/accounts/${address}`, { headers });

  if (res.status === 429) {
    if (cred) await markRateLimited(cred.id, 60);
    throw new Error('trongrid rate limited');
  }

  if (!res.ok) {
    if (cred) await markError(cred.id, `HTTP ${res.status}`);
    throw new Error(`trongrid ${res.status} for ${address}`);
  }

  if (cred) await markSuccess(cred.id);

  const d = (await res.json()) as {
    data: Array<{
      balance?: number;
      trc20?: Array<Record<string, string>>;
    }>;
  };

  if (!d.data || d.data.length === 0) {
    return { address, trx: 0n, usdt: 0n };
  }

  const acc = d.data[0];
  const trx = BigInt(acc.balance ?? 0);

  let usdt = 0n;
  for (const entry of acc.trc20 ?? []) {
    if (USDT_TRC20 in entry) {
      usdt = BigInt(entry[USDT_TRC20]);
      break;
    }
  }

  return { address, trx, usdt };
}

export async function batchTronBalances(
  addresses: string[],
  concurrency = 8
): Promise<TronBalanceResult[]> {
  const results: TronBalanceResult[] = [];

  for (let i = 0; i < addresses.length; i += concurrency) {
    const chunk = addresses.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(chunk.map(getTronBalance));

    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        console.error(`[tron] ${chunk[j]}: ${r.reason}`);
        results.push({ address: chunk[j], trx: 0n, usdt: 0n });
      }
    }

    if (i + concurrency < addresses.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return results;
}
