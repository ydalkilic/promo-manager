/**
 * Azure Functions adapter (Consumption plan).
 *
 * One of two adapters over the same pipeline; neither contains business logic.
 * The serverless constraints are honoured by the pipeline itself, so it behaves
 * identically here, in a container, or on Lambda. See ADR-012.
 *
 * Deployment settings that matter are documented in host.json: `functionTimeout`
 * must exceed the invocation budget, `maxDequeueCount` must be at least
 * INGESTION_MAX_ATTEMPTS, and `batchSize` bounds per-instance concurrency so a
 * scaled-out plan cannot exhaust Postgres.
 */

import { app, type InvocationContext } from '@azure/functions';
import type { IngestionMessage, ProcessChunkMessage, SplitFileMessage } from '../../ingestion/contracts.js';
import { runSplitter } from '../../ingestion/splitter.js';
import { processChunk } from '../../ingestion/chunk-processor.js';
import { getIngestionQueue } from '../../ingestion/queue.js';
import { logger } from '../../logger.js';

/**
 * One queue for both stages, so ordering is irrelevant and the splitter can
 * re-enqueue itself through the same path. Unrecognised messages are logged and
 * acknowledged rather than retried forever.
 */
export async function ingestionQueueHandler(
  message: IngestionMessage,
  context: InvocationContext,
): Promise<void> {
  const invocationId = context.invocationId;

  if (message.kind === 'split-file') {
    const result = await runSplitter(message as SplitFileMessage, {
      queue: getIngestionQueue(),
    });
    context.log(
      `split ${result.bytesScanned} bytes, ${result.chunksCreated} chunks, ` +
        `${result.rescheduled ? 'rescheduled' : 'complete'}`,
    );
    return;
  }

  if (message.kind === 'process-chunk') {
    const result = await processChunk(message as ProcessChunkMessage);
    context.log(`chunk ${message.seq}: ${result.status}, ${result.rowsProcessed} rows`);
    return;
  }

  logger.warn({ invocationId, message }, 'unrecognised ingestion message — acknowledging');
}

app.storageQueue('ingestion', {
  queueName: process.env.INGESTION_QUEUE_NAME ?? 'modaco-ingestion',
  connection: 'AzureWebJobsStorage',
  handler: ingestionQueueHandler,
});
