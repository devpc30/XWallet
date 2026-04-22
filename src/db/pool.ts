/**
 * PostgreSQL connection pool
 */

import { Pool, type PoolConfig } from 'pg';

const config: PoolConfig = {
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? 'wallet_service',
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? '',
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('[pg] idle client error', err);
});

// Graceful shutdown
export async function closePool(): Promise<void> {
  await pool.end();
}
