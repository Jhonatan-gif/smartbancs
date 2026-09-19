import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/infra/db';
import { buildApp } from '../src/server';
import { generateAccountNumber } from '../src/shared/account-number';

const app = buildApp();

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Crea cuentas aisladas para cada prueba (no dependen de los datos semilla). */
async function createAccounts(count: number, balance: string) {
  const email = `test-${randomUUID()}@example.com`;
  const customer = await pool.query(
    `INSERT INTO customers (full_name, email) VALUES ('Cliente de prueba', $1) RETURNING id`,
    [email],
  );
  const accounts: { id: string; number: string }[] = [];
  for (let i = 0; i < count; i++) {
    const number = generateAccountNumber();
    const { rows } = await pool.query(
      `INSERT INTO accounts (customer_id, account_number, balance) VALUES ($1, $2, $3::numeric) RETURNING id`,
      [customer.rows[0].id, number, balance],
    );
    accounts.push({ id: rows[0].id, number });
  }
  return accounts;
}

function transfer(from: string, to: string, amount: string, key: string = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: '/v1/transfers',
    headers: { 'idempotency-key': key },
    payload: { fromAccount: from, toAccount: to, amount },
  });
}

async function balanceOf(accountId: string): Promise<string> {
  const { rows } = await pool.query('SELECT balance::text AS balance FROM accounts WHERE id = $1', [accountId]);
  return rows[0].balance;
}

describe('Transferencias bajo concurrencia', () => {
  it('conserva el dinero total y cuadra saldos con el ledger (400 transferencias simultáneas)', async () => {
    const accounts = await createAccounts(10, '1000.00');
    const ids = accounts.map((a) => a.id);

    const requests = Array.from({ length: 400 }, () => {
      const from = accounts[randomInt(accounts.length)];
      let to = accounts[randomInt(accounts.length)];
      while (to.id === from.id) to = accounts[randomInt(accounts.length)];
      const amount = (randomInt(100, 6000) / 100).toFixed(2); // 1.00 - 59.99
      return transfer(from.number, to.number, amount);
    });
    const responses = await Promise.all(requests);

    // Solo son válidas dos respuestas: éxito o fondos insuficientes. Ningún 5xx / deadlock.
    const codes = responses.map((r) => r.statusCode);
    expect(codes.every((c) => c === 201 || c === 422)).toBe(true);
    expect(codes.filter((c) => c === 201).length).toBeGreaterThan(0);

    // 1) El dinero total del sistema no cambió.
    const total = await pool.query('SELECT SUM(balance)::text AS total FROM accounts WHERE id = ANY($1)', [ids]);
    expect(total.rows[0].total).toBe('10000.00');

    // 2) Ningún saldo negativo.
    const negatives = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE id = ANY($1) AND balance < 0', [ids]);
    expect(negatives.rows[0].n).toBe(0);

    // 3) Saldo final == saldo inicial + créditos - débitos del ledger, para cada cuenta.
    const recon = await pool.query(
      `SELECT a.id,
              (a.balance - 1000.00 - COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END), 0))::text AS diff
         FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
        WHERE a.id = ANY($1) GROUP BY a.id`,
      [ids],
    );
    expect(recon.rows.every((r) => Number(r.diff) === 0)).toBe(true);

    // 4) Cada transacción tiene exactamente 1 débito y 1 crédito por el mismo monto.
    const bad = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT le.transaction_id
           FROM ledger_entries le
          WHERE le.account_id = ANY($1)
          GROUP BY le.transaction_id
         HAVING count(*) <> 2
             OR sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
       ) x`,
      [ids],
    );
    expect(bad.rows[0].n).toBe(0);
  });

  it('no produce deadlocks con transferencias cruzadas A→B y B→A a la vez', async () => {
    const [a, b] = await createAccounts(2, '100000.00');
    const requests = [
      ...Array.from({ length: 100 }, () => transfer(a.number, b.number, '10.00')),
      ...Array.from({ length: 100 }, () => transfer(b.number, a.number, '10.00')),
    ];
    const responses = await Promise.all(requests);
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    // Mismo monto en ambos sentidos: los saldos quedan como al inicio.
    expect(await balanceOf(a.id)).toBe('100000.00');
    expect(await balanceOf(b.id)).toBe('100000.00');
  });

  it('nunca sobregira: 50 débitos simultáneos de 100.00 sobre 1000.00 → solo 10 aprobados', async () => {
    const [a, b] = await createAccounts(2, '0.00');
    await pool.query('UPDATE accounts SET balance = 1000.00 WHERE id = $1', [a.id]);

    const responses = await Promise.all(Array.from({ length: 50 }, () => transfer(a.number, b.number, '100.00')));
    const ok = responses.filter((r) => r.statusCode === 201).length;
    const rejected = responses.filter((r) => r.statusCode === 422).length;

    expect(ok).toBe(10);
    expect(rejected).toBe(40);
    expect(await balanceOf(a.id)).toBe('0.00');
    expect(await balanceOf(b.id)).toBe('1000.00');
  });
});

describe('Idempotencia', () => {
  it('20 peticiones simultáneas con la misma Idempotency-Key generan UNA sola transferencia', async () => {
    const [a, b] = await createAccounts(2, '500.00');
    const key = randomUUID();

    const responses = await Promise.all(Array.from({ length: 20 }, () => transfer(a.number, b.number, '25.00', key)));

    expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(responses.filter((r) => r.statusCode === 201).length).toBe(1);
    const txIds = new Set(responses.map((r) => r.json().transactionId));
    expect(txIds.size).toBe(1);

    expect(await balanceOf(a.id)).toBe('475.00');
    expect(await balanceOf(b.id)).toBe('525.00');
  });

  it('rechaza reutilizar la clave con datos distintos (422)', async () => {
    const [a, b] = await createAccounts(2, '500.00');
    const key = randomUUID();

    expect((await transfer(a.number, b.number, '10.00', key)).statusCode).toBe(201);
    const second = await transfer(a.number, b.number, '99.00', key);
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('Validaciones y consultas', () => {
  it('rechaza números de cuenta con dígito verificador inválido', async () => {
    const res = await transfer('1000000010', '1000000024', '5.00');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ACCOUNT_NUMBER');
  });

  it('rechaza montos negativos, en cero o con más de 2 decimales', async () => {
    for (const amount of ['-5.00', '0', '0.00', '5.123']) {
      const res = await transfer('1000000016', '1000000024', amount);
      expect(res.statusCode).toBe(400);
    }
  });

  it('lista movimientos con paginación por cursor', async () => {
    const [a, b] = await createAccounts(2, '1000.00');
    for (let i = 0; i < 5; i++) await transfer(a.number, b.number, '1.00');

    const page1 = await app.inject({ method: 'GET', url: `/v1/accounts/${a.number}/movements?limit=3` });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(3);
    expect(body1.nextCursor).not.toBeNull();
    expect(body1.items[0].type).toBe('DEBIT');

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${a.number}/movements?limit=3&cursor=${body1.nextCursor}`,
    });
    const body2 = page2.json();
    expect(body2.items).toHaveLength(2);
    expect(body2.nextCursor).toBeNull();
  });
});
