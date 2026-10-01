import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma-test-client.js';
import { CATEGORY, createProduct, future, past, resetFixtures } from './helpers.js';
import { assignPromotion, cancelPromotion, createPromotion } from '../src/modules/promotions/promotion.service.js';
import { createPromotionSchema } from '../src/modules/promotions/promotion.schemas.js';
import { findProductById, listProducts } from '../src/modules/products/product.repository.js';
import { PromotionConflictError } from '../src/http/errors.js';
import { resolvePromotion, type ActivePromotion } from '../src/domain/promotion-resolution.js';

beforeEach(resetFixtures);

describe('promotion precedence', () => {
  it('a PRODUCT-scope promotion outranks a CATEGORY-scope one', () => {
    const product = { id: 'p1', category: 'accessories', basePrice: 10_000 };
    const promos: ActivePromotion[] = [
      { id: 'cat', name: 'cat', discountType: 'PERCENTAGE', valueCents: 5_000, scope: 'CATEGORY', productId: null, category: 'accessories', startsAt: past(), endsAt: future() },
      { id: 'prod', name: 'prod', discountType: 'FIXED_AMOUNT', valueCents: 1_000, scope: 'PRODUCT', productId: 'p1', category: null, startsAt: past(), endsAt: future() },
    ];

    expect(resolvePromotion(product, promos)?.id).toBe('prod');
    // Candidate order must not change the winner.
    expect(resolvePromotion(product, [...promos].reverse())?.id).toBe('prod');
  });

  it('ignores promotions outside their window', () => {
    const product = { id: 'p1', category: 'accessories', basePrice: 10_000 };
    const expired: ActivePromotion[] = [
      { id: 'old', name: 'old', discountType: 'PERCENTAGE', valueCents: 5_000, scope: 'CATEGORY', productId: null, category: 'accessories', startsAt: past(5), endsAt: past(2) },
    ];
    expect(resolvePromotion(product, expired)).toBeNull();
  });

  it('treats the window as half-open, so endsAt is exclusive', () => {
    const at = new Date('2026-06-01T12:00:00Z');
    const product = { id: 'p1', category: 'c', basePrice: 100 };
    const promo: ActivePromotion = { id: 'a', name: 'a', discountType: 'PERCENTAGE', valueCents: 1_000, scope: 'CATEGORY', productId: null, category: 'c', startsAt: at, endsAt: new Date('2026-06-01T13:00:00Z') };

    expect(resolvePromotion(product, [promo], at)?.id).toBe('a');
    expect(resolvePromotion(product, [promo], new Date('2026-06-01T13:00:00Z'))).toBeNull();
  });
});

describe('at most one active promotion — enforced by the database', () => {
  it('rejects a second overlapping CATEGORY promotion', async () => {
    await createPromotion({
      name: 'first', discountType: 'PERCENTAGE', value: 20,
      scope: 'CATEGORY', category: CATEGORY, startsAt: past(2), endsAt: future(2),
    } as never);

    await expect(
      createPromotion({
        name: 'second', discountType: 'PERCENTAGE', value: 30,
        scope: 'CATEGORY', category: CATEGORY, startsAt: past(1), endsAt: future(3),
      } as never),
    ).rejects.toBeInstanceOf(PromotionConflictError);
  });

  it('allows an adjacent, non-overlapping window', async () => {
    await createPromotion({
      name: 'jan', discountType: 'PERCENTAGE', value: 20, scope: 'CATEGORY',
      category: CATEGORY, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-02-01'),
    } as never);

    await expect(
      createPromotion({
        name: 'feb', discountType: 'PERCENTAGE', value: 30, scope: 'CATEGORY',
        category: CATEGORY, startsAt: new Date('2026-02-01'), endsAt: new Date('2026-03-01'),
      } as never),
    ).resolves.toBeDefined();
  });

  it('allows a PRODUCT promotion to coexist with a CATEGORY promotion', async () => {
    const product = await createProduct('coexist', '100.00');

    await createPromotion({
      name: 'cat', discountType: 'PERCENTAGE', value: 50, scope: 'CATEGORY',
      category: CATEGORY, startsAt: past(1), endsAt: future(1),
    } as never);

    await expect(
      createPromotion({
        name: 'prod', discountType: 'FIXED_AMOUNT', value: 10, scope: 'PRODUCT',
        productId: product.id, startsAt: past(1), endsAt: future(1),
      } as never),
    ).resolves.toBeDefined();

    // The product-scope promotion wins.
    const row = await findProductById(product.id, new Date());
    expect(row?.effectivePrice).toBe(9_000);
    expect(row?.promotion?.scope).toBe('PRODUCT');
  });

  it('frees the window once the incumbent is cancelled', async () => {
    const first = await createPromotion({
      name: 'first', discountType: 'PERCENTAGE', value: 20, scope: 'CATEGORY',
      category: CATEGORY, startsAt: past(1), endsAt: future(1),
    } as never);

    await expect(
      createPromotion({
        name: 'second', discountType: 'PERCENTAGE', value: 30, scope: 'CATEGORY',
        category: CATEGORY, startsAt: past(1), endsAt: future(1),
      } as never),
    ).rejects.toBeInstanceOf(PromotionConflictError);

    await cancelPromotion(first.id);

    // The constraint is filtered on ACTIVE, so cancelling releases the window.
    await expect(
      createPromotion({
        name: 'second', discountType: 'PERCENTAGE', value: 30, scope: 'CATEGORY',
        category: CATEGORY, startsAt: past(1), endsAt: future(1),
      } as never),
    ).resolves.toBeDefined();
  });

  /** The race a service-level pre-check cannot win: exactly one of ten must win. */
  it('holds under concurrent writes — exactly one of ten wins', async () => {
    const attempts = Array.from({ length: 10 }, (_, i) =>
      createPromotion({
        name: `race-${i}`, discountType: 'PERCENTAGE', value: 10 + i, scope: 'CATEGORY',
        category: CATEGORY, startsAt: past(1), endsAt: future(1),
      } as never).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
    );

    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);

    const stored = await prisma.promotion.count({ where: { category: CATEGORY, status: 'ACTIVE' } });
    expect(stored).toBe(1);
  });
});

describe('nothing can be made free', () => {
  it('the request schema rejects a 100% percentage discount', () => {
    const base = {
      name: 'Free Everything',
      scope: 'CATEGORY' as const,
      category: CATEGORY,
      startsAt: new Date('2026-01-01'),
      endsAt: new Date('2026-02-01'),
    };

    expect(
      createPromotionSchema.safeParse({ ...base, discountType: 'PERCENTAGE', value: 100 }).success,
    ).toBe(false);
    expect(
      createPromotionSchema.safeParse({ ...base, discountType: 'PERCENTAGE', value: 99.99 }).success,
    ).toBe(true);
  });

  /** The schema is a convenience; a direct write must fail too. */
  it('the database rejects a 100% percentage discount even without the schema', async () => {
    await expect(
      prisma.promotion.create({
        data: {
          name: 'Free Everything (direct)',
          discountType: 'PERCENTAGE',
          value: new Prisma.Decimal(100),
          scope: 'CATEGORY',
          category: CATEGORY,
          startsAt: past(1),
          endsAt: future(1),
        },
      }),
    ).rejects.toThrow();
  });

  it('the database rejects a zero base price', async () => {
    await expect(
      prisma.product.create({
        data: {
          sku: `FREE-${process.pid}`,
          name: 'Free Product',
          category: CATEGORY,
          basePrice: new Prisma.Decimal(0),
          stockQuantity: 1,
        },
      }),
    ).rejects.toThrow();
  });

  /** A fixed discount above the base price is legal, so the floor does the work. */
  it('a fixed discount exceeding the base price floors the effective price at one cent', async () => {
    const product = await createProduct('floor-me', '10.00');

    await createPromotion({
      name: 'Oversized Fixed Discount',
      discountType: 'FIXED_AMOUNT',
      value: 500,
      scope: 'PRODUCT',
      productId: product.id,
      startsAt: past(1),
      endsAt: future(1),
    } as never);

    const row = await findProductById(product.id, new Date());
    expect(row?.effectivePrice).toBe(1);
  });
});

describe('effective price in the list query', () => {
  it('sorts by the computed effective price, not the base price', async () => {
    await createProduct('cheap-base', '100.00');
    await createProduct('pricey-base', '300.00');

    // 90% off flips the ordering: 300 -> 30 becomes cheaper than 100.
    const pricey = await prisma.product.findFirstOrThrow({ where: { category: CATEGORY, basePrice: 300 } });
    await createPromotion({
      name: 'deep', discountType: 'PERCENTAGE', value: 90, scope: 'PRODUCT',
      productId: pricey.id, startsAt: past(1), endsAt: future(1),
    } as never);

    const rows = await listProducts({
      category: CATEGORY, sort: 'effective_price', direction: 'asc',
      limit: 10, offset: 0, at: new Date(),
    });

    expect(rows.map((r) => r.effectivePrice)).toEqual([3_000, 10_000]);
    expect(rows.map((r) => r.basePrice)).toEqual([30_000, 10_000]);
  });

  it('applies a category promotion to a product created after it started', async () => {
    await createPromotion({
      name: 'flash', discountType: 'PERCENTAGE', value: 50, scope: 'CATEGORY',
      category: CATEGORY, startsAt: past(1), endsAt: future(1),
    } as never);

    // The product does not exist when the promotion is created — the
    // requirement that a newly added product benefits automatically.
    const fresh = await createProduct('arrived-later', '80.00');

    const row = await findProductById(fresh.id, new Date());
    expect(row?.effectivePrice).toBe(4_000);
    expect(row?.promotion?.name).toBe('flash');
  });
});

describe('assignment', () => {
  it('refuses to move a promotion onto a target that already has one', async () => {
    const a = await createProduct('target-a', '100.00');
    const b = await createProduct('target-b', '100.00');

    const movable = await createPromotion({
      name: 'movable', discountType: 'FIXED_AMOUNT', value: 5, scope: 'PRODUCT',
      productId: a.id, startsAt: past(1), endsAt: future(1),
    } as never);

    await createPromotion({
      name: 'incumbent', discountType: 'FIXED_AMOUNT', value: 9, scope: 'PRODUCT',
      productId: b.id, startsAt: past(1), endsAt: future(1),
    } as never);

    await expect(
      assignPromotion(movable.id, { scope: 'PRODUCT', productId: b.id }),
    ).rejects.toBeInstanceOf(PromotionConflictError);
  });
});

afterAll(async () => {
  await resetFixtures();
  await prisma.$disconnect();
});
