import { randomUUID } from 'node:crypto';
import Fastify, { FastifyError } from 'fastify';
import { config } from './config';
import { pool } from './infra/db';
import { AppError, mapDbError } from './shared/errors';
import { accountRoutes } from './modules/accounts/accounts.routes';
import { transferRoutes } from './modules/transfers/transfer.routes';
import { AiClient } from './modules/recommendations/ai-client';
import { recommendationRoutes } from './modules/recommendations/recommendations.routes';

export function buildApp(opts: { aiClient?: AiClient } = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Correlation id: se respeta el que envíe el cliente o se genera uno.
    // Aparece en cada log y se guarda en la transacción (trazabilidad).
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    requestIdHeader: false,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      request.log.warn({ code: err.code }, err.message);
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, requestId: request.id },
      });
    }
    if ((err as FastifyError).validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: err.message, requestId: request.id },
      });
    }
    const mapped = mapDbError(err);
    if (mapped) {
      request.log.error({ pgCode: (err as any).code, err }, `db error: ${mapped.code}`);
      return reply.status(mapped.statusCode).send({
        error: { code: mapped.code, message: mapped.message, requestId: request.id },
      });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Error interno', requestId: request.id },
    });
  });

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'db_unavailable' });
    }
  });

  app.register(transferRoutes, { prefix: '/v1' });
  app.register(accountRoutes, { prefix: '/v1' });
  app.register(recommendationRoutes, {
    prefix: '/v1',
    aiClient:
      opts.aiClient ??
      new AiClient({
        baseUrl: config.aiServiceUrl,
        timeoutMs: config.aiTimeoutMs,
        breakerThreshold: config.aiBreakerThreshold,
        breakerCooldownMs: config.aiBreakerCooldownMs,
      }),
  });

  return app;
}
