# SmartBancs App — MVP

Plataforma de transferencias en tiempo real con core legado (Bancs) simulado, recomendaciones de IA
asíncronas y observabilidad. Reto Técnico NextGen Engineer.

> **Estado actual:** Pasos 1 y 2 — API transaccional (transferencias, cuentas, movimientos), sincronización
> asíncrona con el core legado (Bancs simulado) y pruebas de concurrencia/resiliencia.
> Próximos pasos: servicio de IA, ETL, observabilidad, estados de cuenta.

## Arquitectura (resumen)
```
Cliente ─▶ core-api ─▶ PostgreSQL ─(outbox, misma transacción)─┐
                         ▲                                     │ relay (SKIP LOCKED)
                         │ estado en bancs_sync                ▼
                       worker ◀──────── Redis Streams ◀────────┘
                         │  lotes + rate limit + circuit breaker + backoff
                         ▼
                    bancs-mock (core legado: lento, limitado y con fallos)
```
La API **nunca espera a Bancs**: responde con el saldo operativo local y el legado se sincroniza aparte.

## Prerrequisitos
- Docker Desktop (con Docker Compose v2)
- Node.js 20+ (solo para ejecutar las pruebas fuera de Docker)
- `curl` (en Windows usa Git Bash)

## Levantar la solución (un solo comando)
```bash
docker compose up --build
```
Levanta PostgreSQL (con esquema y datos de prueba cargados automáticamente), Redis, el simulador de Bancs,
el worker y la API en http://localhost:3000.

> Si ya tienes un PostgreSQL local en el puerto 5432, crea un archivo `.env` en la raíz con `POSTGRES_PORT=5433`.
> Al actualizar desde el Paso 1 ejecuta una vez `docker compose down -v` para cargar la nueva tabla `bancs_sync`.

Verifica: `curl localhost:3000/health` → `{"status":"ok"}`

## Probar
Cuentas de prueba (números con dígito verificador válido):

| Cuenta | Titular | Saldo | Estado |
|---|---|---|---|
| 1000000016 | Ana Torres | 5000.00 | ACTIVE |
| 1000000024 | Ana Torres | 1200.00 | ACTIVE |
| 1000000032 | Luis Mena | 3000.00 | ACTIVE |
| 1000000040 | Sofía Andrade | 800.00 | ACTIVE |
| 1000000057 | Carlos Pérez | 100.00 | BLOCKED |

```bash
# Consultar una cuenta
curl localhost:3000/v1/accounts/1000000016

# Transferir (el monto va como string decimal; Idempotency-Key es obligatoria)
curl -X POST localhost:3000/v1/transfers \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-0001' \
  -d '{"fromAccount":"1000000016","toAccount":"1000000032","amount":"25.50","description":"Prueba"}'

# Repetir la misma petición → 200 con cabecera Idempotent-Replayed: true (no vuelve a debitar)

# Movimientos (paginación por cursor)
curl "localhost:3000/v1/accounts/1000000016/movements?limit=10"
```

## Ver la sincronización con el core legado
```bash
# Estado de sincronización de las transferencias
docker compose exec postgres psql -U smartbancs -c "select status, count(*) from bancs_sync group by 1"

# Lo que ha recibido el legado (llamadas, lotes aplicados, rechazos, máximo de llamadas por segundo)
curl localhost:4000/bancs/stats

# Logs del worker (reintentos, circuit breaker, DLQ)
docker compose logs -f worker
```

**Demo de resiliencia: el legado se cae y las transferencias siguen funcionando**
```bash
curl -X POST localhost:4000/bancs/admin/outage -H 'content-type: application/json' -d '{"down":true}'
# ...haz transferencias: siguen respondiendo 201 con normalidad; el worker abre el circuit breaker...
curl -X POST localhost:4000/bancs/admin/outage -H 'content-type: application/json' -d '{"down":false}'
# ...el worker se recupera y sincroniza todo lo pendiente sin perder nada ni duplicar.
```

## ETL: limpieza de transacciones (Python)
Toma un extracto crudo y "sucio" (fechas y montos en formatos mezclados, nulos, duplicados, cuentas inválidas,
montos negativos, outliers) y produce datos limpios en Parquet, features por cuenta y un reporte de calidad.
```powershell
docker compose run --rm etl                        # limpia etl/data/sample/dirty_transactions.csv (2.000 filas)
docker compose run --rm etl python -m pytest -q    # 46 pruebas del ETL
```
Salidas en `etl/data/processed/` (no se sube a git): `transactions_clean.parquet` (monto `DECIMAL(18,2)`),
`account_features.parquet|csv`, `rejected_rows.csv` (cada fila rechazada con su motivo) y `quality_report.md|json`.
Resultado sobre la muestra versionada: [`docs/evidencias/etl-reporte-calidad.md`](docs/evidencias/etl-reporte-calidad.md).
Sin Docker: `cd etl; python -m venv .venv; .venv\Scripts\pip install -r requirements.txt; .venv\Scripts\python -m smartbancs_etl.pipeline`.
Decisiones: [ADR-0003](docs/adr/0003-etl-limpieza-y-features.md).

## Recomendaciones de IA (asíncronas, con fallback)
`ai-service` (FastAPI, puerto 8000) lee el stream de transferencias con su propio grupo (`ai-recs`) y genera
recomendaciones por cuenta (reglas + modelo estadístico simple sobre las features del ETL). Las transferencias **nunca**
lo esperan: si el ai-service está lento o apagado, `core-api` responde recomendaciones de respaldo en < 500 ms.
```powershell
Invoke-RestMethod http://localhost:3000/v1/accounts/1000000016/recommendations   # source: "model"
# Simular un ai-service lento (5 s) y volver a consultar: source: "fallback", degraded: true
Invoke-RestMethod -Method Post http://localhost:8000/admin/mode -Body '{"mode":"slow","delay_ms":5000}' -ContentType "application/json"
Invoke-RestMethod http://localhost:3000/v1/accounts/1000000016/recommendations
docker compose stop ai-service        # apagado: sigue respondiendo el fallback; las transferencias siguen dando 201
docker compose start ai-service
Invoke-RestMethod -Method Post http://localhost:8000/admin/mode -Body '{"mode":"normal"}' -ContentType "application/json"
```
Verificación completa (incluye latencias medidas de las transferencias): `powershell -ExecutionPolicy Bypass -File scriptserificar-paso3.ps1`.
Decisiones: [ADR-0004](docs/adr/0004-ia-asincrona-con-fallback.md).

## Observabilidad (métricas, logs y trazas)
Prometheus, Loki, Tempo y Grafana, con dashboards y alertas ya provisionados. Se activa con un perfil para no cargar el arranque básico:
```powershell
docker compose --profile obs up -d --build
```
- **Grafana:** http://localhost:3001 → carpeta **SmartBancs** → *Operación* e *Incidente (latencia, timeouts y deadlocks)*. Se puede ver sin iniciar sesión (admin/admin para editar).
- **Prometheus:** http://localhost:9090 (y `/alerts`). **`/metrics`:** core-api `:3000`, worker `:9464`, ai-service `:8000`.
- Cada respuesta de `POST /v1/transfers` trae `x-request-id` = `trace_id`: con él se ven los logs (Loki) y la traza completa (Tempo): API → pasos SQL → outbox → Bancs.
- Verificación: `powershell -ExecutionPolicy Bypass -File scriptserificar-paso4.ps1` (incluye provocar un deadlock real y ver que queda identificado el paso SQL).
- Guía completa, diseño y límites: [`docs/observabilidad.md`](docs/observabilidad.md) · [ADR-0005](docs/adr/0005-observabilidad.md).

## Pruebas automáticas
```bash
docker compose up -d postgres redis

# API transaccional
cd services/core-api && npm ci && npm test

# Worker + integración con Bancs (usa el simulador de Bancs en memoria)
cd ../bancs-mock && npm ci
cd ../worker && npm ci && npm test
```
Si tu Postgres de Docker usa otro puerto, define antes `DATABASE_URL` (p. ej. `postgres://smartbancs:smartbancs@localhost:5433/smartbancs`).

Verifican, entre otras cosas:
- **API:** 400 transferencias simultáneas conservan el dinero total y cuadran con el ledger, cero deadlocks con
  transferencias cruzadas, imposibilidad de sobregirar y una única transferencia ante 20 peticiones idénticas.
- **Worker:** 500 movimientos con 25 % de fallos inyectados se aplican en Bancs exactamente una vez, sin superar
  ~5 llamadas/s y sin que el legado tenga que limitarnos; y ante una caída del legado el circuit breaker evita la
  avalancha de reintentos y, al volver, no se pierde nada.

## Detener
```bash
docker compose down        # conserva los datos
docker compose down -v     # borra también los datos (vuelve a cargar el esquema)
```

## Endpoints
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/v1/transfers` | Transferencia entre cuentas (idempotente) |
| GET | `/v1/accounts/{accountNumber}` | Datos y saldo de la cuenta |
| GET | `/v1/accounts/{accountNumber}/movements` | Movimientos paginados |
| GET | `/v1/accounts/{accountNumber}/recommendations` | Recomendaciones de IA (con fallback si la IA no responde) |
| GET | `/health` | Estado del servicio y la base de datos |
| GET | `:4000/bancs/stats` | (Bancs simulado) estadísticas de las llamadas recibidas |
| POST | `:4000/bancs/admin/outage` | (Bancs simulado) apagar/encender el legado para la demo |
| GET | `/metrics` (core-api `:3000`, worker `:9464`, ai-service `:8000`) | Métricas Prometheus |
| GET | `:8000/health` · `:8000/model` | (ai-service) estado, consumo del stream e información del modelo |
| POST | `:8000/admin/mode` | (ai-service) `normal`, `slow` o `down` para demostrar la degradación |

## Documentación
- Decisiones de arquitectura: [`docs/adr/`](docs/adr)
- Observabilidad (diseño, uso e incidente): [`docs/observabilidad.md`](docs/observabilidad.md)
- Declaración de uso de IA: [`AI_USAGE.md`](AI_USAGE.md)
