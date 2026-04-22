/**
 * Worker process entry point.
 *
 * اجرا با:
 *   npm run worker
 *
 * این پروسه جدا از API server اجرا می‌شه تا load jobs بر API تأثیر نذاره.
 */

import 'dotenv/config';
import { startGenerationWorker } from './queue/workers/generation.js';
import { startBalanceWorker } from './queue/workers/balance.js';
import { scheduleRecurringBalanceChecks } from './queue/queues.js';

async function main() {
  console.log('▶  starting workers...');

  const genWorker = startGenerationWorker();
  const balWorker = startBalanceWorker();

  // تنظیم scheduled jobs (idempotent — اگه قبلاً ست شده باشن، override می‌شن)
  await scheduleRecurringBalanceChecks();
  console.log('✔  scheduled: active=2min, normal=15min, inactive=2hr');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down workers...`);
    await Promise.all([genWorker.close(), balWorker.close()]);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('✔  workers running. Ctrl+C برای توقف.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
