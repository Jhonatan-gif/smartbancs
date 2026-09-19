import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { config } from '../config';
import { pool } from '../infra/db';

/**
 * MÉTRICAS DE core-api (formato Prometheus, endpoint GET /metrics)
 *
 * Método RED (tráfico, errores, duración) + saturación (pool de BD). Las etiquetas tienen cardinalidad
 * BAJA a propósito: nunca se etiqueta por número de cuenta, id de transacción ni clave de idempotencia.
 */
export const registry = new Registry();
registry.setDefaultLabels({ service: 'core-api' });
collectDefaultMetrics({ register: registry });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de las peticiones HTTP',
  labelNames: ['method', 'route', 'status_code'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const transfersTotal = new Counter({
  name: 'transfers_total',
  help: 'Transferencias por resultado. outcome: created | replayed | rejected (4xx de negocio) | error (5xx)',
  labelNames: ['outcome', 'code'],
  registers: [registry],
});

export const transferDuration = new Histogram({
  name: 'transfer_duration_seconds',
  help: 'Duración total de POST /v1/transfers (incluye esperas por bloqueos)',
  labelNames: ['outcome'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

// --- Diagnóstico de la sección 3.5: QUÉ paso SQL se demora o falla ---
export const dbOpDuration = new Histogram({
  name: 'db_op_duration_seconds',
  help: 'Duración de cada paso SQL de la transferencia (lock_accounts, insert_tx, debit, credit, ledger, outbox...)',
  labelNames: ['op'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const dbOpErrors = new Counter({
  name: 'db_op_errors_total',
  help: 'Errores por paso SQL y código SQLSTATE (40P01 deadlock, 55P03 lock timeout, 57014 statement timeout...)',
  labelNames: ['op', 'pg_code'],
  registers: [registry],
});

export const dbErrors = new Counter({
  name: 'db_errors_total',
  help: 'Errores de base de datos vistos por la API, por tipo',
  labelNames: ['type'],
  registers: [registry],
});

new Gauge({
  name: 'db_pool_connections',
  help: 'Conexiones del pool: total, idle y waiting (peticiones esperando una conexión = saturación)',
  labelNames: ['state'],
  registers: [registry],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
});

new Gauge({
  name: 'db_pool_max_connections',
  help: 'Tamaño máximo configurado del pool',
  registers: [registry],
  collect() {
    this.set(config.dbPoolMax);
  },
});

// --- ai-service ---
export const aiCalls = new Counter({
  name: 'ai_calls_total',
  help: 'Llamadas al ai-service. outcome: ok | timeout | unavailable | circuit_open | bad_response',
  labelNames: ['outcome'],
  registers: [registry],
});

export const aiCallDuration = new Histogram({
  name: 'ai_call_duration_seconds',
  help: 'Duración de la consulta de recomendaciones tal como la ve el cliente (incluye el fallback)',
  labelNames: ['source'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const aiBreakerState = new Gauge({
  name: 'ai_breaker_state',
  help: 'Estado del circuit breaker del ai-service: 0 cerrado, 1 medio abierto, 2 abierto',
  registers: [registry],
});

const PG_ERROR_TYPES: Record<string, string> = {
  '40P01': 'deadlock',
  '40001': 'serialization_failure',
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
  '53300': 'too_many_connections',
};

// Las series de error se crean en 0 al arrancar. Sin esto, un contador que nunca ha fallado NO existe: Prometheus vería su
// primera muestra ya con valor > 0 y increase()/rate() darían 0, así que la PRIMERA alerta de un deadlock nunca se dispararía.
const ERROR_TYPES = [...new Set(Object.values(PG_ERROR_TYPES)), 'pool_timeout', 'other'];
const SQL_OPS = ['lock_accounts', 'lock_from', 'lock_to', 'insert_tx', 'debit', 'credit', 'ledger', 'outbox'];
for (const type of ERROR_TYPES) dbErrors.inc({ type }, 0);
for (const op of SQL_OPS) for (const pg_code of Object.keys(PG_ERROR_TYPES)) dbOpErrors.inc({ op, pg_code }, 0);
for (const outcome of ['created', 'replayed']) transfersTotal.inc({ outcome, code: 'none' }, 0);
for (const outcome of ['ok', 'timeout', 'unavailable', 'circuit_open', 'bad_response']) aiCalls.inc({ outcome }, 0);

export function pgErrorType(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code && PG_ERROR_TYPES[e.code]) return PG_ERROR_TYPES[e.code];
  if (typeof e?.message === 'string' && e.message.includes('timeout exceeded when trying to connect')) return 'pool_timeout';
  return 'other';
}

export interface SlowLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Ejecuta un paso SQL midiendo su duración. Si tarda más que SLOW_OP_MS, o falla, lo registra en el log con el
 * NOMBRE del paso y el trace_id: así se ve qué consulta exacta se bloquea, hace timeout o provoca el deadlock.
 */
const tracer = trace.getTracer('core-api');

export async function timedOp<T>(op: string, fn: () => Promise<T>, ctx?: { log?: SlowLog; traceId?: string }): Promise<T> {
  // Un span por paso SQL: en la traza se ve cuánto tarda cada paso y cuál falla (no-op si el SDK no está activo).
  return tracer.startActiveSpan(`db.${op}`, { attributes: { 'db.operation.name': op } }, async (span) => {
    const start = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - start) / 1e9;
    try {
      const result = await fn();
      const s = elapsed();
      dbOpDuration.observe({ op }, s);
      if (s * 1000 >= config.slowOpMs) {
        ctx?.log?.warn({ op, ms: Math.round(s * 1000), trace_id: ctx.traceId }, 'operación SQL lenta');
      }
      return result;
    } catch (err) {
      const s = elapsed();
      dbOpDuration.observe({ op }, s);
      const e = err as { code?: string; detail?: string; where?: string; message?: string };
      dbOpErrors.inc({ op, pg_code: e?.code ?? 'none' });
      // Solo los errores de BD llevan detalle de bloqueo; los de negocio (AppError) no.
      if (e?.code) {
        span.setAttribute('db.pg_code', e.code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: `${pgErrorType(err)}: ${e.message ?? ''}` });
        span.recordException(err as Error);
        ctx?.log?.error(
          { op, ms: Math.round(s * 1000), pg_code: e.code, type: pgErrorType(err), detail: e.detail, where: e.where, trace_id: ctx.traceId },
          `error SQL en el paso ${op}`,
        );
      }
      throw err;
    } finally {
      span.end();
    }
  });
}
