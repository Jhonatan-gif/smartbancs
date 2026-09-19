import { sleep } from './log';

/**
 * Limitador de tasa por espaciado: garantiza que las llamadas al legado salgan
 * como mucho `perSecond` veces por segundo, sin ráfagas.
 */
export class RateLimiter {
  private nextAt = 0;

  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async acquire(): Promise<void> {
    const interval = 1000 / this.perSecond;
    const t = this.now();
    const start = Math.max(t, this.nextAt);
    this.nextAt = start + interval;
    if (start > t) await this.wait(start - t);
  }
}
