/**
 * Fastify server
 *   - CORS (same-origin در production، permissive در dev)
 *   - Cookie parsing
 *   - Rate limiting
 *   - Static serving برای پنل
 *   - Route registration
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { authRoutes } from './routes/auth.js';
import { walletRoutes } from './routes/wallets.js';
import { jobRoutes } from './routes/jobs.js';
import { credentialRoutes } from './routes/credentials.js';
import { benchmarkRoutes } from './routes/benchmark.js';
import { cleanupOnStartup } from '../services/benchmark-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
    trustProxy: true,
  });

  // ─── Security headers ───
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdn.tailwindcss.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });

  // ─── Cookie ───
  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET ?? process.env.JWT_SECRET,
  });

  // ─── Rate limiting (global default) ───
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    allowList: (req) => req.url?.startsWith('/public/') ?? false,
  });

  // ─── Routes ───
  await app.register(authRoutes);
  await app.register(walletRoutes);
  await app.register(jobRoutes);
  await app.register(credentialRoutes);
  await app.register(benchmarkRoutes);

  // Health check
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  // ─── Static panel ───
  await app.register(staticPlugin, {
    root: join(__dirname, '../../public'),
    prefix: '/',
    decorateReply: false,
  });

  // SPA fallback — هر route ناشناخته بره به index.html
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/auth')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });

  return app;
}

// ─── Bootstrap ───
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  buildServer()
    .then(async (app) => {
      const addr = await app.listen({ port, host });
      console.log(`✔ پنل روی ${addr} بالا اومد`);
      // run های ناتمام قبل از restart رو به failed تغییر بده
      await cleanupOnStartup();
      return addr;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
