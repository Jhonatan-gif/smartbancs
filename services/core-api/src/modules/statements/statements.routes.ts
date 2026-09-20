import { FastifyInstance } from 'fastify';
import { maskAccountNumber } from '../../shared/account-number';
import { statementToCsv } from './statement.csv';
import { statementToPdf } from './statement.pdf';
import { buildStatement } from './statements.service';

/**
 * GET /v1/accounts/{n}/statements?month=YYYY-MM&format=csv|pdf
 * Estado de cuenta mensual descargable: saldo inicial, créditos, débitos, saldo final y el detalle de movimientos.
 * Se genera a partir del ledger en una transacción de solo lectura (ver statements.service.ts).
 */
export async function statementRoutes(app: FastifyInstance) {
  app.get<{ Params: { accountNumber: string }; Querystring: { month: string; format?: 'csv' | 'pdf' } }>(
    '/accounts/:accountNumber/statements',
    {
      schema: {
        params: {
          type: 'object',
          required: ['accountNumber'],
          properties: { accountNumber: { type: 'string', pattern: '^[0-9]{10}$' } },
        },
        querystring: {
          type: 'object',
          required: ['month'],
          additionalProperties: false,
          properties: {
            month: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
            format: { type: 'string', enum: ['csv', 'pdf'], default: 'csv' },
          },
        },
      },
    },
    async (request, reply) => {
      const { accountNumber } = request.params;
      const { month, format = 'csv' } = request.query;
      const statement = await buildStatement(accountNumber, month);

      // El nombre del archivo lleva la cuenta enmascarada (nunca el número completo).
      const filename = `estado-cuenta-${maskAccountNumber(accountNumber).replace(/\*/g, 'x')}-${month}.${format}`;
      reply.header('content-disposition', `attachment; filename="${filename}"`);
      reply.header('cache-control', 'no-store'); // datos financieros: que no se guarden en cachés intermedias
      request.log.info({ month, format, movements: statement.movementCount }, 'estado de cuenta generado');

      if (format === 'pdf') {
        reply.header('content-type', 'application/pdf');
        return reply.send(statementToPdf(statement));
      }
      reply.header('content-type', 'text/csv; charset=utf-8');
      return reply.send(statementToCsv(statement));
    },
  );
}
