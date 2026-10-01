/**
 * Promotion writes. Each mutation: a friendly pre-check, the write guarded by the
 * EXCLUDE constraints, then an epoch bump once committed.
 *
 * The pre-check exists only for error messages — it is racy and never relied on.
 * The constraint is the authority. See ADR-003.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { bumpEpoch } from '../../cache/epoch.js';
import { clearL1 } from '../../cache/index.js';
import { logger } from '../../logger.js';
import { NotFoundError, PromotionConflictError, ValidationError } from '../../http/errors.js';
import type {
  AssignPromotionInput,
  CreatePromotionInput,
} from './promotion.schemas.js';

/** Postgres SQLSTATE for a violated EXCLUDE constraint. */
const EXCLUSION_VIOLATION = '23P01';

const CONFLICT_CONSTRAINTS: Record<string, string> = {
  promotions_no_overlap_per_product:
    'This product already has an active promotion overlapping the requested dates. ' +
    'A product can have at most one active promotion at a time.',
  promotions_no_overlap_per_category:
    'This category already has an active promotion overlapping the requested dates. ' +
    'Cancel or reschedule the existing promotion first.',
};

/**
 * Prisma does not map exclusion violations to an error code, so the driver error
 * is inspected directly. Matching constraint *names* rather than message text
 * keeps this stable across Postgres locales.
 */
function translateWriteError(err: unknown): never {
  const meta = err instanceof Prisma.PrismaClientKnownRequestError ? err.meta : undefined;
  const haystack = JSON.stringify(meta ?? '') + (err instanceof Error ? err.message : '');

  if (haystack.includes(EXCLUSION_VIOLATION) || haystack.includes('exclusion constraint')) {
    for (const [constraint, message] of Object.entries(CONFLICT_CONSTRAINTS)) {
      if (haystack.includes(constraint)) throw new PromotionConflictError(message, { constraint });
    }
    throw new PromotionConflictError('Promotion conflicts with an existing active promotion.');
  }

  if (haystack.includes('promotions_value_chk')) {
    throw new ValidationError('Discount value is out of range for the chosen discount type.');
  }
  if (haystack.includes('promotions_window_chk')) {
    throw new ValidationError('endsAt must be after startsAt.');
  }
  if (haystack.includes('foreign key') || haystack.includes('promotions_product_id_fkey')) {
    throw new ValidationError('The referenced product does not exist.');
  }

  throw err;
}

/** Advisory pre-check; the EXCLUDE constraint is the authority. */
async function findOverlapping(
  target: { scope: 'PRODUCT'; productId: string } | { scope: 'CATEGORY'; category: string },
  startsAt: Date,
  endsAt: Date,
  excludePromotionId?: string,
) {
  return prisma.promotion.findFirst({
    where: {
      status: 'ACTIVE',
      scope: target.scope,
      ...(target.scope === 'PRODUCT'
        ? { productId: target.productId }
        : { category: target.category }),
      ...(excludePromotionId ? { id: { not: excludePromotionId } } : {}),
// [a,b) intersects [c,d) iff a < d and c < b.
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true, name: true, startsAt: true, endsAt: true },
  });
}

export async function createPromotion(input: CreatePromotionInput) {
  const target =
    input.scope === 'PRODUCT'
      ? ({ scope: 'PRODUCT', productId: input.productId } as const)
      : ({ scope: 'CATEGORY', category: input.category } as const);

  if (target.scope === 'PRODUCT') {
    const exists = await prisma.product.findUnique({
      where: { id: target.productId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError('Product', target.productId);
  }

  const clash = await findOverlapping(target, input.startsAt, input.endsAt);
  if (clash) {
    throw new PromotionConflictError(
      CONFLICT_CONSTRAINTS[
        target.scope === 'PRODUCT'
          ? 'promotions_no_overlap_per_product'
          : 'promotions_no_overlap_per_category'
      ]!,
      {
        conflictingPromotion: {
          id: clash.id,
          name: clash.name,
          startsAt: clash.startsAt,
          endsAt: clash.endsAt,
        },
      },
    );
  }

  let promotion;
  try {
    promotion = await prisma.promotion.create({
      data: {
        name: input.name,
        discountType: input.discountType,
        value: new Prisma.Decimal(input.value),
        scope: target.scope,
        productId: target.scope === 'PRODUCT' ? target.productId : null,
        category: target.scope === 'CATEGORY' ? target.category : null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
    });
  } catch (err) {
    translateWriteError(err);
  }

  // The write above touched one row; this INCR makes it visible everywhere.
  await invalidate(`promotion ${promotion.id} created`);

  logger.info(
    { promotionId: promotion.id, scope: promotion.scope, category: promotion.category },
    'promotion created',
  );

  return promotion;
}

export async function cancelPromotion(id: string) {
  const existing = await prisma.promotion.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Promotion', id);

  // Idempotent: re-cancelling is a no-op.
  if (existing.status === 'CANCELLED') return existing;

  const promotion = await prisma.promotion.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  await invalidate(`promotion ${id} cancelled`);
  logger.info({ promotionId: id }, 'promotion cancelled');

  return promotion;
}

/**
 * Re-target a promotion. Moving one onto a product that already has one must
 * fail, and the same EXCLUDE constraint covers it — it guards table state, not
 * just the insert path.
 */
export async function assignPromotion(id: string, input: AssignPromotionInput) {
  const existing = await prisma.promotion.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Promotion', id);

  if (existing.status !== 'ACTIVE') {
    throw new ValidationError('Only an active promotion can be assigned to a new target.');
  }

  if (input.scope === 'PRODUCT') {
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundError('Product', input.productId);
  }

  const clash = await findOverlapping(input, existing.startsAt, existing.endsAt, id);
  if (clash) {
    throw new PromotionConflictError(
      'The target already has an active promotion overlapping this promotion\'s dates.',
      { conflictingPromotion: { id: clash.id, name: clash.name } },
    );
  }

  let promotion;
  try {
    promotion = await prisma.promotion.update({
      where: { id },
      data: {
        scope: input.scope,
        productId: input.scope === 'PRODUCT' ? input.productId : null,
        category: input.scope === 'CATEGORY' ? input.category : null,
      },
    });
  } catch (err) {
    translateWriteError(err);
  }

  await invalidate(`promotion ${id} reassigned`);
  logger.info({ promotionId: id, scope: input.scope }, 'promotion reassigned');

  return promotion;
}

export async function getPromotion(id: string) {
  const promotion = await prisma.promotion.findUnique({ where: { id } });
  if (!promotion) throw new NotFoundError('Promotion', id);
  return promotion;
}

export async function listPromotions(filter: {
  status?: 'ACTIVE' | 'CANCELLED' | undefined;
  scope?: 'PRODUCT' | 'CATEGORY' | undefined;
  category?: string | undefined;
  productId?: string | undefined;
  activeAt?: Date | undefined;
  limit: number;
}) {
  return prisma.promotion.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.scope ? { scope: filter.scope } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.productId ? { productId: filter.productId } : {}),
      ...(filter.activeAt
        ? { startsAt: { lte: filter.activeAt }, endsAt: { gt: filter.activeAt } }
        : {}),
    },
    orderBy: [{ startsAt: 'desc' }],
    take: filter.limit,
  });
}

/**
 * Bump the epoch after commit and drop this process's L1. Other replicas notice
 * within their own L1 TTL, the documented staleness bound.
 */
async function invalidate(reason: string): Promise<void> {
  await bumpEpoch(reason);
  clearL1();
}
