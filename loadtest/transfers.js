// Prueba de carga de POST /v1/transfers con k6.
//
//   SCENARIO=smoke  -> 20 tps 20 s (comprobación rápida)
//   SCENARIO=load   -> 100 -> 300 tps sostenidos (la carga "normal alta")
//   SCENARIO=ramp   -> escalera 200/400/800/1200/1600/2000 tps: busca dónde deja de cumplirse el requisito (< 2 s, < 1 % errores)
//   SCENARIO=fixed  -> tasa fija RATE (tps) durante DURATION (por defecto 30s): sirve para medir un escalón a la vez
//   SCENARIO=hot    -> solo 10 cuentas: fuerte contención de bloqueos (peor caso)
//
// Umbrales del reto: p95 < 2 s y errores < 1 %. Si no se cumplen, k6 termina con código de salida distinto de 0.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { account, randInt, randomAmount, uuid } from './lib.js';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const SCENARIO = __ENV.SCENARIO || 'smoke';
const ACCOUNTS = SCENARIO === 'hot' ? 10 : Number(__ENV.ACCOUNTS || 1000);
const REPLAY_RATE = 0.05; // 5 % de las iteraciones repite la misma Idempotency-Key (debe dar 200 y no duplicar)

const transferLatency = new Trend('transfer_latency', true);
const transferErrors = new Rate('transfer_errors'); // 5xx, 409 (deadlock/serialización) o sin respuesta
const created = new Counter('transfers_created');
const replayed = new Counter('transfers_replayed');
const rejected = new Counter('transfers_rejected');

const stage = (target, duration) => ({ target, duration });
const SCENARIOS = {
  smoke: { rate: 20, stages: [stage(20, '20s')], vus: 50, max: 200 },
  load: { rate: 100, stages: [stage(100, '10s'), stage(300, '20s'), stage(300, '60s')], vus: 200, max: 1000 },
  ramp: {
    rate: 100,
    stages: [stage(200, '30s'), stage(400, '30s'), stage(800, '30s'), stage(1200, '30s'), stage(1600, '30s'), stage(2000, '30s')],
    vus: 500,
    max: 3000,
  },
  fixed: { rate: Number(__ENV.RATE || 500), stages: [stage(Number(__ENV.RATE || 500), __ENV.DURATION || '30s')], vus: 300, max: 3000 },
  hot: { rate: 50, stages: [stage(50, '10s'), stage(200, '30s'), stage(200, '30s')], vus: 200, max: 1000 },
};
const cfg = SCENARIOS[SCENARIO];

export const options = {
  scenarios: {
    transfers: {
      executor: 'ramping-arrival-rate', // tasa de llegada fija por segundo, independiente de cuánto tarde el servidor
      startRate: cfg.rate,
      timeUnit: '1s',
      preAllocatedVUs: cfg.vus,
      maxVUs: cfg.max,
      stages: cfg.stages,
    },
  },
  // 201 creada, 200 repetición idempotente y 422 rechazo de negocio son respuestas correctas del API
  thresholds: {
    transfer_latency: ['p(95)<2000'],
    transfer_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function post(body, key) {
  return http.post(`${BASE_URL}/v1/transfers`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    tags: { name: 'transfer' },
    responseCallback: http.expectedStatuses(200, 201, 422),
  });
}

export default function () {
  const from = randInt(1, ACCOUNTS);
  let to = randInt(1, ACCOUNTS);
  if (to === from) to = (to % ACCOUNTS) + 1;
  const body = { fromAccount: account(from), toAccount: account(to), amount: randomAmount(), description: 'k6' };
  const key = uuid();

  const res = post(body, key);
  transferLatency.add(res.timings.duration);
  const failed = res.status === 0 || res.status >= 500 || res.status === 409;
  transferErrors.add(failed);
  if (res.status === 201) created.add(1);
  else if (res.status === 422) rejected.add(1);
  check(res, { 'respuesta esperada (201 o 422)': (r) => r.status === 201 || r.status === 422 });

  if (res.status === 201 && Math.random() < REPLAY_RATE) {
    const again = post(body, key); // misma clave y mismos datos: no debe volver a mover dinero
    replayed.add(1);
    check(again, {
      'repetición idempotente = 200 y mismo id': (r) => r.status === 200 && r.json('transactionId') === res.json('transactionId'),
    });
  }
}
