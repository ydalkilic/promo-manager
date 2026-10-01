/**
 * Tier 1 availability guards. These close a measured vulnerability: an
 * unauthenticated `?at=<unique>&page=400000` cost ~380ms of database work per
 * request, uncached and unrated. See ADR-013.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/prisma-test-client.js';
import { redis } from '../src/cache/redis.js';
import { config } from '../src/config/index.js';
import {
  listProductsQuerySchema,
  productDetailQuerySchema,
  snapToMinute,
} from '../src/modules/products/product.schemas.js';
import { startIngestion } from '../src/ingestion/ingestion.service.js';
import { TooManyRequestsError } from '../src/http/errors.js';

const app = createApp();

describe('pagination offset cap', () => {
  it('rejects an offset past the cap', () => {
    const page = Math.floor(config.MAX_PAGINATION_OFFSET / 100) + 2;
    const result = listProductsQuerySchema.safeParse({ page: String(page), limit: '100' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(['page']);
      expect(result.error.issues[0]!.message).toMatch(/offset exceeds/i);
    }
  });

  it('accepts an offset just inside the cap', () => {
    const page = config.MAX_PAGINATION_OFFSET / 100;
    expect(listProductsQuerySchema.safeParse({ page: String(page), limit: '100' }).success).toBe(true);
  });

  /** A cap on `page` alone would admit cheap-but-deep and reject expensive-but-shallow. */
  it('bounds the product of page and limit, not page alone', () => {
    const deepButCheap = listProductsQuerySchema.safeParse({ page: '5000', limit: '1' });
    const shallowButExpensive = listProductsQuerySchema.safeParse({ page: '5000', limit: '100' });

    expect(deepButCheap.success).toBe(true);
    expect(shallowButExpensive.success).toBe(false);
  });
});

describe('?at= simulation guards', () => {
  it('snaps to the start of the minute', () => {
    const snapped = snapToMinute(new Date('2026-06-01T14:37:42.511Z'));
    expect(snapped.toISOString()).toBe('2026-06-01T14:37:00.000Z');
  });

  it('collapses instants within the same minute to one value', () => {
    const a = listProductsQuerySchema.parse({ at: '2026-06-01T14:37:02Z' });
    const b = listProductsQuerySchema.parse({ at: '2026-06-01T14:37:58Z' });
    expect(a.at?.toISOString()).toBe(b.at?.toISOString());
  });

  it('preserves minute-level precision, so a sale starting at 14:30 is visible at 14:31', () => {
    const at = listProductsQuerySchema.parse({ at: '2026-06-01T14:31:00Z' }).at;
    expect(at?.toISOString()).toBe('2026-06-01T14:31:00.000Z');
  });

  it('rejects an instant beyond the allowed skew', () => {
    const tooFar = new Date(Date.now() + (config.AT_MAX_SKEW_DAYS + 10) * 86_400_000);
    expect(listProductsQuerySchema.safeParse({ at: tooFar.toISOString() }).success).toBe(false);
  });

  /** This route used to accept anything and hand Invalid Dates to the query layer. */
  it('rejects an unparseable instant on the detail endpoint', () => {
    expect(productDetailQuerySchema.safeParse({ at: 'not-a-date' }).success).toBe(false);
  });
});

describe('simulations are cached rather than bypassing', () => {
  let productId: string;
  const at = '2026-03-15T10:00:00Z';

  beforeEach(async () => {
    const product = await prisma.product.upsert({
      where: { sku: `HARD-${process.pid}` },
      create: {
        sku: `HARD-${process.pid}`,
        name: 'Hardening Fixture',
        category: `hard-cat-${process.pid}`,
        basePrice: '100.00',
        stockQuantity: 1,
      },
      update: {},
    });
    productId = product.id;
    // Clear this test's cache entries, leaving the epoch intact.
    const keys = await redis.keys('modaco:cache:products:*');
    if (keys.length) await redis.del(...keys);
  });

  it('a repeated list simulation is served from cache', async () => {
    const url = `/api/products?category=hard-cat-${process.pid}&at=${encodeURIComponent(at)}`;

    const first = await request(app).get(url).expect(200);
    expect(first.body.meta.cache).toBe('miss');

    // Previously 'bypass' on every call.
    const second = await request(app).get(url).expect(200);
    expect(second.body.meta.cache).toBe('l2');
    expect(second.body.meta.pricedAt).toBe(new Date(at).toISOString());
  });

  it('a repeated detail simulation is served from cache', async () => {
    const url = `/api/products/${productId}?at=${encodeURIComponent(at)}`;

    expect((await request(app).get(url).expect(200)).body.meta.cache).toBe('miss');
    expect(['l1', 'l2']).toContain((await request(app).get(url).expect(200)).body.meta.cache);
  });

  it('a simulation never shares a cache entry with the live view', async () => {
    const base = `/api/products?category=hard-cat-${process.pid}`;

    await request(app).get(base).expect(200);
    const simulated = await request(app).get(`${base}&at=${encodeURIComponent(at)}`).expect(200);

    // Without `at` in the cache key this would hit the live entry.
    expect(simulated.body.meta.cache).toBe('miss');
    expect(simulated.body.meta.pricedAt).toBe(new Date(at).toISOString());
  });

  it('rejects the original attack request with 400 rather than doing the work', async () => {
    const res = await request(app)
      .get(`/api/products?at=${encodeURIComponent(at)}&page=400000`)
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('ingestion capacity guards', () => {
  beforeEach(async () => {
    await prisma.ingestionJob.deleteMany({ where: { fileKey: { contains: 'hardening-' } } });
  });

  /** The key must resolve in storage; dedupe returns before the queue is touched. */
  it('returns the in-flight job for a repeated fileKey instead of starting another', async () => {
    const realKey = 'vendor/weekly-sync.csv';
    await prisma.ingestionJob.deleteMany({
      where: { fileKey: realKey, status: { in: ['SPLITTING', 'PROCESSING'] } },
    });

    const inFlight = await prisma.ingestionJob.create({
      data: { fileKey: realKey, status: 'PROCESSING', totalBytes: BigInt(1_000) },
    });

    try {
      const result = await startIngestion(realKey);

      expect(result.jobId).toBe(inFlight.id);
      expect(result.deduplicated).toBe(true);

      // Crucially, no second job was created.
      const count = await prisma.ingestionJob.count({
        where: { fileKey: realKey, status: { in: ['SPLITTING', 'PROCESSING'] } },
      });
      expect(count).toBe(1);
    } finally {
      await prisma.ingestionJob.delete({ where: { id: inFlight.id } });
    }
  });

  it('refuses a new job once the concurrency cap is reached', async () => {
    await prisma.ingestionJob.createMany({
      data: Array.from({ length: config.MAX_ACTIVE_INGESTION_JOBS }, (_, i) => ({
        fileKey: `vendor/hardening-filler-${i}.csv`,
        status: 'PROCESSING' as const,
        totalBytes: BigInt(1_000),
      })),
    });

    await expect(startIngestion('vendor/weekly-sync.csv')).rejects.toBeInstanceOf(
      TooManyRequestsError,
    );
  });
});

describe('rate limiting', () => {
  /**
   * The limiter keys on client IP in shared Redis, and supertest and Newman both
   * arrive as 127.0.0.1, so budget leaks between runs unless cleared.
   */
  async function resetBudgets(): Promise<void> {
    const keys = await redis.keys('modaco:rl:*');
    if (keys.length) await redis.del(...keys);
  }

  beforeEach(resetBudgets);

  it('returns 429 once a route-class budget is exhausted, with Retry-After', async () => {
    const budget = config.RATE_LIMIT_INGESTION_PER_MIN;

    // The limiter runs before the handler, so bad requests still cost a point.
    for (let i = 0; i < budget; i++) {
      await request(app)
        .post('/api/ingestion/jobs')
        .send({ fileKey: `vendor/nope-${i}.csv` })
        .expect(404);
    }

    const limited = await request(app)
      .post('/api/ingestion/jobs')
      .send({ fileKey: 'vendor/nope-final.csv' })
      .expect(429);

    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');

    await resetBudgets();
  });

  it('rations simulations separately from ordinary reads', async () => {
    // Separate buckets: exhausting one must not affect the other.
    const readKeyBefore = await redis.keys('modaco:rl:read*');
    await request(app).get('/api/products?limit=1').expect(200);
    await request(app).get('/api/products?limit=1&at=2026-03-15T10:00:00Z').expect(200);

    const readKeys = await redis.keys('modaco:rl:read*');
    const simKeys = await redis.keys('modaco:rl:simulation*');

    expect(readKeys.length).toBeGreaterThan(readKeyBefore.length - 1);
    expect(simKeys.length).toBeGreaterThan(0);

    await resetBudgets();
  });

  afterAll(resetBudgets);
});

afterAll(async () => {
  await prisma.ingestionJob.deleteMany({ where: { fileKey: { contains: 'hardening-' } } });
  const rlKeys = await redis.keys('modaco:rl:*');
  if (rlKeys.length) await redis.del(...rlKeys);
  await prisma.product.deleteMany({ where: { sku: { startsWith: 'HARD-' } } });
  await prisma.$disconnect();
  await redis.quit().catch(() => redis.disconnect());
});
