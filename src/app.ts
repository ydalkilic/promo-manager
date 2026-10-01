import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { logger } from './logger.js';
import { config } from './config/index.js';
import { errorHandler, notFoundHandler } from './http/middleware.js';
import { productRoutes } from './modules/products/product.routes.js';
import { promotionRoutes } from './modules/promotions/promotion.routes.js';
import { ingestionRoutes } from './ingestion/ingestion.routes.js';
import { cacheStats } from './cache/index.js';
import { isRedisHealthy } from './cache/redis.js';
import { prisma } from './db/prisma.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // Decides what `req.ip` is, and so what the rate limiter keys on. Conservative
  // by default; see TRUST_PROXY in config.
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      // Logging every 2xx at info would cost more than serving the request.
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug',
    }),
  );

  app.get('/health', async (_req, res) => {
    let database = 'down';
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      /* reported as down */
    }

    const healthy = database === 'up';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      // Redis down is not unhealthy: the API serves correctly without it.
      dependencies: { database, redis: isRedisHealthy() ? 'up' : 'down' },
      cache: cacheStats(),
      env: config.NODE_ENV,
    });
  });

  app.use('/api/products', productRoutes);
  app.use('/api/promotions', promotionRoutes);
  app.use('/api/ingestion', ingestionRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
