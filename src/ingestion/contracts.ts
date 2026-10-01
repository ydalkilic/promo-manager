/**
 * Message contracts for the ingestion pipeline (Scenario A).
 *
 * Messages carry byte ranges, not row payloads, so they stay a few hundred
 * bytes regardless of file size — queue services cap message size (64 KB on
 * Azure Storage Queues, 256 KB on SQS).
 */

/** Ask the splitter to scan a file from `fromByte`. */
export interface SplitFileMessage {
  kind: 'split-file';
  jobId: string;
  fileKey: string;
  /** Resume point; a splitter out of time re-enqueues itself from here. */
  fromByte: number;
  seqFrom: number;
}

/** Ask a worker to ingest one bounded byte range of a file. */
export interface ProcessChunkMessage {
  kind: 'process-chunk';
  jobId: string;
  /**
   * Chunk identity is (jobId, seq), a natural key backed by a unique index, so
   * the worker resolves the row itself rather than depending on write ordering.
   */
  seq: number;
  fileKey: string;
  byteStart: number;
  /** Exclusive, and always aligned to a record boundary by the splitter. */
  byteEnd: number;
  /** Header column order, so each chunk parses without re-reading the file head. */
  columns: string[];
}

export type IngestionMessage = SplitFileMessage | ProcessChunkMessage;

export const INGESTION_QUEUE = 'modaco-ingestion';

/** A raw vendor record, before the dynamic pricing rules are applied. */
export interface VendorRecord {
  sku: string;
  name: string;
  category: string;
  /** Vendor list price, in minor units. Not what we sell at. */
  vendorPrice: number;
  /** Vendor cost, in minor units. The markup is applied to this. */
  cost: number;
  stockQuantity: number;
}

/** The outcome of applying the pricing rules to one record. */
export interface PricedRecord {
  sku: string;
  name: string;
  category: string;
  basePrice: number;
  stockQuantity: number;
}
