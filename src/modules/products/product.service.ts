/**
 * Product read services.
 *
 * Detail is the hottest route, so it uses both cache tiers. The list is heavier
 * per miss but far lower in cardinality, so Redis only — L1 would cost memory
 * per replica for little hit-rate gain. Both are invalidated by the promotion
 * epoch, so a flash sale lands everywhere at once.
 */

import { config } from '../../config/index.js';
import { cacheKey, getOrLoad, type CacheOutcome } from '../../cache/index.js';
import { centsToNumber } from '../../domain/money.js';
import { NotFoundError } from '../../http/errors.js';
import {
  countProducts,
  findProductById,
  listProducts,
  type ProductRow,
} from './product.repository.js';
import type { ListProductsQuery } from './product.schemas.js';

export interface ProductResponse {
  id: string;
  sku: string;
  name: string;
  category: string;
  basePrice: number;
  effectivePrice: number;
  discountAmount: number;
  onPromotion: boolean;
  stockQuantity: number;
  appliedPromotion: {
    id: string;
    name: string;
    discountType: string;
    scope: string;
    value: number;
  } | null;
}

export interface ProductListResponse {
  data: ProductResponse[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  meta: { pricedAt: string; cache: CacheOutcome };
}

function serialise(row: ProductRow): ProductResponse {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    basePrice: centsToNumber(row.basePrice),
    effectivePrice: centsToNumber(row.effectivePrice),
    discountAmount: centsToNumber(row.basePrice - row.effectivePrice),
    onPromotion: row.promotion !== null,
    stockQuantity: row.stockQuantity,
    appliedPromotion: row.promotion
      ? {
          id: row.promotion.id,
          name: row.promotion.name,
          discountType: row.promotion.discountType,
          scope: row.promotion.scope,
          value: Number(row.promotion.value),
        }
      : null,
  };
}

/**
 * A caller-supplied `at` prices the catalogue at that instant instead of now.
 *
 * Simulations are cached like any other page. The instant is snapped to the
 * minute by the schema and participates in the cache key, so a simulation can
 * never be served live prices or vice versa. See ADR-013.
 */
export async function getProductList(query: ListProductsQuery): Promise<ProductListResponse> {
  // Live reads are not snapped: they must reflect a promotion that started
  // seconds ago. Only the explicit simulation path is.
  const at = query.at ?? new Date();
  const offset = (query.page - 1) * query.limit;

  const load = async () => {
    const [rows, total] = await Promise.all([
      listProducts({
        category: query.category,
        sort: query.sort,
        direction: query.direction,
        limit: query.limit,
        offset,
        at,
      }),
      getProductCount(query.category),
    ]);
    return { rows: rows.map(serialise), total };
  };

  const { value, outcome } = await getOrLoad(
    cacheKey('products:list', {
      category: query.category,
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      direction: query.direction,
      // Simulations only; live reads omit it and share one key per filter.
      at: query.at?.toISOString(),
    }),
    config.CACHE_TTL_LIST_SECONDS,
    load,
  );

  return {
    data: value.rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total: value.total,
      totalPages: Math.max(1, Math.ceil(value.total / query.limit)),
    },
    meta: { pricedAt: at.toISOString(), cache: outcome },
  };
}

/**
 * Cached separately from the page payload: product counts are unaffected by
 * promotions, so tying them to the epoch would discard a valid count per sale.
 */
async function getProductCount(category: string | undefined): Promise<number> {
  const { value } = await getOrLoad(
    cacheKey('products:count', { category }),
    config.CACHE_TTL_LIST_SECONDS,
    () => countProducts(category),
  );
  return value;
}

export async function getProduct(
  id: string,
  at?: Date,
): Promise<{ product: ProductResponse; cache: CacheOutcome; pricedAt: string }> {
  const instant = at ?? new Date();

  // Keyed by the snapped instant so simulations and live reads never collide.
  const { value, outcome } = await getOrLoad(
    cacheKey('products:detail', { id, at: at?.toISOString() }),
    config.CACHE_TTL_PRODUCT_SECONDS,
    async () => {
      const row = await findProductById(id, instant);
      return row ? serialise(row) : null;
    },
    { useL1: true },
  );

  if (!value) throw new NotFoundError('Product', id);
  return { product: value, cache: outcome, pricedAt: instant.toISOString() };
}
