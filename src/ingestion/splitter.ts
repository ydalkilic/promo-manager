/**
 * Stage 1: turn one large file into many small, independently processable byte
 * ranges. Never parses the file, never holds more than a 64 KB buffer.
 *
 * Memory is a fixed buffer. The scan yields on a self-imposed time budget and
 * re-enqueues itself from `split_cursor` in Postgres, so a file of any size
 * spans as many invocations as it needs.
 *
 * Boundary detection tracks quote state, because splitting on every newline
 * would cut through a quoted field containing one and corrupt both halves.
 */

import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { blobStore, type BlobStore } from './blob-store.js';
import { Deadline } from './deadline.js';
import { recordChunks } from './job-store.js';
import type { IngestionQueue } from './queue.js';
import type { ProcessChunkMessage, SplitFileMessage } from './contracts.js';

const NEWLINE = 0x0a;
const QUOTE = 0x22;
const SCAN_BUFFER_BYTES = 64 * 1024;

/** Flush pending chunks to the database and queue every N chunks. */
const FLUSH_EVERY_CHUNKS = 50;

/** Reserved so an in-progress flush finishes before yielding. */
const FLUSH_RESERVE_MS = 5_000;

export interface SplitResult {
  chunksCreated: number;
  bytesScanned: number;
  completed: boolean;
  /** True when it yielded on its time budget and rescheduled itself. */
  rescheduled: boolean;
}

export interface SplitterDeps {
  queue: IngestionQueue;
  store?: BlobStore;
  budgetMs?: number;
  chunkRows?: number;
}

export async function runSplitter(
  message: SplitFileMessage,
  deps: SplitterDeps,
): Promise<SplitResult> {
  const store = deps.store ?? blobStore;
  const chunkRows = deps.chunkRows ?? config.INGESTION_CHUNK_ROWS;
  const deadline = new Deadline(deps.budgetMs ?? config.INGESTION_INVOCATION_BUDGET_MS);

  const { size: totalBytes } = await store.stat(message.fileKey);

  // Read once on the first invocation; column order then travels in each message.
  const { columns, dataStart } =
    message.fromByte === 0
      ? await readHeader(store, message.fileKey)
      : { columns: await readHeaderColumns(store, message.fileKey), dataStart: message.fromByte };

  let cursor = Math.max(message.fromByte, dataStart);
  let seq = message.seqFrom;
  let chunkStart = cursor;
  let rowsInChunk = 0;
  let inQuotes = false;

  let pending: { seq: number; byteStart: number; byteEnd: number }[] = [];
  let chunksCreated = 0;
  let rescheduled = false;

  const flush = async (upTo: number, completed: boolean): Promise<void> => {
    await recordChunks(message.jobId, pending, upTo, completed);
    await deps.queue.enqueueMany(
      pending.map(
        (chunk): ProcessChunkMessage => ({
          kind: 'process-chunk',
          jobId: message.jobId,
          seq: chunk.seq,
          fileKey: message.fileKey,
          byteStart: chunk.byteStart,
          byteEnd: chunk.byteEnd,
          columns,
        }),
      ),
    );
    chunksCreated += pending.length;
    pending = [];
  };

  scan: while (cursor < totalBytes) {
    const readEnd = Math.min(cursor + SCAN_BUFFER_BYTES, totalBytes);
    const buffer = await readAll(store, message.fileKey, cursor, readEnd);

    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i]!;

      if (byte === QUOTE) {
        // Toggling is enough: an escaped `""` toggles twice and leaves the
        // state unchanged, which is the right answer for "is this newline
        // inside a field?".
        inQuotes = !inQuotes;
        continue;
      }

      if (byte !== NEWLINE || inQuotes) continue;

      rowsInChunk++;
      if (rowsInChunk < chunkRows) continue;

      // Just past the newline, so ranges tile the file with no gaps or overlaps.
      const byteEnd = cursor + i + 1;
      pending.push({ seq, byteStart: chunkStart, byteEnd });
      seq++;
      chunkStart = byteEnd;
      rowsInChunk = 0;

      if (pending.length >= FLUSH_EVERY_CHUNKS) {
        await flush(chunkStart, false);

        // Only yield point: between chunks, nothing buffered, cursor durable.
        if (deadline.exhausted(FLUSH_RESERVE_MS)) {
          cursor = chunkStart;
          rescheduled = true;
          break scan;
        }
      }
    }

    if (rescheduled) break;
    cursor = readEnd;
  }

  if (rescheduled) {
    await deps.queue.enqueue({
      kind: 'split-file',
      jobId: message.jobId,
      fileKey: message.fileKey,
      fromByte: cursor,
      seqFrom: seq,
    });

    logger.info(
      { jobId: message.jobId, cursor, seq, elapsedMs: deadline.elapsedMs },
      'splitter yielded on time budget and rescheduled itself',
    );

    return { chunksCreated, bytesScanned: cursor, completed: false, rescheduled: true };
  }

  // Trailing partial chunk.
  if (chunkStart < totalBytes) {
    pending.push({ seq, byteStart: chunkStart, byteEnd: totalBytes });
  }

  await flush(totalBytes, true);

  logger.info(
    { jobId: message.jobId, chunksCreated, totalBytes, elapsedMs: deadline.elapsedMs },
    'split complete',
  );

  return { chunksCreated, bytesScanned: totalBytes, completed: true, rescheduled: false };
}

/** Read the header line and where the data starts. */
async function readHeader(
  store: BlobStore,
  fileKey: string,
): Promise<{ columns: string[]; dataStart: number }> {
  const { size } = await store.stat(fileKey);
  const probe = await readAll(store, fileKey, 0, Math.min(SCAN_BUFFER_BYTES, size));
  const newlineAt = probe.indexOf(NEWLINE);

  if (newlineAt === -1) {
    throw new Error(`Vendor file ${fileKey} has no header terminator in the first 64 KB`);
  }

  const header = probe.subarray(0, newlineAt).toString('utf8').replace(/\r$/, '');

  return {
    columns: header.split(',').map((c) => c.trim().replace(/^"|"$/g, '')),
    dataStart: newlineAt + 1,
  };
}

async function readHeaderColumns(store: BlobStore, fileKey: string): Promise<string[]> {
  return (await readHeader(store, fileKey)).columns;
}

async function readAll(
  store: BlobStore,
  fileKey: string,
  start: number,
  end: number,
): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);

  const parts: Buffer[] = [];
  for await (const part of store.readRange(fileKey, start, end)) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}
