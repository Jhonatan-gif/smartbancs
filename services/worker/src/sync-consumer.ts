import { Pool } from 'pg';
import Redis from 'ioredis';
import { BancsClient, PermanentError, PostingEvent, PostingResult, RetryableError } from './bancs-client';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { WorkerConfig } from './config';
import { log, sleep } from './log';
import { RateLimiter } from './rate-limiter';

interface SyncEvent {
  streamId: string;
  transactionId: string;
  fromAccount: string;
  toAccount: string;
  amount: string;
  currency: string;
}

type StreamEntry = [string, string[]];

function parseEntry([streamId, fields]: StreamEntry): SyncEvent {
  const f: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  return {
    streamId,
    transactionId: f.transactionId,
    fromAccount: f.fromAccount,
    toAccount: f.toAccount,
    amount: f.amount,
    currency: f.currency,
  };
}

/**
 * CONSUMIDOR DE SINCRONIZACIÓN CON BANCS
 *
 * Protege al core legado de tres maneras:
 *   1. LOTES: hasta `bancsBatchSize` movimientos por llamada.
 *   2. RATE LIMIT: máximo `bancsMaxCallsPerSec` llamadas por segundo.
 *   3. CIRCUIT BREAKER + backoff exponencial con jitter: si el legado falla, se le da respiro.
 * Y garantiza que no se pierde nada: reintentos, luego dead-letter queue (DLQ).
 */
export function createSyncConsumer(deps: {
  pool: Pool;
  redis: Redis; // conexión DEDICADA (XREADGROUP bloquea la conexión)
  bancs: BancsClient;
  breaker: CircuitBreaker;
  limiter: RateLimiter;
  cfg: WorkerConfig;
}) {
  const { pool, redis, bancs, breaker, limiter, cfg } = deps;
  let running = false;
  let loop: Promise<void> = Promise.resolve();
  let lastClaim = 0;

  const stats = { batchesSent: 0, synced: 0, deadLettered: 0, retries: 0, circuitWaits: 0 };

  const backoff = (attempt: number) => {
    const exp = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** (attempt - 1));
    return exp * (0.5 + Math.random() * 0.5); // jitter: evita que todos reintenten a la vez
  };

  async function ensureGroup() {
    try {
      // '0' = procesar también lo publicado antes de que existiera el grupo
      await redis.xgroup('CREATE', cfg.stream, cfg.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
  }

  async function markSynced(events: SyncEvent[], attempts: number) {
    if (events.length === 0) return;
    await pool.query(
      `INSERT INTO bancs_sync (transaction_id, status, attempts, synced_at)
       SELECT unnest($1::uuid[]), 'SYNCED', $2::int, now()
       ON CONFLICT (transaction_id) DO UPDATE
         SET status = 'SYNCED', attempts = EXCLUDED.attempts, last_error = NULL,
             synced_at = now(), updated_at = now()`,
      [events.map((e) => e.transactionId), attempts],
    );
  }

  async function deadLetter(events: SyncEvent[], reason: string, attempts: number) {
    if (events.length === 0) return;
    await pool.query(
      `INSERT INTO bancs_sync (transaction_id, status, attempts, last_error)
       SELECT unnest($1::uuid[]), 'FAILED', $2::int, $3
       ON CONFLICT (transaction_id) DO UPDATE
         SET status = 'FAILED', attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error, updated_at = now()`,
      [events.map((e) => e.transactionId), attempts, reason],
    );
    for (const e of events) {
      await redis.xadd(
        cfg.dlqStream, '*',
        'transactionId', e.transactionId, 'fromAccount', e.fromAccount, 'toAccount', e.toAccount,
        'amount', e.amount, 'currency', e.currency, 'reason', reason,
      );
    }
    await redis.xack(cfg.stream, cfg.group, ...events.map((e) => e.streamId));
    stats.deadLettered += events.length;
    log('error', 'eventos enviados a la DLQ', { count: events.length, reason, attempts });
  }

  async function handleResults(events: SyncEvent[], results: PostingResult[], attempts: number) {
    const byRef = new Map(results.map((r) => [r.reference, r]));
    const ok: SyncEvent[] = [];
    const rejected: { event: SyncEvent; reason: string }[] = [];
    for (const e of events) {
      const r = byRef.get(e.transactionId);
      if (r && (r.status === 'APPLIED' || r.status === 'DUPLICATE')) ok.push(e);
      else rejected.push({ event: e, reason: r?.reason ?? 'sin resultado del legado' });
    }
    // Primero la BD, luego el ACK: si cae entre ambos, se reintenta y Bancs responde DUPLICATE.
    await markSynced(ok, attempts);
    if (ok.length) await redis.xack(cfg.stream, cfg.group, ...ok.map((e) => e.streamId));
    stats.synced += ok.length;
    for (const r of rejected) await deadLetter([r.event], r.reason, attempts);
  }

  async function processBatch(events: SyncEvent[]) {
    const postings: PostingEvent[] = events.map((e) => ({
      reference: e.transactionId,
      fromAccount: e.fromAccount,
      toAccount: e.toAccount,
      amount: e.amount,
      currency: e.currency,
    }));

    let attempt = 0;
    const startedAt = Date.now();
    const tooOld = () => Date.now() - startedAt > cfg.maxRetryMs;
    while (running) {
      try {
        await limiter.acquire();
        const results = await breaker.exec(
          () => bancs.postBatch(postings),
          (err) => err instanceof RetryableError && err.countsForBreaker,
        );
        stats.batchesSent++;
        await handleResults(events, results, attempt + 1);
        return;
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          // Circuito abierto: no se llama al legado. Esperar NO consume intentos.
          stats.circuitWaits++;
          if (tooOld()) {
            await deadLetter(events, `sin entrega tras ${cfg.maxRetryMs} ms (circuito abierto)`, attempt);
            return;
          }
          log('warn', 'circuito abierto, esperando', { retryInMs: err.retryInMs });
          await sleep(err.retryInMs);
          continue;
        }
        if (err instanceof PermanentError) {
          await deadLetter(events, err.message, attempt + 1);
          return;
        }
        attempt++;
        stats.retries++;
        const message = (err as Error).message;
        if (tooOld()) {
          await deadLetter(events, `sin entrega tras ${cfg.maxRetryMs} ms: ${message}`, attempt);
          return;
        }
        const delay = err instanceof RetryableError && err.retryAfterMs ? err.retryAfterMs : backoff(attempt);
        log('warn', 'reintento programado', { attempt, delayMs: Math.round(delay), error: message });
        await sleep(delay);
      }
    }
    // Si se detiene el servicio, los mensajes quedan pendientes y se reclaman luego (XAUTOCLAIM).
  }

  async function readEntries(): Promise<StreamEntry[]> {
    // Cada ~10 s se reclaman mensajes que un consumidor caído dejó sin confirmar.
    if (Date.now() - lastClaim > 10_000) {
      lastClaim = Date.now();
      const claimed = (await redis.xautoclaim(
        cfg.stream, cfg.group, cfg.consumer, cfg.claimIdleMs, '0-0', 'COUNT', cfg.bancsBatchSize,
      )) as unknown as [string, StreamEntry[]];
      if (claimed[1]?.length) {
        log('warn', 'reclamando mensajes pendientes', { count: claimed[1].length });
        return claimed[1];
      }
    }
    const res = (await redis.xreadgroup(
      'GROUP', cfg.group, cfg.consumer, 'COUNT', cfg.bancsBatchSize, 'BLOCK', 1000, 'STREAMS', cfg.stream, '>',
    )) as [string, StreamEntry[]][] | null;
    return res?.[0]?.[1] ?? [];
  }

  async function run() {
    await ensureGroup();
    while (running) {
      try {
        const entries = await readEntries();
        if (entries.length > 0) await processBatch(entries.map(parseEntry));
      } catch (err) {
        log('error', 'error en el consumidor', { error: (err as Error).message });
        await sleep(1000);
      }
    }
  }

  return {
    stats: () => ({ ...stats, breaker: breaker.currentState }),
    start() {
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      await loop;
    },
  };
}
