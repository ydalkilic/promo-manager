/**
 * Read-through cache with epoch validation and stampede protection.
 *
 * L1 is an in-process Map (hottest reads, no network hop; its TTL is the
 * staleness bound). L2 is Redis, shared across replicas. Every failure path
 * falls through to Postgres, so a Redis outage costs latency, not correctness.
 * See ADR-009.
 */

import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { redis } from './redis.js';
import { EPOCH_KEY, EPOCH_UNAVAILABLE, parseEpoch } from './epoch.js';

export type CacheOutcome = 'l1' | 'l2' | 'miss' | 'bypass';

export interface CacheResult<T> {
  value: T;
  outcome: CacheOutcome;
}

interface Envelope<T> {
  /** Epoch current when the data was read. */
  e: number;
  v: T;
}

interface L1Entry {
  epoch: number;
  payload: unknown;
  expiresAt: number;
}

const l1 = new Map<string, L1Entry>();

/**
 * In-flight loads, so concurrent misses on one key run the loader once.
 * Per-process, so the worst case is one query per replica, not per request.
 */
const inFlight = new Map<string, Promise<unknown>>();

function l1Get(key: string, now: number): L1Entry | undefined {
  const entry = l1.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    l1.delete(key);
    return undefined;
  }
  // Refresh recency for LRU eviction.
  l1.delete(key);
  l1.set(key, entry);
  return entry;
}

function l1Set(key: string, epoch: number, payload: unknown, now: number): void {
  if (!config.CACHE_L1_ENABLED || config.CACHE_L1_TTL_MS === 0) return;

  l1.set(key, { epoch, payload, expiresAt: now + config.CACHE_L1_TTL_MS });

  while (l1.size > config.CACHE_L1_MAX_ENTRIES) {
    const oldest = l1.keys().next();
    if (oldest.done) break;
    l1.delete(oldest.value);
  }
}

/** Drop the L1 tier. Used by tests and the promotion write path. */
export function clearL1(): void {
  l1.clear();
}

export function cacheStats(): { l1Size: number; inFlight: number } {
  return { l1Size: l1.size, inFlight: inFlight.size };
}

/**
 * Fetch `key` from cache, or run `loader` and populate it.
 *
 * Ordering is load-bearing: the epoch is read *before* the loader runs, and
 * that pre-read value is stamped on the entry. Reading it afterwards would mark
 * stale prices as fresh for a full TTL if a promotion committed mid-load.
 */
export async function getOrLoad<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  options: { useL1?: boolean } = {},
): Promise<CacheResult<T>> {
  if (!config.CACHE_ENABLED) {
    return { value: await loader(), outcome: 'bypass' };
  }

  const now = Date.now();
  const useL1 = options.useL1 ?? false;

  if (useL1) {
    const hit = l1Get(key, now);
    if (hit) return { value: hit.payload as T, outcome: 'l1' };
  }

  let epoch = EPOCH_UNAVAILABLE;
  let cached: string | null = null;

  try {
    // One round trip for both the epoch and the entry.
    const [epochRaw, entryRaw] = await redis.mget(EPOCH_KEY, key);
    epoch = parseEpoch(epochRaw ?? null);
    cached = entryRaw ?? null;
  } catch {
    // Redis unreachable — serve from Postgres, cache nothing.
    return { value: await loader(), outcome: 'bypass' };
  }

  if (cached !== null && epoch !== EPOCH_UNAVAILABLE) {
    try {
      const envelope = JSON.parse(cached) as Envelope<T>;
      if (envelope.e === epoch) {
        if (useL1) l1Set(key, epoch, envelope.v, now);
        return { value: envelope.v, outcome: 'l2' };
      }
    } catch {
      logger.warn({ key }, 'discarding unparseable cache entry');
    }
  }

  const existing = inFlight.get(key);
  if (existing) return { value: (await existing) as T, outcome: 'miss' };

  const load = (async () => {
    const value = await loader();

    if (epoch !== EPOCH_UNAVAILABLE) {
      const envelope: Envelope<T> = { e: epoch, v: value };
      // Fire-and-forget: a failed write costs a miss, not correctness.
      redis
        .set(key, JSON.stringify(envelope), 'EX', ttlSeconds)
        .catch((err) => logger.debug({ err: err.message, key }, 'cache write failed'));
      if (useL1) l1Set(key, epoch, value, Date.now());
    }

    return value;
  })();

  inFlight.set(key, load);

  try {
    return { value: (await load) as T, outcome: 'miss' };
  } finally {
    inFlight.delete(key);
  }
}

/** Stable cache key from a prefix and an ordered set of discriminators. */
export function cacheKey(prefix: string, parts: Record<string, string | number | undefined>): string {
  const encoded = Object.keys(parts)
    .sort()
    .filter((k) => parts[k] !== undefined && parts[k] !== '')
    .map((k) => `${k}=${parts[k]}`)
    .join('&');

  return `modaco:cache:${prefix}:${encoded || 'default'}`;
}
