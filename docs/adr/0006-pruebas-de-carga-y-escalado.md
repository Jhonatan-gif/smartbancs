# ADR-0006: Pruebas de carga con k6, umbrales del reto y escalado horizontal de core-api

- **Estado:** Aceptada
- **Fecha:** 2026-09-19

## Contexto
El reto pide soportar picos de 10.000 TPS con transferencias < 2 s. Hay que medir de verdad (no afirmar cifras), saber dónde está el límite
y qué palanca lo mueve, y poder reproducir el incidente de deadlocks (3.5).

## Opciones evaluadas
| Opción | A favor | En contra |
|---|---|---|
| Probar solo con pruebas unitarias/concurrencia | Rápido | No dice nada de latencia ni de límites |
| JMeter / Locust | Conocidos | Más pesado o dependiente de Python/Java |
| **k6** | Un binario, scripts en JS, umbrales que hacen fallar la ejecución, generador de tasa fija (*arrival rate*) | Genera la carga desde la misma máquina en este entorno |

## Decisión
1. **k6 con tasa de llegada fija** (`ramping-arrival-rate`): el generador no se frena si el servidor se retrasa, así se ve la saturación real (iteraciones no lanzadas). Umbrales del reto: **p95 < 2 s y errores < 1 %** (un umbral incumplido devuelve código de salida ≠ 0).
2. **La velocidad no basta:** tras cada prueba (`run-loadtest.ps1`) se comprueba que cada transferencia existe una vez, el dinero se conserva, el ledger cuadra y su cadena de saldos es continua.
3. **Escenarios:** `smoke`, `load`, `ramp` (escalera hasta 2.000 tps), `fixed` (un escalón) y cuentas calientes; `find-limit.ps1` mide un escalón a la vez y el CPU de cada contenedor.
4. **Escalado horizontal:** core-api no tiene estado; `docker-compose.scale.yml` levanta N réplicas detrás de nginx (`--scale core-api=4`). El balanceador **no reintenta** en otra réplica (la idempotencia la decide el cliente).
5. **Pool de conexiones precalentado** (`DB_POOL_MIN`, sin cierre por inactividad): la primera prueba mostró 11 errores por crear conexiones en pleno pico; se corrigió y el error pasó a `503 POOL_TIMEOUT` reintentable.
6. **Simulador del incidente** (`simulate-incident.ps1`): línea base → incidente → diagnóstico → mitigación → corrección, con los números de cada fase.

## Consecuencias
- **Medido:** una instancia sostiene ~400 tps cumpliendo el requisito (máx. ~570); 4 réplicas sostienen 1.000 tps (máx. ~1.100). **10.000 TPS no se alcanzaron**; el camino (más réplicas, PostgreSQL particionado, neteo hacia Bancs) está descrito en `docs/carga-resultados.md` como diseño, no como resultado.
- **Límite del método:** k6, API, base de datos y el resto de servicios comparten un solo portátil; las cifras no son extrapolables linealmente a un entorno dedicado.
- **Producción:** generar la carga desde otra máquina, entorno dedicado, PostgreSQL con almacenamiento rápido y particionado, autoescalado por CPU y por `db_pool_connections{state="waiting"}`, y pruebas de carga programadas antes de cada pico conocido.
