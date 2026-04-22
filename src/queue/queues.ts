/**
 * BullMQ queue definitions.
 *
 * دو صف اصلی:
 *   - wallet-generation: batch تولید ولت
 *   - balance-check: چک موجودی (repeatable)
 */

import { Queue } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from './connection.js';

// ─── Typed job data ───
export interface GenerationJobData {
  jobDbId: number;                  // id تو generation_jobs table
  startUserId: number;
  count: number;
  wordCount: 12 | 24;
  addressesPerWallet: number;
}

export interface BalanceCheckJobData {
  priority: 'active' | 'normal' | 'inactive';
  batchSize?: number;
}

// ─── Queue instances ───
// یه connection share می‌کنیم بین queue‌ها (producer side)
const producerConnection = createQueueConnection();

export const generationQueue = new Queue<GenerationJobData>(QUEUE_NAMES.GENERATION, {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 7 * 24 * 3600 },
    removeOnFail: { count: 500, age: 30 * 24 * 3600 },
  },
});

export const balanceQueue = new Queue<BalanceCheckJobData>(QUEUE_NAMES.BALANCE_CHECK, {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

/**
 * repeatable jobs برای balance check با سه priority مختلف.
 * در startup worker صدا می‌خوریم.
 */
export async function scheduleRecurringBalanceChecks(): Promise<void> {
  // active: هر ۲ دقیقه
  await balanceQueue.add(
    'check-active',
    { priority: 'active' },
    {
      repeat: { every: 2 * 60 * 1000 },
      jobId: 'recurring:active', // جلوگیری از duplicate
    }
  );

  // normal: هر ۱۵ دقیقه
  await balanceQueue.add(
    'check-normal',
    { priority: 'normal' },
    {
      repeat: { every: 15 * 60 * 1000 },
      jobId: 'recurring:normal',
    }
  );

  // inactive: هر ۲ ساعت
  await balanceQueue.add(
    'check-inactive',
    { priority: 'inactive' },
    {
      repeat: { every: 2 * 60 * 60 * 1000 },
      jobId: 'recurring:inactive',
    }
  );
}
