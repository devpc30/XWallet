/**
 * Educational Benchmark Service.
 *
 * هر run:
 *   - یه target_count مشخص داره (حداکثر MAX_TARGET)
 *   - mnemonic random می‌سازه، آدرس derive می‌کنه، موجودی چک می‌کنه
 *   - mnemonic هرگز ذخیره نمی‌شه
 *   - اگه hit شد (ریاضیاً نخواهد شد)، فقط آدرس و موجودی ثبت می‌شه
 *   - در پایان یه گزارش آمار می‌ده
 *
 * هم‌زمان فقط یه run می‌تونه اجرا بشه.
 */

import { pool } from '../db/pool.js';
import { generateMnemonic, deriveMany, type Chain, type DerivedAddress } from '../wallet/derivation.js';
import { fetchBalancesByChain } from '../balance/cache.js';

// ═════════════ HARD LIMITS ═════════════
// این‌ها تو کد hardcoded هست و از env/پنل قابل تغییر نیست.
export const MAX_TARGET = 100_000;
export const BATCH_SIZE = 20;
export const BATCH_DELAY_MS = 500;
// ═══════════════════════════════════════

let currentRunId: number | null = null;
let stopRequested = false;

export function getCurrentRunId(): number | null {
  return currentRunId;
}

export async function requestStop(): Promise<void> {
  stopRequested = true;
}

export interface StartOptions {
  targetCount: number;
  wordCount: 12 | 24;
  addressesPerMnemonic: number;
  chains: Chain[];
  adminId: number;
}

export async function startBenchmark(opts: StartOptions): Promise<number> {
  if (currentRunId !== null) {
    throw new Error('یه benchmark در حال اجراست، اول صبر کن تموم بشه یا stopش کن');
  }

  // اعمال HARD LIMITS
  const target = Math.min(MAX_TARGET, Math.max(1, opts.targetCount));
  const wordCount = (opts.wordCount === 24 ? 24 : 12) as 12 | 24;
  const n = Math.max(1, Math.min(10, opts.addressesPerMnemonic));
  const chains = opts.chains.filter((c) => ['BTC', 'ETH', 'TRON'].includes(c));

  if (chains.length === 0) {
    throw new Error('حداقل یه chain انتخاب کن');
  }

  const res = await pool.query<{ id: number }>(
    `INSERT INTO benchmark_runs
     (word_count, addresses_per_mnemonic, target_count, chains, status, started_at, started_by)
     VALUES ($1, $2, $3, $4, 'running', NOW(), $5)
     RETURNING id`,
    [wordCount, n, target, chains, opts.adminId]
  );
  const runId = res.rows[0].id;
  currentRunId = runId;
  stopRequested = false;

  // run رو async start می‌کنیم
  runLoop(runId, target, wordCount, n, chains).catch(async (e) => {
    console.error('[benchmark] error:', e);
    await pool.query(
      `UPDATE benchmark_runs
       SET status = 'failed', error = $1, completed_at = NOW()
       WHERE id = $2`,
      [(e as Error).message, runId]
    );
  }).finally(() => {
    if (currentRunId === runId) currentRunId = null;
    stopRequested = false;
  });

  return runId;
}

async function runLoop(
  runId: number,
  target: number,
  wordCount: 12 | 24,
  n: number,
  chains: Chain[]
): Promise<void> {
  const startTime = Date.now();
  let checked = 0;
  let hits = 0;
  const hitsInfo: Array<{ chain: string; address: string; native: string; usdt: string }> = [];

  while (checked < target && !stopRequested) {
    const remaining = target - checked;
    const batchSize = Math.min(BATCH_SIZE, remaining);

    // بساز batch
    const batch: Array<{ addresses: DerivedAddress[] }> = [];
    for (let i = 0; i < batchSize; i++) {
      const mnemonic = generateMnemonic(wordCount);
      // mnemonic فقط تو این scope زنده‌ست، بعد از loop GC میشه
      const addresses = await deriveMany(
        mnemonic,
        chains.map((chain) => ({ chain, fromIndex: 0, count: n }))
      );
      batch.push({ addresses });
      // نکته: mnemonic رو جایی save نمی‌کنیم — قبل از این خط فراموش می‌شه
    }

    // چک موجودی
    const byChain: Record<Chain, string[]> = { BTC: [], ETH: [], TRON: [] };
    for (const item of batch) {
      for (const addr of item.addresses) byChain[addr.chain].push(addr.address);
    }

    const balances = await fetchBalancesByChain(byChain.BTC, byChain.ETH, byChain.TRON);

    // پردازش
    for (const item of batch) {
      for (const addr of item.addresses) {
        let native = 0n, usdt = 0n;
        if (addr.chain === 'BTC') {
          const b = balances.btc.get(addr.address);
          if (b) native = b.sats;
        } else if (addr.chain === 'ETH') {
          const b = balances.eth.get(addr.address);
          if (b) { native = b.eth; usdt = b.usdt; }
        } else if (addr.chain === 'TRON') {
          const b = balances.tron.get(addr.address);
          if (b) { native = b.trx; usdt = b.usdt; }
        }

        if (native > 0n || usdt > 0n) {
          hits++;
          // فقط آدرس و موجودی. mnemonic نگه نمی‌داریم.
          hitsInfo.push({
            chain: addr.chain,
            address: addr.address,
            native: native.toString(),
            usdt: usdt.toString(),
          });
        }
      }
    }

    checked += batchSize;

    // آپدیت progress
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = checked / Math.max(1, elapsed);

    await pool.query(
      `UPDATE benchmark_runs
       SET checked_count = $1,
           hit_count = $2,
           hits_info = $3::jsonb,
           avg_rate_per_sec = $4
       WHERE id = $5`,
      [checked, hits, JSON.stringify(hitsInfo), rate.toFixed(2), runId]
    );

    if (BATCH_DELAY_MS > 0 && checked < target && !stopRequested) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // پایان
  const duration = Date.now() - startTime;
  const finalStatus = stopRequested ? 'stopped' : 'completed';

  await pool.query(
    `UPDATE benchmark_runs
     SET status = $1, completed_at = NOW(), duration_ms = $2
     WHERE id = $3`,
    [finalStatus, duration, runId]
  );

  console.log(
    `[benchmark] run #${runId} ${finalStatus}: checked=${checked}, hits=${hits}, duration=${(duration/1000).toFixed(1)}s`
  );
}

/** اگه API restart بشه، run های ناتمام رو 'failed' علامت بزن */
export async function cleanupOnStartup(): Promise<void> {
  await pool.query(
    `UPDATE benchmark_runs
     SET status = 'failed',
         error = 'interrupted by server restart',
         completed_at = NOW()
     WHERE status IN ('pending', 'running')`
  );
}
