# Pruebas de carga: qué se midió y cómo escalaría hacia 10.000 TPS

> **Resumen honesto:** con una instancia de core-api se sostienen **~400 transferencias/s cumpliendo el requisito** (p95 = 66 ms, 0 % de errores)
> y el máximo medido es **~570 tps**. Con **4 réplicas** detrás de un balanceador se sostienen **1.000 tps con p95 = 203 ms y 0,11 % de errores**
> (máximo ~1.100 tps). **No se alcanzaron 10.000 TPS**, y este documento explica qué se necesita para llegar y qué NO se ha probado.

## 1. Método
| | |
|---|---|
| Herramienta | k6 v2.2.0 (`loadtest/transfers.js`), tasa de llegada fija (*arrival rate*): el generador no se frena si el servidor se retrasa |
| Operación | `POST /v1/transfers` entre 1.000 cuentas (`loadtest/seed-accounts.sql`), montos aleatorios, `Idempotency-Key` única; el 5 % de las iteraciones repite la clave (debe devolver 200 sin duplicar) |
| Requisito (umbrales k6) | p95 < 2 s y errores < 1 % (errores = 5xx, 409 o sin respuesta) |
| Entorno | **Un solo portátil** con Windows + Docker Desktop (20 CPU lógicas y 8 GB asignados a Docker): k6, core-api, PostgreSQL 16, Redis, worker, ai-service y Bancs simulado **comparten la misma máquina** |
| Configuración | `DB_POOL_MAX=20`, `DB_POOL_MIN=10` (pool precalentado), muestreo de trazas al 5 %, sin el perfil de observabilidad |
| Reproducir | `powershell -ExecutionPolicy Bypass -File scripts\run-loadtest.ps1 -Scenario load` · `scripts\find-limit.ps1 -Rates "400,600,800"` · `docker-compose.scale.yml` para réplicas |

Tras las pruebas de `run-loadtest.ps1` se comprueba la **corrección**, no solo la velocidad: cada transferencia creada existe una sola vez, el saldo total se conserva,
cada transacción tiene 2 asientos que cuadran, el saldo de cada cuenta coincide con su último asiento, **la cadena de saldos de cada cuenta es continua** y no hay saldos negativos.
Pasaron en: smoke, carga sostenida (2 veces), **escalera hasta 2.000 tps con el sistema saturado (41 % de errores)** y **4 réplicas a 1.000 tps** (29.541 transferencias).
Los escalones de `find-limit.ps1` miden solo rendimiento y no ejecutan esas comprobaciones.

## 2. Una instancia de core-api
| Objetivo (tps) | Logrado (tps) | p50 | p95 | p99 | Errores | CPU core-api / PostgreSQL* | ¿Cumple? |
|---:|---:|---:|---:|---:|---:|---|:-:|
| 20 (smoke) | 20 | 8 ms | 11 ms | 14 ms | 0 % | - | sí |
| 100→300 (sostenido 90 s) | 255 | 5,6 ms | 7,4 ms | 10,2 ms | 0 % | - | sí |
| 400 | 400 | 5,9 ms | 66 ms | 126 ms | 0 % | 77 % / 85 % | sí |
| 600 | 573 | 1.270 ms | 1.466 ms | 1.550 ms | 0,9 % | 103 % / 139 % | no (636 iteraciones no lanzadas) |
| 800 | 518 | 3.404 ms | 4.006 ms | 4.033 ms | 26 % | 104 % / 128 % | no |
| 1.000 | 514 | - | 4.013 ms | - | 34 % | 104 % / 140 % | no |
| 1.300 | 460 | 3.310 ms | 3.819 ms | 3.979 ms | 47 % | 105 % / 121 % | no |

\* Porcentaje de un núcleo (100 % = 1 núcleo). **Lectura:** el límite es ~570 tps; el proceso de core-api (Node, un solo hilo) llega al 100 % de un núcleo mientras PostgreSQL
usa ~1,4 de los 20 disponibles. Por encima del límite el rendimiento **baja** (460 tps) porque las peticiones esperan en el pool y vencen a los 2 s (fallo rápido por diseño, 503 reintentable).

## 3. Escalado horizontal: 4 réplicas + balanceador (`docker-compose.scale.yml`)
| Objetivo (tps) | Logrado (tps) | p50 | p95 | p99 | Errores | CPU core-api (suma) / PostgreSQL | ¿Cumple? |
|---:|---:|---:|---:|---:|---:|---|:-:|
| 700 | 700 | 10 ms | 65 ms | 305 ms | 0 % | 258 % / 280 % | sí |
| 900 | 897 | 15 ms | 56 ms | 126 ms | 0,34 % | 390 % / 427 % | sí |
| **1.000** | **999** | 34 ms | **203 ms** | 272 ms | **0,11 %** | 426 % / 533 % | **sí** |
| 1.000 (repetición, con comprobación de corrección) | 984 | 275 ms (media) | 675 ms | 758 ms | 0 % | - | sí |
| 1.200 | 878 | 2.541 ms | 3.837 ms | 4.098 ms | 9,1 % | 496 % / 132 % | no |
| 1.800 | 1.104 | 2.643 ms | 3.122 ms | 3.276 ms | 0 % | 448 % / 509 % | no (20.886 no lanzadas) |
| 2.400 | 1.116 | 2.634 ms | 3.006 ms | 3.168 ms | 0 % | 431 % / 535 % | no |
| 3.000 | 1.103 | 2.742 ms | 3.207 ms | 3.383 ms | 0 % | 439 % / 548 % | no |

**Variabilidad:** al repetir los 1.000 tps el p95 fue 675 ms en vez de 203 ms (1.000 tps está cerca del techo de ~1.100, donde pequeñas diferencias de carga del equipo cambian mucho la latencia). Ambas corridas cumplen el requisito, pero no conviene fiarse del mejor valor.

**Lectura:** pasar de 1 a 4 réplicas duplica el techo (~570 → ~1.100 tps), **no lo cuadruplica**. Con todo en una máquina compartida (k6 también consume CPU y las 4 réplicas
compiten con PostgreSQL), no se puede separar cuánto es límite del diseño y cuánto del equipo. En hardware separado el resultado será distinto: **no se ha medido**.
Los datos crudos están en `docs/evidencias/k6-*.json`.

## 4. Hallazgos durante las pruebas (ya corregidos)
1. **Pool sin calentar:** en la primera corrida hubo 11 errores en 22.999 (0,048 %) y una petición de 2 s, todos `Connection terminated due to connection timeout`
   al crear conexiones nuevas en pleno pico. Se precalienta el pool (`DB_POOL_MIN`) y no se cierran las conexiones inactivas: **0 errores y máximo de 37 ms** en la repetición.
2. Ese error se devolvía como `500`; ahora es `503` (`POOL_TIMEOUT`), reintentable con la misma `Idempotency-Key`.

## 5. Sincronización con Bancs: el legado NO frena a la API, pero marca el ritmo de la consistencia
La API acepta transferencias a su propio ritmo; los movimientos se envían a Bancs en lotes limitados (25 por llamada, máx. 5 llamadas/s).
| Prueba | Transferencias | Pendientes de Bancs al terminar | Ritmo medido de sincronización | Tiempo estimado para vaciar |
|---|---:|---:|---:|---:|
| Carga sostenida (90 s) | 22.998 | 18.812 | 41,6 mov/s | 7,5 min |
| Escalera hasta 2.000 tps | 64.011 | 78.321 | 53,9 mov/s | 24 min |

Ritmo real 40-55 mov/s, por debajo del máximo teórico de 125 mov/s (25 × 5): el simulador tarda 200-600 ms por llamada y falla un 10 % de las veces (con reintentos).
**Bancs no se satura:** tras todas las cargas (26 min) el simulador registró 1.927 llamadas con **0 respuestas 429**, un máximo de **5 llamadas/s** y 1 en paralelo, 40.475 movimientos aplicados exactamente una vez y 2.250 reintentos absorbidos como duplicados (idempotencia).
**Implicación:** la API absorbe los picos y Bancs los recibe después a su ritmo, a costa de **consistencia eventual**.
Con 10.000 TPS sostenidos el legado tendría que recibir 10.000 movimientos/s: no cabe sin cambiar el modelo (ver punto 6).

## 6. Camino hacia 10.000 TPS (diseño, **no medido**)
| Palanca | Qué aporta | Estado |
|---|---|---|
| Más réplicas de core-api (sin estado) | Cada instancia aporta ~570 tps de CPU; para 10.000 harían falta del orden de **18-20 instancias** en hardware dedicado | Demostrado ×2 con 4 réplicas en un equipo compartido; extrapolación teórica |
| PostgreSQL | Un solo primario con esta carga de escritura (5 sentencias + WAL por transferencia) llegará a su techo antes: **particionar/*shardear* por rango de cuenta**, NVMe, `synchronous_commit` ajustado, PgBouncer, réplicas de lectura para consultas y estados de cuenta | No probado |
| Contención | Las transferencias solo bloquean 2 filas y en orden fijo; una cuenta muy caliente (comercio con miles de cobros/s) se serializa: patrón de cuenta "particionada" o cola por cuenta | No probado |
| Bancs | Dejar de enviar 1 movimiento por transferencia: **netear por cuenta y ventana** (un asiento neto cada N segundos) o intercambio por lotes/archivos; subir el lote hasta el máximo que acepte el legado | Lote configurable (`BANCS_BATCH_SIZE`), neteo no implementado |
| Redis Streams / worker | Varios consumidores en el mismo grupo; particionar el stream por hash de cuenta | Un consumidor probado |
| Autoescalado | Escalar réplicas según CPU y `db_pool_connections{state="waiting"}` (p. ej. Kubernetes HPA) | No implementado |

**Conclusión para la defensa:** el diseño **evita** los problemas clásicos (sin *race conditions*, sin deadlocks, idempotente, con Bancs desacoplado) y escala de forma
horizontal en la capa de API; el techo medido es ~570 tps por instancia y ~1.100 con 4 réplicas en un solo equipo. Llegar a 10.000 TPS requiere hardware dedicado y evolucionar
la capa de datos (particionado) y la integración con el legado (neteo), y **eso no está demostrado en este MVP**.
