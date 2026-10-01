import { Router } from 'express';
import { asyncHandler } from '../../http/middleware.js';
import { classifyProductRead, rateLimit } from '../../http/rate-limit.js';
import {
  listProductsQuerySchema,
  productDetailQuerySchema,
  productIdParamSchema,
} from './product.schemas.js';
import { getProduct, getProductList } from './product.service.js';

export const productRoutes = Router();

/** GET /api/products — filter, paginate, sort (including by computed effective price). */
productRoutes.get(
  '/',
  // `?at=` simulations draw from the tighter budget.
  rateLimit(classifyProductRead),
  asyncHandler(async (req, res) => {
    const query = listProductsQuerySchema.parse(req.query);
    const result = await getProductList(query);

    // Which cache tier served this; useful for demonstrating Scenario B.
    res.setHeader('X-Cache', result.meta.cache);
    res.json(result);
  }),
);

/** GET /api/products/:id — the hottest route; served by the two-tier cache. */
productRoutes.get(
  '/:id',
  rateLimit(classifyProductRead),
  asyncHandler(async (req, res) => {
    const { id } = productIdParamSchema.parse(req.params);
    // Validated and snapped by the shared schema, so a bad `at` is rejected here.
    const { at } = productDetailQuerySchema.parse(req.query);
    const result = await getProduct(id, at);

    res.setHeader('X-Cache', result.cache);
    res.json({ data: result.product, meta: { pricedAt: result.pricedAt, cache: result.cache } });
  }),
);
