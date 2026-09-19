export class CircuitOpenError extends Error {
  constructor(public readonly retryInMs: number) {
    super(`circuit open, retry in ${retryInMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Circuit breaker para proteger a core-api de un ai-service lento o caído.
 *  CLOSED    -> todo pasa; cuenta fallos consecutivos.
 *  OPEN      -> tras N fallos seguidos NO se llama al ai-service durante `cooldownMs`: se responde el fallback al instante.
 *  HALF_OPEN -> pasado el cooldown se permite UNA llamada de prueba; si funciona vuelve a CLOSED, si falla a OPEN.
 */
export class CircuitBreaker {
  private state: State = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get currentState(): State {
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) throw new CircuitOpenError(this.cooldownMs - elapsed);
      this.state = 'HALF_OPEN';
      this.probing = false;
    }
    if (this.state === 'HALF_OPEN') {
      // Solo UNA petición de prueba a la vez; el resto sigue recibiendo el fallback.
      if (this.probing) throw new CircuitOpenError(this.cooldownMs);
      this.probing = true;
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'CLOSED';
      this.probing = false;
      return result;
    } catch (err) {
      this.failures++;
      this.probing = false;
      if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
        this.state = 'OPEN';
        this.openedAt = this.now();
      }
      throw err;
    }
  }
}
