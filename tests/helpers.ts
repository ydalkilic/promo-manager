import { prisma } from '../src/prisma-test-client.js';

export const CATEGORY = `test-cat-${process.pid}`;

export async function resetFixtures(): Promise<void> {
  await prisma.promotion.deleteMany({ where: { OR: [{ category: CATEGORY }, { product: { category: CATEGORY } }] } });
  await prisma.product.deleteMany({ where: { category: CATEGORY } });
}

export async function createProduct(sku: string, basePrice: string, category = CATEGORY) {
  return prisma.product.create({
    data: { sku: `${sku}-${process.pid}`, name: sku, category, basePrice, stockQuantity: 1 },
  });
}

export const HOUR = 3_600_000;
export const past = (h = 1) => new Date(Date.now() - h * HOUR);
export const future = (h = 1) => new Date(Date.now() + h * HOUR);
