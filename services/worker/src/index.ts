import { Pool } from 'pg';
import Redis from 'ioredis';
import { BancsClient } from './bancs-client';
import { CircuitBreaker } from './circuit-breaker';
import { loadConfig } from './config';
import { log } from './log';
import { RateLimiter } from './rate-limiter';
import { createRelay } from './relay';
import { createSyncConsumer } from './sync-consumer';

const cfg = loadConfig();
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 5 });
// Si PostgreSQL reinicia, el pool descarta la conexión muerta y reconecta en vez de tumbar el worker.
pool.on('error', (err) => log('error', 'error en conexión inactiva del pool', { err: err.message }));
const redisPublisher = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
const redisConsumer = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });

const relay = createRelay({ pool, redis: redisPublisher, cfg });
const consumer = createSyncConsumer({
  pool,
  redis: redisConsumer,
  bancs: new BancsClient(cfg.bancsUrl, cfg.bancsTimeoutMs),
  breaker: new CircuitBreaker(cfg.breakerThreshold, cfg.breakerCooldownMs),
  limiter: new RateLimiter(cfg.bancsMaxCallsPerSec),
  cfg,
});

relay.start();
consumer.start();
log('info', 'worker iniciado', {
  stream: cfg.stream,
  bancsUrl: cfg.bancsUrl,
  batchSize: cfg.bancsBatchSize,
  maxCallsPerSec: cfg.bancsMaxCallsPerSec,
});

// Resumen periódico (en el Paso de observabilidad pasará a métricas Prometheus).
setInterval(() => log('info', 'estado del worker', consumer.stats()), 15_000).unref();

async function shutdown(signal: string) {
  log('info', 'apagando worker', { signal });
  await relay.stop();
  await consumer.stop();
  await pool.end();
  redisPublisher.disconnect();
  redisConsumer.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
