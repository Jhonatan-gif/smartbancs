import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import Fastify, { FastifyError } from 'fastify';
import { config } from './config';
import { pool } from './infra/db';
import { maskAccountsInUrl } from './shared/account-number';
import { AppError, mapDbError } from './shared/errors';
import { dbErrors, httpDuration, pgErrorType, registry } from './observability/metrics';
import { accountRoutes } from './modules/accounts/accounts.routes';
import { transferRoutes } from './modules/transfers/transfer.routes';
import { AiClient } from './modules/recommendations/ai-client';
import { recommendationRoutes } from './modules/recommendations/recommendations.routes';
import { statementRoutes } from './modules/statements/statements.routes';

export function buildApp(opts: { aiClient?: AiClient } = {}) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        // La URL de las consultas de cuenta lleva el número completo: se enmascara antes de llegar a los logs (y a Loki).
        req: (req) => ({ method: req.method, url: maskAccountsInUrl(req.url ?? ''), remoteAddress: req.ip }),
      },
    },
    // Correlation id: se respeta el que envíe el cliente o se genera uno.
    // Aparece en cada log y se guarda en la transacción (trazabilidad).
    // Prioridad: id enviado por el cliente > trace id de OpenTelemetry (enlaza logs y trazas) > uuid.
    genReqId: (req) =>
      (req.headers['x-request-id'] as string) || trace.getActiveSpan()?.spanContext().traceId || randomUUID(),
    requestIdHeader: false,
    // El id de la petición sale en cada log como `trace_id`: permite buscar en Loki todo lo de una transferencia.
    requestIdLogLabel: 'trace_id',
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Métrica RED por ruta (se usa la plantilla de la ruta, no la URL: evita explosión de cardinalidad).
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    if (route === '/metrics') return;
    httpDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
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
      dbErrors.inc({ type: pgErrorType(err) });
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

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  app.register(transferRoutes, { prefix: '/v1' });
  app.register(accountRoutes, { prefix: '/v1' });
  app.register(statementRoutes, { prefix: '/v1' });
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
