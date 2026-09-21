# SmartBancs App: MVP

Plataforma de transferencias en tiempo real, con integración protegida a un core legado (**Bancs**, simulado), recomendaciones de IA que nunca
bloquean el flujo transaccional y observabilidad completa. Reto técnico *NextGen Engineer*.

> **Léelo primero:** [`docs/documento-tecnico.md`](docs/documento-tecnico.md) explica la arquitectura y las decisiones, y su sección 14 dice **qué no está demostrado**
> (por ejemplo, **no se alcanzaron 10.000 TPS**: lo medido es ~400 tps por instancia y ~1.000 con 4 réplicas, en un portátil).

## Qué incluye

| Bloque | Qué hace | Cómo verlo |
|---|---|---|
| **Interfaz web** (HTML/CSS/JS, nginx) | App móvil: cuentas, saldo, transferir, movimientos, estado de cuenta y consejos de la IA. **http://localhost:8080** | [Interfaz web](#interfaz-web) |
| **core-api** (Node 22 + Fastify) | Transferencias atómicas e idempotentes, ledger de doble entrada, movimientos, estados de cuenta CSV/PDF | [Probar la API](#probar-la-api) |
| **PostgreSQL 16** | Esquema, datos de prueba, ledger inmutable, outbox | `db/` |
| **worker + Redis Streams + Bancs simulado** | Sincroniza con el legado en lotes con límite de tasa, *circuit breaker*, reintentos y DLQ, sin saturarlo | [Sincronización con Bancs](#sincronización-con-bancs) |
| **ETL** (Python, pandas, Parquet) | Limpia un extracto sucio, reporte de calidad, features por cuenta, detección de *drift* | [ETL](#etl-y-data-drift) |
| **ai-service** (FastAPI) | Recomendaciones con reglas + modelo estadístico; con *timeout*, *breaker* y *fallback* | [IA](#recomendaciones-de-ia) |
| **Observabilidad** (Prometheus, Loki, Tempo, Grafana) | Métricas, logs JSON con `trace_id`, trazas OpenTelemetry, 2 dashboards, 12 alertas | [Observabilidad](#observabilidad) |
| **Carga e incidente** (k6) | Pruebas con umbrales, escalado con réplicas, simulación reproducible de deadlocks | [Carga e incidente](#carga-e-incidente-simulado) |

## Arquitectura

```mermaid
flowchart LR
  C[Cliente] -->|POST /v1/transfers<br/>Idempotency-Key| API[core-api]
  API -->|1 transacción SQL| PG[(PostgreSQL<br/>ledger + outbox)]
  PG -->|outbox| W[worker]
  W -->|XADD| R[(Redis Streams)]
  R -->|grupo bancs-sync| W
  W -->|lotes + rate limit<br/>breaker + DLQ| B[Bancs simulado]
  R -->|grupo ai-recs| AI[ai-service]
  API -.->|timeout + breaker + fallback| AI
  ETL[ETL Python] -.->|features| AI
```
La transferencia **solo depende de PostgreSQL**. Bancs, la IA y la observabilidad no pueden retrasarla ni romperla. Detalle, flujo completo y modelo de datos en el
[documento técnico](docs/documento-tecnico.md#2-arquitectura) y [`docs/diagrams/`](docs/diagrams).

## Prerrequisitos
- **Docker Desktop** con Docker Compose v2 (todo se ejecuta en contenedores; el arranque básico ocupa unos 330 MB de memoria en reposo, medido; con la observabilidad activa y bajo carga, bastante más).
- Para ejecutar las **pruebas de Node fuera de Docker**: Node.js 22 (o 20+). Para **k6**: [k6](https://k6.io/docs/get-started/installation/) o Docker (usa `grafana/k6`).
- Los verificadores de extremo a extremo (`scripts/*.ps1`) son **PowerShell**; se probaron en Windows PowerShell 5.1 y **no** en `pwsh`/Linux/macOS (en esos sistemas, usa los comandos `curl`/`docker compose` de este README).

## Iniciar (un solo comando)
```bash
docker compose up --build -d      # PostgreSQL, Redis, Bancs simulado, worker, core-api, ai-service y la interfaz web
docker compose ps                 # los 7 servicios deben quedar "healthy"
curl localhost:3000/health        # {"status":"ok"}
```
> Si ya tienes un PostgreSQL en el puerto 5432, crea un archivo `.env` en la raíz con `POSTGRES_PORT=5433` (no se sube al repositorio). Ver `.env.example`.
> Si cambian las migraciones, reinicia con `docker compose down -v` (PostgreSQL solo ejecuta los scripts de inicio con el volumen vacío).

| Servicio | Puerto | |
|---|---|---|
| **web** | **8080** | **interfaz móvil** (entra con `ana`, `luis`, `sofia` o `carlos`) |
| core-api | 3000 | API (y `/metrics`) |
| ai-service | 8000 | recomendaciones (`/health`, `/model`, `/metrics`) |
| bancs-mock | 4000 | legado simulado (`/bancs/stats`, `/bancs/admin/outage`) |
| worker | 9464 | `/metrics` y `/health` |
| PostgreSQL / Redis | 5432 (o el de `.env`) / 6379 | |

## Interfaz web
Abre **http://localhost:8080**. Es una app móvil (se ve como un teléfono centrado en pantallas anchas) que usa **solo lo que el backend ofrece**: cuentas y saldo (con ojo para ocultarlo y carrusel de cuentas),
transferir (con confirmación, errores claros y reintento sin duplicar), movimientos, estado de cuenta en PDF/CSV y consejos de la IA. Las pestañas Tarjetas, Créditos e Inversiones aparecen como "próxima versión" porque no hay backend para ellas.
> **El acceso es una demostración:** el MVP no tiene autenticación; el modal solo permite elegir un perfil de prueba (`ana`, `luis`, `sofia` o `carlos`, cuya cuenta está bloqueada) y lo dice en pantalla. `?u=ana` entra directo.

Detalle, decisiones y límites: [`web/README.md`](web/README.md). Capturas: [`docs/capturas/`](docs/capturas). Prueba de extremo a extremo con navegador real (33 comprobaciones): `web/test/e2e.js`.

## Probar la API
Cuentas de prueba (números con dígito verificador válido):

| Cuenta | Titular | Saldo | Estado |
|---|---|---|---|
| 1000000016 | Ana Torres | 5000.00 | ACTIVE |
| 1000000024 | Ana Torres | 1200.00 | ACTIVE |
| 1000000032 | Luis Mena | 3000.00 | ACTIVE |
| 1000000040 | Sofía Andrade | 800.00 | ACTIVE |
| 1000000057 | Carlos Pérez | 100.00 | BLOCKED |

```bash
curl localhost:3000/v1/accounts/1000000016                       # saldo (como texto decimal)

# Transferir. El monto va como string decimal; Idempotency-Key es obligatoria (8-100 caracteres)
curl -X POST localhost:3000/v1/transfers -H 'content-type: application/json' -H 'idempotency-key: demo-0001' \
  -d '{"fromAccount":"1000000016","toAccount":"1000000032","amount":"25.50","description":"Prueba"}'
# Repetir EXACTAMENTE lo mismo -> 200 con "replayed": true (no vuelve a debitar).
# Misma clave con otro monto -> 422 IDEMPOTENCY_KEY_REUSED.

curl "localhost:3000/v1/accounts/1000000016/movements?limit=10"   # paginación por cursor
curl -OJ "localhost:3000/v1/accounts/1000000016/statements?month=2026-09&format=csv"   # estado de cuenta (csv | pdf)
```
En PowerShell: `Invoke-RestMethod http://localhost:3000/v1/accounts/1000000016` y `Invoke-WebRequest ".../statements?month=2026-09&format=pdf" -OutFile estado.pdf`.
Errores de negocio: `400` validación, `404` cuenta inexistente, `422` fondos insuficientes / cuenta no activa / clave reutilizada, `503` saturación (reintentable con la misma clave).

### Estados de cuenta
Saldo inicial, créditos, débitos, saldo final y detalle por mes (UTC), calculados desde el ledger con `NUMERIC` en una transacción de solo lectura: **cuadran exactamente**
con los movimientos y el saldo. Cuenta y contraparte enmascaradas, sin caché. Decisión y límites: [ADR-0007](docs/adr/0007-estados-de-cuenta.md).

## Sincronización con Bancs
```bash
docker compose exec postgres psql -U smartbancs -c "select status, count(*) from bancs_sync group by 1"   # estado de cada transferencia
curl localhost:4000/bancs/stats        # lo que recibió el legado: llamadas, lotes, 429, máximo de llamadas por segundo
docker compose logs -f worker          # reintentos, circuit breaker, DLQ
```
**Demo: el legado se cae y las transferencias siguen funcionando**
```bash
curl -X POST localhost:4000/bancs/admin/outage -H 'content-type: application/json' -d '{"down":true}'
# haz transferencias: siguen dando 201; el worker abre el circuit breaker y deja de llamar al legado
curl -X POST localhost:4000/bancs/admin/outage -H 'content-type: application/json' -d '{"down":false}'
# el worker se recupera y sincroniza lo pendiente sin perder ni duplicar nada
```
Diseño (lotes de 25, máx. 5 llamadas/s, *backoff* con *jitter*, idempotencia por id de transacción, DLQ): [ADR-0002](docs/adr/0002-integracion-con-core-legado.md).

## Recomendaciones de IA
`ai-service` consume el stream con su **propio grupo** y genera recomendaciones por cuenta (reglas explicables + modelo estadístico). Las transferencias **nunca** lo esperan:
si está lento o apagado, core-api responde recomendaciones de respaldo en menos de 500 ms.
```bash
curl localhost:3000/v1/accounts/1000000016/recommendations                 # "source": "model"
curl -X POST localhost:8000/admin/mode -H 'content-type: application/json' -d '{"mode":"slow","delay_ms":5000}'
curl localhost:3000/v1/accounts/1000000016/recommendations                 # "source": "fallback", "degraded": true
docker compose stop ai-service                                              # apagado: sigue respondiendo el fallback; las transferencias dan 201
docker compose start ai-service
curl -X POST localhost:8000/admin/mode -H 'content-type: application/json' -d '{"mode":"normal"}'
```
Una transferencia grande genera "Transferencia inusual" con severidad `alert`. Decisión: [ADR-0004](docs/adr/0004-ia-asincrona-con-fallback.md). Ciclo de vida del modelo (drift, reentrenamiento, despliegue): [documento técnico §7](docs/documento-tecnico.md#7-ia-servicio-consumo-no-bloqueante-y-ciclo-de-vida-del-modelo-33).

## ETL y data drift
Limpia un extracto crudo "sucio" (fechas y montos en formatos mezclados, nulos, duplicados, cuentas inválidas, montos negativos, *outliers*) → Parquet, features por cuenta y reporte de calidad.
```bash
docker compose run --rm etl                                   # etl/data/sample/dirty_transactions.csv (2.000 filas) -> etl/data/processed/
docker compose run --rm etl python -m smartbancs_etl.drift    # demostración de data drift (PSI y KS)
```
Resultado sobre la muestra: 2.000 entrantes = 1.716 limpias + 284 rechazadas con motivo ([`docs/evidencias/etl-reporte-calidad.md`](docs/evidencias/etl-reporte-calidad.md)).
Salidas en `etl/data/processed/` (no se sube a git): Parquet con `amount DECIMAL(18,2)`, `account_features.parquet|csv`, `rejected_rows.csv` y `quality_report.md|json`. Decisiones: [ADR-0003](docs/adr/0003-etl-limpieza-y-features.md).

## Observabilidad
Prometheus, Loki, Tempo y Grafana con dashboards y alertas ya provisionados. Se activa con un perfil para no cargar el arranque básico:
```bash
docker compose --profile obs up -d --build
```
- **Grafana:** http://localhost:3001 → carpeta **SmartBancs** → *Operación* e *Incidente (latencia, timeouts y deadlocks)*. Se ve sin iniciar sesión (admin/admin para editar).
- **Prometheus:** http://localhost:9090 (y `/alerts`).
- Cada respuesta de `POST /v1/transfers` trae `x-request-id` = `trace_id`: con él se ven los logs (Loki) y la traza completa (Tempo): API → pasos SQL → outbox → Bancs.
- Guía, diseño y límites: [`docs/observabilidad.md`](docs/observabilidad.md) · [ADR-0005](docs/adr/0005-observabilidad.md).

## Carga e incidente simulado
```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-loadtest.ps1 -Scenario smoke      # smoke | load | ramp | hot | fixed -Rate 500
powershell -ExecutionPolicy Bypass -File scripts\find-limit.ps1 -Rates "400,600,800"   # escalones de tasa fija + CPU de cada contenedor
powershell -ExecutionPolicy Bypass -File scripts\simulate-incident.ps1                 # deadlocks + pool agotado: base -> incidente -> corrección
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --build --scale core-api=4   # 4 réplicas detrás de nginx
```
Tras cada carga se comprueba que el dinero se conserva y el ledger cuadra. **Medido en un portátil:** 1 instancia ≈ 400 tps cumpliendo el requisito (máx. ~570); 4 réplicas ≈ 1.000 tps (máx. ~1.100).
**No se alcanzaron 10.000 TPS**: [`docs/carga-resultados.md`](docs/carga-resultados.md) (método, tablas, límites y camino hacia 10.000), [runbook](docs/runbook-incidente.md),
[post mortem de la simulación](docs/postmortem/2026-09-19-simulacion-deadlocks.md) y [ADR-0006](docs/adr/0006-pruebas-de-carga-y-escalado.md).

## Pruebas y verificación

**Pruebas automáticas** (con `docker compose up -d postgres redis` levantados):
```bash
cd services/core-api && npm ci && npm test                            # 40 pruebas: concurrencia, idempotencia, IA, métricas, deadlock real, estados de cuenta
cd services/bancs-mock && npm ci && cd ../worker && npm ci && npm test   # 10 pruebas: pipeline con Bancs simulado, resiliencia, métricas
docker compose exec ai-service python -m pytest -q                   # 23 pruebas: motor, API, consumidor con Redis real
docker compose run --rm etl python -m pytest -q                      # 54 pruebas: limpieza, features, drift, pipeline
```
Si tu PostgreSQL de Docker usa otro puerto: `DATABASE_URL=postgres://smartbancs:smartbancs@localhost:5433/smartbancs` (PowerShell: `$env:DATABASE_URL="..."`).

**Verificadores de extremo a extremo** (PowerShell, PASS/FAIL; requieren la pila levantada):

| Script | Comprueba | Chequeos |
|---|---|---|
| `scripts\verificar-paso1.ps1` | API, validaciones, idempotencia, saldos, ledger inmutable | 27 |
| `scripts\verificar-paso2.ps1` | Sincronización con Bancs, caída simulada, *breaker*, recuperación, DLQ | 26 |
| `scripts\verificar-paso3.ps1` | IA lenta o apagada: transferencias intactas y *fallback* < 500 ms | 27 |
| `scripts\verificar-paso4.ps1` | Métricas, logs con `trace_id`, trazas, dashboards, alertas y un deadlock real (perfil `obs`) | 52 |
| `scripts\verificar-estados-cuenta.ps1` | CSV y PDF cuadran con el ledger y el saldo | 26 |
| `scripts\simulate-incident.ps1` | Incidente reproducible y dinero conservado | 10 |

La salida de las verificaciones está en [`docs/evidencias/`](docs/evidencias) (ver su [índice](docs/evidencias/README.md)).

## Detener
```bash
docker compose --profile obs --profile etl down      # detiene todo y conserva los datos
docker compose --profile obs down -v                 # borra también los datos (vuelve a cargar el esquema)
```

## Endpoints
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/v1/transfers` | Transferencia entre cuentas (idempotente) |
| GET | `/v1/accounts/{n}` | Datos y saldo de la cuenta |
| GET | `/v1/accounts/{n}/movements` | Movimientos paginados por cursor |
| GET | `/v1/accounts/{n}/statements?month=YYYY-MM&format=csv\|pdf` | Estado de cuenta descargable |
| GET | `/v1/accounts/{n}/recommendations` | Recomendaciones de IA (con *fallback*) |
| GET | `/health` · `/metrics` | Estado (API y BD) · métricas Prometheus |
| GET / POST | `:4000/bancs/stats` · `/bancs/admin/outage` | (Bancs simulado) estadísticas y apagado |
| GET / POST | `:8000/health` · `/model` · `/admin/mode` | (ai-service) estado, modelo y modo de prueba `normal\|slow\|down` |

## Estructura del repositorio
```
web/                   interfaz web móvil (nginx) y su prueba e2e
services/core-api      API transaccional (transferencias, cuentas, estados de cuenta, recomendaciones, métricas y trazas)
services/worker        relay del outbox + sincronización con Bancs (lotes, rate limit, breaker, DLQ)
services/bancs-mock    core legado simulado (lento, limitado, con fallos)
services/ai-service    recomendaciones (FastAPI)
etl/                   limpieza, features, drift (Python)
db/                    migraciones (esquema, bancs_sync) y datos de prueba
observability/         Prometheus, alertas, Loki, Alloy, Tempo, Grafana (dashboards)
loadtest/              escenarios k6 y cuentas de carga
scripts/               verificadores, carga, incidente
infra/nginx/           balanceador para las réplicas
docs/                  documento técnico, ADR, runbook, post mortem, evidencias, diagramas
```

## Documentación
- **[Documento técnico](docs/documento-tecnico.md):** arquitectura, Bancs, ETL, IA y ciclo de vida del modelo, observabilidad, incidente, seguridad y limitaciones.
- [Decisiones de arquitectura (ADR 0001-0007)](docs/adr) · [Observabilidad](docs/observabilidad.md) · [Carga y escalado](docs/carga-resultados.md)
- **[Guion de defensa, guion del video y preguntas probables](docs/defensa.md)** · [Diagramas](docs/diagrams) (Mermaid y PlantUML)
- [Runbook del incidente](docs/runbook-incidente.md) · [Post mortem: plantilla](docs/postmortem/plantilla.md) y [simulación](docs/postmortem/2026-09-19-simulacion-deadlocks.md)
- [Evidencias y datos de prueba](docs/evidencias/README.md) · [Declaración de uso de IA](AI_USAGE.md)

## Uso de inteligencia artificial
Se usaron **Claude** (asistente conversacional) y **Claude Code** (asistente de programación) como apoyo de implementación; las decisiones de alcance, reglas de negocio y criterios de aceptación son propios y todo se ejecutó y probó.
Detalle por componente en [`AI_USAGE.md`](AI_USAGE.md).

## Limitaciones conocidas
No hay autenticación ni autorización; 10.000 TPS no se alcanzaron (cifras de un portátil compartido); Bancs y la observabilidad hacia Dynatrace no se probaron contra sistemas reales; el modelo de IA es estadístico sin evaluación con etiquetas;
sin CI. Lista completa en el [documento técnico §14](docs/documento-tecnico.md#14-limitaciones-y-trabajo-futuro-lo-que-no-está-demostrado).
