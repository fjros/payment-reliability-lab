/** Injected time source. Application timestamps come from here, never from the database clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests and scenario runs. Every read advances by `tickMs`. */
export class ManualClock implements Clock {
  private current: number;
  private readonly tickMs: number;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z', tickMs = 1) {
    this.current = new Date(start).getTime();
    this.tickMs = tickMs;
  }

  now(): Date {
    const value = new Date(this.current);
    this.current += this.tickMs;
    return value;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
