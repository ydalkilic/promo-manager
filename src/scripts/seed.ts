/** A small catalogue where the promotion precedence rules are visible at a glance. */

import { prisma } from '../db/prisma.js';
import { bumpEpoch } from '../cache/epoch.js';
import { disconnectPrisma } from '../db/prisma.js';
import { disconnectRedis } from '../cache/redis.js';
import { Prisma } from '@prisma/client';

const PRODUCTS = [
  { sku: 'ACC-001', name: 'Leather Belt', category: 'accessories', basePrice: '89.00', stockQuantity: 42 },
  { sku: 'ACC-002', name: 'Silk Scarf', category: 'accessories', basePrice: '129.00', stockQuantity: 18 },
  { sku: 'ACC-003', name: 'Wool Gloves', category: 'accessories', basePrice: '45.00', stockQuantity: 90 },
  { sku: 'OUT-001', name: 'Trench Coat', category: 'outerwear', basePrice: '450.00', stockQuantity: 12 },
  { sku: 'OUT-002', name: 'Quilted Jacket', category: 'outerwear', basePrice: '320.00', stockQuantity: 25 },
  { sku: 'FTW-001', name: 'Suede Loafer', category: 'footwear', basePrice: '240.00', stockQuantity: 30 },
];

async function main(): Promise<void> {
  await prisma.promotion.deleteMany({});
  await prisma.product.deleteMany({});

  await prisma.product.createMany({
    data: PRODUCTS.map((p) => ({ ...p, basePrice: new Prisma.Decimal(p.basePrice) })),
  });

  const belt = await prisma.product.findUniqueOrThrow({ where: { sku: 'ACC-001' } });
  const now = new Date();
  const inAWeek = new Date(now.getTime() + 7 * 86_400_000);

  // One row, three products repriced.
  await prisma.promotion.create({
    data: {
      name: 'Flash Sale — 50% Off All Accessories',
      discountType: 'PERCENTAGE',
      value: new Prisma.Decimal(50),
      scope: 'CATEGORY',
      category: 'accessories',
      startsAt: new Date(now.getTime() - 3_600_000),
      endsAt: inAWeek,
    },
  });

  // Already covered by the flash sale: a precedence case, not a conflict.
  await prisma.promotion.create({
    data: {
      name: 'Belt Clearance — 30 off',
      discountType: 'FIXED_AMOUNT',
      value: new Prisma.Decimal(30),
      scope: 'PRODUCT',
      productId: belt.id,
      startsAt: new Date(now.getTime() - 3_600_000),
      endsAt: inAWeek,
    },
  });

  await bumpEpoch('seed');

  process.stdout.write(
    `Seeded ${PRODUCTS.length} products and 2 promotions.\n\n` +
      `Expected effective prices:\n` +
      `  Leather Belt  89.00 -> 59.00  (PRODUCT promo wins over the category flash sale)\n` +
      `  Silk Scarf   129.00 -> 64.50  (category flash sale)\n` +
      `  Wool Gloves   45.00 -> 22.50  (category flash sale)\n` +
      `  Trench Coat  450.00 -> 450.00 (no promotion)\n\n` +
      `Try:  curl 'localhost:3000/api/products?category=accessories&sort=effective_price'\n`,
  );
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
  });
