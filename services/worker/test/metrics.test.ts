import { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { bancsCalls, deadLetteredTotal, startMetricsServer } from '../src/metrics';

let healthy = true;
const server = startMetricsServer(0, () => healthy);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => new Promise((r) => server.close(r)));

describe('Métricas y health del worker', () => {
  it('/metrics expone contadores de Bancs y de DLQ con el label service=worker', async () => {
    bancsCalls.inc({ outcome: 'ok' });
    deadLetteredTotal.inc(2);
    await new Promise((r) => setTimeout(r, 50));
    const body = await (await fetch(`${base()}/metrics`)).text();
    expect(body).toContain('bancs_calls_total{outcome="ok",service="worker"} 1');
    expect(body).toContain('bancs_dead_lettered_total{service="worker"} 2');
    expect(body).toContain('# TYPE bancs_batch_size histogram');
  });

  it('/health responde 200 cuando está sano y 503 cuando no', async () => {
    expect((await fetch(`${base()}/health`)).status).toBe(200);
    healthy = false;
    expect((await fetch(`${base()}/health`)).status).toBe(503);
    healthy = true;
  });

  it('ruta desconocida = 404', async () => {
    expect((await fetch(`${base()}/otra`)).status).toBe(404);
  });
});
