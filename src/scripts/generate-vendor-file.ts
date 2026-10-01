/**
 * Generate a synthetic vendor file for Scenario A. Writes with backpressure,
 * since producing the file is itself a streaming problem.
 *
 * The output is deliberately not clean — duplicate SKUs exercise the intra-batch
 * de-duplication, quoted newlines exercise the splitter's boundary scanner, and
 * invalid rows exercise per-row rejection.
 *
 * Usage: npm run generate:vendor-file -- [rows] [outputKey]
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { config } from '../config/index.js';

const CATEGORIES = [
  'accessories',
  'outerwear',
  'footwear',
  'luxury',
  'knitwear',
  'denim',
  'dresses',
  'shirts',
];

const ADJECTIVES = ['Classic', 'Tailored', 'Relaxed', 'Cropped', 'Oversized', 'Slim', 'Draped'];
const NOUNS = ['Jacket', 'Scarf', 'Loafer', 'Coat', 'Sweater', 'Jean', 'Dress', 'Shirt'];

async function main(): Promise<void> {
  const rows = Number.parseInt(process.argv[2] ?? '500000', 10);
  const key = process.argv[3] ?? 'vendor/weekly-sync.csv';

  const target = resolve(join(config.BLOB_STORAGE_ROOT, key));
  await mkdir(dirname(target), { recursive: true });

  const out = createWriteStream(target, { highWaterMark: 1 << 20 });
  const startedAt = Date.now();

  await write(out, 'sku,name,category,vendor_price,cost,stock_quantity\n');

  for (let i = 0; i < rows; i++) {
    await write(out, buildRow(i));

    if (i > 0 && i % 100_000 === 0) {
      process.stdout.write(`  ${i.toLocaleString()} rows...\n`);
    }
  }

  out.end();
  await once(out, 'finish');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(
    `\nWrote ${rows.toLocaleString()} rows to ${key} in ${elapsed}s\n` +
      `Path: ${target}\n\n` +
      `Trigger ingestion with:\n` +
      `  curl -X POST localhost:3000/api/ingestion/jobs \\\n` +
      `    -H 'content-type: application/json' \\\n` +
      `    -d '{"fileKey":"${key}"}'\n`,
  );
}

function buildRow(i: number): string {
  const category = CATEGORIES[i % CATEGORIES.length]!;
  const name = `${ADJECTIVES[i % ADJECTIVES.length]} ${NOUNS[(i >> 3) % NOUNS.length]} ${i}`;
  const cost = (5 + ((i * 7919) % 40_000) / 100).toFixed(2);
  const vendorPrice = (Number(cost) * 1.4).toFixed(2);
  const stock = (i * 31) % 500;

  // Distinct residues of one modulus, so the three cases are disjoint by
  // construction. Separate moduli made the invalid case dead code (every
  // multiple of 10,000 is also one of 5,000). The residues are also not
  // multiples of UPSERT_BATCH_ROWS, or duplicate pairs would straddle a batch
  // boundary every time and never exercise the de-duplication path.
  const bucket = i % 5_000;

  // A corrected line later in the export; collapsing these is required.
  if (i > 0 && bucket === 137) {
    const duplicated = i - 1;
    return `SKU-${String(duplicated).padStart(8, '0')},Corrected ${name},${category},${vendorPrice},${cost},${stock}\n`;
  }

  // Quoted multi-line description: a naive newline split would corrupt it.
  if (i > 0 && bucket === 1_234) {
    return `SKU-${String(i).padStart(8, '0')},"${name}\nSecond line of description, with a comma",${category},${vendorPrice},${cost},${stock}\n`;
  }

  // Must be rejected and counted while the rest of the chunk still lands.
  if (i > 0 && bucket === 2_345) {
    return `SKU-${String(i).padStart(8, '0')},${name},${category},not-a-price,${cost},${stock}\n`;
  }

  return `SKU-${String(i).padStart(8, '0')},${name},${category},${vendorPrice},${cost},${stock}\n`;
}

/** Write honouring backpressure. */
async function write(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
