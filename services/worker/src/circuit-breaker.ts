export class CircuitOpenError extends Error {
  constructor(public readonly retryInMs: number) {
    super(`circuit open, retry in ${retryInMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Circuit breaker clásico.
 *  CLOSED    -> todo pasa; cuenta fallos consecutivos.
 *  OPEN      -> tras N fallos seguidos, NO se llama al legado durante `cooldownMs`
 *               (se le da tiempo a recuperarse en vez de hundirlo con reintentos).
 *  HALF_OPEN -> pasado el cooldown se permite UNA llamada de prueba:
 *               si funciona vuelve a CLOSED; si falla vuelve a OPEN.
 */
export class CircuitBreaker {
  private state: State = 'CLOSED';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get currentState(): State {
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>, countsAsFailure: (err: unknown) => boolean = () => true): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) throw new CircuitOpenError(this.cooldownMs - elapsed);
      this.state = 'HALF_OPEN';
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (countsAsFailure(err)) this.onFailure();
      else this.onSuccess(); // el legado respondió (p. ej. 429): está vivo
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failures++;
    if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }
}
