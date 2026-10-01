/**
 * Ingestion entry point.
 *
 * Deliberately does not accept the upload. The file arrives in object storage
 * out of band and the API is only notified of its key; pushing a multi-hundred
 * -megabyte body through a handler would hold the request open for the whole job,
 * which is the failure mode the design exists to avoid.
 *
 * So the trigger is O(1): record a job, enqueue one message, return 202.
 */

import { logger } from '../logger.js';
import { config } from '../config/index.js';
import { prisma } from '../db/prisma.js';
import { NotFoundError, TooManyRequestsError, ValidationError } from '../http/errors.js';
import { blobStore } from './blob-store.js';
import { createJob, getJobProgress } from './job-store.js';
import { getIngestionQueue } from './queue.js';

/** Job states that still consume worker and database capacity. */
const IN_FLIGHT = ['SPLITTING', 'PROCESSING'] as const;

export async function startIngestion(fileKey: string) {
  // Fail fast, and translate the storage error: an unresolvable key is a caller
  // mistake, and a raw ENOENT would surface as a 500.
  let size: number;
  try {
    ({ size } = await blobStore.stat(fileKey));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError('Vendor file', fileKey);
    }
    throw err;
  }

  if (size === 0) throw new ValidationError(`Vendor file ${fileKey} is empty`);

  /**
   * De-duplicate before capping. Returning the in-flight job makes the trigger
   * idempotent — a retried webhook should not start a second import — and keeps
   * the accidental case from consuming a slot against the cap.
   */
  const existing = await prisma.ingestionJob.findFirst({
    where: { fileKey, status: { in: [...IN_FLIGHT] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, totalBytes: true },
  });

  if (existing) {
    logger.info({ jobId: existing.id, fileKey }, 'ingestion already in flight — returning it');
    return { jobId: existing.id, fileKey, totalBytes: Number(existing.totalBytes), deduplicated: true };
  }

  /**
   * Capacity cap. One trigger fans out to ~250 chunk jobs, each holding a
   * connection while it writes. Rate limiting alone is insufficient: requests
   * spread over minutes stay inside any per-minute budget while still stacking
   * up unbounded concurrent work.
   */
  const activeJobs = await prisma.ingestionJob.count({
    where: { status: { in: [...IN_FLIGHT] } },
  });

  if (activeJobs >= config.MAX_ACTIVE_INGESTION_JOBS) {
    throw new TooManyRequestsError(
      `${activeJobs} ingestion jobs are already in flight ` +
        `(limit ${config.MAX_ACTIVE_INGESTION_JOBS}). Retry once one completes.`,
      { activeJobs, limit: config.MAX_ACTIVE_INGESTION_JOBS },
    );
  }

  const job = await createJob(fileKey, size);

  await getIngestionQueue().enqueue({
    kind: 'split-file',
    jobId: job.id,
    fileKey,
    fromByte: 0,
    seqFrom: 0,
  });

  logger.info({ jobId: job.id, fileKey, size }, 'ingestion job accepted');

  return { jobId: job.id, fileKey, totalBytes: size };
}

export async function getIngestionStatus(jobId: string) {
  return getJobProgress(jobId);
}
