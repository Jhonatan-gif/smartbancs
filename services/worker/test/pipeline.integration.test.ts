import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBancsMock } from '../../bancs-mock/src/server';
import { BancsClient } from '../src/bancs-client';
import { CircuitBreaker } from '../src/circuit-breaker';
import { loadConfig, WorkerConfig } from '../src/config';
import { sleep } from '../src/log';
import { RateLimiter } from '../src/rate-limiter';
import { createRelay } from '../src/relay';
import { createSyncConsumer } from '../src/sync-consumer';

const base = loadConfig();
const pool = new Pool({ connectionString: base.databaseUrl, max: 5 });
const redisPub = new Redis(base.redisUrl);
const redisSub = new Redis(base.redisUrl, { maxRetriesPerRequest: null });
const redisAdmin = new Redis(base.redisUrl);

beforeAll(async () => {
  await pool.query('SELECT 1');
  await redisAdmin.ping();
});
afterAll(async () => {
  await pool.end();
  redisPub.disconnect();
  redisSub.disconnect();
  redisAdmin.disconnect();
});

/** Crea N eventos de transferencia en el outbox, con un tipo único para aislar cada prueba. */
async function seedEvents(count: number, eventType: string) {
  const cust = await pool.query(
    `INSERT INTO customers (full_name, email) VALUES ('Prueba worker', $1) RETURNING id`,
    [`worker-${randomUUID()}@example.com`],
  );
  const num = () => String(Math.floor(1e9 + Math.random() * 9e9));
  const acc = async () =>
    (
      await pool.query(
        `INSERT INTO accounts (customer_id, account_number, balance) VALUES ($1, $2, 100000) RETURNING id, account_number`,
        [cust.rows[0].id, num()],
      )
    ).rows[0];
  const from = await acc();
  const to = await acc();

  const { rows } = await pool.query(
    `WITH tx AS (
       INSERT INTO transactions (idempotency_key, request_hash, from_account_id, to_account_id, amount, currency)
       SELECT 'wtest-' || gen_random_uuid(), 'x', $1::bigint, $2::bigint, 10.00, 'USD' FROM generate_series(1, $3::int)
       RETURNING id, created_at
     )
     INSERT INTO outbox_events (aggregate_id, event_type, payload)
     SELECT id, $4, jsonb_build_object('transactionId', id, 'fromAccountId', $1::bigint, 'toAccountId', $2::bigint,
                                       'amount', '10.00', 'currency', 'USD', 'occurredAt', created_at)
       FROM tx
     RETURNING aggregate_id`,
    [from.id, to.id, count, eventType],
  );
  return { from: from.account_number as string, to: to.account_number as string, ids: rows.map((r) => r.aggregate_id as string) };
}

function makeCfg(overrides: Partial<WorkerConfig> = {}) {
  const id = randomUUID().slice(0, 8);
  return loadConfig({
    eventType: `test.${id}`,
    stream: `test.stream.${id}`,
    dlqStream: `test.dlq.${id}`,
    group: `test-group-${id}`,
    consumer: `test-consumer-${id}`,
    relayPollMs: 30,
    bancsTimeoutMs: 1000,
    backoffBaseMs: 20,
    backoffMaxMs: 200,
    ...overrides,
  });
}

async function startBancs(opts: Parameters<typeof buildBancsMock>[0]) {
  const app = buildBancsMock({ logger: false, ...opts });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  return { app, url: `http://127.0.0.1:${addr.port}` };
}

function startPipeline(cfg: WorkerConfig, bancsUrl: string) {
  const relay = createRelay({ pool, redis: redisPub, cfg });
  const consumer = createSyncConsumer({
    pool,
    redis: redisSub,
    bancs: new BancsClient(bancsUrl, cfg.bancsTimeoutMs),
    breaker: new CircuitBreaker(cfg.breakerThreshold, cfg.breakerCooldownMs),
    limiter: new RateLimiter(cfg.bancsMaxCallsPerSec),
    cfg,
  });
  relay.start();
  consumer.start();
  return { relay, consumer, stop: async () => { await relay.stop(); await consumer.stop(); } };
}

async function syncedCount(ids: string[], status = 'SYNCED') {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM bancs_sync WHERE transaction_id = ANY($1::uuid[]) AND status = $2',
    [ids, status],
  );
  return rows[0].n as number;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await sleep(150);
  }
  return false;
}

describe('Pipeline outbox → Redis Streams → Bancs', () => {
  it('sincroniza 500 movimientos sin duplicar, sin saturar al legado y con fallos inyectados', async () => {
    const cfg = makeCfg({ bancsBatchSize: 25, bancsMaxCallsPerSec: 5, breakerThreshold: 5, breakerCooldownMs: 300 });
    const bancs = await startBancs({
      latencyMinMs: 5, latencyMaxMs: 25, maxRps: 20, maxConcurrency: 5,
      failureRate: 0.25, lostResponseRate: 0.05,
    });
    const { from, to, ids } = await seedEvents(500, cfg.eventType);
    const pipeline = startPipeline(cfg, bancs.url);

    const done = await waitFor(async () => (await syncedCount(ids)) === 500, 60_000);
    await pipeline.stop();
    const stats = (await bancs.app.inject({ method: 'GET', url: '/bancs/stats' })).json();
    const net = async (n: string) => (await bancs.app.inject({ method: 'GET', url: `/bancs/accounts/${n}` })).json().net;

    if (process.env.SHOW_STATS) console.log('BANCS STATS', JSON.stringify(stats), 'WORKER', JSON.stringify(pipeline.consumer.stats()));

    expect(done).toBe(true);
    // Cada movimiento se aplicó UNA sola vez en el legado (aunque hubo reintentos y respuestas perdidas).
    expect(stats.postingsApplied).toBe(500);
    expect(stats.uniqueReferences).toBe(500);
    // Los saldos netos en Bancs cuadran con lo enviado.
    expect(await net(from)).toBe('-5000.00');
    expect(await net(to)).toBe('5000.00');
    // El legado nunca tuvo que limitarnos: nuestro límite (5/s) está muy por debajo del suyo (20/s).
    expect(stats.rateLimited).toBe(0);
    expect(stats.maxCallsPerSecond).toBeLessThanOrEqual(6);
    // Nada terminó en la DLQ.
    expect(await redisAdmin.xlen(cfg.dlqStream)).toBe(0);
    expect(await syncedCount(ids, 'FAILED')).toBe(0);

    await bancs.app.close();
    await redisAdmin.del(cfg.stream, cfg.dlqStream);
  });

  it('ante una caída del legado el circuit breaker evita la avalancha y al volver no se pierde nada', async () => {
    const cfg = makeCfg({ bancsBatchSize: 25, bancsMaxCallsPerSec: 20, breakerThreshold: 3, breakerCooldownMs: 500 });
    const bancs = await startBancs({ latencyMinMs: 5, latencyMaxMs: 10, failureRate: 0, lostResponseRate: 0, maxRps: 100 });
    await bancs.app.inject({ method: 'POST', url: '/bancs/admin/outage', payload: { down: true } });

    const { ids } = await seedEvents(100, cfg.eventType);
    const pipeline = startPipeline(cfg, bancs.url);

    await sleep(2500); // el legado sigue caído
    const duringOutage = (await bancs.app.inject({ method: 'GET', url: '/bancs/stats' })).json();
    expect(await syncedCount(ids)).toBe(0);
    // Sin breaker serían decenas de llamadas; con breaker: 3 fallos + una prueba cada 500 ms.
    expect(duringOutage.calls).toBeLessThan(15);
    expect(pipeline.consumer.stats().breaker).not.toBe('CLOSED');

    await bancs.app.inject({ method: 'POST', url: '/bancs/admin/outage', payload: { down: false } });
    const done = await waitFor(async () => (await syncedCount(ids)) === 100, 30_000);
    await pipeline.stop();
    const after = (await bancs.app.inject({ method: 'GET', url: '/bancs/stats' })).json();

    expect(done).toBe(true);
    expect(after.postingsApplied).toBe(100);
    expect(await redisAdmin.xlen(cfg.dlqStream)).toBe(0);
    expect(pipeline.consumer.stats().deadLettered).toBe(0);

    await bancs.app.close();
    await redisAdmin.del(cfg.stream, cfg.dlqStream);
  });
});
