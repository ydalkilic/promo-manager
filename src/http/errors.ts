/**
 * Domain code throws these; one middleware translates them to HTTP. Keeping
 * status codes out of services keeps them usable from workers and tests.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/** 429 not 503: the service is healthy, this caller asked for too much. */
export class TooManyRequestsError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 429, 'TOO_MANY_REQUESTS', details);
  }
}

/** 409 not 400: well-formed, conflicts with current state, may succeed later. */
export class PromotionConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'PROMOTION_CONFLICT', details);
  }
}
