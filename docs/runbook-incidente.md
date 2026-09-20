# Runbook: latencia alta, timeouts de conexión y deadlocks en transferencias

Cubre el escenario 3.5 del reto ("pico de quincena: latencia, timeouts con la base de datos y posibles deadlocks").
Se puede **reproducir y practicar** con `scripts/simulate-incident.ps1`; los números que aparecen aquí salen de esa simulación
(ver [post mortem de la simulación](postmortem/2026-09-19-simulacion-deadlocks.md)).

## 0. Señales de que empieza (qué alerta salta)
| Alerta / panel (Grafana › *Incidente*) | Significa |
|---|---|
| `TransferLatencyP95High` | p95 de transferencias > 2 s (incumple el requisito del reto) |
| `DbPoolSaturated` / `DbPoolExhausted` | peticiones esperando una conexión / 0 conexiones libres |
| `DeadlocksDetected`, `LockTimeouts` | PostgreSQL mata transacciones por deadlock o el bloqueo excede `lock_timeout` |
| `TransferErrorRateHigh` | más de 1 % de errores 5xx/409 |

## 1. Triage (primeros 5 minutos)
1. **¿Es solo esto o hay caída total?** `up` de Prometheus y `GET /health`. Si core-api no responde: reiniciar réplica y pasar al punto 5.
2. **¿Se está perdiendo dinero?** No: cada transferencia es una transacción atómica; los errores dejan el estado sin cambios y el cliente puede
   reintentar con la **misma `Idempotency-Key`** (nunca se duplica). Comunicarlo al canal de soporte.
3. **¿Afecta a Bancs o a la IA?** No bloquean la transferencia (sincronización asíncrona y recomendaciones con *fallback*). Mirar
   `bancs_breaker_state` y `ai_breaker_state` solo para descartarlos.

## 2. Diagnóstico: identificar la consulta o el proceso exacto
Orden de lectura (todo está en el dashboard **SmartBancs - Incidente**):
1. **¿Dónde se va el tiempo?** *Duración p99 por paso SQL* (`db_op_duration_seconds{op}`): `lock_accounts`, `lock_from`, `lock_to`,
   `insert_tx`, `debit`, `credit`, `ledger`, `outbox`.
2. **¿Qué falla y con qué código?** *Errores por paso y SQLSTATE* (`db_op_errors_total`): `40P01` deadlock, `55P03` lock timeout, `57014` statement timeout.
   En la simulación los errores estaban en `lock_from` y `lock_to`: el problema es el **orden de los bloqueos**, no las escrituras.
3. **¿Hay saturación?** `db_pool_connections{state="waiting"}` (en la simulación llegó a 428 peticiones esperando con un pool de 8).
4. **Evidencia en logs** (Loki): `{service="core-api"} |= "error SQL en el paso"` → paso, `pg_code`, `detail` (procesos bloqueados) y `trace_id`.
   Con el `trace_id`, abrir la traza en Tempo: el span `db.lock_*` en rojo es el paso que falló.
5. **Quién bloquea a quién** (SQL directo):
   ```sql
   SELECT blocked.pid AS bloqueada, blocking.pid AS bloqueante, blocked.wait_event_type, blocked.wait_event,
          now() - blocked.xact_start AS antiguedad, left(blocked.query, 90) AS consulta
     FROM pg_stat_activity blocked
     JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON true
     JOIN pg_stat_activity blocking ON blocking.pid = b.pid
    WHERE blocked.datname = 'smartbancs';
   ```
   Transacciones largas: `SELECT pid, state, now()-xact_start AS edad, left(query,80) FROM pg_stat_activity WHERE state <> 'idle' ORDER BY xact_start;`
6. **Log de PostgreSQL** (`log_lock_waits=on`, `deadlock_timeout=500ms`): `{service="postgres"} |~ "deadlock|still waiting"`.

## 3. Acciones inmediatas (estabilizar; soluciones temporales)
Ordenadas de menor a mayor impacto. Marcadas con ✅ las que se ejercitaron en la simulación.
| Acción | Cuándo | Efecto / riesgo |
|---|---|---|
| ✅ **Revertir el último cambio / apagar el flag** (`LOCK_ORDERING=on`, o rollback del despliegue) | El incidente empezó tras un despliegue | Es la mitigación que funcionó: 93 % de errores → 0 % en cuanto se aplicó |
| ✅ **Terminar las sesiones bloqueantes** (`SELECT pg_terminate_backend(<pid bloqueante>)`) | Hay una transacción colgada reteniendo bloqueos | Libera el pool al instante; el cliente reintenta. En la simulación no había sesiones largas: PostgreSQL ya resolvía cada deadlock en 500 ms |
| **Limitar la entrada** (rate limit / `429` en el balanceador, `limit_req` de nginx) | Saturación sostenida | Falla rápido y protege la BD en vez de encolar; el cliente reintenta con backoff |
| **Escalar réplicas de core-api** (`--scale core-api=N`) | El cuello es CPU de la API, no la BD | Con 4 réplicas se pasó de ~570 a ~1.100 tps máx. **No ayuda** si el problema son los bloqueos: más concurrencia = más deadlocks |
| **Ajustar timeouts y pool** (`DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`) | Cola larga de conexiones | Sube el techo o falla antes; cuidado con superar `max_connections` de PostgreSQL |
| **Balancear/aislar cuentas calientes** | Un titular o cuenta concentra el tráfico | Serializar en la aplicación o separar la carga |
| **Reiniciar la réplica afectada** | Proceso degradado | Rápido pero no arregla la causa |
| Degradar lo no crítico | Siempre disponible | IA (fallback) y sincronización con Bancs ya no bloquean la transferencia |

## 4. Corrección definitiva
- **Causa técnica del escenario:** dos transferencias cruzadas (A→B y B→A) bloquean las cuentas en orden distinto y se esperan mutuamente.
- **Fix:** bloquear siempre **ambas cuentas en una sola sentencia y en orden ascendente de id** (`ORDER BY id FOR UPDATE`) → una espera a la otra, nunca hay ciclo.
  Ya está en el código (por defecto `LOCK_ORDERING=on`) y lo cubre el test de concurrencia (`transfers.concurrency.test.ts`).
- **Que no vuelva:** test de deadlocks en CI, alerta `DeadlocksDetected`, revisión de cualquier cambio que toque el orden de bloqueo.

## 5. Verificación de la recuperación
- p95 < 2 s, errores < 1 %, `db_errors_total{type="deadlock"}` sin cambios durante 10 minutos, `db_pool_connections{state="waiting"}` = 0.
- Conciliar: `dlq_length` = 0 y `sync_unsynced_transactions` bajando (los movimientos acumulados se sincronizan solos).
- `scripts/run-loadtest.ps1 -Scenario smoke` confirma dinero conservado y ledger cuadrado.

## 6. Comunicación y escalamiento
| Nivel | Quién | Cuándo se involucra |
|---|---|---|
| L1 | Guardia (on-call) | Alerta disparada: triage y acciones de la sección 3 |
| L2 | Backend + DBA | 15 min sin mejora, o sospecha de bloqueos/consultas: diagnóstico SQL y fix |
| L3 | Arquitectura / responsable técnico | 30 min sin mejora, riesgo de pérdida de datos, o decisión de rollback mayor |
| Incident commander | Rol designado en L2/L3 | Coordina, lleva la línea de tiempo y comunica cada 15-30 min a negocio y soporte |

Después: abrir el post mortem ([plantilla](postmortem/plantilla.md)) en las 48 h siguientes, sin buscar culpables.
