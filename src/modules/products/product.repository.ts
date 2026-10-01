/**
 * Product read paths, hand-written SQL rather than Prisma calls.
 *
 * The list endpoint must ORDER BY the effective price, which is not a column —
 * it depends on whichever promotion wins per row. No ORM expresses that without
 * materialising the whole result set, which defeats pagination. Prisma owns
 * migrations and all writes; only these two hot reads drop to SQL. See ADR-002.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { parseMoneyToCents, type Cents } from '../../domain/money.js';
import type { DiscountType } from '../../domain/pricing.js';
import type { PromotionScope } from '../../domain/promotion-resolution.js';

export type ProductSortField = 'effective_price' | 'base_price' | 'name' | 'created_at';
export type SortDirection = 'asc' | 'desc';

export interface ProductListQuery {
  category?: string | undefined;
  sort: ProductSortField;
  direction: SortDirection;
  limit: number;
  offset: number;
  /** Evaluation instant, explicit so any date can be priced. */
  at: Date;
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  basePrice: Cents;
  effectivePrice: Cents;
  stockQuantity: number;
  createdAt: Date;
  promotion: {
    id: string;
    name: string;
    discountType: DiscountType;
    scope: PromotionScope;
    value: string;
  } | null;
}

interface RawProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  base_price: string;
  effective_price: string;
  stock_quantity: number;
  created_at: Date;
  promotion_id: string | null;
  promotion_name: string | null;
  promotion_discount_type: DiscountType | null;
  promotion_scope: PromotionScope | null;
  promotion_value: string | null;
}

/**
 * Resolve the winning promotion for every product in scope.
 *
 * The two LEFT JOINs can only be 1:1 because the EXCLUDE constraints forbid two
 * active same-scope promotions on one target. Without them the joins would fan
 * out and duplicate products across pages — the constraint is what makes this
 * query shape valid, not just a business rule.
 *
 * `active` is tiny (tens of rows), so this is a hash join against a small
 * relation rather than a per-row lookup.
 */
const RESOLVED_PRODUCTS_CTE = (at: Date, category: string | undefined) => Prisma.sql`
  WITH active AS (
    SELECT id, name, discount_type, value, scope, product_id, category
    FROM promotions
    WHERE status = 'ACTIVE'
      AND starts_at <= ${at}
      AND ${at} < ends_at
  ),
  resolved AS (
    SELECT
      p.id,
      p.sku,
      p.name,
      p.category,
      p.base_price,
      p.stock_quantity,
      p.created_at,
      -- PRODUCT scope outranks CATEGORY. Driven off one discriminator so every
      -- column comes from the same row, unlike per-column COALESCE.
      CASE WHEN pp.id IS NOT NULL THEN pp.id            ELSE cp.id            END AS promotion_id,
      CASE WHEN pp.id IS NOT NULL THEN pp.name          ELSE cp.name          END AS promotion_name,
      CASE WHEN pp.id IS NOT NULL THEN pp.discount_type ELSE cp.discount_type END AS promotion_discount_type,
      CASE WHEN pp.id IS NOT NULL THEN pp.scope         ELSE cp.scope         END AS promotion_scope,
      CASE WHEN pp.id IS NOT NULL THEN pp.value         ELSE cp.value         END AS promotion_value
    FROM products p
    LEFT JOIN active pp ON pp.scope = 'PRODUCT'  AND pp.product_id = p.id
    LEFT JOIN active cp ON cp.scope = 'CATEGORY' AND cp.category   = p.category
    WHERE ${category === undefined ? Prisma.sql`TRUE` : Prisma.sql`p.category = ${category}`}
  ),
  priced AS (
    SELECT
      resolved.*,
      -- Floored at 0.01, matching MIN_PRICE_CENTS. Both branches need it: a
      -- sub-100% discount can still round to zero on a one-cent item.
      CASE
        WHEN promotion_discount_type IS NULL THEN base_price
        WHEN promotion_discount_type = 'PERCENTAGE'
          THEN GREATEST(0.01, ROUND(base_price * (100 - promotion_value) / 100, 2))
        ELSE GREATEST(0.01, base_price - promotion_value)
      END AS effective_price
    FROM resolved
  )
`;

/**
 * ORDER BY cannot be parameterised, so sorts come from a closed allowlist.
 * `id` makes the ordering total, without which rows sharing a price can appear
 * on two pages or none.
 *
 * The `priced.` qualification is load-bearing. The outer SELECT casts money to
 * text, and SQL resolves a bare ORDER BY name against output aliases first — so
 * unqualified, this sorted lexicographically ('100.00' before '30.00').
 * Qualifying forces the numeric input column. See ADR-007.
 */
const SORT_COLUMNS: Record<ProductSortField, string> = {
  effective_price: 'effective_price',
  base_price: 'base_price',
  name: 'name',
  created_at: 'created_at',
};

function orderByClause(sort: ProductSortField, direction: SortDirection): Prisma.Sql {
  const column = SORT_COLUMNS[sort];
  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  return Prisma.raw(`ORDER BY priced.${column} ${dir}, priced.id ASC`);
}

export async function listProducts(query: ProductListQuery): Promise<ProductRow[]> {
  const rows = await prisma.$queryRaw<RawProductRow[]>`
    ${RESOLVED_PRODUCTS_CTE(query.at, query.category)}
    SELECT
      id, sku, name, category,
      base_price::text      AS base_price,
      effective_price::text AS effective_price,
      stock_quantity, created_at,
      promotion_id, promotion_name, promotion_discount_type, promotion_scope,
      promotion_value::text AS promotion_value
    FROM priced
    ${orderByClause(query.sort, query.direction)}
    LIMIT ${query.limit} OFFSET ${query.offset}
  `;

  return rows.map(toProductRow);
}

export async function findProductById(id: string, at: Date): Promise<ProductRow | null> {
  const rows = await prisma.$queryRaw<RawProductRow[]>`
    ${RESOLVED_PRODUCTS_CTE(at, undefined)}
    SELECT
      id, sku, name, category,
      base_price::text      AS base_price,
      effective_price::text AS effective_price,
      stock_quantity, created_at,
      promotion_id, promotion_name, promotion_discount_type, promotion_scope,
      promotion_value::text AS promotion_value
    FROM priced
    WHERE id = ${id}::uuid
    LIMIT 1
  `;

  return rows[0] ? toProductRow(rows[0]) : null;
}

/**
 * Row count for pagination. Independent of promotions, so callers cache it on
 * its own TTL rather than tying it to the promotion epoch. An exact COUNT is a
 * full scan on a large catalogue, hence advisory metadata.
 */
export async function countProducts(category: string | undefined): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM products
    WHERE ${category === undefined ? Prisma.sql`TRUE` : Prisma.sql`category = ${category}`}
  `;

  return Number(rows[0]?.count ?? 0n);
}

function toProductRow(raw: RawProductRow): ProductRow {
  return {
    id: raw.id,
    sku: raw.sku,
    name: raw.name,
    category: raw.category,
    basePrice: parseMoneyToCents(raw.base_price),
    effectivePrice: parseMoneyToCents(raw.effective_price),
    stockQuantity: raw.stock_quantity,
    createdAt: raw.created_at,
    promotion:
      raw.promotion_id && raw.promotion_name && raw.promotion_discount_type && raw.promotion_scope
        ? {
            id: raw.promotion_id,
            name: raw.promotion_name,
            discountType: raw.promotion_discount_type,
            scope: raw.promotion_scope,
            value: raw.promotion_value ?? '0',
          }
        : null,
  };
}
