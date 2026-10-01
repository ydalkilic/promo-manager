/**
 * Promotion epoch — the invalidation mechanism behind Scenario B.
 *
 * Every cache entry is stamped with the epoch current when its data was read;
 * a mismatch is treated as a miss. Creating a promotion increments the epoch,
 * so one Redis INCR invalidates every derived entry regardless of how many
 * products the promotion affects. Stale entries are never deleted — they stop
 * matching and expire on their TTL.
 *
 * The epoch is global, so a single-product promotion invalidates the whole
 * catalogue's entries. See ADR-008 for why that trade is accepted.
 */

import { redis } from './redis.js';
import { logger } from '../logger.js';

export const EPOCH_KEY = 'modaco:promo:epoch';

/** Used when Redis is unreachable; never equals a real epoch, so reads fail closed. */
export const EPOCH_UNAVAILABLE = -1;

export function parseEpoch(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : EPOCH_UNAVAILABLE;
}

export async function readEpoch(): Promise<number> {
  try {
    return parseEpoch(await redis.get(EPOCH_KEY));
  } catch {
    return EPOCH_UNAVAILABLE;
  }
}

/**
 * Invalidate every promotion-derived cache entry.
 *
 * Must be called *after* the write commits: bumping first lets a reader
 * repopulate from pre-commit state and stamp it as current.
 */
export async function bumpEpoch(reason: string): Promise<number> {
  try {
    const next = await redis.incr(EPOCH_KEY);
    logger.info({ epoch: next, reason }, 'promotion epoch bumped — caches invalidated');
    return next;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, reason },
      'failed to bump promotion epoch — cached prices may be stale until TTL expiry',
    );
    return EPOCH_UNAVAILABLE;
  }
}
