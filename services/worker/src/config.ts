const int = (v: string | undefined, d: number) => (v !== undefined && v !== '' ? parseInt(v, 10) : d);

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  bancsUrl: string;
  logLevel: string;

  // --- Outbox -> Redis Streams ---
  eventType: string; // tipo de evento del outbox que este relay publica
  stream: string;
  dlqStream: string;
  group: string;
  consumer: string;
  relayBatchSize: number;
  relayPollMs: number;

  // --- Sincronización con Bancs ---
  bancsBatchSize: number; // cuántos movimientos viajan en UNA llamada
  bancsMaxCallsPerSec: number; // tope de llamadas por segundo hacia el legado
  bancsTimeoutMs: number;
  // Tiempo máximo reintentando un lote antes de aparcarlo en la DLQ (evita bloquear la cola
  // por un lote "venenoso"). Una caída del legado NO manda nada a la DLQ mientras dure menos.
  maxRetryMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  breakerThreshold: number; // fallos consecutivos que abren el circuito
  breakerCooldownMs: number;
  claimIdleMs: number; // tiempo tras el cual se reclaman mensajes de un consumidor caído
}

export function loadConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const e = process.env;
  return {
    databaseUrl: e.DATABASE_URL ?? 'postgres://smartbancs:smartbancs@localhost:5432/smartbancs',
    redisUrl: e.REDIS_URL ?? 'redis://localhost:6379',
    bancsUrl: e.BANCS_URL ?? 'http://localhost:4000',
    logLevel: e.LOG_LEVEL ?? 'info',

    eventType: e.OUTBOX_EVENT_TYPE ?? 'transfer.completed',
    stream: e.STREAM ?? 'transfers.completed',
    dlqStream: e.DLQ_STREAM ?? 'transfers.dlq',
    group: e.CONSUMER_GROUP ?? 'bancs-sync',
    consumer: e.CONSUMER_NAME ?? `worker-${process.pid}`,
    relayBatchSize: int(e.RELAY_BATCH_SIZE, 100),
    relayPollMs: int(e.RELAY_POLL_MS, 200),

    bancsBatchSize: int(e.BANCS_BATCH_SIZE, 25),
    bancsMaxCallsPerSec: int(e.BANCS_MAX_CALLS_PER_SEC, 5),
    bancsTimeoutMs: int(e.BANCS_TIMEOUT_MS, 2000),
    maxRetryMs: int(e.MAX_RETRY_MS, 900_000),
    backoffBaseMs: int(e.BACKOFF_BASE_MS, 200),
    backoffMaxMs: int(e.BACKOFF_MAX_MS, 5000),
    breakerThreshold: int(e.BREAKER_THRESHOLD, 5),
    breakerCooldownMs: int(e.BREAKER_COOLDOWN_MS, 5000),
    claimIdleMs: int(e.CLAIM_IDLE_MS, 30000),
    ...overrides,
  };
}
