/**
 * The application-layer pricing rules every vendor record passes through before
 * it is saved: validate, apply one markup over cost, enforce the shared minimum
 * price. See ADR-014.
 *
 * This cannot be a set-based `INSERT ... SELECT`: the markup lives in
 * application config, and rejected rows must be counted and reported rather than
 * silently skipped. That is also what forces the chunked design — every one of
 * 500k rows makes a round trip through JavaScript.
 */

import { config } from '../config/index.js';
import { roundHalfUp } from '../domain/money.js';
import { enforceMinimumPrice } from '../domain/pricing.js';
import type { PricedRecord, VendorRecord } from './contracts.js';

export type RuleRejection = {
  sku: string;
  reason: string;
};

export type RuleOutcome =
  | { ok: true; record: PricedRecord }
  | { ok: false; rejection: RuleRejection };

/**
 * Returns a result rather than throwing: one malformed row must not abort the
 * chunk containing it. Rejections are counted and surfaced on the job.
 */
export function applyPricingRules(raw: VendorRecord): RuleOutcome {
  const sku = raw.sku.trim();

  if (!sku) return reject(sku, 'missing SKU');
  if (!raw.name.trim()) return reject(sku, 'missing name');
  if (!raw.category.trim()) return reject(sku, 'missing category');
  if (!Number.isFinite(raw.cost) || raw.cost <= 0) return reject(sku, 'invalid cost');
  // Not used in the calculation, but a malformed one signals a corrupt line.
  if (!Number.isFinite(raw.vendorPrice) || raw.vendorPrice < 0) {
    return reject(sku, 'invalid vendor price');
  }
  if (!Number.isInteger(raw.stockQuantity) || raw.stockQuantity < 0) {
    return reject(sku, 'invalid stock quantity');
  }

  // One rule: cost plus a flat markup, floored at the minimum price.
  const marked = roundHalfUp((raw.cost * (100 + config.INGESTION_MARKUP_PERCENT)) / 100);
  const basePrice = enforceMinimumPrice(marked);

  return {
    ok: true,
    record: {
      sku,
      name: raw.name.trim(),
      category: raw.category.trim().toLowerCase(),
      basePrice,
      stockQuantity: raw.stockQuantity,
    },
  };
}

function reject(sku: string, reason: string): RuleOutcome {
  return { ok: false, rejection: { sku: sku || '(blank)', reason } };
}
