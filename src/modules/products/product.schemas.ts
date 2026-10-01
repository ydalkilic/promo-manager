import { z } from 'zod';
import { config } from '../../config/index.js';

/**
 * Snap an instant to the start of its minute.
 *
 * `?at=` used to bypass the cache, which made a unique timestamp an unbounded
 * -cost request. Snapping collapses the key space so repeats hit cache. Minute
 * rather than hour granularity keeps a sale starting at 14:30 visible at 14:31.
 */
export function snapToMinute(at: Date): Date {
  const snapped = new Date(at);
  snapped.setSeconds(0, 0);
  return snapped;
}

/**
 * The `?at=` simulation instant, shared by both read endpoints. The detail route
 * previously parsed it with a bare `new Date(String(...))`, which accepted
 * anything and handed Invalid Dates to the query layer.
 */
export const simulationInstantSchema = z.coerce
  .date()
  .refine((value) => Number.isFinite(value.getTime()), { message: 'at must be a valid date' })
  .refine(
    (value) => Math.abs(value.getTime() - Date.now()) <= config.AT_MAX_SKEW_DAYS * 86_400_000,
    { message: `at must be within ${config.AT_MAX_SKEW_DAYS} days of now` },
  )
  .transform(snapToMinute);

export const listProductsQuerySchema = z
  .object({
    category: z.string().trim().min(1).max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    /** Capped because the list query sorts by a computed expression. */
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(['effective_price', 'base_price', 'name', 'created_at']).default('effective_price'),
    direction: z.enum(['asc', 'desc']).default('asc'),
    /** Price the catalogue at an arbitrary instant, to verify a scheduled sale. */
    at: simulationInstantSchema.optional(),
  })
  /**
   * The bound is on the computed offset, not `page`: page=1000&limit=100 is a
   * hundred times more expensive than page=1000&limit=1. Interim protection
   * until keyset pagination (ADR-007).
   */
  .refine((query) => (query.page - 1) * query.limit <= config.MAX_PAGINATION_OFFSET, {
    message:
      `Pagination offset exceeds the maximum of ${config.MAX_PAGINATION_OFFSET}. ` +
      'Narrow the result set with ?category= rather than paging deeper.',
    path: ['page'],
  });

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const productIdParamSchema = z.object({
  id: z.string().uuid('Product id must be a UUID'),
});

export const productDetailQuerySchema = z.object({
  at: simulationInstantSchema.optional(),
});

export type ProductDetailQuery = z.infer<typeof productDetailQuerySchema>;
