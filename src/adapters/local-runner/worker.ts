/**
 * Local / containerised worker: the second adapter over the same pipeline, so the
 * system runs without a cloud account. Kill it mid-run and restart — the job
 * resumes from its last durable chunk.
 *
 * Contains no business logic, only message dispatch.
 */

import { Worker } from 'bullmq';
import { config } from '../../config/index.js';
import { logger } from '../../logger.js';
import { createQueueConnection } from '../../cache/redis.js';
import { INGESTION_QUEUE, type IngestionMessage } from '../../ingestion/contracts.js';
import { runSplitter } from '../../ingestion/splitter.js';
import { processChunk } from '../../ingestion/chunk-processor.js';
import { getIngestionQueue } from '../../ingestion/queue.js';
import { disconnectPrisma } from '../../db/prisma.js';

const worker = new Worker<IngestionMessage>(
  INGESTION_QUEUE,
  async (job) => {
    const message = job.data;

    if (message.kind === 'split-file') {
      return runSplitter(message, { queue: getIngestionQueue() });
    }

    return processChunk(message);
  },
  {
    connection: createQueueConnection(),
    // Each concurrent chunk holds a Postgres connection, so unbounded
    // parallelism exhausts the pool and starts failing chunks.
    concurrency: config.INGESTION_WORKER_CONCURRENCY,
  },
);

worker.on('completed', (job) => {
  logger.debug({ jobId: job.id, kind: job.name }, 'queue job completed');
});

worker.on('failed', (job, err) => {
  logger.warn({ jobId: job?.id, kind: job?.name, err: err.message }, 'queue job failed');
});

logger.info(
  { concurrency: config.INGESTION_WORKER_CONCURRENCY, queue: INGESTION_QUEUE },
  'ingestion worker started',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  // Waits for in-flight chunks so none is abandoned mid-batch.
  await worker.close();
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
