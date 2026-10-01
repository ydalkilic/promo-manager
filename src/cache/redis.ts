import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * Cache connection. `enableOfflineQueue: false` means commands reject
 * immediately when Redis is down rather than blocking on a reconnect, so callers
 * fall through to Postgres. The cache is never a correctness dependency.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});

let redisHealthy = true;

redis.on('error', (err) => {
  if (redisHealthy) {
    redisHealthy = false;
    logger.warn({ err: err.message }, 'redis unavailable — serving from Postgres');
  }
});

redis.on('ready', () => {
  if (!redisHealthy) logger.info('redis recovered');
  redisHealthy = true;
});

export function isRedisHealthy(): boolean {
  return redisHealthy;
}

/** BullMQ needs its own connection; its blocking commands differ. */
export function createQueueConnection(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit().catch(() => redis.disconnect());
}
