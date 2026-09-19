import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

export interface Recommendation {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
}

export interface AiRecommendations {
  account: string;
  source: 'model';
  modelVersion: string;
  coldStart: boolean;
  segment: string | null;
  recommendations: Recommendation[];
  generatedAt: string;
}

export type FailureReason = 'timeout' | 'unavailable' | 'circuit_open' | 'bad_response';

export class AiUnavailableError extends Error {
  constructor(public readonly reason: FailureReason, detail?: string) {
    super(detail ?? reason);
    this.name = 'AiUnavailableError';
  }
}

export interface AiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
}

/**
 * Cliente del ai-service. Nunca se usa dentro de una transferencia: solo lo llama el endpoint de recomendaciones.
 * Tiene tres defensas: timeout corto, circuit breaker y (en la ruta) un fallback local.
 */
export class AiClient {
  private readonly breaker: CircuitBreaker;
  constructor(private readonly opts: AiClientOptions) {
    this.breaker = new CircuitBreaker(opts.breakerThreshold, opts.breakerCooldownMs);
  }

  get breakerState() {
    return this.breaker.currentState;
  }

  async recommendations(account: string, requestId: string): Promise<AiRecommendations> {
    try {
      return await this.breaker.exec(() => this.call(account, requestId));
    } catch (err) {
      if (err instanceof CircuitOpenError) throw new AiUnavailableError('circuit_open');
      if (err instanceof AiUnavailableError) throw err;
      throw new AiUnavailableError('unavailable', (err as Error).message);
    }
  }

  private async call(account: string, requestId: string): Promise<AiRecommendations> {
    let res: Response;
    try {
      // El timeout cubre conexión, cabeceras y cuerpo: la petición NO puede colgarse más de timeoutMs.
      res = await fetch(`${this.opts.baseUrl}/recommendations/${account}`, {
        headers: { 'x-request-id': requestId },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) throw new AiUnavailableError('unavailable', `ai-service respondió ${res.status}`);
      const body = (await res.json()) as AiRecommendations;
      if (!Array.isArray(body?.recommendations)) throw new AiUnavailableError('bad_response');
      return body;
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new AiUnavailableError('timeout');
      throw new AiUnavailableError('unavailable', (err as Error).message);
    }
  }
}
