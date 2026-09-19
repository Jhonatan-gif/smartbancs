# Observabilidad de SmartBancs

Cubre 3.4 (instrumentación y diseño) y la parte de monitoreo de 3.5 (incidente). Decisión y límites: [ADR-0005](adr/0005-observabilidad.md).

## Cómo levantarla
```powershell
docker compose --profile obs up -d --build       # el sistema + observabilidad
```
| Qué | URL |
|---|---|
| Grafana (dashboards en la carpeta **SmartBancs**; lectura sin iniciar sesión, admin/admin para editar) | http://localhost:3001 |
| Prometheus (métricas y `/alerts`) | http://localhost:9090 |
| Tempo (trazas, por API) · Loki (logs, por API) | http://localhost:3200 · http://localhost:3100 |
| `/metrics` de cada servicio | core-api `:3000` · worker `:9464` · ai-service `:8000` |

Verificación automática: `powershell -ExecutionPolicy Bypass -File scripts\verificar-paso4.ps1` (evidencia en
[`evidencias/paso4-verificacion.txt`](evidencias/paso4-verificacion.txt)).

## 1. Qué se registra (3.4, práctico)
| Requisito del reto | Dónde |
|---|---|
| Transacciones exitosas, errores y excepciones | `transfers_total{outcome,code}`; logs de core-api con `trace_id` (JSON) |
| Llamadas al servicio de IA | `ai_calls_total{outcome}`, `ai_call_duration_seconds`, `ai_breaker_state`; log `llamada al ai-service` / `ai-service no disponible` |
| Interacciones con la BD | `db_op_duration_seconds{op}`, `db_op_errors_total{op,pg_code}`, `db_errors_total{type}`, pool (`db_pool_connections`), spans `db.*` y `pg.query` |
| Volumen, errores y tiempos de respuesta | `http_request_duration_seconds{route,status_code}`, `transfer_duration_seconds` |
| Rastrear una transacción entre componentes | `trace_id` en logs de core-api, relay, worker y ai-service, y **una traza** que cruza core-api → outbox → worker → Bancs |
| Sincronización con Bancs | `bancs_calls_total`, `bancs_call_duration_seconds`, `bancs_batch_size`, `bancs_breaker_state`, `bancs_synced_total`, `bancs_retries_total`, `dlq_length`, `sync_unsynced_transactions`, `outbox_unpublished_events`, `stream_group_lag` |
| Motor de BD | postgres_exporter: `pg_stat_database_deadlocks`, `pg_locks_count`, `pg_stat_activity_count`, `pg_stat_activity_max_tx_duration` |

### Seguir UNA transferencia de punta a punta
1. La respuesta de `POST /v1/transfers` trae la cabecera `x-request-id`: es el `trace_id` (32 hex).
2. **Loki:** `{service=~"core-api|worker"} |= "<trace_id>"` → petición, evento publicado por el relay y lote enviado a Bancs.
3. **Tempo:** abrir la traza `<trace_id>`: `POST /v1/transfers` → `db.lock_accounts` → `db.insert_tx` → `db.debit` → `db.credit` →
   `db.ledger` → `db.outbox` → `outbox.publish` → `bancs.sync` (en el worker, con la duración real de la sincronización).
4. En Grafana los logs de Loki tienen un enlace "Ver traza" y, desde la traza, se salta a sus logs.

## 2. Diseño: qué información identifica cada problema (3.4, teórico)
Se usan las **cuatro señales doradas** (latencia, tráfico, errores, saturación) y se añade una por dependencia externa.

| Síntoma | Señal que lo revela | Por qué sirve |
|---|---|---|
| Transferencias lentas | `p95/p99 de transfer_duration_seconds` y `db_op_duration_seconds` por paso | El percentil alto detecta la cola que el promedio esconde; el paso que se dispara indica dónde se va el tiempo |
| Degradación por saturación | `db_pool_connections{state="waiting"}`, sesiones y transacción más larga en PostgreSQL | Las peticiones esperan conexión antes de fallar: es el aviso temprano |
| Errores | `transfers_total{outcome="error"}` por `code`; `db_op_errors_total` por SQLSTATE | Separa errores de negocio (rejected) de infraestructura (error) para no alertar por fondos insuficientes |
| Bloqueos y deadlocks | `db_errors_total{type="deadlock"}`, `pg_stat_database_deadlocks`, log con `detail` y `where` | La métrica avisa; el detalle dice qué procesos y qué fila |
| Legado caído o lento | `bancs_breaker_state`, `bancs_calls_total{outcome}`, `sync_unsynced_transactions` | El breaker abierto explica por qué se acumula el retraso sin afectar al cliente |
| Pérdida de movimientos | `dlq_length`, `stream_group_lag`, `outbox_unpublished_events` | Deben tender a 0: si crecen, algo no se entrega |
| IA degradada | `ai_calls_total{outcome!="ok"}` | No afecta a transferencias, pero indica que las recomendaciones salen del fallback |
| Un servicio no responde | `up` de Prometheus | Detecta caídas totales |

## 3. Incidente 3.5: cómo se identifica el proceso exacto (práctico)
Panel **SmartBancs - Incidente** y este orden de lectura:
1. *Síntomas:* p95 de transferencias, deadlocks/min, timeouts/min, pool esperando, transacción más larga, alertas.
2. *Dónde:* **duración p99 por paso SQL** y **errores por paso y SQLSTATE**. Con `LOCK_ORDERING=off` el deadlock aparece en
   `lock_to` (`40P01`); con bloqueos largos se dispara `lock_accounts`.
3. *Saturación:* pool de la API frente a sesiones de PostgreSQL (`active` / `idle in transaction`) y `pg_locks` por modo.
4. *Evidencia:* logs de "operación SQL lenta" y "error SQL en el paso" (paso, `pg_code`, procesos bloqueados, `trace_id`), log de
   PostgreSQL (`deadlock detected`, `still waiting`; `log_lock_waits=on`, `deadlock_timeout=500ms`) y trazas con error.

Reproducción controlada: `LOCK_ORDERING=off SIMULATED_LOCK_DELAY_MS=300` y transferencias cruzadas A↔B a la vez
(lo automatiza `scripts/verificar-paso4.ps1`; el simulador completo con corrección y post mortem es el siguiente bloque).

## 4. Alertas (`observability/prometheus/alerts.yml`)
`TransferLatencyP95High` (> 2 s) · `TransferErrorRateHigh` (> 1 %) · `DeadlocksDetected` · `LockTimeouts` · `DbPoolSaturated` ·
`DbPoolExhausted` · `LongRunningTransaction` (> 5 s) · `BancsCircuitOpen` · `BancsSyncLagging` · `DeadLetterQueueNotEmpty` ·
`AiServiceDegraded` · `TargetDown`. Cada una lleva un resumen y una pista de a qué panel ir.

## 5. En producción (Dynatrace u otro proveedor)
Los servicios ya hablan **OTLP/HTTP**: para enviar las trazas a Dynatrace basta cambiar `OTEL_EXPORTER_OTLP_ENDPOINT` (y el token de
cabecera), idealmente pasando por un OpenTelemetry Collector que además haga muestreo y filtrado. Las métricas pueden enviarse por
OTLP o por `remote_write`. **Esto no se ha probado contra Dynatrace**: es la vía de migración, no una integración entregada.
Además: muestreo (`OTEL_TRACES_SAMPLER_ARG`, p. ej. 5 %), Alertmanager con Slack/PagerDuty, almacenamiento de objetos para
Loki/Tempo, SLOs con alertas de quemado del presupuesto de error, y retención acorde a la normativa.

## 6. Límites conocidos (dicho con honestidad)
- Sin Alertmanager: las alertas se ven en Prometheus y Grafana, no se notifican.
- ai-service y bancs-mock no generan trazas propias (su tiempo se ve dentro del span del cliente).
- Umbrales y dashboards diseñados y comprobados con tráfico de prueba pequeño; no calibrados con carga alta (pendiente: k6).
- Solo `DeadlocksDetected` se ha disparado en una prueba real; el resto de alertas están validadas sintácticamente (Prometheus las carga sin errores).
- Los dashboards se comprobaron ejecutando cada consulta de cada panel contra Prometheus, Loki y Tempo; no se hizo revisión visual con capturas.
