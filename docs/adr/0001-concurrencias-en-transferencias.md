# ADR-0001: Estrategia de concurrencia en transferencias

- **Estado:** Aceptada
- **Fecha:** 2026-09-18

## Contexto
Las transferencias deben completarse en menos de 2 s con picos de miles de operaciones por segundo.
Dos peticiones simultáneas no pueden sobregirar una cuenta, duplicar un movimiento ni bloquearse
mutuamente (deadlock), sobre todo cuando llegan transferencias cruzadas A→B y B→A.

## Opciones evaluadas
| Opción | A favor | En contra |
|---|---|---|
| Bloqueo optimista (columna `version`) | Sin bloqueos largos | Reintentos constantes en cuentas "calientes"; más complejidad en el cliente |
| Aislamiento `SERIALIZABLE` | Corrección garantizada por el motor | Abortos frecuentes bajo carga; obliga a reintentar |
| **Bloqueo pesimista de filas, en orden fijo de `id`** | Simple, predecible, sin deadlocks entre cuentas | Serializa las transferencias que tocan la misma cuenta |
| Bloqueos distribuidos (Redis) | Independiente de la BD | Un punto de falla más; no protege el dato en sí |

## Decisión
Una sola transacción en PostgreSQL (`READ COMMITTED`) que:
1. Bloquea las dos cuentas con `SELECT … ORDER BY id FOR UPDATE` (orden determinista → sin deadlocks).
2. Registra la transacción con `UNIQUE(idempotency_key)` (reintentos seguros).
3. Debita con `UPDATE … WHERE balance >= monto` (la validación y el cambio son atómicos).
4. Escribe dos asientos inmutables en el ledger y el evento en la tabla `outbox_events`.

Además: `lock_timeout` y `statement_timeout` para fallar rápido, y `CHECK (balance >= 0)` como última defensa.

## Consecuencias
- Corrección demostrada con pruebas automáticas (`test/transfers.concurrency.test.ts`): conservación del dinero,
  ledger cuadrado con saldos, cero deadlocks en transferencias cruzadas y ninguna condición de carrera al sobregirar.
- Con `LOCK_ORDERING=off` el sistema reproduce el deadlock del incidente simulado, lo que permite mostrar
  el diagnóstico y la corrección (sección 3.5 del reto).
- Límite conocido: una cuenta muy activa se convierte en cuello de botella. En producción se mitigaría con
  particionado por cuenta, colas por cuenta y saldos reservados/pre-autorizados.
