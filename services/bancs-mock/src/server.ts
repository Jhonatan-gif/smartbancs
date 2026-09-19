import Fastify from 'fastify';

/**
 * BANCS MOCK — simula el core bancario legado.
 *
 * Características que imitan a un sistema legado real:
 *  - Lento: cada llamada tarda 200-600 ms.
 *  - Frágil: soporta pocas llamadas por segundo y pocas en paralelo (responde 429).
 *  - Poco fiable: falla de forma aleatoria (503) y a veces aplica la operación
 *    pero pierde la respuesta (504) -> obliga al cliente a ser IDEMPOTENTE.
 *  - Se puede "apagar" (POST /bancs/admin/outage) para demostrar el circuit breaker.
 */
export interface BancsOptions {
  latencyMinMs: number;
  latencyMaxMs: number;
  maxConcurrency: number;
  maxRps: number;
  failureRate: number;
  lostResponseRate: number;
  logger: boolean;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' ? Number(v) : d);

export function optionsFromEnv(): BancsOptions {
  return {
    latencyMinMs: num(process.env.BANCS_LATENCY_MIN_MS, 200),
    latencyMaxMs: num(process.env.BANCS_LATENCY_MAX_MS, 600),
    maxConcurrency: num(process.env.BANCS_MAX_CONCURRENCY, 5),
    maxRps: num(process.env.BANCS_MAX_RPS, 10),
    failureRate: num(process.env.BANCS_FAILURE_RATE, 0.1),
    lostResponseRate: num(process.env.BANCS_LOST_RESPONSE_RATE, 0.05),
    logger: (process.env.LOG_LEVEL ?? 'info') !== 'silent',
  };
}

interface Posting {
  reference: string;
  fromAccount: string;
  toAccount: string;
  amount: string;
  currency: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toCents(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const s = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}

export function buildBancsMock(overrides: Partial<BancsOptions> = {}) {
  const o: BancsOptions = { ...optionsFromEnv(), ...overrides };
  const app = Fastify({ logger: o.logger ? { level: 'info' } : false });

  const applied = new Set<string>(); // referencias ya aplicadas (idempotencia)
  const net = new Map<string, bigint>(); // movimiento neto por cuenta
  const recentCalls: number[] = []; // marcas de tiempo de las llamadas recibidas (ventana de 1 s)
  let inFlight = 0;
  let down = false;

  const stats = {
    calls: 0,
    outageRejected: 0,
    rateLimited: 0,
    overloaded: 0,
    injectedFailures: 0,
    lostResponses: 0,
    postingsApplied: 0,
    postingsDuplicate: 0,
    maxInFlight: 0,
    maxCallsPerSecond: 0,
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post<{ Body: { postings: Posting[] } }>(
    '/bancs/postings/batch',
    {
      schema: {
        body: {
          type: 'object',
          required: ['postings'],
          properties: {
            postings: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                required: ['reference', 'fromAccount', 'toAccount', 'amount', 'currency'],
                properties: {
                  reference: { type: 'string', minLength: 1, maxLength: 64 },
                  fromAccount: { type: 'string', pattern: '^[0-9]{10}$' },
                  toAccount: { type: 'string', pattern: '^[0-9]{10}$' },
                  amount: { type: 'string', pattern: '^[0-9]{1,16}(\\.[0-9]{1,2})?$' },
                  currency: { type: 'string', minLength: 3, maxLength: 3 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const now = Date.now();
      stats.calls++;

      // Ventana deslizante de 1 s: cuántas llamadas recibió el legado en el último segundo.
      while (recentCalls.length && recentCalls[0] <= now - 1000) recentCalls.shift();
      recentCalls.push(now);
      stats.maxCallsPerSecond = Math.max(stats.maxCallsPerSecond, recentCalls.length);

      if (down) {
        stats.outageRejected++;
        return reply.status(503).send({ error: 'BANCS_DOWN' });
      }
      if (recentCalls.length > o.maxRps) {
        stats.rateLimited++;
        return reply.status(429).header('Retry-After', '1').send({ error: 'RATE_LIMITED' });
      }
      if (inFlight >= o.maxConcurrency) {
        stats.overloaded++;
        return reply.status(429).header('Retry-After', '1').send({ error: 'OVERLOADED' });
      }

      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      try {
        await sleep(o.latencyMinMs + Math.random() * (o.latencyMaxMs - o.latencyMinMs));

        if (Math.random() < o.failureRate) {
          stats.injectedFailures++;
          return reply.status(503).send({ error: 'BANCS_INTERNAL_ERROR' });
        }

        // Aplicar cada posteo. La referencia (id de transacción) hace la operación idempotente.
        const results = request.body.postings.map((p) => {
          if (applied.has(p.reference)) {
            stats.postingsDuplicate++;
            return { reference: p.reference, status: 'DUPLICATE' as const };
          }
          const cents = toCents(p.amount);
          net.set(p.fromAccount, (net.get(p.fromAccount) ?? 0n) - cents);
          net.set(p.toAccount, (net.get(p.toAccount) ?? 0n) + cents);
          applied.add(p.reference);
          stats.postingsApplied++;
          return { reference: p.reference, status: 'APPLIED' as const };
        });

        // El legado aplicó los cambios pero la respuesta se "perdió" (timeout de gateway).
        if (Math.random() < o.lostResponseRate) {
          stats.lostResponses++;
          return reply.status(504).send({ error: 'GATEWAY_TIMEOUT' });
        }
        return { results };
      } finally {
        inFlight--;
      }
    },
  );

  // --- Consulta y administración (para pruebas, conciliación y demos) ---
  app.get('/bancs/stats', async () => ({ ...stats, uniqueReferences: applied.size, down }));

  app.get<{ Params: { accountNumber: string } }>('/bancs/accounts/:accountNumber', async (request) => ({
    accountNumber: request.params.accountNumber,
    net: fromCents(net.get(request.params.accountNumber) ?? 0n),
  }));

  app.post<{ Body: { down: boolean } }>('/bancs/admin/outage', async (request) => {
    down = Boolean(request.body?.down);
    return { down };
  });

  app.post('/bancs/admin/reset', async () => {
    applied.clear();
    net.clear();
    recentCalls.length = 0;
    down = false;
    Object.keys(stats).forEach((k) => ((stats as Record<string, number>)[k] = 0));
    return { reset: true };
  });

  return app;
}
