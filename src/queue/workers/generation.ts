/**
 * Generation worker:
 *   از صف wallet-generation کار می‌گیره، N تا ولت می‌سازه،
 *   progress رو تو job و DB update می‌کنه.
 */

import { Worker } from 'bullmq';
import { createQueueConnection, QUEUE_NAMES } from '../connection.js';
import type { GenerationJobData } from '../queues.js';
import { createWallet } from '../../services/wallet-service.js';
import { pool } from '../../db/pool.js';

export function startGenerationWorker() {
  const worker = new Worker<GenerationJobData>(
    QUEUE_NAMES.GENERATION,
    async (job) => {
      const { jobDbId, startUserId, count, wordCount, addressesPerWallet } = job.data;

      // علامت شروع
      await pool.query(
        `UPDATE generation_jobs
         SET status = 'running', started_at = NOW()
         WHERE id = $1`,
        [jobDbId]
      );

      let completed = 0;
      let failed = 0;
      const errors: string[] = [];

      // خروج هم‌زمان مناسب: در هر loop چک کنیم که job cancel نشده
      for (let i = 0; i < count; i++) {
        const userId = startUserId + i;

        try {
          await createWallet({ userId, wordCount, initialAddressCount: addressesPerWallet });
          completed++;
        } catch (e) {
          failed++;
          const msg = (e as Error).message;
          if (errors.length < 10) errors.push(`user_id=${userId}: ${msg}`);
        }

        // Update progress هر ۱۰ ولت یا آخر
        if ((i + 1) % 10 === 0 || i === count - 1) {
          await job.updateProgress({ completed, failed, total: count });
          await pool.query(
            `UPDATE generation_jobs SET completed = $1 WHERE id = $2`,
            [completed, jobDbId]
          );
        }
      }

      // علامت پایان
      await pool.query(
        `UPDATE generation_jobs
         SET status = $1,
             completed = $2,
             completed_at = NOW(),
             error = $3
         WHERE id = $4`,
        [
          failed === count ? 'failed' : failed > 0 ? 'partial' : 'completed',
          completed,
          errors.length > 0 ? errors.join('\n') : null,
          jobDbId,
        ]
      );

      return { completed, failed, total: count };
    },
    {
      connection: createQueueConnection(),
      concurrency: Number(process.env.GEN_CONCURRENCY ?? 2),
    }
  );

  worker.on('completed', (job) => {
    console.log(`[gen] job ${job.id} completed:`, job.returnvalue);
  });

  worker.on('failed', (job, err) => {
    console.error(`[gen] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
