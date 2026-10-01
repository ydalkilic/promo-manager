/**
 * Queue abstraction. BullMQ backs the local setup; the interface is deliberately
 * two methods, the whole surface shared with Azure Storage Queues and SQS. The
 * splitter and chunk processor never import BullMQ.
 */

import { Queue } from 'bullmq';
import { createQueueConnection } from '../cache/redis.js';
import { INGESTION_QUEUE, type IngestionMessage } from './contracts.js';
import { config } from '../config/index.js';

export interface IngestionQueue {
  enqueue(message: IngestionMessage): Promise<void>;
  enqueueMany(messages: IngestionMessage[]): Promise<void>;
  close(): Promise<void>;
}

export class BullIngestionQueue implements IngestionQueue {
  private readonly queue: Queue;

  constructor() {
    this.queue = new Queue(INGESTION_QUEUE, {
      connection: createQueueConnection(),
      defaultJobOptions: {
        attempts: config.INGESTION_MAX_ATTEMPTS,
        // A chunk usually fails because the database is briefly saturated;
        // retrying immediately makes that worse.
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
  }

  async enqueue(message: IngestionMessage): Promise<void> {
    await this.queue.add(message.kind, message, jobOptionsFor(message));
  }

  /** Batched: the splitter emits hundreds of messages per invocation. */
  async enqueueMany(messages: IngestionMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.queue.addBulk(
      messages.map((message) => ({
        name: message.kind,
        data: message,
        opts: jobOptionsFor(message),
      })),
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Deterministic job ids let the queue discard re-emitted chunks after a partial
 * splitter failure. Complements, not replaces, the database-level idempotency.
 */
function jobOptionsFor(message: IngestionMessage): { jobId: string } {
  return {
    jobId:
      message.kind === 'process-chunk'
        ? `chunk:${message.jobId}:${message.seq}`
        : `split:${message.jobId}:${message.fromByte}`,
  };
}

let singleton: IngestionQueue | undefined;

export function getIngestionQueue(): IngestionQueue {
  singleton ??= new BullIngestionQueue();
  return singleton;
}
