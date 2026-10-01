import { describe, expect, it, afterAll } from 'vitest';
import {
  applyDiscount,
  enforceMinimumPrice,
  isValidDiscountValue,
  MAX_DISCOUNT_PERCENT,
  MIN_PRICE_CENTS,
} from '../src/domain/pricing.js';
import { centsToDecimalString, parseMoneyToCents } from '../src/domain/money.js';
import { prisma } from '../src/prisma-test-client.js';

describe('money parsing', () => {
  it('parses decimal strings without floating point drift', () => {
    expect(parseMoneyToCents('0.10')).toBe(10);
    expect(parseMoneyToCents('1299.50')).toBe(129_950);
    expect(parseMoneyToCents('0.1')).toBe(10);
    expect(parseMoneyToCents('100')).toBe(10_000);
  });

  it('rounds half-up on a third decimal, as Postgres does', () => {
    expect(parseMoneyToCents('1.005')).toBe(101);
    expect(parseMoneyToCents('1.004')).toBe(100);
  });

  it('round-trips through the wire format', () => {
    for (const cents of [0, 1, 99, 100, 129_950]) {
      expect(parseMoneyToCents(centsToDecimalString(cents))).toBe(cents);
    }
  });
});

describe('applyDiscount', () => {
  it('applies a percentage discount', () => {
    expect(applyDiscount(10_000, { discountType: 'PERCENTAGE', valueCents: 5_000 })).toBe(5_000);
    expect(applyDiscount(12_900, { discountType: 'PERCENTAGE', valueCents: 5_000 })).toBe(6_450);
  });

  it('applies a fixed discount', () => {
    expect(applyDiscount(8_900, { discountType: 'FIXED_AMOUNT', valueCents: 3_000 })).toBe(5_900);
  });

  /** The floor is one cent, not zero, and it has to be total — see ADR-014. */
  it('floors at one cent when the fixed discount exceeds the base price', () => {
    expect(applyDiscount(1_000, { discountType: 'FIXED_AMOUNT', valueCents: 5_000 })).toBe(
      MIN_PRICE_CENTS,
    );
    expect(applyDiscount(1_000, { discountType: 'FIXED_AMOUNT', valueCents: 1_000 })).toBe(
      MIN_PRICE_CENTS,
    );
  });

  it('floors at one cent when a deep percentage would round to zero', () => {
// Rounds to zero before the floor applies.
    expect(applyDiscount(1, { discountType: 'PERCENTAGE', valueCents: 9_999 })).toBe(
      MIN_PRICE_CENTS,
    );
  });

  it('never returns a price at or below zero for any input', () => {
    for (const base of [1, 50, 999, 100_000]) {
      for (const value of [1, 5_000, 9_999]) {
        expect(applyDiscount(base, { discountType: 'PERCENTAGE', valueCents: value })).toBeGreaterThan(0);
        expect(applyDiscount(base, { discountType: 'FIXED_AMOUNT', valueCents: value })).toBeGreaterThan(0);
      }
    }
  });
});

describe('pricing invariants shared by both paths', () => {
  it('rejects a 100% percentage discount', () => {
    expect(isValidDiscountValue('PERCENTAGE', MAX_DISCOUNT_PERCENT)).toBe(false);
    expect(isValidDiscountValue('PERCENTAGE', 100.01)).toBe(false);
    expect(isValidDiscountValue('PERCENTAGE', 99.99)).toBe(true);
  });

  it('rejects a non-positive discount of either type', () => {
    expect(isValidDiscountValue('PERCENTAGE', 0)).toBe(false);
    expect(isValidDiscountValue('FIXED_AMOUNT', 0)).toBe(false);
    expect(isValidDiscountValue('FIXED_AMOUNT', -5)).toBe(false);
  });

  it('allows a fixed discount larger than any plausible price — the floor handles it', () => {
    expect(isValidDiscountValue('FIXED_AMOUNT', 1_000_000)).toBe(true);
  });

  it('enforceMinimumPrice is the same floor the ingestion pipeline uses', () => {
    expect(enforceMinimumPrice(0)).toBe(MIN_PRICE_CENTS);
    expect(enforceMinimumPrice(-100)).toBe(MIN_PRICE_CENTS);
    expect(enforceMinimumPrice(500)).toBe(500);
  });
});

/**
 * The critical test here. Effective price is computed in SQL for the sortable
 * list and in TypeScript everywhere else; a one-cent disagreement would show
 * different prices on the listing and the product page.
 */
describe('SQL and TypeScript pricing agree exactly', () => {
  const cases: { base: string; type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: string }[] = [];
  for (const base of ['0.01', '9.99', '10.00', '33.33', '99.95', '129.00', '1299.50', '99999.99']) {
    // 100.00 is absent: a 100% discount is no longer legal.
    for (const value of ['0.01', '1.00', '7.50', '12.34', '33.33', '50.00', '99.98', '99.99']) {
      cases.push({ base, type: 'PERCENTAGE', value });
    }
    for (const value of ['0.01', '5.00', '33.33', '1000.00']) {
      cases.push({ base, type: 'FIXED_AMOUNT', value });
    }
  }

  it(`matches on all ${cases.length} combinations`, async () => {
    const rows = await prisma.$queryRaw<{ idx: number; sql_result: string }[]>`
      SELECT idx, (
        CASE
          WHEN t.dtype = 'PERCENTAGE'
            THEN GREATEST(0.01, ROUND(t.base * (100 - t.val) / 100, 2))
          ELSE GREATEST(0.01, t.base - t.val)
        END
      )::text AS sql_result
      FROM (
        SELECT
          ordinality::int AS idx,
          (elem->>'base')::numeric(12,2)  AS base,
          (elem->>'type')                 AS dtype,
          (elem->>'value')::numeric(12,2) AS val
        FROM jsonb_array_elements(${JSON.stringify(cases)}::jsonb)
             WITH ORDINALITY AS a(elem, ordinality)
      ) t
      ORDER BY idx
    `;

    expect(rows).toHaveLength(cases.length);

    const mismatches: string[] = [];
    for (const row of rows) {
      const c = cases[row.idx - 1]!;
      const ts = applyDiscount(parseMoneyToCents(c.base), {
        discountType: c.type,
        valueCents: parseMoneyToCents(c.value),
      });
      const sql = parseMoneyToCents(row.sql_result);
      if (ts !== sql) {
        mismatches.push(`${c.base} ${c.type} ${c.value}: ts=${ts} sql=${sql}`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
