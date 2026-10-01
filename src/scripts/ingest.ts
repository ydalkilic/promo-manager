/**
 * Trigger an ingestion job and follow it to completion.
 * Usage: npm run ingest -- [fileKey]
 *
 * Requires `npm run worker`. That separation is the architecture: this only
 * enqueues, and all work happens in short-lived worker invocations.
 */

import { startIngestion, getIngestionStatus } from '../ingestion/ingestion.service.js';
import { disconnectPrisma } from '../db/prisma.js';
import { disconnectRedis } from '../cache/redis.js';

async function main(): Promise<void> {
  const fileKey = process.argv[2] ?? 'vendor/weekly-sync.csv';

  const { jobId, totalBytes } = await startIngestion(fileKey);
  process.stdout.write(
    `Job ${jobId} accepted for ${fileKey} (${(totalBytes / 1_048_576).toFixed(1)} MB)\n\n`,
  );

  const startedAt = Date.now();

  for (;;) {
    await new Promise((r) => setTimeout(r, 1_000));
    const status = await getIngestionStatus(jobId);
    if (!status) break;

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const rate = status.rowsProcessed / Math.max(1, Number(elapsed));

    process.stdout.write(
      `\r[${elapsed}s] ${status.status.padEnd(10)} ` +
        `chunks ${status.chunks.completed}/${status.chunksTotal}` +
        `${status.chunks.failed ? ` (${status.chunks.failed} failed)` : ''}  ` +
        `rows ${status.rowsProcessed.toLocaleString()}` +
        `${status.rowsRejected ? ` (${status.rowsRejected} rejected)` : ''}  ` +
        `${Math.round(rate).toLocaleString()}/s   `,
    );

    if (status.status === 'COMPLETED' || status.status === 'FAILED') {
      process.stdout.write(`\n\nFinished: ${status.status}\n`);
      if (status.error) process.stdout.write(`Error: ${status.error}\n`);
      break;
    }
  }

  await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
