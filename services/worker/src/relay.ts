import { Pool } from 'pg';
import Redis from 'ioredis';
import { WorkerConfig } from './config';
import { log, sleep } from './log';
import { relayPublishedTotal } from './metrics';
import { recordEventSpans } from './tracing';

/**
 * RELAY DEL OUTBOX (patrón Transactional Outbox)
 *
 * La API guarda el evento en `outbox_events` DENTRO de la misma transacción que la
 * transferencia. Este proceso lo lee y lo publica en Redis Streams:
 *   - `FOR UPDATE SKIP LOCKED`: varias réplicas del worker pueden correr a la vez sin pisarse.
 *   - Entrega "al menos una vez": si el proceso cae entre publicar y marcar, el evento se
 *     republica; por eso los consumidores son idempotentes (referencia = id de transacción).
 */
export function createRelay(deps: { pool: Pool; redis: Redis; cfg: WorkerConfig }) {
  const { pool, redis, cfg } = deps;
  let running = false;
  let loop: Promise<void> = Promise.resolve();

  async function relayOnce(): Promise<number> {
    const startedMs = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT o.id, o.aggregate_id, o.payload, o.trace_id,
                fa.account_number AS from_account, ta.account_number AS to_account
           FROM outbox_events o
           JOIN accounts fa ON fa.id = (o.payload->>'fromAccountId')::bigint
           JOIN accounts ta ON ta.id = (o.payload->>'toAccountId')::bigint
          WHERE o.published_at IS NULL AND o.event_type = $2
          ORDER BY o.id
          LIMIT $1
          FOR UPDATE OF o SKIP LOCKED`,
        [cfg.relayBatchSize, cfg.eventType],
      );
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const pipeline = redis.pipeline();
      for (const r of rows) {
        pipeline.call(
          'XADD', cfg.stream, 'MAXLEN', '~', '1000000', '*',
          'eventId', String(r.id),
          'transactionId', r.aggregate_id,
          'fromAccount', r.from_account,
          'toAccount', r.to_account,
          'amount', r.payload.amount,
          'currency', r.payload.currency,
          'occurredAt', r.payload.occurredAt,
          'traceId', r.trace_id ?? '',
          'traceparent', r.payload.traceparent ?? '',
        );
      }
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err)) throw new Error('falló la publicación en Redis Streams');

      await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [
        rows.map((r) => r.id),
      ]);
      await client.query('COMMIT');
      relayPublishedTotal.inc(rows.length);
      recordEventSpans(
        rows.map((r) => ({ traceparent: r.payload.traceparent ?? '' })),
        'outbox.publish',
        startedMs,
        Date.now(),
        { 'messaging.system': 'redis-streams', 'messaging.destination.name': cfg.stream, 'batch.size': rows.length },
      );
      log('info', 'eventos publicados', {
        count: rows.length,
        stream: cfg.stream,
        trace_ids: rows.map((r) => r.trace_id).filter(Boolean),
      });
      return rows.length;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignorar */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function run() {
    while (running) {
      let published = 0;
      try {
        published = await relayOnce();
      } catch (err) {
        log('error', 'relay falló, reintentando', { error: (err as Error).message });
        await sleep(1000);
      }
      if (published === 0) await sleep(cfg.relayPollMs);
    }
  }

  return {
    relayOnce,
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
