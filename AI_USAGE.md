# Declaración de uso de inteligencia artificial

> Requisito del reto: indicar las herramientas empleadas, cómo se utilizaron y en qué componentes.

## Herramientas
- **Claude (Anthropic)**: asistente conversacional, usado para consultar opciones de diseño, planificar y obtener borradores.
- **Claude Code (Anthropic)**: asistente de programación en el editor. Escribió gran parte del código, las pruebas, los scripts y la documentación
  a partir de las indicaciones del autor, y **ejecutó** las pruebas y verificaciones sobre el repositorio.

## Qué hizo la IA y qué decidió el autor
**La IA (Claude Code) escribió la mayor parte del código y de los documentos de este repositorio.** El autor definió los requisitos y el alcance a partir del enunciado,
eligió el stack, fijó las reglas de trabajo (probar antes de afirmar, no inventar cifras, una ADR por decisión relevante, un commit por bloque funcional), aprobó el plan de cada bloque
antes de que se programara y orientó las correcciones. La responsabilidad final del contenido es del autor.

| Componente | Qué hizo la IA | Decisiones del autor |
|---|---|---|
| Arquitectura y plan del proyecto | Propuso alternativas, estructura de carpetas y un plan por commits | Stack, priorización, recortes admisibles y calendario |
| `db/` (esquema, datos de prueba) | Escribió el esquema (ledger, outbox, idempotencia) | Modelo de cuentas y datos de prueba aprobados |
| `services/core-api` (transferencias, cuentas, movimientos) | Código y pruebas de concurrencia | Reglas de negocio de la transferencia y de sus errores |
| `docker-compose.yml`, Dockerfiles | Escribió y depuró la orquestación | Un solo comando para levantar todo; perfiles opcionales |
| `services/bancs-mock`, `services/worker` (outbox, Redis Streams, lotes, rate limit, circuit breaker, DLQ) | Código y pruebas | Comportamiento esperado ante caídas del legado |
| `services/ai-service` y `core-api/src/modules/recommendations` | Código, reglas de recomendación y pruebas | Que la IA nunca bloquee la transferencia y degrade con *fallback* |
| `etl/` (limpieza, features, reporte de calidad, drift, generador de datos) | Código y pruebas | Qué se rechaza y qué se imputa; criterio de reentrenamiento |
| `observability/` y la instrumentación de los servicios (métricas, logs JSON, trazas, dashboards, alertas) | Código, configuración y dashboards (generados con un script) | Qué debe poder diagnosticarse (incidente 3.5) y con qué señales |
| `loadtest/`, `scripts/run-loadtest.ps1`, `find-limit.ps1`, `simulate-incident.ps1`, `docker-compose.scale.yml` | Scripts, ejecución de las mediciones y análisis de resultados | No afirmar 10.000 TPS ni cifras no medidas |
| `core-api/src/modules/statements` (estados de cuenta CSV/PDF) | Código, generador de PDF y pruebas | Contenido y reglas del estado de cuenta |
| `scripts/verificar-*.ps1` | Scripts de verificación PASS/FAIL y su ejecución | Qué se verifica en cada bloque |
| Documentación (`docs/`, ADR, runbook, post mortem, documento técnico, README) | Borradores completos | Enfoque, tono y qué se declara como no probado |

## Cómo se verificó
La IA ejecutó el código y las pruebas antes de cada commit: pruebas automáticas (concurrencia, idempotencia, integración con el simulador de Bancs, ETL, IA, métricas, estados de cuenta),
verificadores de extremo a extremo con resultado PASS/FAIL, pruebas de carga con k6 y la simulación del incidente; las salidas están en `docs/evidencias/`.
Al verificar se encontraron y corrigieron defectos reales, entre ellos:
- el worker y core-api caían si PostgreSQL reiniciaba (faltaba el manejador de error del pool);
- alertas que no se disparaban con contadores nunca inicializados;
- números de cuenta completos en los logs de acceso;
- conexiones nuevas en pleno pico y un error de conexión devuelto como 500 en lugar de 503;
- el formato de los totales vacíos de un estado de cuenta (`0` en vez de `0.00`);
- un *seed* de pruebas que reiniciaba saldos y daba un falso desajuste del ledger.

Las limitaciones que no se pudieron resolver (p. ej. 10.000 TPS no alcanzados, sin autenticación) se declaran en `docs/documento-tecnico.md` (sección 14) en lugar de ocultarse.
