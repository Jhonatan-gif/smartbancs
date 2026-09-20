# Post mortem: pico de quincena con deadlocks y agotamiento del pool (SIMULACIÓN)

> **Este incidente es simulado.** Se reproduce con `scripts/simulate-incident.ps1` (4 ejecuciones, todas con el mismo resultado cualitativo).
> Las cifras son **medidas** en un portátil con carga sintética de k6 sobre 6 cuentas calientes; no son datos de producción.
> Formato sin culpables. Plantilla usada: [`plantilla.md`](plantilla.md). Runbook aplicado: [`../runbook-incidente.md`](../runbook-incidente.md).

| | |
|---|---|
| **Escenario** | Pico transaccional: 120 transferencias/s cruzadas (A→B y B→A) sobre 6 cuentas muy activas |
| **Duración del incidente simulado** | 40 s de carga por fase |
| **Severidad (si fuera real)** | SEV1: 94,3 % de las transferencias fallan |
| **Estado** | Cerrado (corrección verificada) |

## 1. Resumen ejecutivo
Un cambio hizo que las dos cuentas de una transferencia se bloquearan **en el orden de la petición** en lugar de en orden de identificador.
Con transferencias cruzadas simultáneas, cada una retuvo una cuenta esperando la otra: *deadlocks*. Las transacciones bloqueadas retenían las
conexiones del pool de la base de datos, el pool se agotó (hasta 428 peticiones en cola) y casi todas las peticiones terminaron en error tras 2 s
de espera. Se identificó el paso SQL exacto con las métricas, los logs y las trazas; la mitigación efectiva fue **revertir el cambio**, que devolvió el
sistema a 0 errores. **No hubo pérdida ni duplicación de dinero (comprobado al final de la simulación).**

## 2. Impacto (medido)
| Fase | Transferencias/s atendidas | p50 | p95 | p99 | Errores | Deadlocks | Timeouts del pool |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1. Línea base (`LOCK_ORDERING=on`, pool 20) | 120 | 5 ms | 7 ms | 10 ms | 0 % | 0 | 0 |
| 2. **Incidente** (`LOCK_ORDERING=off`, pool 8) | **7** | **3.563 ms** | **4.207 ms** | 5.134 ms | **94,3 %** | **137** | **4.247** |
| 3. Corrección (`LOCK_ORDERING=on`) | 120 | 5 ms | 7 ms | 11 ms | 0 % | 0 | 0 |

(Las cuatro ejecuciones dieron p95 de 3,8 a 4,2 s y 93-95 % de errores; ver `docs/evidencias/incidente-*.json`.)
- Requisito incumplido: transferencias < 2 s y errores < 1 %.
- **Dinero: comprobado.** Tras las 3 fases (9.862 transacciones nuevas, con 137 deadlocks y 4.247 timeouts en la fase del incidente) el simulador verifica que el saldo total se conserva
  exactamente (1.000.000.000.000,00 antes y después), que cada transacción tiene 2 asientos que cuadran, que el saldo de cada cuenta coincide con su último asiento, que la cadena
  de saldos es continua y que no hay saldos negativos ni claves idempotentes duplicadas. Los errores dejan el estado sin cambios (transacción atómica con *rollback*) y el cliente puede reintentar con la misma `Idempotency-Key`.

## 3. Línea de tiempo (de la simulación)
| Tiempo | Evento | Fuente |
|---|---|---|
| T+0 s | Se aplica el cambio (`LOCK_ORDERING=off`, retraso de 150 ms entre bloqueos, pool de 8) y llega el pico de 120 tps | Configuración de la fase 2 |
| Poco después de T+0 | Primeros deadlocks: `db_errors_total{type="deadlock"}` empieza a subir; PostgreSQL los detecta a los 500 ms (`deadlock_timeout`) | Métrica, log de PostgreSQL |
| T+15 s | Diagnóstico: 359-428 peticiones esperando conexión (393 en la última corrida); 41-47 deadlocks; sesiones en `Lock/transactionid` y `Lock/tuple`; errores en `lock_from` y `lock_to` | Panel *Incidente*, `pg_stat_activity`, `pg_blocking_pids` |
| T+15 s | Mitigación 1: terminar sesiones bloqueadas > 1 s → **0 sesiones** (PostgreSQL ya había resuelto cada deadlock) | `pg_terminate_backend` |
| T+40 s | Fin de la carga del incidente: 94,3 % de errores | k6 |
| Fase 3 | Mitigación 2 / corrección: restaurar `LOCK_ORDERING=on` | Configuración |
| Fase 3 + 40 s | Recuperado: 0 deadlocks, p95 = 7 ms, 0 % de errores; dinero conciliado | k6, métricas, SQL |

No se mide MTTD/MTTR reales porque es una simulación; en producción los daría la alerta `DeadlocksDetected` (que sí se dispara con un deadlock real, comprobado en `scripts/verificar-paso4.ps1`).

## 4. Causa raíz
1. **Qué falló:** el bloqueo de las dos cuentas en orden de petición produce un **ciclo de espera** entre transferencias cruzadas (A→B y B→A).
2. **Por qué se dio:** el orden de bloqueo dependía de los datos de entrada, no de un criterio determinista.
3. **Amplificación:** cada transacción bloqueada mantiene una conexión; con un pool pequeño (8), unas pocas transacciones detenidas dejan a todas las demás esperando conexión (hasta 428 en cola) y vencen a los 2 s.
4. **Por qué no se detectó antes:** con carga baja los cruces simultáneos son raros; solo un pico los vuelve frecuentes. El defecto está latente hasta el pico.
5. **Factores contribuyentes:** pool dimensionado sin margen para transacciones retenidas; cuentas muy concentradas (calientes).

## 5. Detección y respuesta
- **Bien:** la métrica por paso SQL y el log con el detalle del bloqueo señalaron el problema (los pasos de **bloqueo**, no los de escritura); las trazas marcan en rojo el span que falló; los deadlocks se detectan en 500 ms.
- **Mal / a mejorar:** terminar sesiones bloqueadas **no aportó nada** en este caso (el daño venía del pool saturado y de las peticiones reintentando, no de sesiones colgadas); escalar réplicas habría empeorado (más concurrencia = más deadlocks).
- **Suerte:** ninguna; el fallo es determinista y reproducible.

## 6. Resolución
- **Mitigación temporal efectiva:** revertir el cambio / apagar el flag (`LOCK_ORDERING=on`): 94,3 % de errores → 0 %.
- **Corrección definitiva:** bloquear **ambas cuentas en una sola sentencia y en orden ascendente de id** (`SELECT ... ORDER BY id FOR UPDATE`). Está en `transfer.service.ts` como comportamiento por defecto y lo protege el test `transfers.concurrency.test.ts` (transferencias cruzadas simultáneas sin deadlocks).

## 7. Acciones preventivas
| # | Acción | Ámbito | Estado |
|---|---|---|---|
| 1 | Bloqueo determinista de recursos (orden de id) como única implementación; eliminar la variante desordenada fuera de las demos | Código | Orden por defecto hecho; la bandera de demo sigue existiendo (documentar que nunca se activa en producción) |
| 2 | Test de concurrencia (cruces A↔B) obligatorio en CI antes de cada despliegue | Código / proceso | Test existe; falta el pipeline de CI |
| 3 | `lock_timeout` (1,5 s) y `statement_timeout` (3 s) para que ninguna transacción retenga una conexión indefinidamente | Código / BD | Hecho |
| 4 | Alertas `DeadlocksDetected`, `DbPoolSaturated`, `TransferLatencyP95High` | Observabilidad | Hecho |
| 5 | Dimensionar pool y `max_connections` con margen; PgBouncer en modo transacción | Infraestructura | Pendiente |
| 6 | Pruebas de carga con cuentas calientes antes de los picos conocidos (quincena) | Proceso | Escenarios k6 listos (`loadtest/`), sin calendario |
| 7 | *Feature flag* con *rollback* en un paso y despliegue *canary* | Infraestructura | Flag existe; canary pendiente |
| 8 | *Game day* trimestral con `simulate-incident.ps1` | Proceso | Propuesto |

## 8. Lecciones aprendidas
- Un defecto de **orden de bloqueo** solo aparece bajo concurrencia real: hay que probarlo con cargas cruzadas, no con pruebas unitarias.
- La observabilidad útil identifica el **paso** que falla (no "la base de datos va lenta"): por eso cada paso SQL tiene métrica, log y span.
- Las mitigaciones "clásicas" (matar sesiones, escalar) no siempre sirven: hay que diagnosticar antes de actuar y tener el *rollback* preparado.

## 9. Anexos
`docs/evidencias/incidente-salida.txt` (salida completa), `incidente-diagnostico.txt` (diagnóstico en vivo), `incidente-resultado.json` y los resúmenes de k6 por fase.
