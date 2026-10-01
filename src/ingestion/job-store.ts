/**
 * Durable bookkeeping — the pipeline's memory. A stateless runtime forgets
 * everything at invocation end, so progress lives here and any invocation can
 * be killed without losing work.
 */

import { prisma } from '../db/prisma.js';

export async function createJob(fileKey: string, totalBytes: number) {
  return prisma.ingestionJob.create({
    data: { fileKey, totalBytes: BigInt(totalBytes), status: 'SPLITTING' },
  });
}

export async function getJob(jobId: string) {
  return prisma.ingestionJob.findUnique({ where: { id: jobId } });
}

/**
 * Record chunks and advance the cursor in one transaction. If the rows committed
 * but the cursor did not, a retried splitter would rescan and the job's chunk
 * count would be wrong even though the unique index rejected the duplicates.
 */
export async function recordChunks(
  jobId: string,
  chunks: { seq: number; byteStart: number; byteEnd: number }[],
  cursor: number,
  splitCompleted: boolean,
) {
  return prisma.$transaction(async (tx) => {
    if (chunks.length > 0) {
      await tx.ingestionChunk.createMany({
        data: chunks.map((c) => ({
          jobId,
          seq: c.seq,
          byteStart: BigInt(c.byteStart),
          byteEnd: BigInt(c.byteEnd),
        })),
        // A re-emitted chunk is expected: the row and the queued work exist.
        skipDuplicates: true,
      });
    }

    return tx.ingestionJob.update({
      where: { id: jobId },
      data: {
        splitCursor: BigInt(cursor),
        splitCompleted,
        chunksTotal: { increment: chunks.length },
        ...(splitCompleted ? { status: 'PROCESSING' } : {}),
      },
    });
  });
}

/**
 * Claim a chunk. The conditional update is the idempotency gate: a redelivery of
 * an already-COMPLETED chunk updates zero rows, so the caller returns without
 * touching products.
 */
export async function claimChunk(
  jobId: string,
  seq: number,
): Promise<{ outcome: 'claimed' | 'already-completed' | 'unknown'; attempts: number }> {
  const chunk = await prisma.ingestionChunk.findUnique({
    where: { jobId_seq: { jobId, seq } },
    select: { status: true, attempts: true },
  });

  if (!chunk) return { outcome: 'unknown', attempts: 0 };
  if (chunk.status === 'COMPLETED') return { outcome: 'already-completed', attempts: chunk.attempts };

  const { count } = await prisma.ingestionChunk.updateMany({
    where: { jobId, seq, status: { not: 'COMPLETED' } },
    data: { status: 'IN_PROGRESS', attempts: { increment: 1 } },
  });

  // count === 0: another worker finished it between read and write.
  return {
    outcome: count === 1 ? 'claimed' : 'already-completed',
    attempts: chunk.attempts + 1,
  };
}

export async function completeChunk(
  jobId: string,
  seq: number,
  rowsProcessed: number,
  rowsRejected: number,
) {
  await prisma.$transaction([
    prisma.ingestionChunk.update({
      where: { jobId_seq: { jobId, seq } },
      data: { status: 'COMPLETED', rowsProcessed, rowsRejected, error: null },
    }),
    prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        rowsProcessed: { increment: BigInt(rowsProcessed) },
        rowsRejected: { increment: BigInt(rowsRejected) },
      },
    }),
  ]);
}

export async function failChunk(jobId: string, seq: number, error: string) {
  await prisma.ingestionChunk.update({
    where: { jobId_seq: { jobId, seq } },
    data: { status: 'FAILED', error: error.slice(0, 2_000) },
  });
}

/** Byte range of a recorded chunk, for re-reading on retry. */
export async function getChunkRange(jobId: string, seq: number) {
  const chunk = await prisma.ingestionChunk.findUnique({
    where: { jobId_seq: { jobId, seq } },
    select: { byteStart: true, byteEnd: true },
  });

  return chunk
    ? { byteStart: Number(chunk.byteStart), byteEnd: Number(chunk.byteEnd) }
    : null;
}

/**
 * Close the job once every chunk is terminal. Called after each chunk rather
 * than by a coordinator — there is no long-lived process to hold that role, so
 * the last worker to finish notices.
 */
export async function finaliseJobIfComplete(jobId: string) {
  const job = await prisma.ingestionJob.findUnique({
    where: { id: jobId },
    select: { splitCompleted: true, status: true },
  });

  if (!job || !job.splitCompleted || job.status === 'COMPLETED' || job.status === 'FAILED') {
    return null;
  }

  const outstanding = await prisma.ingestionChunk.count({
    where: { jobId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
  });
  if (outstanding > 0) return null;

  const failed = await prisma.ingestionChunk.count({ where: { jobId, status: 'FAILED' } });

  return prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: failed > 0 ? 'FAILED' : 'COMPLETED',
      completedAt: new Date(),
      ...(failed > 0 ? { error: `${failed} chunk(s) failed after exhausting retries` } : {}),
    },
  });
}

export async function getJobProgress(jobId: string) {
  const [job, byStatus] = await Promise.all([
    prisma.ingestionJob.findUnique({ where: { id: jobId } }),
    prisma.ingestionChunk.groupBy({
      by: ['status'],
      where: { jobId },
      _count: { _all: true },
    }),
  ]);

  if (!job) return null;

  const chunks = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]));

  return {
    id: job.id,
    fileKey: job.fileKey,
    status: job.status,
    totalBytes: Number(job.totalBytes),
    bytesScanned: Number(job.splitCursor),
    splitCompleted: job.splitCompleted,
    chunksTotal: job.chunksTotal,
    chunks: {
      pending: chunks.PENDING ?? 0,
      inProgress: chunks.IN_PROGRESS ?? 0,
      completed: chunks.COMPLETED ?? 0,
      failed: chunks.FAILED ?? 0,
    },
    rowsProcessed: Number(job.rowsProcessed),
    rowsRejected: Number(job.rowsRejected),
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}
