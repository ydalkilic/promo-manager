import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/prisma-test-client.js';
import { LocalBlobStore } from '../src/ingestion/blob-store.js';
import { runSplitter } from '../src/ingestion/splitter.js';
import { processChunk } from '../src/ingestion/chunk-processor.js';
import { createJob } from '../src/ingestion/job-store.js';
import type { IngestionMessage, ProcessChunkMessage, SplitFileMessage } from '../src/ingestion/contracts.js';
import type { IngestionQueue } from '../src/ingestion/queue.js';

/** Collects messages instead of enqueuing, so stages can be driven by hand. */
class FakeQueue implements IngestionQueue {
  readonly messages: IngestionMessage[] = [];
  async enqueue(m: IngestionMessage) { this.messages.push(m); }
  async enqueueMany(ms: IngestionMessage[]) { this.messages.push(...ms); }
  async close() {}
  chunks(): ProcessChunkMessage[] {
    return this.messages.filter((m): m is ProcessChunkMessage => m.kind === 'process-chunk');
  }
  splits(): SplitFileMessage[] {
    return this.messages.filter((m): m is SplitFileMessage => m.kind === 'split-file');
  }
}

let root: string;
let store: LocalBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modaco-ingest-'));
  store = new LocalBlobStore(root);
  await prisma.product.deleteMany({ where: { sku: { startsWith: 'IT-' } } });
});

async function writeCsv(key: string, rows: string[]): Promise<void> {
  await writeFile(join(root, key), `sku,name,category,vendor_price,cost,stock_quantity\n${rows.join('\n')}\n`);
}

function row(i: number, name = `Item ${i}`): string {
  return `IT-${String(i).padStart(5, '0')},${name},accessories,20.00,10.00,5`;
}

describe('splitter', () => {
  it('produces ranges that tile the file with no gaps or overlaps', async () => {
    await writeCsv('f.csv', Array.from({ length: 100 }, (_, i) => row(i)));
    const { size } = await store.stat('f.csv');
    const job = await createJob('f.csv', size);
    const queue = new FakeQueue();

    const result = await runSplitter(
      { kind: 'split-file', jobId: job.id, fileKey: 'f.csv', fromByte: 0, seqFrom: 0 },
      { queue, store, chunkRows: 10 },
    );

    expect(result.completed).toBe(true);
    const chunks = queue.chunks();
    expect(chunks).toHaveLength(10);

    // Contiguous and complete: a gap drops rows, an overlap double-counts them.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.byteStart).toBe(chunks[i - 1]!.byteEnd);
    }
    expect(chunks.at(-1)!.byteEnd).toBe(size);
    expect(chunks[0]!.columns).toEqual(['sku', 'name', 'category', 'vendor_price', 'cost', 'stock_quantity']);
  });

  /** A naive newline split would cut one record into two unparseable fragments. */
  it('never cuts inside a quoted field containing newlines', async () => {
    const rows = [
      row(0),
      `IT-00001,"Multi line name\nsecond line, with comma",accessories,20.00,10.00,5`,
      row(2),
      `IT-00003,"Another ""quoted"" value\nwith a newline",accessories,20.00,10.00,5`,
      row(4),
    ];
    await writeCsv('q.csv', rows);
    const { size } = await store.stat('q.csv');
    const job = await createJob('q.csv', size);
    const queue = new FakeQueue();

    await runSplitter(
      { kind: 'split-file', jobId: job.id, fileKey: 'q.csv', fromByte: 0, seqFrom: 0 },
      { queue, store, chunkRows: 1 },
    );

    // Five records, so five chunks — not seven as a raw newline split gives.
    expect(queue.chunks()).toHaveLength(5);

    for (const chunk of queue.chunks()) {
      await processChunk(chunk, { store });
    }

    const stored = await prisma.product.findMany({
      where: { sku: { startsWith: 'IT-' } },
      orderBy: { sku: 'asc' },
    });
    expect(stored).toHaveLength(5);
    expect(stored[1]!.name).toBe('Multi line name\nsecond line, with comma');
    expect(stored[3]!.name).toBe('Another "quoted" value\nwith a newline');
  });

  it('yields on its time budget and resumes from the durable cursor', async () => {
    await writeCsv('big.csv', Array.from({ length: 600 }, (_, i) => row(i)));
    const { size } = await store.stat('big.csv');
    const job = await createJob('big.csv', size);
    const queue = new FakeQueue();

    // Zero budget forces a yield at the first flush boundary.
    const first = await runSplitter(
      { kind: 'split-file', jobId: job.id, fileKey: 'big.csv', fromByte: 0, seqFrom: 0 },
      { queue, store, chunkRows: 1, budgetMs: 0 },
    );

    expect(first.completed).toBe(false);
    expect(first.rescheduled).toBe(true);
    expect(queue.splits()).toHaveLength(1);

    const continuation = queue.splits()[0]!;
    expect(continuation.fromByte).toBe(first.bytesScanned);

    // The cursor is durable, not just in the message.
    const persisted = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(Number(persisted.splitCursor)).toBe(first.bytesScanned);
    expect(persisted.splitCompleted).toBe(false);

    // Drive continuations as the queue would.
    let guard = 0;
    let next = continuation;
    for (;;) {
      const r = await runSplitter(next, { queue, store, chunkRows: 1, budgetMs: 0 });
      if (r.completed) break;
      next = queue.splits().at(-1)!;
      if (++guard > 50) throw new Error('splitter failed to converge');
    }

    const chunks = queue.chunks();
    expect(chunks).toHaveLength(600);

    // Resumption must not duplicate or drop ranges.
    const seqs = chunks.map((c) => c.seq);
    expect(new Set(seqs).size).toBe(600);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.byteStart).toBe(chunks[i - 1]!.byteEnd);
    }
    expect(chunks.at(-1)!.byteEnd).toBe(size);
  });
});

describe('chunk processing', () => {
  it('is idempotent under at-least-once redelivery', async () => {
    await writeCsv('idem.csv', Array.from({ length: 20 }, (_, i) => row(i)));
    const { size } = await store.stat('idem.csv');
    const job = await createJob('idem.csv', size);
    const queue = new FakeQueue();

    await runSplitter(
      { kind: 'split-file', jobId: job.id, fileKey: 'idem.csv', fromByte: 0, seqFrom: 0 },
      { queue, store, chunkRows: 20 },
    );

    const chunk = queue.chunks()[0]!;

    const first = await processChunk(chunk, { store });
    expect(first.status).toBe('completed');
    expect(first.rowsProcessed).toBe(20);

    // What a queue does after a visibility timeout expires.
    const second = await processChunk(chunk, { store });
    expect(second.status).toBe('skipped');
    expect(second.rowsProcessed).toBe(0);

    expect(await prisma.product.count({ where: { sku: { startsWith: 'IT-' } } })).toBe(20);

    // The job's row counter must not be double-incremented by the redelivery.
    const refreshed = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(Number(refreshed.rowsProcessed)).toBe(20);
  });

  /** Without collapsing, Postgres errors and every retry fails identically. */
  it('collapses duplicate SKUs inside a single batch', async () => {
    await writeCsv('dupes.csv', [
      row(1, 'Original'),
      row(2),
      row(1, 'Corrected'),
    ]);
    const { size } = await store.stat('dupes.csv');
    const job = await createJob('dupes.csv', size);
    const queue = new FakeQueue();

    await runSplitter(
      { kind: 'split-file', jobId: job.id, fileKey: 'dupes.csv', fromByte: 0, seqFrom: 0 },
      { queue, store, chunkRows: 10 },
    );

    const result = await processChunk(queue.chunks()[0]!, { store });

    expect(result.status).toBe('completed');
    expect(result.rowsProcessed).toBe(2);

    // Last occurrence wins.
    const stored = await prisma.product.findFirstOrThrow({ where: { sku: 'IT-00001' } });
    expect(stored.name).toBe('Corrected');
  });

  it('rejects malformed rows without failing the chunk', async () => {
    await writeCsv('mixed.csv', [
      row(1),
      `IT-00002,Bad Price,accessories,not-a-number,10.00,5`,
      row(3),
      `,Missing SKU,accessories,20.00,10.00,5`,
    ]);
    const { size } = await store.stat('mixed.csv');
    const job = await createJob('mixed.csv', size);
    const queue = new FakeQueue();

    await runSplitter(
      { kind: 'split-file', jobId: job.id, fileKey: 'mixed.csv', fromByte: 0, seqFrom: 0 },
      { queue, store, chunkRows: 10 },
    );

    const result = await processChunk(queue.chunks()[0]!, { store });

    expect(result.status).toBe('completed');
    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsRejected).toBe(2);
    expect(result.rejections.map((r) => r.reason)).toContain('invalid vendor price');
  });
});

afterAll(async () => {
  await prisma.product.deleteMany({ where: { sku: { startsWith: 'IT-' } } });
  await prisma.$disconnect();
});
