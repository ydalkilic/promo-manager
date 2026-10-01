/**
 * A self-imposed wall-clock budget for one invocation.
 *
 * Serverless platforms kill a function the moment it exceeds their timeout,
 * with no chance to flush state. Stages check this budget instead and yield
 * cleanly — persisting position and re-enqueuing — while they still can.
 */
export class Deadline {
  private readonly startedAt: number;

  constructor(
    private readonly budgetMs: number,
    now: number = Date.now(),
  ) {
    this.startedAt = now;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs);
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }

  /** True when too little time remains to start work that must finish. */
  exhausted(reserveMs: number): boolean {
    return this.remainingMs <= reserveMs;
  }
}
