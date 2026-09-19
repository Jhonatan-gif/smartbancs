# Declaración de uso de inteligencia artificial

> Requisito del reto: indicar herramientas, cómo se usaron y en qué componentes.
> **Revisa y ajusta este texto para que refleje exactamente lo que hiciste tú.**

## Herramientas
- **Claude (Anthropic)** — asistente de IA conversacional.

## Cómo se usó y en qué componentes
| Componente | Uso de la IA | Trabajo propio |
|---|---|---|
| Diseño de arquitectura y plan del proyecto | Propuesta de stack, estructura de carpetas y priorización | Elección final de tecnologías y justificación |
| `db/` (DDL/DML) | Borrador del esquema (ledger, outbox, idempotencia) | Revisión, ajustes y validación |
| `services/core-api` (transferencias, cuentas, movimientos) | Borrador inicial del código y de las pruebas | Revisión línea por línea, ejecución y ajustes |
| `docker-compose.yml`, `Dockerfile` | Borrador inicial | Ejecución y verificación en mi entorno |
| Documentación (`docs/`) | Borradores de ADR y README | Edición y adaptación |

## Verificación
Todo el código generado con asistencia de IA fue ejecutado y probado por mí (pruebas automáticas de concurrencia,
pruebas manuales con `curl`) antes de incluirlo en el repositorio.

<!-- Actualiza esta tabla a medida que agregues componentes (worker, ETL, IA, observabilidad, informe). -->
