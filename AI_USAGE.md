# Declaración de uso de inteligencia artificial

> Requisito del reto: indicar las herramientas empleadas, cómo se utilizaron y en qué componentes.

## Herramientas
- **Claude (Anthropic)**: asistente conversacional, usado para consultar opciones de diseño y obtener borradores.
- **Claude Code (Anthropic)**: asistente de programación en el editor, usado para generar borradores de código, pruebas
  y scripts, y para ejecutar comprobaciones sobre el repositorio.

## Cómo se usó y en qué componentes
Las decisiones de alcance, stack, reglas de negocio y criterios de aceptación las definí yo a partir del enunciado.
La IA se usó como apoyo de implementación; cada resultado se ejecutó y se comprobó con pruebas antes de incluirse.

| Componente | Apoyo de la IA | Trabajo propio |
|---|---|---|
| Arquitectura y plan del proyecto | Alternativas de diseño y estructura de carpetas | Elección final de tecnologías, justificación y priorización |
| `db/` (DDL/DML) | Borrador del esquema (ledger, outbox, idempotencia) | Revisión, ajustes y validación |
| `services/core-api` (transferencias, cuentas, movimientos) | Borrador del código y de las pruebas de concurrencia | Ejecución de las pruebas, revisión y ajustes |
| `docker-compose.yml`, `Dockerfile` | Borrador inicial | Ejecución y verificación en mi entorno |
| `services/bancs-mock`, `services/worker` (outbox, Redis Streams, lotes, rate limit, circuit breaker) | Borrador del código y de las pruebas | Ejecución de pruebas, revisión y ajustes |
| `scripts/verificar-paso*.ps1` | Borrador de los scripts de verificación (PASS/FAIL) y de una corrección de resiliencia: manejador `error` del pool de PostgreSQL | Ejecución, análisis de los resultados y decisión de qué se verifica |
| `etl/` (limpieza, features, reporte de calidad, generador de datos sucios y pruebas) | Borrador del código y de las pruebas | Reglas de negocio (qué se rechaza, qué se imputa), ejecución y revisión de resultados |
| `services/ai-service` (consumidor del stream, modelo estadístico, reglas) y `core-api/src/modules/recommendations` (timeout, circuit breaker, fallback) | Borrador del código y de las pruebas | Definición de las reglas de recomendación, del comportamiento ante fallos (qué se degrada y cómo), ejecución y revisión de resultados |
| `observability/` (Prometheus, alertas, Loki, Alloy, Tempo, Grafana y dashboards), métricas/logs/trazas en core-api, worker y ai-service, `scripts/verificar-paso4.ps1` | Borrador del código, las configuraciones, los dashboards (generados con un script) y las pruebas | Qué se mide y con qué umbrales, qué es un incidente, qué dato identifica el problema; ejecución y revisión. Se detectaron y corrigieron dos defectos reales al verificar: alertas que no se disparaban con contadores sin inicializar y números de cuenta completos en los logs |
| Documentación (`docs/`, README) | Borradores de ADR y README | Edición y adaptación |

## Verificación
El código se ejecutó y se probó antes de incluirlo en el repositorio: pruebas automáticas (concurrencia, idempotencia,
integración con el simulador de Bancs, ETL), scripts de verificación con resultado PASS/FAIL y pruebas manuales de la API.

<!-- Actualizar esta tabla al agregar componentes (k6, incidente reproducible, informe). -->
