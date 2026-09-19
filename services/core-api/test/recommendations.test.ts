import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/infra/db';
import { AiClient } from '../src/modules/recommendations/ai-client';
import { buildApp } from '../src/server';
import { generateAccountNumber } from '../src/shared/account-number';

type Mode = 'ok' | 'slow' | 'error500';

/** ai-service simulado: responde bien, se cuelga 5 s o devuelve 500. Cuenta las llamadas recibidas. */
function startStub() {
  const stub = { mode: 'ok' as Mode, hits: 0, url: '', server: http.createServer() };
  stub.server.on('request', (req, res) => {
    stub.hits++;
    const send = () => {
      if (res.writableEnded || res.destroyed) return;
      if (stub.mode === 'error500') {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          account: req.url!.split('/').pop(),
          source: 'model',
          modelVersion: 'stub-v1',
          coldStart: false,
          segment: 'medio',
          recommendations: [{ id: 'X', type: 'general', severity: 'info', title: 't', message: 'm' }],
          generatedAt: new Date().toISOString(),
        }),
      );
    };
    if (stub.mode === 'slow') setTimeout(send, 5000).unref();
    else send();
  });
  return new Promise<typeof stub>((resolve) =>
    stub.server.listen(0, '127.0.0.1', () => {
      stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
      resolve(stub);
    }),
  );
}

const timed = async <T>(fn: () => Promise<T>) => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
};

let stub: Awaited<ReturnType<typeof startStub>>;
let accounts: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

function makeApp(overrides: Partial<ConstructorParameters<typeof AiClient>[0]> = {}) {
  const client = new AiClient({ baseUrl: stub.url, timeoutMs: 300, breakerThreshold: 3, breakerCooldownMs: 400, ...overrides });
  const app = buildApp({ aiClient: client });
  apps.push(app);
  return { app, client };
}
const recs = (app: ReturnType<typeof buildApp>, account = accounts[0]) =>
  app.inject({ method: 'GET', url: `/v1/accounts/${account}/recommendations` });

beforeAll(async () => {
  stub = await startStub();
  const customer = await pool.query(
    `INSERT INTO customers (full_name, email) VALUES ('Cliente IA', $1) RETURNING id`,
    [`ia-${randomUUID()}@example.com`],
  );
  for (let i = 0; i < 4; i++) {
    const number = generateAccountNumber();
    await pool.query(`INSERT INTO accounts (customer_id, account_number, balance) VALUES ($1, $2, 100000.00)`, [
      customer.rows[0].id,
      number,
    ]);
    accounts.push(number);
  }
});
afterEach(() => {
  stub.mode = 'ok';
  stub.hits = 0;
});
afterAll(async () => {
  for (const a of apps) await a.close();
  stub.server.closeAllConnections();
  await new Promise((r) => stub.server.close(r));
  await pool.end();
});

describe('Recomendaciones con ai-service sano', () => {
  it('devuelve las recomendaciones del modelo', async () => {
    const { app } = makeApp();
    const res = await recs(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'model', degraded: false, modelVersion: 'stub-v1' });
    expect(res.headers['x-recommendations-source']).toBe('model');
  });

  it('404 si la cuenta no existe y 400 si el formato es inválido', async () => {
    const { app } = makeApp();
    expect((await recs(app, generateAccountNumber())).statusCode).toBe(404);
    expect((await recs(app, '123')).statusCode).toBe(400);
    expect(stub.hits).toBe(0); // ni siquiera se molesta al ai-service
  });
});

describe('Degradación elegante: el ai-service falla y el cliente igual recibe respuesta', () => {
  it('ai-service LENTO (5 s): responde el fallback en < 500 ms', async () => {
    stub.mode = 'slow';
    const { app } = makeApp();
    const { value: res, ms } = await timed(() => recs(app));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'fallback', degraded: true, reason: 'timeout' });
    expect(res.json().recommendations.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });

  it('ai-service CAÍDO (conexión rechazada): fallback inmediato', async () => {
    const dead = new AiClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300, breakerThreshold: 3, breakerCooldownMs: 400 });
    const app = buildApp({ aiClient: dead });
    apps.push(app);
    const { value: res, ms } = await timed(() => recs(app));
    expect(res.json()).toMatchObject({ source: 'fallback', reason: 'unavailable' });
    expect(ms).toBeLessThan(500);
  });

  it('ai-service con error 500: fallback', async () => {
    stub.mode = 'error500';
    const { app } = makeApp();
    expect((await recs(app)).json()).toMatchObject({ source: 'fallback', degraded: true });
  });

  it('circuit breaker: tras 3 fallos deja de llamar al ai-service y responde al instante', async () => {
    stub.mode = 'slow';
    const { app, client } = makeApp();
    for (let i = 0; i < 3; i++) await recs(app); // 3 timeouts -> abre el circuito
    expect(client.breakerState).toBe('OPEN');
    expect(stub.hits).toBe(3);

    const { value: res, ms } = await timed(() => recs(app));
    expect(res.json()).toMatchObject({ source: 'fallback', reason: 'circuit_open' });
    expect(ms).toBeLessThan(100); // sin esperar el timeout
    expect(stub.hits).toBe(3); // no se le hizo ni una llamada más
  });

  it('recuperación: al volver el ai-service, tras el cooldown se vuelve a servir el modelo', async () => {
    stub.mode = 'error500';
    const { app, client } = makeApp();
    for (let i = 0; i < 3; i++) await recs(app);
    expect(client.breakerState).toBe('OPEN');

    stub.mode = 'ok';
    await new Promise((r) => setTimeout(r, 450)); // cooldown de 400 ms
    const res = await recs(app);
    expect(res.json()).toMatchObject({ source: 'model', degraded: false });
    expect(client.breakerState).toBe('CLOSED');
  });
});

describe('La IA NUNCA afecta al flujo transaccional', () => {
  const runTransfers = async (app: ReturnType<typeof buildApp>, n: number) => {
    const latencies: number[] = [];
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const from = accounts[i % 2];
      const to = accounts[2 + (i % 2)];
      const { value: res, ms } = await timed(() =>
        app.inject({
          method: 'POST',
          url: '/v1/transfers',
          headers: { 'idempotency-key': randomUUID() },
          payload: { fromAccount: from, toAccount: to, amount: '1.00' },
        }),
      );
      latencies.push(ms);
      codes.push(res.statusCode);
    }
    latencies.sort((a, b) => a - b);
    return { codes, p50: latencies[Math.floor(n * 0.5)], p95: latencies[Math.floor(n * 0.95)] };
  };

  it('con el ai-service colgado y 40 consultas de recomendaciones en paralelo, las transferencias siguen dando 201', async () => {
    const { app } = makeApp();
    const base = await runTransfers(app, 40); // referencia: IA sana y sin carga de recomendaciones
    expect(base.codes.every((c) => c === 201)).toBe(true);

    stub.mode = 'slow';
    const recPromises = Array.from({ length: 40 }, () => recs(app));
    const during = await runTransfers(app, 40);
    const recResults = await Promise.all(recPromises);

    expect(during.codes.every((c) => c === 201)).toBe(true);
    expect(recResults.every((r) => r.statusCode === 200 && r.json().source === 'fallback')).toBe(true);
    expect(during.p95).toBeLessThan(2000); // requisito del reto: transferencias < 2 s
    // Las cifras reales quedan en el log de la prueba para documentarlas (no se inventan)
    console.log(
      `[medido] transferencias sin carga IA: p50=${base.p50.toFixed(1)}ms p95=${base.p95.toFixed(1)}ms | ` +
        `con IA colgada + 40 consultas: p50=${during.p50.toFixed(1)}ms p95=${during.p95.toFixed(1)}ms`,
    );
  });
});
