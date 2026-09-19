import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { config } from '../../config';
import { pool, withTransaction } from '../../infra/db';
import { AppError } from '../../shared/errors';
import { maskAccountNumber } from '../../shared/account-number';

export interface TransferInput {
  idempotencyKey: string;
  fromAccount: string;
  toAccount: string;
  amount: string; // decimal en string ("25.50"): nunca float
  description?: string;
  traceId?: string;
}

export interface TransferResult {
  transactionId: string;
  status: string;
  fromAccount: string; // enmascarada
  toAccount: string; // enmascarada
  amount: string;
  currency: string;
  description: string | null;
  createdAt: string;
  replayed: boolean; // true si es una repetición idempotente
}

interface LockedAccount {
  id: string;
  account_number: string;
  currency: string;
  status: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hashRequest(i: TransferInput): string {
  return createHash('sha256').update(`${i.fromAccount}|${i.toAccount}|${i.amount}`).digest('hex');
}

/**
 * BLOQUEO DE CUENTAS
 *
 * Modo seguro (por defecto): se bloquean las DOS filas en una sola sentencia
 * y SIEMPRE en orden ascendente de id. Si A→B y B→A llegan a la vez, ambas
 * transacciones piden los bloqueos en el mismo orden, así que una espera a la
 * otra y nunca se produce un deadlock.
 *
 * Modo inseguro (LOCK_ORDERING=off): bloquea "origen" y luego "destino" con una
 * pausa entre medio. Reproduce el deadlock del incidente simulado (reto 3.5).
 */
async function lockAccounts(c: PoolClient, from: string, to: string): Promise<Map<string, LockedAccount>> {
  const sql = `SELECT id, account_number, currency, status
                 FROM accounts WHERE account_number = ANY($1::text[])`;
  const rows: LockedAccount[] = [];

  if (config.lockOrdering) {
    const res = await c.query<LockedAccount>(`${sql} ORDER BY id FOR UPDATE`, [[from, to]]);
    rows.push(...res.rows);
  } else {
    const first = await c.query<LockedAccount>(`${sql} FOR UPDATE`, [[from]]);
    if (config.simulatedLockDelayMs > 0) await sleep(config.simulatedLockDelayMs);
    const second = await c.query<LockedAccount>(`${sql} FOR UPDATE`, [[to]]);
    rows.push(...first.rows, ...second.rows);
  }
  return new Map(rows.map((r) => [r.account_number, r]));
}

async function findByIdempotencyKey(key: string) {
  const { rows } = await pool.query(
    `SELECT t.id, t.status, t.amount::text AS amount, t.currency, t.description, t.created_at,
            t.request_hash, fa.account_number AS from_account, ta.account_number AS to_account
       FROM transactions t
       JOIN accounts fa ON fa.id = t.from_account_id
       JOIN accounts ta ON ta.id = t.to_account_id
      WHERE t.idempotency_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

function replayResult(existing: any, input: TransferInput): TransferResult {
  if (existing.request_hash !== hashRequest(input)) {
    throw new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'La Idempotency-Key ya fue usada con datos distintos',
    );
  }
  return {
    transactionId: existing.id,
    status: existing.status,
    fromAccount: maskAccountNumber(existing.from_account),
    toAccount: maskAccountNumber(existing.to_account),
    amount: existing.amount,
    currency: existing.currency,
    description: existing.description,
    createdAt: new Date(existing.created_at).toISOString(),
    replayed: true,
  };
}

export async function executeTransfer(input: TransferInput): Promise<TransferResult> {
  // Camino rápido: si la clave ya existe, devolvemos el resultado sin tomar bloqueos.
  const already = await findByIdempotencyKey(input.idempotencyKey);
  if (already) return replayResult(already, input);

  const outcome = await withTransaction(async (c) => {
    // 1) Bloquear ambas cuentas (orden determinista) y validar.
    const accounts = await lockAccounts(c, input.fromAccount, input.toAccount);
    const from = accounts.get(input.fromAccount);
    const to = accounts.get(input.toAccount);
    if (!from) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'La cuenta origen no existe');
    if (!to) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'La cuenta destino no existe');
    if (from.status !== 'ACTIVE' || to.status !== 'ACTIVE') {
      throw new AppError(422, 'ACCOUNT_NOT_ACTIVE', 'Ambas cuentas deben estar activas');
    }
    if (from.currency !== to.currency) {
      throw new AppError(422, 'CURRENCY_MISMATCH', 'Las cuentas tienen monedas distintas');
    }

    // 2) Registrar la transacción. Si dos peticiones con la misma clave llegan a la
    //    vez, la UNIQUE(idempotency_key) deja pasar solo a una.
    const inserted = await c.query(
      `INSERT INTO transactions
         (idempotency_key, request_hash, from_account_id, to_account_id, amount, currency, description, trace_id)
       VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, created_at`,
      [
        input.idempotencyKey,
        hashRequest(input),
        from.id,
        to.id,
        input.amount,
        from.currency,
        input.description ?? null,
        input.traceId ?? null,
      ],
    );
    if (inserted.rowCount === 0) return { duplicate: true as const };
    const tx = inserted.rows[0];

    // 3) Débito atómico: la condición `balance >= monto` y el UPDATE ocurren en
    //    la misma sentencia, así que dos débitos concurrentes nunca sobregiran.
    const debit = await c.query(
      `UPDATE accounts
          SET balance = balance - $1::numeric, version = version + 1, updated_at = now()
        WHERE id = $2 AND balance >= $1::numeric
        RETURNING balance::text AS balance`,
      [input.amount, from.id],
    );
    if (debit.rowCount === 0) {
      throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Fondos insuficientes');
    }
    const credit = await c.query(
      `UPDATE accounts
          SET balance = balance + $1::numeric, version = version + 1, updated_at = now()
        WHERE id = $2
        RETURNING balance::text AS balance`,
      [input.amount, to.id],
    );

    // 4) Asientos de doble entrada (inmutables) con el saldo resultante.
    await c.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, balance_after)
       VALUES ($1, $2, 'DEBIT',  $3::numeric, $4::numeric),
              ($1, $5, 'CREDIT', $3::numeric, $6::numeric)`,
      [tx.id, from.id, input.amount, debit.rows[0].balance, to.id, credit.rows[0].balance],
    );

    // 5) Outbox: el evento se guarda en la MISMA transacción. Un worker lo publicará
    //    después (IA, sincronización con Bancs) sin bloquear esta respuesta.
    await c.query(
      `INSERT INTO outbox_events (aggregate_id, event_type, payload, trace_id)
       VALUES ($1, 'transfer.completed', $2::jsonb, $3)`,
      [
        tx.id,
        JSON.stringify({
          transactionId: tx.id,
          fromAccountId: from.id,
          toAccountId: to.id,
          amount: input.amount,
          currency: from.currency,
          occurredAt: new Date(tx.created_at).toISOString(),
        }),
        input.traceId ?? null,
      ],
    );

    return {
      duplicate: false as const,
      result: {
        transactionId: tx.id as string,
        status: 'COMPLETED',
        fromAccount: maskAccountNumber(input.fromAccount),
        toAccount: maskAccountNumber(input.toAccount),
        amount: input.amount,
        currency: from.currency,
        description: input.description ?? null,
        createdAt: new Date(tx.created_at).toISOString(),
        replayed: false,
      } satisfies TransferResult,
    };
  });

  if (outcome.duplicate) {
    // Otra petición con la misma clave ganó la carrera: devolvemos su resultado.
    const winner = await findByIdempotencyKey(input.idempotencyKey);
    if (!winner) throw new AppError(500, 'INCONSISTENT_STATE', 'Estado inconsistente al resolver idempotencia');
    return replayResult(winner, input);
  }
  return outcome.result;
}
