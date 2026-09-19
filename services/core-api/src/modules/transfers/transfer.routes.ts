import { FastifyInstance } from 'fastify';
import { AppError } from '../../shared/errors';
import { isValidAccountNumber } from '../../shared/account-number';
import { executeTransfer } from './transfer.service';

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

      const result = await executeTransfer({
        idempotencyKey: request.headers['idempotency-key'],
        fromAccount,
        toAccount,
        amount,
        description,
        traceId: request.id,
      });

      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );
}
