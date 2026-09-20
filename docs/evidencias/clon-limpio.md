# Prueba en clon limpio

**Qué se hizo:** `git clone` del repositorio en una carpeta nueva (solo lo versionado: sin `CLAUDE.md`, `docs/PLAN.md`, `node_modules` ni datos previos),
`docker compose down -v` de la pila anterior y `docker compose up --build -d` desde cero; después se ejecutaron los verificadores. Único archivo añadido a mano: un `.env` con
`POSTGRES_PORT=5433`, porque el equipo de pruebas tiene un PostgreSQL propio en el 5432 (el README lo explica).

## Resultado final
| Comprobación | Resultado |
|---|---|
| Arranque desde cero (`docker compose up --build -d`) | 6 de 6 servicios `healthy` en 19 s (con las capas de Docker ya en caché: **no** es un arranque en frío) |
| `verificar-paso1.ps1` | 27/27 |
| `verificar-paso2.ps1` | 26/26 |
| `verificar-paso3.ps1` | 27/27 |
| `verificar-paso4.ps1` (perfil `obs`, incluye un deadlock real) | 52/52 |
| `verificar-estados-cuenta.ps1` | 25/25 (una comprobación menos: la lectura del PDF con un lector de terceros solo corre si existe `etl/.venv`) |
| ETL (`docker compose run --rm etl`) | 2.000 entrantes → 1.716 limpias, balance correcto; 54 pruebas |

## Fallos que encontró (y ya están corregidos)
Todos de los scripts de verificación o de una métrica, ninguno del flujo de dinero:
1. El test de integración del worker importa el código de `bancs-mock` y en un clon limpio faltaban sus dependencias: el verificador ahora las instala.
   (Un primer arreglo dejó un carácter de escape en la ruta y no funcionó; se detectó al repetir la prueba en el clon.)
2. `verificar-paso3` esperaba 46 pruebas del ETL y son 54.
3. Las transacciones históricas que insertan las pruebas de estados de cuenta directamente por SQL no generan evento en el outbox, y se contaban como "sin sincronizar":
   falso retraso en el verificador y en la métrica `sync_unsynced_transactions`. Ahora solo cuentan las transferencias con evento.

## Límites de esta prueba
Se hizo en el mismo equipo con la caché de imágenes de Docker; no se probó en otro sistema operativo (los verificadores son PowerShell y solo se han ejecutado en Windows PowerShell 5.1).
