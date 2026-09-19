import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool } from '../src/infra/db';
import { timedOp } from '../src/observability/metrics';
import { buildApp } from '../src/server';
import { generateAccountNumber, maskAccountsInUrl } from '../src/shared/account-number';

const app = buildApp();
const accounts: string[] = [];

beforeAll(async () => {
  await app.ready();
  const customer = await pool.query(`INSERT INTO customers (full_name, email) VALUES ('Cliente métricas', $1) RETURNING id`, [
    `met-${randomUUID()}@example.com`,
  ]);
  for (let i = 0; i < 4; i++) {
    const number = generateAccountNumber();
    await pool.query(`INSERT INTO accounts (customer_id, account_number, balance) VALUES ($1, $2, $3::numeric)`, [
      customer.rows[0].id,
      number,
      i === 3 ? '5.00' : '10000.00',
    ]);
    accounts.push(number);
  }
});
afterAll(async () => {
  config.lockOrdering = true;
  config.simulatedLockDelayMs = 0;
  await app.close();
  await pool.end();
});

const transfer = (from: string, to: string, amount: string, key = randomUUID()) =>
  app.inject({
    method: 'POST',
    url: '/v1/transfers',
    headers: { 'idempotency-key': key },
    payload: { fromAccount: from, toAccount: to, amount },
  });

/** Suma el valor de las series de /metrics cuyo nombre y etiquetas coinciden. */
async function metric(name: string, labels: Record<string, string> = {}): Promise<number> {
  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  let total = 0;
  for (const line of body.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue;
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) total += Number(line.split(' ').pop());
  }
  return total;
}

describe('Métricas Prometheus', () => {
  it('GET /metrics responde en formato Prometheus con el label service', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE transfers_total counter');
    expect(res.body).toContain('service="core-api"');
  });

  it('cuenta transferencias creadas, repetidas (idempotentes) y rechazadas por código', async () => {
    const created0 = await metric('transfers_total', { outcome: 'created' });
    const replayed0 = await metric('transfers_total', { outcome: 'replayed' });
    const funds0 = await metric('transfers_total', { outcome: 'rejected', code: 'INSUFFICIENT_FUNDS' });

    const key = randomUUID();
    expect((await transfer(accounts[0], accounts[1], '10.00', key)).statusCode).toBe(201);
    expect((await transfer(accounts[0], accounts[1], '10.00', key)).statusCode).toBe(200);
    expect((await transfer(accounts[3], accounts[1], '999.00')).statusCode).toBe(422);

    expect(await metric('transfers_total', { outcome: 'created' })).toBe(created0 + 1);
    expect(await metric('transfers_total', { outcome: 'replayed' })).toBe(replayed0 + 1);
    expect(await metric('transfers_total', { outcome: 'rejected', code: 'INSUFFICIENT_FUNDS' })).toBe(funds0 + 1);
  });

  it('mide la duración de cada paso SQL de la transferencia', async () => {
    const before = await Promise.all(
      ['lock_accounts', 'insert_tx', 'debit', 'credit', 'ledger', 'outbox'].map((op) => metric('db_op_duration_seconds_count', { op })),
    );
    await transfer(accounts[0], accounts[1], '1.00');
    const after = await Promise.all(
      ['lock_accounts', 'insert_tx', 'debit', 'credit', 'ledger', 'outbox'].map((op) => metric('db_op_duration_seconds_count', { op })),
    );
    after.forEach((n, i) => expect(n).toBe(before[i] + 1));
  });

  it('registra la latencia HTTP por ruta (plantilla, no URL con la cuenta)', async () => {
    await app.inject({ method: 'GET', url: `/v1/accounts/${accounts[0]}` });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toContain('route="/v1/accounts/:accountNumber"');
    expect(body).not.toContain(accounts[0]); // ningún número de cuenta en las etiquetas
  });

  it('expone el estado del pool de conexiones', async () => {
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toMatch(/db_pool_connections\{[^}]*state="waiting"[^}]*\} \d+/);
    expect(await metric('db_pool_max_connections')).toBe(config.dbPoolMax);
  });
});

describe('Diagnóstico del incidente: el deadlock queda identificado por paso SQL', () => {
  it('timedOp registra nombre del paso, código SQLSTATE, detalle y trace_id cuando la BD falla', async () => {
    const logs: Record<string, unknown>[] = [];
    const log = { warn: (o: Record<string, unknown>) => logs.push(o), error: (o: Record<string, unknown>) => logs.push(o) };
    const dbErr = Object.assign(new Error('deadlock detected'), { code: '40P01', detail: 'Process 1 waits for ShareLock on transaction 2' });
    await expect(timedOp('lock_to', () => Promise.reject(dbErr), { log, traceId: 'trace-abc' })).rejects.toThrow('deadlock');
    expect(logs[0]).toMatchObject({ op: 'lock_to', pg_code: '40P01', type: 'deadlock', trace_id: 'trace-abc' });
    expect(String(logs[0].detail)).toContain('ShareLock');
  });

  it('timedOp marca como lenta una operación que supera SLOW_OP_MS', async () => {
    const logs: Record<string, unknown>[] = [];
    const log = { warn: (o: Record<string, unknown>) => logs.push(o), error: () => {} };
    const slow = config.slowOpMs;
    config.slowOpMs = 20;
    await timedOp('debit', () => new Promise((r) => setTimeout(r, 40)), { log, traceId: 't1' });
    config.slowOpMs = slow;
    expect(logs[0]).toMatchObject({ op: 'debit', trace_id: 't1' });
    expect(Number(logs[0].ms)).toBeGreaterThanOrEqual(30);
  });

  it('con LOCK_ORDERING=off, transferencias cruzadas producen un deadlock real y las métricas señalan el paso', async () => {
    config.lockOrdering = false;
    config.simulatedLockDelayMs = 300;
    const deadlocks0 = await metric('db_errors_total', { type: 'deadlock' });
    const opErr0 = await metric('db_op_errors_total', { pg_code: '40P01' });
    const [ab, ba] = await Promise.all([
      transfer(accounts[0], accounts[1], '1.00'),
      transfer(accounts[1], accounts[0], '1.00'),
    ]);
    config.lockOrdering = true;
    config.simulatedLockDelayMs = 0;

    // PostgreSQL mata a una de las dos (409) y la otra termina bien
    expect([ab.statusCode, ba.statusCode].sort()).toEqual([201, 409]);
    expect(await metric('db_errors_total', { type: 'deadlock' })).toBe(deadlocks0 + 1);
    expect(await metric('db_op_errors_total', { pg_code: '40P01' })).toBe(opErr0 + 1);
    expect(await metric('transfers_total', { outcome: 'error', code: 'DEADLOCK_DETECTED' })).toBeGreaterThanOrEqual(1);
  });
});

describe('Privacidad en logs', () => {
  it('enmascara el número de cuenta de las URL antes de registrarlas', () => {
    expect(maskAccountsInUrl('/v1/accounts/1000000016/recommendations')).toBe('/v1/accounts/******0016/recommendations');
    expect(maskAccountsInUrl('/v1/accounts/1000000016/movements?limit=5')).toBe('/v1/accounts/******0016/movements?limit=5');
    expect(maskAccountsInUrl('/v1/transfers')).toBe('/v1/transfers');
  });
});
