/**
 * Stage 2: ingest one bounded byte range.
 *
 * The range is streamed and only one upsert batch is resident at a time, so peak
 * memory follows the batch size, not the file size. A chunk completes in seconds;
 * if the process dies it is simply never marked COMPLETED and the queue
 * redelivers it.
 *
 * Idempotency is load-bearing, because queues deliver at-least-once. Two
 * independent mechanisms cover it: the status gate below, and the write being an
 * upsert on the vendor SKU, so replay converges rather than duplicating.
 */

import { parse } from 'csv-parse';
import { Prisma } from '@prisma/client';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { prisma } from '../db/prisma.js';
import { centsToDecimalString } from '../domain/money.js';
import { blobStore, type BlobStore } from './blob-store.js';
import { applyPricingRules, type RuleRejection } from './pricing-rules.js';
import {
  claimChunk,
  completeChunk,
  failChunk,
  finaliseJobIfComplete,
  getChunkRange,
} from './job-store.js';
import type { PricedRecord, ProcessChunkMessage, VendorRecord } from './contracts.js';

/** Rows per INSERT. 5 cols x 500 rows = 2,500 of Postgres' 65,535 param limit. */
const UPSERT_BATCH_ROWS = 500;

/** Bounded so a wholly malformed file cannot make the error path a memory problem. */
const MAX_RETAINED_REJECTIONS = 20;

export interface ChunkResult {
  status: 'completed' | 'skipped' | 'failed';
  rowsProcessed: number;
  rowsRejected: number;
  rejections: RuleRejection[];
}

export interface ChunkProcessorDeps {
  store?: BlobStore;
}

export async function processChunk(
  message: ProcessChunkMessage,
  deps: ChunkProcessorDeps = {},
): Promise<ChunkResult> {
  const store = deps.store ?? blobStore;
  const { outcome, attempts } = await claimChunk(message.jobId, message.seq);

  if (outcome === 'unknown') {
    // Row purged. Acknowledge; retrying would loop forever.
    logger.warn({ jobId: message.jobId, seq: message.seq }, 'chunk row not found — discarding');
    return { status: 'skipped', rowsProcessed: 0, rowsRejected: 0, rejections: [] };
  }

  if (outcome === 'already-completed') {
    // Expected at-least-once redelivery. Not an error.
    logger.debug({ jobId: message.jobId, seq: message.seq }, 'chunk already completed — skipping');
    return { status: 'skipped', rowsProcessed: 0, rowsRejected: 0, rejections: [] };
  }

  // Prefer the durable range: the row is what the splitter actually committed.
  const range = (await getChunkRange(message.jobId, message.seq)) ?? {
    byteStart: message.byteStart,
    byteEnd: message.byteEnd,
  };

  try {
    const result = await ingestRange(store, message, range);

    await completeChunk(message.jobId, message.seq, result.rowsProcessed, result.rowsRejected);
    await finaliseJobIfComplete(message.jobId);

    logger.debug(
      { jobId: message.jobId, seq: message.seq, ...result },
      'chunk completed',
    );

    return { status: 'completed', ...result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    if (attempts >= config.INGESTION_MAX_ATTEMPTS) {
      // Terminal: park it so one poison chunk cannot block the other 249.
      await failChunk(message.jobId, message.seq, reason);
      await finaliseJobIfComplete(message.jobId);

      logger.error(
        { jobId: message.jobId, seq: message.seq, attempts, err: reason },
        'chunk failed permanently after exhausting retries',
      );

      return { status: 'failed', rowsProcessed: 0, rowsRejected: 0, rejections: [] };
    }

    logger.warn(
      { jobId: message.jobId, seq: message.seq, attempts, err: reason },
      'chunk failed — will retry',
    );
    // Rethrow so the queue applies its backoff and redelivers.
    throw err;
  }
}

async function ingestRange(
  store: BlobStore,
  message: ProcessChunkMessage,
  range: { byteStart: number; byteEnd: number },
): Promise<{ rowsProcessed: number; rowsRejected: number; rejections: RuleRejection[] }> {
  const parser = store.readRange(message.fileKey, range.byteStart, range.byteEnd).pipe(
    parse({
      columns: message.columns,
      skip_empty_lines: true,
      // A trailing column added mid-file must not fail the chunk.
      relax_column_count: true,
      trim: true,
    }),
  );

  let batch: PricedRecord[] = [];
  let rowsProcessed = 0;
  let rowsRejected = 0;
  const rejections: RuleRejection[] = [];

  for await (const row of parser) {
    const outcome = applyPricingRules(toVendorRecord(row as Record<string, string>));

    if (!outcome.ok) {
      rowsRejected++;
      if (rejections.length < MAX_RETAINED_REJECTIONS) rejections.push(outcome.rejection);
      continue;
    }

    batch.push(outcome.record);

    if (batch.length >= UPSERT_BATCH_ROWS) {
      rowsProcessed += await upsertProducts(batch);
      batch = [];
    }
  }

  if (batch.length > 0) rowsProcessed += await upsertProducts(batch);

  return { rowsProcessed, rowsRejected, rejections };
}

function toVendorRecord(row: Record<string, string>): VendorRecord {
  return {
    sku: row.sku ?? '',
    name: row.name ?? '',
    category: row.category ?? '',
    vendorPrice: toCents(row.vendor_price),
    cost: toCents(row.cost),
    stockQuantity: Number.parseInt(row.stock_quantity ?? '0', 10),
  };
}

function toCents(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN;
}

/**
 * Bulk upsert one batch.
 *
 * The de-duplication is required, not defensive: Postgres raises "ON CONFLICT DO
 * UPDATE command cannot affect row a second time" if one statement touches the
 * same conflict target twice, and vendor files routinely repeat a SKU. Without
 * collapsing first the batch fails, and every retry fails identically until the
 * chunk is parked. Last occurrence wins, matching vendor convention.
 */
async function upsertProducts(batch: PricedRecord[]): Promise<number> {
  const bySku = new Map<string, PricedRecord>();
  for (const record of batch) bySku.set(record.sku, record);
  const rows = [...bySku.values()];

  const values = Prisma.join(
    rows.map(
      (r) => Prisma.sql`(
        ${r.sku},
        ${r.name},
        ${r.category},
        ${centsToDecimalString(r.basePrice)}::numeric(12,2),
        ${r.stockQuantity},
        now()
      )`,
    ),
  );

  await prisma.$executeRaw`
    INSERT INTO products (sku, name, category, base_price, stock_quantity, updated_at)
    VALUES ${values}
    ON CONFLICT (sku) DO UPDATE SET
      name           = EXCLUDED.name,
      category       = EXCLUDED.category,
      base_price     = EXCLUDED.base_price,
      stock_quantity = EXCLUDED.stock_quantity,
      updated_at     = now()
  `;

  return rows.length;
}
