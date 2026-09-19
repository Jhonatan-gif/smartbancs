import { FastifyInstance } from 'fastify';
import { pool } from '../../infra/db';
import { AppError } from '../../shared/errors';
import { maskAccountNumber } from '../../shared/account-number';

const accountParams = {
  type: 'object',
  required: ['accountNumber'],
  properties: { accountNumber: { type: 'string', pattern: '^[0-9]{10}$' } },
} as const;

export async function accountRoutes(app: FastifyInstance) {
  // Consulta de cuenta: número, tipo, moneda y saldo.
  app.get<{ Params: { accountNumber: string } }>(
    '/accounts/:accountNumber',
    { schema: { params: accountParams } },
    async (request) => {
      const { rows } = await pool.query(
        `SELECT a.account_number, a.account_type, a.currency, a.balance::text AS balance,
                a.status, a.created_at, c.full_name AS holder
           FROM accounts a JOIN customers c ON c.id = a.customer_id
          WHERE a.account_number = $1`,
        [request.params.accountNumber],
      );
      if (rows.length === 0) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'La cuenta no existe');
      const a = rows[0];
      return {
        accountNumber: a.account_number,
        accountType: a.account_type,
        currency: a.currency,
        balance: a.balance,
        status: a.status,
        holder: a.holder,
        createdAt: new Date(a.created_at).toISOString(),
      };
    },
  );

  // Movimientos: sale directamente del libro mayor, paginado por cursor
  // (estable y rápido aunque haya millones de filas, a diferencia de OFFSET).
  app.get<{ Params: { accountNumber: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/accounts/:accountNumber/movements',
    {
      schema: {
        params: accountParams,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string', pattern: '^[0-9]{1,18}$' },
          },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ?? 20;
      const cursor = request.query.cursor ?? null;

      const acc = await pool.query('SELECT id FROM accounts WHERE account_number = $1', [
        request.params.accountNumber,
      ]);
      if (acc.rows.length === 0) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'La cuenta no existe');

      const { rows } = await pool.query(
        `SELECT le.id, le.transaction_id, le.direction, le.amount::text AS amount,
                le.balance_after::text AS balance_after, le.created_at, t.description,
                cp.account_number AS counterparty
           FROM ledger_entries le
           JOIN transactions t      ON t.id = le.transaction_id
           JOIN ledger_entries lo   ON lo.transaction_id = le.transaction_id AND lo.account_id <> le.account_id
           JOIN accounts cp         ON cp.id = lo.account_id
          WHERE le.account_id = $1 AND ($2::bigint IS NULL OR le.id < $2::bigint)
          ORDER BY le.id DESC
          LIMIT $3`,
        [acc.rows[0].id, cursor, limit + 1],
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map((r) => ({
          id: r.id,
          transactionId: r.transaction_id,
          type: r.direction, // DEBIT | CREDIT
          amount: r.amount,
          balanceAfter: r.balance_after,
          counterparty: maskAccountNumber(r.counterparty),
          description: r.description,
          createdAt: new Date(r.created_at).toISOString(),
        })),
        nextCursor: hasMore ? String(page[page.length - 1].id) : null,
      };
    },
  );
}
