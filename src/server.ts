import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { disconnectPrisma } from './db/prisma.js';
import { disconnectRedis } from './cache/redis.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'ModaCo promotion API listening');
});

/** Drain in-flight requests before releasing pools, so deploys don't drop them. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');

  server.close(async () => {
    await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
