import { z } from 'zod';
import { MAX_DISCOUNT_PERCENT } from '../../domain/pricing.js';

/** A promotion carries its own target rather than having a separate assignments table. */
const targetSchema = z.union([
  z.object({
    scope: z.literal('PRODUCT'),
    productId: z.string().uuid('productId must be a UUID'),
  }),
  z.object({
    scope: z.literal('CATEGORY'),
    category: z.string().trim().min(1).max(120),
  }),
]);

const discountSchema = z.discriminatedUnion('discountType', [
  z.object({
    discountType: z.literal('PERCENTAGE'),
    // Strictly below 100: a free product is forbidden (ADR-014). Mirrors
    // promotions_value_chk, which remains the authority.
    value: z.number().positive().lt(MAX_DISCOUNT_PERCENT),
  }),
  z.object({
    discountType: z.literal('FIXED_AMOUNT'),
    value: z.number().positive(),
  }),
]);

export const createPromotionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
  })
  .and(discountSchema)
  .and(targetSchema)
  .refine((data) => data.endsAt > data.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type CreatePromotionInput = z.infer<typeof createPromotionSchema>;

/** Move an existing promotion onto a different product or category. */
export const assignPromotionSchema = targetSchema;
export type AssignPromotionInput = z.infer<typeof assignPromotionSchema>;

export const promotionIdParamSchema = z.object({
  id: z.string().uuid('Promotion id must be a UUID'),
});

export const listPromotionsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
  scope: z.enum(['PRODUCT', 'CATEGORY']).optional(),
  category: z.string().trim().min(1).optional(),
  productId: z.string().uuid().optional(),
  activeAt: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
