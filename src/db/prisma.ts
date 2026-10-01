/**
 * Prisma client singleton. Pool size lives in DATABASE_URL rather than in code,
 * because the API and the workers run the same code with very different
 * concurrency profiles.
 */

import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

// Reuse across hot reloads so `tsx watch` does not leak pools.
if (config.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.debug('prisma disconnected');
}
