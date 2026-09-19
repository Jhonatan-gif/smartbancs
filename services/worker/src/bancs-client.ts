export interface PostingEvent {
  reference: string; // id de la transacción: clave de idempotencia en el legado
  fromAccount: string;
  toAccount: string;
  amount: string;
  currency: string;
}

export interface PostingResult {
  reference: string;
  status: 'APPLIED' | 'DUPLICATE' | 'REJECTED';
  reason?: string;
}

/** Error temporal: se puede reintentar (timeout, 5xx, 429). */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    /** true si debe contar para abrir el circuit breaker (5xx/timeout); false para 429. */
    public readonly countsForBreaker: boolean = true,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Error definitivo: reintentar no sirve (p. ej. 400). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export class BancsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /** Envía un LOTE de movimientos en una sola llamada (menos carga para el legado). */
  async postBatch(postings: PostingEvent[]): Promise<PostingResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/bancs/postings/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postings }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new RetryableError(`bancs inalcanzable o timeout: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      throw new RetryableError('bancs limitó la tasa (429)', seconds > 0 ? seconds * 1000 : undefined, false);
    }
    if (res.status >= 500) throw new RetryableError(`bancs respondió ${res.status}`);
    if (!res.ok) throw new PermanentError(`bancs rechazó el lote: ${res.status} ${await res.text()}`);

    const body = (await res.json()) as { results: PostingResult[] };
    return body.results;
  }
}
