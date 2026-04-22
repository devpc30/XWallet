/**
 * Redis client برای caching عمومی.
 * BullMQ از connection factory جداگونه استفاده می‌کنه (src/queue/connection.ts)
 * چون نیازمندی‌های متفاوتی داره (maxRetriesPerRequest=null).
 */

import { Redis } from 'ioredis';

export const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB ?? 0),
  lazyConnect: false,
  enableOfflineQueue: true,
});

redis.on('error', (err) => {
  console.error('[redis]', err.message);
});

redis.on('connect', () => {
  console.log('[redis] connected');
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
