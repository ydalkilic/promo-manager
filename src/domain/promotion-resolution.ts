/**
 * Picks the one promotion that applies to a product at a given instant.
 *
 * Two same-scope promotions overlapping in time is an authoring error and is
 * rejected by the database. A PRODUCT and a CATEGORY promotion covering the
 * same product is normal, and resolved here by specificity: narrower wins.
 * See ADR-004.
 */

import type { Cents } from './money.js';
import { applyDiscount, type DiscountType } from './pricing.js';

export type PromotionScope = 'PRODUCT' | 'CATEGORY';

export interface ActivePromotion {
  id: string;
  name: string;
  discountType: DiscountType;
  valueCents: Cents;
  scope: PromotionScope;
  productId: string | null;
  category: string | null;
  startsAt: Date;
  endsAt: Date;
}

export interface PricedProduct {
  id: string;
  category: string;
  basePrice: Cents;
}

/** Higher wins. Data rather than branching, so a new scope is a one-line change. */
const SCOPE_PRECEDENCE: Record<PromotionScope, number> = {
  CATEGORY: 1,
  PRODUCT: 2,
};

/** Half-open window: [startsAt, endsAt). */
export function isActiveAt(promotion: ActivePromotion, at: Date): boolean {
  const t = at.getTime();
  return promotion.startsAt.getTime() <= t && t < promotion.endsAt.getTime();
}

export function targets(promotion: ActivePromotion, product: PricedProduct): boolean {
  return promotion.scope === 'PRODUCT'
    ? promotion.productId === product.id
    : promotion.category === product.category;
}

export function resolvePromotion(
  product: PricedProduct,
  candidates: readonly ActivePromotion[],
  at: Date = new Date(),
): ActivePromotion | null {
  let winner: ActivePromotion | null = null;

  for (const candidate of candidates) {
    if (!targets(candidate, product) || !isActiveAt(candidate, at)) continue;
    if (winner === null || beats(candidate, winner)) winner = candidate;
  }

  return winner;
}

function beats(challenger: ActivePromotion, incumbent: ActivePromotion): boolean {
  const byScope = SCOPE_PRECEDENCE[challenger.scope] - SCOPE_PRECEDENCE[incumbent.scope];
  if (byScope !== 0) return byScope > 0;
  // Unreachable for well-formed data; returning a price beats throwing.
  return challenger.startsAt.getTime() > incumbent.startsAt.getTime();
}

export interface PricingResult {
  basePrice: Cents;
  effectivePrice: Cents;
  appliedPromotion: ActivePromotion | null;
}

export function priceProduct(
  product: PricedProduct,
  candidates: readonly ActivePromotion[],
  at: Date = new Date(),
): PricingResult {
  const appliedPromotion = resolvePromotion(product, candidates, at);

  return {
    basePrice: product.basePrice,
    effectivePrice: appliedPromotion
      ? applyDiscount(product.basePrice, appliedPromotion)
      : product.basePrice,
    appliedPromotion,
  };
}
