/**
 * Balance check worker:
 *   از صف balance-check کار می‌گیره (با priority مختلف)،
 *   آدرس‌های stale رو از DB میاره، batch می‌کنه، بهینه‌ترین API رو صدا می‌زنه،
 *   نتیجه رو bulk update می‌کنه + cache می‌کنه.
 */

import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { BalanceCheckJobData } from '../queues.js';
import { pool } from '../../db/pool.js';
import { fetchBalancesByChain, setCached } from '../../balance/cache.js';

// Stale threshold (دقیقه) بر اساس priority
const STALE_MINUTES = {
  active: 2,
  normal: 15,
  inactive: 120,
} as const;

const PRIORITY_NUMBER = {
  active: 2,
  normal: 1,
  inactive: 0,
} as const;

interface AddressRow {
  id: number;
  chain: 'BTC' | 'ETH' | 'TRON';
  address: string;
  native_balance: string;
  usdt_balance: string;
}

export function startBalanceWorker() {
  const worker = new Worker<BalanceCheckJobData>(
    QUEUE_NAMES.BALANCE_CHECK,
    async (job) => {
      const { priority, batchSize = 200 } = job.data;
      const priorityNum = PRIORITY_NUMBER[priority];
      const staleMin = STALE_MINUTES[priority];

      // آدرس‌های stale رو بگیر
      const res = await pool.query<AddressRow>(
        `SELECT id, chain, address,
                native_balance::text, usdt_balance::text
         FROM addresses
         WHERE priority = $1
           AND status = 'active'
           AND (last_checked_at IS NULL OR last_checked_at < NOW() - ($2 || ' minutes')::interval)
         ORDER BY last_checked_at NULLS FIRST
         LIMIT $3`,
        [priorityNum, staleMin.toString(), batchSize]
      );

      if (res.rows.length === 0) {
        return { checked: 0, priority };
      }

      // گروه‌بندی بر اساس chain
      const byChain = {
        BTC: [] as AddressRow[],
        ETH: [] as AddressRow[],
        TRON: [] as AddressRow[],
      };
      for (const row of res.rows) byChain[row.chain].push(row);

      // Fetch موازی از هر سه API
      const fetched = await fetchBalancesByChain(
        byChain.BTC.map((r) => r.address),
        byChain.ETH.map((r) => r.address),
        byChain.TRON.map((r) => r.address)
      );

      // Build update arrays
      const ids: number[] = [];
      const natives: string[] = [];
      const usdts: string[] = [];
      const changes: Array<{ id: number; changed: boolean }> = [];

      for (const row of byChain.BTC) {
        const b = fetched.btc.get(row.address);
        if (!b) continue;
        const newNative = b.sats.toString();
        ids.push(row.id);
        natives.push(newNative);
        usdts.push('0');
        changes.push({ id: row.id, changed: newNative !== row.native_balance });

        await setCached(
          'BTC',
          row.address,
          { native: newNative, usdt: '0', checkedAt: Date.now() },
          priorityNum as 0 | 1 | 2
        );
      }

      for (const row of byChain.ETH) {
        const b = fetched.eth.get(row.address);
        if (!b) continue;
        const newNative = b.eth.toString();
        const newUsdt = b.usdt.toString();
        ids.push(row.id);
        natives.push(newNative);
        usdts.push(newUsdt);
        changes.push({
          id: row.id,
          changed: newNative !== row.native_balance || newUsdt !== row.usdt_balance,
        });

        await setCached(
          'ETH',
          row.address,
          { native: newNative, usdt: newUsdt, checkedAt: Date.now() },
          priorityNum as 0 | 1 | 2
        );
      }

      for (const row of byChain.TRON) {
        const b = fetched.tron.get(row.address);
        if (!b) continue;
        const newNative = b.trx.toString();
        const newUsdt = b.usdt.toString();
        ids.push(row.id);
        natives.push(newNative);
        usdts.push(newUsdt);
        changes.push({
          id: row.id,
          changed: newNative !== row.native_balance || newUsdt !== row.usdt_balance,
        });

        await setCached(
          'TRON',
          row.address,
          { native: newNative, usdt: newUsdt, checkedAt: Date.now() },
          priorityNum as 0 | 1 | 2
        );
      }

      if (ids.length === 0) return { checked: 0, priority };

      // Bulk update با UNNEST
      await pool.query(
        `UPDATE addresses a
         SET native_balance = v.native,
             usdt_balance = v.usdt,
             last_checked_at = NOW(),
             last_balance_change_at = CASE
               WHEN v.changed THEN NOW()
               ELSE a.last_balance_change_at
             END,
             priority = CASE
               -- اگه balance تغییر کرد یا نصفر شد: priority بره بالا
               WHEN v.changed OR v.native::numeric > 0 OR v.usdt::numeric > 0 THEN 2
               -- اگه خالی و >30 روز بدون تغییر: inactive
               WHEN v.native::numeric = 0 AND v.usdt::numeric = 0
                    AND a.last_balance_change_at IS NOT NULL
                    AND a.last_balance_change_at < NOW() - INTERVAL '30 days' THEN 0
               ELSE a.priority
             END
         FROM UNNEST($1::bigint[], $2::numeric[], $3::numeric[], $4::boolean[])
              AS v(id, native, usdt, changed)
         WHERE a.id = v.id`,
        [ids, natives, usdts, changes.map((c) => c.changed)]
      );

      const changed = changes.filter((c) => c.changed).length;
      return { checked: ids.length, changed, priority };
    },
    {
      connection: createQueueConnection(),
      concurrency: Number(process.env.BALANCE_CONCURRENCY ?? 3),
    }
  );

  worker.on('completed', (job) => {
    const r = job.returnvalue as any;
    console.log(`[bal] ${r.priority}: checked=${r.checked} changed=${r.changed ?? 0}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[bal] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
