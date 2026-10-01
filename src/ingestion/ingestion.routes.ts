import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/middleware.js';
import { rateLimit } from '../http/rate-limit.js';
import { NotFoundError } from '../http/errors.js';
import { getIngestionStatus, startIngestion } from './ingestion.service.js';

export const ingestionRoutes = Router();

const startSchema = z.object({
  /** Object-storage key of a vendor file already uploaded out of band. */
  fileKey: z.string().trim().min(1).max(512),
});

/** POST /api/ingestion/jobs — 202; the work is queued, not performed here. */
ingestionRoutes.post(
  '/jobs',
  // One trigger fans out to ~250 chunk jobs: the tightest budget.
  rateLimit('ingestion'),
  asyncHandler(async (req, res) => {
    const { fileKey } = startSchema.parse(req.body);
    res.status(202).json({ data: await startIngestion(fileKey) });
  }),
);

/** GET /api/ingestion/jobs/:id — poll progress, including per-chunk state. */
ingestionRoutes.get(
  '/jobs/:id',
  rateLimit('read'),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const status = await getIngestionStatus(id);
    if (!status) throw new NotFoundError('Ingestion job', id);
    res.json({ data: status });
  }),
);
