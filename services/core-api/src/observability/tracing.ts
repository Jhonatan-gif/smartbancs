/**
 * TRAZAS DISTRIBUIDAS (OpenTelemetry). Este módulo debe importarse ANTES que fastify/pg para poder instrumentarlos.
 *
 * Solo se activa si existe OTEL_EXPORTER_OTLP_ENDPOINT (en las pruebas no existe, así que no se exporta nada).
 * Exporta por OTLP/HTTP: el mismo protocolo sirve para Tempo (aquí) o para un Collector / Dynatrace en producción,
 * cambiando únicamente la URL. El muestreo se controla con OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG
 * (p. ej. parentbased_traceidratio y 0.05 para muestrear el 5 % con mucho tráfico).
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
let sdk: NodeSDK | undefined;

if (endpoint) {
  sdk = new NodeSDK({
    serviceName: 'core-api',
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      // /metrics y /health se llaman cada pocos segundos: no aportan nada como trazas
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => ['/metrics', '/health'].includes((req.url ?? '').split('?')[0]),
      }),
      new FastifyInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }), // SQL con $1, $2: nunca los valores
      new UndiciInstrumentation(), // fetch hacia el ai-service (propaga traceparent)
    ],
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
}
