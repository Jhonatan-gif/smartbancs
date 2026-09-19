import { FastifyInstance } from 'fastify';
import { pool } from '../../infra/db';
import { AppError } from '../../shared/errors';
import { AiClient, AiUnavailableError } from './ai-client';
import { FALLBACK_RECOMMENDATIONS } from './fallback';

/**
 * GET /v1/accounts/{n}/recommendations
 *
 * Es un endpoint APARTE del flujo transaccional: una transferencia nunca espera al ai-service.
 * Si el ai-service tarda más que el timeout, falla o su circuit breaker está abierto, se responde 200 con
 * recomendaciones genéricas y `source: "fallback"` (degradación elegante), en menos de timeout + unos ms.
 */
export async function recommendationRoutes(app: FastifyInstance, opts: { aiClient: AiClient }) {
  app.get<{ Params: { accountNumber: string } }>(
    '/accounts/:accountNumber/recommendations',
    {
      schema: {
        params: {
          type: 'object',
          required: ['accountNumber'],
          properties: { accountNumber: { type: 'string', pattern: '^[0-9]{10}$' } },
        },
      },
    },
    async (request, reply) => {
      const { accountNumber } = request.params;
      const exists = await pool.query('SELECT 1 FROM accounts WHERE account_number = $1', [accountNumber]);
      if (exists.rows.length === 0) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'La cuenta no existe');

      const started = process.hrtime.bigint();
      const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
      try {
        const ai = await opts.aiClient.recommendations(accountNumber, request.id);
        request.log.info({ ai: 'ok', ms: elapsedMs(), breaker: opts.aiClient.breakerState }, 'llamada al ai-service');
        reply.header('x-recommendations-source', 'model');
        return { ...ai, degraded: false };
      } catch (err) {
        const reason = err instanceof AiUnavailableError ? err.reason : 'unavailable';
        request.log.warn(
          { ai: 'fallback', reason, ms: elapsedMs(), breaker: opts.aiClient.breakerState },
          'ai-service no disponible: se responde el fallback',
        );
        reply.header('x-recommendations-source', 'fallback');
        return {
          account: accountNumber,
          source: 'fallback',
          degraded: true,
          reason,
          recommendations: FALLBACK_RECOMMENDATIONS,
          generatedAt: new Date().toISOString(),
        };
      }
    },
  );
}
