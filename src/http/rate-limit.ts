/**
 * Redis-backed rate limiting, by route class, because request costs differ by
 * orders of magnitude — a cached read versus a simulation sort versus an
 * ingestion trigger that fans out to ~250 queue jobs.
 *
 * Two deliberate choices (ADR-013):
 *  - Fails open if Redis is unreachable. Failing closed would turn a cache
 *    outage into a storefront outage, which is strictly worse.
 *  - Keys on client IP, which is only trustworthy with `trust proxy` set
 *    correctly. Per-consumer budgets need authentication, which does not exist yet.
 */

import type { NextFunction, Request, Response } from 'express';
import { RateLimiterRedis, type RateLimiterRes } from 'rate-limiter-flexible';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { redis } from '../cache/redis.js';

export type RouteClass = 'read' | 'simulation' | 'write' | 'ingestion';

const BUDGETS: Record<RouteClass, number> = {
  read: config.RATE_LIMIT_READ_PER_MIN,
  simulation: config.RATE_LIMIT_SIMULATION_PER_MIN,
  write: config.RATE_LIMIT_WRITE_PER_MIN,
  ingestion: config.RATE_LIMIT_INGESTION_PER_MIN,
};

const WINDOW_SECONDS = 60;

const limiters = new Map<RouteClass, RateLimiterRedis>();

function limiterFor(routeClass: RouteClass): RateLimiterRedis {
  let limiter = limiters.get(routeClass);
  if (!limiter) {
    limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `modaco:rl:${routeClass}`,
      points: BUDGETS[routeClass],
      duration: WINDOW_SECONDS,
      insuranceLimiter: undefined,
    });
    limiters.set(routeClass, limiter);
  }
  return limiter;
}

/** Caller identity, honouring `trust proxy`. */
function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function isRateLimiterRes(value: unknown): value is RateLimiterRes {
  return typeof value === 'object' && value !== null && 'msBeforeNext' in value;
}

/**
 * Middleware for a route class. A function lets one route choose per request —
 * the product list sends `?at=` simulations to the tighter budget.
 */
export function rateLimit(
  routeClass: RouteClass | ((req: Request) => RouteClass),
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.RATE_LIMIT_ENABLED) {
      next();
      return;
    }

    const resolved = typeof routeClass === 'function' ? routeClass(req) : routeClass;

    try {
      const result = await limiterFor(resolved).consume(clientKey(req), 1);
      res.setHeader('X-RateLimit-Limit', BUDGETS[resolved]);
      res.setHeader('X-RateLimit-Remaining', result.remainingPoints);
      next();
    } catch (err) {
      // A RateLimiterRes means the budget is spent (429); an Error means the
      // store failed, which must not take the endpoint down.
      if (isRateLimiterRes(err)) {
        const retryAfter = Math.ceil(err.msBeforeNext / 1_000);
        res.setHeader('Retry-After', retryAfter);
        res.setHeader('X-RateLimit-Limit', BUDGETS[resolved]);
        res.setHeader('X-RateLimit-Remaining', 0);

        logger.warn(
          { routeClass: resolved, ip: clientKey(req), path: req.path },
          'rate limit exceeded',
        );

        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: `Too many requests. Retry in ${retryAfter}s.`,
          },
        });
        return;
      }

      logger.warn(
        { err: err instanceof Error ? err.message : String(err), routeClass: resolved },
        'rate limiter store unavailable — failing open',
      );
      next();
    }
  };
}

/** `?at=` is a simulation: it cannot share a cache entry with live traffic. */
export function classifyProductRead(req: Request): RouteClass {
  return req.query.at === undefined ? 'read' : 'simulation';
}
