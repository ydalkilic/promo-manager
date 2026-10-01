/**
 * Pricing rules, shared by the promotion path and the ingestion pipeline.
 *
 * Two invariants: a price is always > 0, and a percentage discount is always
 * < 100%. Mirrored by CHECK constraints in the DDL. See ADR-014.
 *
 * Effective price is also computed in SQL for the sortable product list;
 * `tests/pricing.test.ts` holds the two implementations to identical results.
 */

import { roundHalfUp, type Cents } from './money.js';

export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';

/** Lowest price anything may be sold at. */
export const MIN_PRICE_CENTS: Cents = 1;

/** Percentage discounts must be strictly below this. */
export const MAX_DISCOUNT_PERCENT = 100;

export interface DiscountSpec {
  discountType: DiscountType;
  /** Percentage points (2dp) or a fixed amount, both in minor units. */
  valueCents: Cents;
}

/**
 * Apply a discount, floored at one cent.
 *
 * Flooring rather than rejecting is deliberate: a category promotion cannot
 * know every price it will touch, including products ingested after it was
 * created, so the rule has to be total.
 */
export function applyDiscount(basePrice: Cents, discount: DiscountSpec): Cents {
  if (discount.discountType === 'PERCENTAGE') {
    // valueCents is percentage-points x 100, hence the 10,000 denominator.
    const remainingBasisPoints = 10_000 - discount.valueCents;
    if (remainingBasisPoints <= 0) return MIN_PRICE_CENTS;
    return Math.max(MIN_PRICE_CENTS, roundHalfUp((basePrice * remainingBasisPoints) / 10_000));
  }

  return Math.max(MIN_PRICE_CENTS, basePrice - discount.valueCents);
}

/** The discount actually granted, after the floor is applied. */
export function discountAmount(basePrice: Cents, discount: DiscountSpec): Cents {
  return basePrice - applyDiscount(basePrice, discount);
}

/** Clamp any computed price to the minimum. Used by the ingestion markup. */
export function enforceMinimumPrice(price: Cents): Cents {
  return Math.max(MIN_PRICE_CENTS, price);
}

export function isValidDiscountValue(discountType: DiscountType, value: number): boolean {
  if (!(value > 0)) return false;
  return discountType === 'PERCENTAGE' ? value < MAX_DISCOUNT_PERCENT : true;
}
