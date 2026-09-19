# ADR-0003: ETL de transacciones con rechazo trazable, Parquet y features por cuenta

- **Estado:** Aceptada
- **Fecha:** 2026-09-19

## Contexto
El reto (3.2) pide un proceso ETL/ELT que tome un lote de transacciones crudas, las limpie (nulos, formatos) y las deje
en un formato optimizado para análisis o para la IA. Los extractos reales llegan de varios sistemas con fechas y montos
en formatos distintos, duplicados y cuentas erróneas. El resultado alimenta al modelo de recomendaciones (Paso 3, ai-service).

## Opciones evaluadas
| Opción | A favor | En contra |
|---|---|---|
| SQL puro sobre PostgreSQL | Sin dependencias nuevas | Parseo de formatos mixtos torpe; pruebas unitarias difíciles |
| **Python + pandas + Parquet** | Legible, testeable con pytest, Parquet compacto y columnar | Procesa en memoria: para cientos de millones de filas hace falta Spark/Polars |
| Spark / dbt | Escala horizontal | Exceso de infraestructura para un MVP |

## Decisión
1. **Python 3.12 + pandas**, fuera del camino transaccional. Se ejecuta bajo demanda (`docker compose run --rm etl`), no arranca con `up`.
2. **Ninguna fila desaparece en silencio:** cada fila entrante termina en el dataset limpio o en `rejected_rows.csv` con un
   motivo (`DUPLICADO`, `MONTO_NO_POSITIVO`, `CUENTA_INVALIDA`, ...). El reporte comprueba `entrantes = salientes + rechazadas`
   y el pipeline falla si no cuadra.
3. **Reglas de limpieza:**
   - Nulos: se rechaza lo esencial (id, cuentas, monto, fecha); se **imputa** lo accesorio (moneda → USD, categoría → `sin_categoria`, canal → `desconocido`) y se cuenta cada imputación.
   - Fechas en 7 formatos (ISO, `dd/mm/yyyy`, epoch s/ms...) a **UTC**. Sin zona se asume hora de Ecuador (UTC-5, sin horario de verano). Fechas futuras se rechazan.
   - Montos (`1,234.50`, `1.234,50`, `$12`, `USD 45`) a **`Decimal`**, redondeo bancario a 2 decimales; **nunca float**. Caso ambiguo `1,234` se interpreta como miles.
   - Cuentas: se quitan guiones y espacios y se valida el dígito verificador **Luhn** (misma regla que core-api).
   - **Outliers:** se **marcan** (`is_outlier`, z-score robusto con mediana y MAD sobre log(monto), por categoría) pero no se eliminan: un monto alto puede ser legítimo.
4. **Salida:** Parquet con `amount` como `DECIMAL(18,2)` (mismo tipo que la BD), features por cuenta en Parquet y CSV, y reporte de calidad (JSON y Markdown).
5. **Features por cuenta:** número y monto de transacciones, media, máximo, desviación, contrapartes distintas, gasto de los últimos 30 días frente a los 30 anteriores (`spend_trend`), participación por categoría y días desde la última transacción. Se convierten a float solo aquí, porque son variables de entrada de un modelo y no se usan en contabilidad.
6. **Datos de prueba reproducibles:** generador con semilla fija (`--seed 42`) que inyecta nulos, formatos mixtos, duplicados, cuentas inválidas, montos negativos, outliers y fechas futuras. Se versiona una muestra de 2.000 filas.

## Consecuencias
- **Bueno:** trazabilidad total de rechazos, dinero sin errores de coma flotante, salida lista para el ai-service y 46 casos de prueba.
- **Costo aceptado:** procesamiento en memoria y en un solo proceso. Con la muestra (2.000 filas) tarda menos de 1 s; **no se ha medido con volúmenes grandes**.
- **Producción:** particionar el Parquet por fecha en almacenamiento de objetos, procesar por lotes o por ventanas (Polars o Spark si el volumen lo exige), orquestar con un planificador (Airflow o cron) y publicar el reporte de calidad como métrica para vigilar el data drift.
