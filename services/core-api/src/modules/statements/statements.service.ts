import { config } from '../../config';
import { pool } from '../../infra/db';
import { AppError } from '../../shared/errors';
import { maskAccountNumber } from '../../shared/account-number';

export interface StatementMovement {
  date: string; // ISO 8601 UTC
  type: 'DEBIT' | 'CREDIT';
  counterparty: string; // enmascarada
  description: string;
  amount: string; // decimal como texto, nunca float
  balanceAfter: string;
}

export interface Statement {
  accountNumber: string; // enmascarado
  holder: string;
  currency: string;
  month: string; // YYYY-MM
  periodStart: string;
  periodEnd: string; // exclusivo
  openingBalance: string;
  totalCredits: string;
  totalDebits: string;
  closingBalance: string;
  movementCount: number;
  movements: StatementMovement[];
  generatedAt: string;
}

/**
 * ESTADO DE CUENTA MENSUAL (periodo en UTC: del día 1 a las 00:00 al día 1 del mes siguiente, exclusivo)
 *
 * Todo sale del LIBRO MAYOR (ledger) y del saldo actual, dentro de UNA transacción de solo lectura con snapshot
 * (REPEATABLE READ): los totales y el detalle no pueden descuadrarse aunque entren transferencias mientras se genera.
 *
 *   saldo final   = saldo actual - (movimientos netos posteriores al periodo)
 *   saldo inicial = saldo final  - (créditos - débitos del periodo)
 *
 * Así el saldo inicial es correcto incluso si la cuenta nació con saldo (sin asiento) o si hay meses sin movimientos.
 * Los importes se calculan en PostgreSQL con NUMERIC y salen como texto: nunca pasan por float.
 */
export async function buildStatement(accountNumber: string, month: string): Promise<Statement> {
  const [year, mon] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(year, mon, 1));

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const acc = await client.query(
      `SELECT a.id, a.account_number, a.currency, a.balance::text AS balance, c.full_name AS holder
         FROM accounts a JOIN customers c ON c.id = a.customer_id
        WHERE a.account_number = $1`,
      [accountNumber],
    );
    if (acc.rows.length === 0) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'La cuenta no existe');
    const a = acc.rows[0];

    const totals = await client.query(
      `WITH m AS (
         SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0) AS credits,
                COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)  AS debits,
                count(*)::int AS n
           FROM ledger_entries WHERE account_id = $1 AND created_at >= $2 AND created_at < $3),
       posterior AS (
         SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) AS net
           FROM ledger_entries WHERE account_id = $1 AND created_at >= $3)
       SELECT ($4::numeric - posterior.net)::numeric(18,2)::text                          AS closing,
              ($4::numeric - posterior.net - (m.credits - m.debits))::numeric(18,2)::text AS opening,
              m.credits::numeric(18,2)::text AS credits, m.debits::numeric(18,2)::text AS debits, m.n
         FROM m, posterior`,
      [a.id, start.toISOString(), end.toISOString(), a.balance],
    );
    const t = totals.rows[0];
    // Tope de movimientos por estado de cuenta: se responde 422 en vez de armar una respuesta gigante en memoria.
    if (t.n > config.statementMaxRows) {
      throw new AppError(
        422,
        'STATEMENT_TOO_LARGE',
        `El periodo tiene ${t.n} movimientos (máximo ${config.statementMaxRows}); use /movements con paginación`,
      );
    }

    const rows = await client.query(
      `SELECT le.created_at, le.direction, le.amount::text AS amount, le.balance_after::text AS balance_after,
              COALESCE(tx.description, '') AS description, cp.account_number AS counterparty
         FROM ledger_entries le
         JOIN transactions tx   ON tx.id = le.transaction_id
         JOIN ledger_entries lo ON lo.transaction_id = le.transaction_id AND lo.account_id <> le.account_id
         JOIN accounts cp       ON cp.id = lo.account_id
        WHERE le.account_id = $1 AND le.created_at >= $2 AND le.created_at < $3
        ORDER BY le.id`,
      [a.id, start.toISOString(), end.toISOString()],
    );
    await client.query('COMMIT');

    return {
      accountNumber: maskAccountNumber(a.account_number),
      holder: a.holder,
      currency: a.currency.trim(),
      month,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      openingBalance: t.opening,
      totalCredits: t.credits,
      totalDebits: t.debits,
      closingBalance: t.closing,
      movementCount: t.n,
      movements: rows.rows.map((r) => ({
        date: new Date(r.created_at).toISOString(),
        type: r.direction,
        counterparty: maskAccountNumber(r.counterparty),
        description: r.description,
        amount: r.amount,
        balanceAfter: r.balance_after,
      })),
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* la conexión pudo haberse caído */
    }
    throw err;
  } finally {
    client.release();
  }
}
