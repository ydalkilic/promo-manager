/**
 * Blob storage. The pipeline reads bounded byte ranges and never holds a whole
 * file, which is what keeps memory flat at any file size. S3 and Azure Blob both
 * support the same `Range` primitive, so the local implementation is faithful.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../config/index.js';

export interface BlobStat {
  key: string;
  size: number;
}

export interface BlobStore {
  stat(key: string): Promise<BlobStat>;
  /** Read `[start, end)`. Both bounds in bytes; `end` is exclusive. */
  readRange(key: string, start: number, end: number): Readable;
  write(key: string, source: Readable): Promise<BlobStat>;
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string = config.BLOB_STORAGE_ROOT) {}

  private path(key: string): string {
    const full = resolve(join(this.root, key));
    // Vendor-supplied keys reach here, so path traversal is a real input.
    if (!full.startsWith(resolve(this.root))) {
      throw new Error(`Blob key escapes storage root: ${key}`);
    }
    return full;
  }

  async stat(key: string): Promise<BlobStat> {
    const { size } = await stat(this.path(key));
    return { key, size };
  }

  readRange(key: string, start: number, end: number): Readable {
    // node's `end` is inclusive; the pipeline uses half-open ranges.
    return createReadStream(this.path(key), { start, end: end - 1 });
  }

  async write(key: string, source: Readable): Promise<BlobStat> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(source, createWriteStream(target));
    return this.stat(key);
  }
}

export const blobStore: BlobStore = new LocalBlobStore();
