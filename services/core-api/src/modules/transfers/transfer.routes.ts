import { FastifyInstance } from 'fastify';
import { AppError } from '../../shared/errors';
import { isValidAccountNumber } from '../../shared/account-number';
import { executeTransfer } from './transfer.service';
import { transferDuration, transfersTotal } from '../../observability/metrics';
import { mapDbError } from '../../shared/errors';

const accountNumberSchema = { type: 'string', pattern: '^[0-9]{10}$' } as const;

export async function transferRoutes(app: FastifyInstance) {
  app.post<{
    Headers: { 'idempotency-key': string };
    Body: { fromAccount: string; toAccount: string; amount: string; description?: string };
  }>(
    '/transfers',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 100 } },
        },
        body: {
          type: 'object',
          required: ['fromAccount', 'toAccount', 'amount'],
          additionalProperties: false,
          properties: {
            fromAccount: accountNumberSchema,
            toAccount: accountNumberSchema,
            // String decimal con máximo 2 decimales y mayor que cero.
            amount: { type: 'string', pattern: '^(?!0+(\\.0{1,2})?$)[0-9]{1,16}(\\.[0-9]{1,2})?$' },
            description: { type: 'string', maxLength: 140 },
          },
        },
      },
    },
    async (request, reply) => {
      const { fromAccount, toAccount, amount, description } = request.body;

      if (!isValidAccountNumber(fromAccount) || !isValidAccountNumber(toAccount)) {
        throw new AppError(400, 'INVALID_ACCOUNT_NUMBER', 'Número de cuenta inválido (dígito verificador)');
      }
      if (fromAccount === toAccount) {
        throw new AppError(400, 'SAME_ACCOUNT', 'La cuenta origen y destino deben ser distintas');
      }

      const started = process.hrtime.bigint();
      const observe = (outcome: string, code: string) => {
        transfersTotal.inc({ outcome, code });
        transferDuration.observe({ outcome }, Number(process.hrtime.bigint() - started) / 1e9);
      };

      let result;
      try {
        result = await executeTransfer({
          idempotencyKey: request.headers['idempotency-key'],
          fromAccount,
          toAccount,
          amount,
          description,
          traceId: request.id,
          log: request.log,
        });
      } catch (err) {
        // Errores de negocio (4xx) y de infraestructura (5xx) se cuentan por separado y por código.
        // Rechazo de negocio = AppError 4xx lanzado por nosotros. Todo lo demás (deadlock, timeouts, pool, bug) es "error".
        const isBusiness = err instanceof AppError && err.statusCode < 500;
        const code = err instanceof AppError ? err.code : (mapDbError(err)?.code ?? 'INTERNAL_ERROR');
        observe(isBusiness ? 'rejected' : 'error', code);
        throw err;
      }
      observe(result.replayed ? 'replayed' : 'created', 'none');

      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );
}
