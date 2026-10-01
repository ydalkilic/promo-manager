import { Router } from 'express';
import { asyncHandler } from '../../http/middleware.js';
import { rateLimit } from '../../http/rate-limit.js';
import {
  assignPromotionSchema,
  createPromotionSchema,
  listPromotionsQuerySchema,
  promotionIdParamSchema,
} from './promotion.schemas.js';
import {
  assignPromotion,
  cancelPromotion,
  createPromotion,
  getPromotion,
  listPromotions,
} from './promotion.service.js';

export const promotionRoutes = Router();

/**
 * POST /api/promotions — targets a product or a whole category. The category case
 * is the flash sale: one row written, tens of thousands of prices changed.
 */
promotionRoutes.post(
  '/',
  // Each write bumps the epoch and invalidates every cached page.
  rateLimit('write'),
  asyncHandler(async (req, res) => {
    const input = createPromotionSchema.parse(req.body);
    const promotion = await createPromotion(input);
    res.status(201).json({ data: promotion });
  }),
);

promotionRoutes.get(
  '/',
  rateLimit('read'),
  asyncHandler(async (req, res) => {
    const query = listPromotionsQuerySchema.parse(req.query);
    res.json({ data: await listPromotions(query) });
  }),
);

promotionRoutes.get(
  '/:id',
  rateLimit('read'),
  asyncHandler(async (req, res) => {
    const { id } = promotionIdParamSchema.parse(req.params);
    res.json({ data: await getPromotion(id) });
  }),
);

/** Cancel rather than delete: promotions are an audit trail of what was charged. */
promotionRoutes.post(
  '/:id/cancel',
  rateLimit('write'),
  asyncHandler(async (req, res) => {
    const { id } = promotionIdParamSchema.parse(req.params);
    res.json({ data: await cancelPromotion(id) });
  }),
);

/** POST /api/promotions/:id/assign — move a promotion to a product or category. */
promotionRoutes.post(
  '/:id/assign',
  rateLimit('write'),
  asyncHandler(async (req, res) => {
    const { id } = promotionIdParamSchema.parse(req.params);
    const input = assignPromotionSchema.parse(req.body);
    res.json({ data: await assignPromotion(id, input) });
  }),
);
