/**
 * TRAZAS DEL WORKER (OpenTelemetry). Solo se activa con OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * El worker no atiende peticiones: continúa las trazas que empezó core-api. El contexto W3C (`traceparent`) viaja en
 * el outbox y en el stream; aquí se crean spans HIJOS de la transferencia original (outbox.publish, bancs.sync), de modo
 * que UNA traza muestra API -> pasos SQL -> outbox -> sincronización con Bancs.
 */
import { ROOT_CONTEXT, SpanStatusCode, propagation, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
let sdk: NodeSDK | undefined;

if (endpoint) {
  sdk = new NodeSDK({
    serviceName: 'worker',
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [], // solo spans manuales: instrumentar fetch/pg crearía trazas huérfanas por cada lote
  });
  sdk.start();
}

const tracer = trace.getTracer('worker');

/** Crea un span por evento, hijo del span de la transferencia original, con la duración real de la etapa. */
export function recordEventSpans(
  events: { traceparent: string }[],
  name: string,
  startMs: number,
  endMs: number,
  attributes: Record<string, string | number>,
  error?: string,
): void {
  for (const e of events) {
    if (!e.traceparent) continue;
    const parent = propagation.extract(ROOT_CONTEXT, { traceparent: e.traceparent });
    const span = tracer.startSpan(name, { startTime: startMs, attributes }, parent);
    if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.end(endMs);
  }
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
}
