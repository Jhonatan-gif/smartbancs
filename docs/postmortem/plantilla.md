# Post mortem: <título corto del incidente>

> Formato sin culpables ("blameless"): se busca entender **cómo falló el sistema**, no quién se equivocó. Publicar en 48 h.

| | |
|---|---|
| **Fecha y hora (inicio - fin)** | |
| **Duración** | |
| **Severidad** | SEV1 / SEV2 / SEV3 |
| **Incident commander** | |
| **Autores** | |
| **Estado** | Borrador / Revisado / Cerrado |

## 1. Resumen ejecutivo
Tres o cuatro frases: qué pasó, a quién afectó y cómo se resolvió. Para alguien que no es técnico.

## 2. Impacto
- Usuarios / transferencias afectadas (número y porcentaje), errores devueltos, latencia (p95/p99) y duración.
- ¿Hubo pérdida o duplicación de dinero? (Sí/No y cómo se comprobó: conciliación del ledger, DLQ, sincronización con Bancs).
- Impacto en negocio y en el cumplimiento del SLO (transferencias < 2 s, errores < 1 %).

## 3. Línea de tiempo
| Hora | Evento | Fuente (alerta, log, persona) |
|---|---|---|
| | Cambio / despliegue / pico que origina el problema | |
| | Primera señal (métrica o alerta) | |
| | Alguien reconoce el incidente | |
| | Diagnóstico: causa identificada | |
| | Mitigación aplicada | |
| | Servicio recuperado / verificado | |

Métricas de respuesta: **MTTD** (tiempo hasta detectar), **MTTA** (hasta reconocer), **MTTR** (hasta resolver).

## 4. Causa raíz
- **Qué falló** (técnico y concreto), y **por qué se dio**: técnica de los *5 porqués*.
- **Factores contribuyentes** (configuración, falta de pruebas, límites no revisados, dependencia externa).
- **Por qué no se detectó antes.**

## 5. Detección y respuesta
- ¿Qué alertas saltaron y cuáles debieron saltar? ¿La observabilidad permitió identificar el proceso exacto?
- **Qué salió bien**, **qué salió mal** y **dónde tuvimos suerte**.
- ¿Se siguió el runbook? ¿Qué le faltó?

## 6. Resolución
Mitigación temporal aplicada y corrección definitiva, con enlace al cambio (commit/PR) y evidencia de la recuperación.

## 7. Acciones preventivas
| # | Acción | Ámbito | Responsable | Fecha | Estado |
|---|---|---|---|---|---|
| 1 | | Código | | | |
| 2 | | Infraestructura | | | |
| 3 | | Observabilidad / alertas | | | |
| 4 | | Proceso / pruebas | | | |

Ejemplos de referencia para este sistema:
- **Código:** bloqueo ordenado de recursos, pruebas de concurrencia en CI, reintentos con backoff e idempotencia, `lock_timeout` y `statement_timeout`, revisión de cambios que tocan transacciones.
- **Infraestructura:** dimensionar pool y `max_connections`, réplicas de la API detrás de un balanceador, PgBouncer, límites de tasa, separar lecturas (réplica de lectura), pruebas de carga previas a picos conocidos (quincena), autoescalado.
- **Proceso:** *game days*, feature flags con *rollback* rápido, *canary*, revisión del runbook.

## 8. Lecciones aprendidas
Qué cambia en cómo diseñamos, probamos u operamos.

## 9. Anexos
Gráficas (Grafana), consultas usadas, trazas (`trace_id`), fragmentos de log, enlaces al runbook y a los cambios.
