# ADR-0004: Recomendaciones de IA desacopladas del flujo transaccional, con timeout, circuit breaker y fallback

- **Estado:** Aceptada
- **Fecha:** 2026-09-19

## Contexto
El reto (2 y 3.3) exige que las recomendaciones de IA **no bloqueen ni retrasen** las transferencias (< 2 s) y que el
código del servicio principal demuestre un consumo asíncrono o no bloqueante. La IA es un componente lento, costoso y
propenso a fallar; la transferencia, en cambio, es el camino crítico del negocio.

## Opciones evaluadas
| Opción | A favor | En contra |
|---|---|---|
| Llamar al modelo dentro de la transferencia | Recomendación al instante | La latencia y los fallos de la IA pasan a ser los de la transferencia: inaceptable |
| Cola de tareas (worker de IA) que escribe recomendaciones en BD | Muy desacoplado | Más piezas y tablas; recomendaciones pueden quedar viejas |
| **Stream de eventos + servicio de IA independiente + consulta con timeout/breaker/fallback** | La transferencia nunca sabe que existe la IA; degradación elegante | Recomendaciones eventualmente consistentes |
| Modelo embebido en core-api | Sin red | Acopla ciclo de vida, recursos y dependencias del modelo al servicio crítico |

## Decisión
1. **Cero acoplamiento en la escritura:** la transferencia solo escribe su evento en el outbox (ADR-0002). El **ai-service** lee el
   stream `transfers.completed` con su **propio grupo** (`ai-recs`), independiente de `bancs-sync`: no compite con el worker ni le
   quita eventos. Si el ai-service cae, los eventos quedan en el stream y se procesan al volver (comprobado).
2. **Lectura con tres defensas** en core-api (`GET /v1/accounts/{n}/recommendations`):
   - **Timeout de 300 ms** (`AI_TIMEOUT_MS`) que cubre conexión, cabeceras y cuerpo.
   - **Circuit breaker:** 3 fallos seguidos abren el circuito 10 s; con el circuito abierto no se llama al ai-service y el fallback es inmediato. Pasado el cooldown, una sola llamada de prueba decide si se cierra.
   - **Fallback:** recomendaciones genéricas con `source: "fallback"`, `degraded: true` y el motivo (`timeout`, `unavailable`, `circuit_open`). HTTP 200: para el cliente la pantalla siempre carga.
3. **El ai-service es opcional para core-api:** no hay `depends_on` ni afecta a su healthcheck. Las transferencias no importan el cliente de IA.
4. **Modelo simple y explicable** (`zscore-seg-v1`): reglas sobre las features del ETL (tendencia de gasto, concentración por categoría, movimientos atípicos, inactividad), puntaje de perfil atípico (promedio de |z| frente a la población) y segmentos por terciles de gasto. Se combina con la actividad en vivo del stream (transferencia inusual respecto al promedio, ráfaga de transferencias en una hora).
5. **Datos:** las features salen del ETL (ADR-0003). El ai-service lee `processed/` y, si no existe, la muestra versionada, así `docker compose up` funciona en un clon limpio. `account_number` se lee siempre como texto.
6. **Modos de prueba** (`POST :8000/admin/mode` con `normal|slow|down`, activable con `ENABLE_ADMIN`): permiten demostrar la degradación sin tocar código.

## Consecuencias
- **Medido** (`scripts/verificar-paso3.ps1`, HTTP real en el equipo de desarrollo): con el ai-service colgado (5 s por respuesta) y 40 consultas de recomendaciones en paralelo, las 40 transferencias siguen dando 201; la latencia no cambió de forma apreciable frente a la referencia (ver la salida del script en `docs/evidencias/`). El fallback responde en menos de 500 ms (con el circuito abierto, en unos 12 ms).
- **Costo aceptado:** el estado en vivo del ai-service está en memoria; al reiniciar se pierde y vuelve a construirse solo con los eventos nuevos y las features. Con un solo consumidor no hay reparto de carga.
- **Producción:** persistir el estado en vivo en Redis o un feature store; varios consumidores en el mismo grupo para escalar; exponer el estado del breaker y el ratio de fallback como métricas (Paso de observabilidad); servir el modelo con despliegue *shadow/canary* y monitorear *drift* (PSI/KS) según el ciclo de vida descrito en el documento técnico.
