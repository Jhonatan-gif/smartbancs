# ADR-0002: Integración con el core legado (Bancs) sin saturarlo

- **Estado:** Aceptada
- **Fecha:** 2026-09-19

## Contexto
Bancs procesa pocas operaciones por segundo, responde lento (cientos de ms) y falla de forma intermitente.
SmartBancs debe atender picos muy superiores sin pasarle esa carga al legado y sin perder movimientos.

## Opciones evaluadas
| Opción | A favor | En contra |
|---|---|---|
| Consultar/escribir en Bancs en cada petición | Siempre consistente | La latencia y los fallos del legado se vuelven los nuestros; lo satura |
| Cache de saldos con TTL | Fácil | Saldos desactualizados; no resuelve la escritura |
| **Saldo operativo local + sincronización asíncrona (outbox + cola + lotes)** | La API no depende de Bancs; protege al legado; sin pérdida | Consistencia eventual; requiere conciliación |
| CDC (Debezium/Kafka Connect) sobre la BD | Sin código de relay | Más infraestructura para el alcance del MVP |

## Decisión
1. La API opera sobre el **saldo operativo local** (PostgreSQL) y **nunca llama a Bancs** dentro de una transferencia.
2. El evento se guarda en `outbox_events` en la misma transacción (**Transactional Outbox**): no se pierde ni se publica un evento sin transferencia.
3. Un **relay** publica el outbox en **Redis Streams** (`FOR UPDATE SKIP LOCKED`, entrega al menos una vez).
4. Un consumidor envía a Bancs en **lotes** (hasta 25 movimientos por llamada) con un **tope de 5 llamadas/s**.
5. Los reintentos usan **backoff exponencial con jitter** y un **circuit breaker** (5 fallos seguidos → 5 s sin llamar al legado).
6. La **idempotencia** viene de usar el id de la transacción como referencia: si Bancs aplica la operación pero la respuesta se pierde, el reintento recibe `DUPLICATE` y se da por sincronizado.
7. Errores permanentes o lotes que no se pueden entregar tras 15 min van a la **DLQ** y quedan marcados como `FAILED` en `bancs_sync`.

## Consecuencias
- Demostrado con pruebas automáticas: 500 movimientos con 25 % de fallos inyectados se aplican una sola vez, el legado nunca tuvo que limitarnos y, tras una caída simulada, no se pierde nada.
- Por 1 llamada por movimiento serían 500 llamadas; con lotes son ~20.
- Costo aceptado: consistencia eventual entre el saldo operativo y el contable de Bancs. Se mitiga con la tabla `bancs_sync` y una conciliación periódica (saldo local vs. Bancs).
- Límite conocido: un lote "venenoso" bloquea el consumidor hasta que vence su tiempo máximo; en producción se dividiría el lote (bisección).
