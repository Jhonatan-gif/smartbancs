import http from 'node:http';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { WorkerConfig } from './config';
import { log } from './log';

/**
 * MÉTRICAS DEL WORKER (Prometheus, GET /metrics en METRICS_PORT).
 * Responden a: ¿se está quedando atrás la sincronización? ¿estamos protegiendo o saturando a Bancs?
 */
export const registry = new Registry();
registry.setDefaultLabels({ service: 'worker' });
collectDefaultMetrics({ register: registry });

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

export const bancsCalls = new Counter({
  name: 'bancs_calls_total',
  help: 'Llamadas al legado. outcome: ok | retryable (5xx/timeout/429) | permanent | circuit_open (no se llamó)',
  labelNames: ['outcome'],
  registers: [registry],
});
export const bancsCallDuration = new Histogram({
  name: 'bancs_call_duration_seconds',
  help: 'Duración de cada llamada por lote al legado',
  buckets: BUCKETS,
  registers: [registry],
});
export const bancsBatchSize = new Histogram({
  name: 'bancs_batch_size',
  help: 'Movimientos por llamada (los lotes protegen al legado)',
  buckets: [1, 5, 10, 25, 50, 100],
  registers: [registry],
});
export const syncedTotal = new Counter({ name: 'bancs_synced_total', help: 'Movimientos sincronizados con Bancs', registers: [registry] });
export const deadLetteredTotal = new Counter({ name: 'bancs_dead_lettered_total', help: 'Movimientos enviados a la DLQ', registers: [registry] });
export const retriesTotal = new Counter({ name: 'bancs_retries_total', help: 'Reintentos hacia Bancs', registers: [registry] });
export const relayPublishedTotal = new Counter({ name: 'outbox_published_total', help: 'Eventos del outbox publicados en el stream', registers: [registry] });

export function registerGauges(deps: {
  pool: Pool;
  redis: Redis;
  cfg: WorkerConfig;
  breakerState: () => 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}) {
  const { pool, redis, cfg } = deps;
  const safe = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      log('warn', 'no se pudo leer la métrica', { metric: name, error: (err as Error).message });
    }
  };

  new Gauge({
    name: 'bancs_breaker_state',
    help: 'Circuit breaker hacia Bancs: 0 cerrado, 1 medio abierto, 2 abierto',
    registers: [registry],
    collect() {
      this.set({ CLOSED: 0, HALF_OPEN: 1, OPEN: 2 }[deps.breakerState()]);
    },
  });

  new Gauge({
    name: 'outbox_unpublished_events',
    help: 'Eventos en el outbox aún sin publicar (si crece, el relay se queda atrás)',
    registers: [registry],
    async collect() {
      await safe('outbox_unpublished_events', async () => {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS age
             FROM outbox_events WHERE published_at IS NULL AND event_type = $1`,
          [cfg.eventType],
        );
        this.set(rows[0].n);
        oldestAge.set(rows[0].age);
      });
    },
  });
  const oldestAge = new Gauge({
    name: 'outbox_oldest_unpublished_age_seconds',
    help: 'Antigüedad del evento más viejo sin publicar',
    registers: [registry],
  });

  new Gauge({
    name: 'sync_unsynced_transactions',
    help: 'Transferencias todavía no confirmadas por Bancs (retraso de sincronización)',
    registers: [registry],
    async collect() {
      await safe('sync_unsynced_transactions', async () => {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM transactions t
            WHERE NOT EXISTS (SELECT 1 FROM bancs_sync s WHERE s.transaction_id = t.id AND s.status = 'SYNCED')`,
        );
        this.set(rows[0].n);
      });
    },
  });

  new Gauge({
    name: 'stream_group_pending',
    help: 'Mensajes entregados a un consumidor y aún sin confirmar (ACK), por grupo',
    labelNames: ['group'],
    registers: [registry],
    async collect() {
      await safe('stream_group_pending', async () => {
        const groups = (await redis.xinfo('GROUPS', cfg.stream)) as unknown[][];
        for (const g of groups) {
          const m = toMap(g);
          this.set({ group: String(m.name) }, Number(m.pending));
          lag.set({ group: String(m.name) }, Number(m.lag ?? 0));
        }
      });
    },
  });
  const lag = new Gauge({
    name: 'stream_group_lag',
    help: 'Mensajes del stream aún no entregados al grupo (lag de consumo), por grupo',
    labelNames: ['group'],
    registers: [registry],
  });

  new Gauge({
    name: 'dlq_length',
    help: 'Mensajes en la dead-letter queue (debería ser 0)',
    registers: [registry],
    async collect() {
      await safe('dlq_length', async () => {
        this.set(await redis.xlen(cfg.dlqStream));
      });
    },
  });
}

function toMap(flat: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

/** Servidor mínimo: /metrics para Prometheus y /health para el healthcheck de Docker. */
export function startMetricsServer(port: number, isHealthy: () => boolean) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType });
      res.end(await registry.metrics());
    } else if (req.url === '/health') {
      const ok = isHealthy();
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'unhealthy' }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, '0.0.0.0', () => log('info', 'servidor de métricas escuchando', { port }));
  return server;
}
