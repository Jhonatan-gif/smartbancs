# ADR-0005: Observabilidad con métricas, logs y trazas correlacionados (OpenTelemetry, Prometheus, Loki, Tempo, Grafana)

- **Estado:** Aceptada
- **Fecha:** 2026-09-19

## Contexto
El reto (3.4 y 3.5) pide registrar operaciones críticas, medir volumen, errores y tiempos, rastrear una transacción entre
componentes y, ante un incidente de latencia, timeouts y deadlocks, **identificar la consulta o el proceso exacto** que causa
el problema. Un dashboard que solo diga "la base de datos está lenta" no basta.

## Opciones evaluadas
| Opción | A favor | En contra |
|---|---|---|
| Solo logs | Simple | No permite ver tendencias ni alertar; buscar a mano en incidentes |
| Producto SaaS (Dynatrace, Datadog) | Todo integrado | Requiere licencia y cuenta; no reproducible por el jurado |
| **OpenTelemetry + Prometheus + Loki + Tempo + Grafana** | Abierto, se levanta con Docker, estándar (OTLP) portable a cualquier proveedor | Más contenedores (por eso va en un perfil `obs`) |

## Decisión
1. **Tres señales correlacionadas por `trace_id`:** métricas (Prometheus), logs JSON (Loki) y trazas (Tempo). El id de la petición
   es el `trace_id` de OpenTelemetry (32 hex) y aparece en cada log, en el outbox, en el stream y en el worker.
2. **Métricas con método RED + saturación** (tráfico, errores, duración, pool de BD). Etiquetas de **cardinalidad baja**: nunca por
   cuenta, transacción o clave de idempotencia.
3. **Diagnóstico del incidente por paso SQL:** cada paso de la transferencia (`lock_accounts`, `insert_tx`, `debit`, `credit`,
   `ledger`, `outbox`) tiene su histograma, su contador de errores por SQLSTATE, un span propio y, si es lento o falla, un log con el
   nombre del paso, el detalle del bloqueo que devuelve PostgreSQL y el `trace_id`.
4. **Las series de error se inicializan en 0.** Sin ello, un contador que nunca ha fallado no existe y la primera alerta (p. ej. el
   primer deadlock) no se dispara porque `increase()` no ve variación. Esto se descubrió y corrigió en la verificación.
5. **Trazas que cruzan el outbox:** el contexto W3C (`traceparent`) viaja en el payload del outbox y en el stream; el worker crea
   spans hijos (`outbox.publish`, `bancs.sync`). Una traza cubre API → pasos SQL → outbox → sincronización con Bancs.
6. **Privacidad:** los números de cuenta se enmascaran en los logs de acceso (`/accounts/******0016`) y en los del ai-service; las
   sentencias SQL se trazan con marcadores (`$1`), nunca con valores.
7. **Alertas como código** (`observability/prometheus/alerts.yml`, 12 reglas) y **Grafana provisionado por archivos** (2 dashboards,
   3 datasources): el entorno es reproducible sin configurar nada a mano.
8. **Perfil `obs`:** `docker compose up` (sin perfil) sigue levantando solo el sistema; la observabilidad se activa con
   `docker compose --profile obs up -d`. Los servicios exportan trazas siempre y, sin Tempo, se descartan en silencio (comprobado).

## Consecuencias
- **Comprobado** (`scripts/verificar-paso4.ps1`): con un deadlock real (LOCK_ORDERING=off) la alerta `DeadlocksDetected` se dispara,
  la métrica y el log señalan el paso exacto (`lock_to`), Tempo tiene la traza con ese span en ERROR y el log de PostgreSQL muestra
  "deadlock detected" en Loki.
- **Costo aceptado:** 6 contenedores extra en modo `obs`; Alertmanager no está incluido (las alertas se ven en Prometheus y Grafana);
  ai-service y bancs-mock no emiten trazas (se ven como tiempo dentro del span del cliente); los umbrales de las alertas y los
  dashboards no están calibrados con carga alta: la calibración con k6 es el siguiente paso.
- **Producción:** muestreo por ratio (`OTEL_TRACES_SAMPLER_ARG`), OpenTelemetry Collector como intermediario y exportación OTLP a
  Dynatrace (o el proveedor elegido) cambiando solo el endpoint; Alertmanager con Slack/PagerDuty y enlaces a un runbook; retención
  y almacenamiento de objetos para Loki y Tempo; SLOs con alertas de quemado del presupuesto de error.
