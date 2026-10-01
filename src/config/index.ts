/** Typed configuration, validated at boot so misconfiguration fails fast. */

import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .string()
  .transform((v) => v === 'true' || v === '1')
  .pipe(z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  CACHE_ENABLED: booleanish.default('true'),
  CACHE_TTL_PRODUCT_SECONDS: z.coerce.number().int().positive().default(300),
  CACHE_TTL_LIST_SECONDS: z.coerce.number().int().positive().default(30),
  // CACHE_L1_TTL_MS is also the worst-case price staleness window: an L1 hit
  // does not consult Redis, so it cannot see an epoch bump.
  CACHE_L1_ENABLED: booleanish.default('true'),
  CACHE_L1_TTL_MS: z.coerce.number().int().nonnegative().default(1_000),
  CACHE_L1_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),

  // --- Availability guards (ADR-013) -------------------------------------
  // Caps (page-1)*limit. Sorting by effective price cannot use an index, so an
  // attacker-controlled OFFSET was worth ~380ms of database work per request.
  MAX_PAGINATION_OFFSET: z.coerce.number().int().positive().default(10_000),
  AT_MAX_SKEW_DAYS: z.coerce.number().int().positive().default(400),

  // Rate limits per client per minute, by route class.
  RATE_LIMIT_ENABLED: booleanish.default('true'),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_SIMULATION_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_INGESTION_PER_MIN: z.coerce.number().int().positive().default(5),
  /**
   * Express `trust proxy`, which decides what the rate limiter keys on. Unset
   * behind a load balancer every caller looks identical; set to "true",
   * X-Forwarded-For becomes spoofable. Use the proxy count, e.g. "1".
   */
  TRUST_PROXY: z.string().default('loopback'),

  // One trigger fans out to ~250 chunk jobs, so this bounds the fan-out.
  MAX_ACTIVE_INGESTION_JOBS: z.coerce.number().int().positive().default(3),

  // --- Scenario A tuning -------------------------------------------------
  // Rows per chunk, sized so one chunk finishes well inside the platform
  // timeout even on a cold start with a retry.
  INGESTION_CHUNK_ROWS: z.coerce.number().int().positive().default(2000),
  // Self-imposed budget per invocation; always below the platform timeout so
  // the process yields rather than being killed mid-transaction.
  INGESTION_INVOCATION_BUDGET_MS: z.coerce.number().int().positive().default(90_000),
  INGESTION_PLATFORM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  INGESTION_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  INGESTION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** Flat markup over vendor cost, in percent. The whole ingestion price rule. */
  INGESTION_MARKUP_PERCENT: z.coerce.number().nonnegative().default(30),
  BLOB_STORAGE_ROOT: z.string().default('./storage'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${detail}`);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;

// Fail at boot rather than letting chunks be killed mid-flight.
if (config.INGESTION_INVOCATION_BUDGET_MS >= config.INGESTION_PLATFORM_TIMEOUT_MS) {
  throw new Error(
    `INGESTION_INVOCATION_BUDGET_MS (${config.INGESTION_INVOCATION_BUDGET_MS}) must be ` +
      `below INGESTION_PLATFORM_TIMEOUT_MS (${config.INGESTION_PLATFORM_TIMEOUT_MS}); ` +
      'the budget exists so the function yields before the platform kills it.',
  );
}
