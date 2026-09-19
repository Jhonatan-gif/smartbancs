# SmartBancs App — MVP

Plataforma de transferencias en tiempo real con core legado (Bancs) simulado, recomendaciones de IA
asíncronas y observabilidad.

> **Estado actual:** Paso 1 — API transaccional (transferencias, cuentas, movimientos), base de datos y pruebas
> de concurrencia. Próximos pasos: worker + Bancs mock, servicio de IA, ETL, observabilidad, estados de cuenta.

## Prerrequisitos
- Docker Desktop (con Docker Compose v2)
- Node.js 20+ (solo para ejecutar las pruebas fuera de Docker)
- `curl` (en Windows usa Git Bash)

## Levantar la solución (un solo comando)
```bash
docker compose up --build
```
Levanta PostgreSQL (con esquema y datos de prueba cargados automáticamente) y la API en http://localhost:3000.

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

## Pruebas automáticas (concurrencia e idempotencia)
```bash
docker compose up -d postgres
cd services/core-api
npm ci
npm test
```
Verifican, entre otras cosas: 400 transferencias simultáneas conservan el dinero total y cuadran con el ledger,
cero deadlocks con transferencias cruzadas, imposibilidad de sobregirar y una única transferencia ante 20
peticiones idénticas simultáneas.

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
| GET | `/health` | Estado del servicio y la base de datos |

## Documentación
- Decisiones de arquitectura: [`docs/adr/`](docs/adr)
- Declaración de uso de IA: [`AI_USAGE.md`](AI_USAGE.md)
