# Reporte de calidad de datos (ETL sobre la muestra de 2.000 filas, semilla 42)

- Filas entrantes: **2000**
- Filas limpias: **1716** (85.8 %)
- Filas rechazadas: **284**
- Cuadre entrantes = salientes + rechazadas: **OK**
- Outliers marcados (no eliminados): 22
- Cuentas normalizadas (guiones/espacios): 34
- Montos redondeados a 2 decimales: 0
- Cuentas con features: 42

## Rechazos por motivo

| Motivo | Filas |
|---|---:|
| DUPLICADO | 77 |
| MONTO_NO_POSITIVO | 44 |
| CUENTA_INVALIDA | 28 |
| FECHA_FALTANTE | 26 |
| MONTO_FALTANTE | 23 |
| CUENTA_FALTANTE | 21 |
| CONTRAPARTE_INVALIDA | 17 |
| MONTO_ILEGIBLE | 17 |
| MISMA_CUENTA | 11 |
| MONEDA_INVALIDA | 11 |
| FECHA_FUTURA | 9 |

## Nulos en la entrada

| Columna | Nulos |
|---|---:|
| transaction_id | 0 |
| account_number | 22 |
| counterparty_account | 0 |
| amount | 25 |
| currency | 60 |
| timestamp | 31 |
| category | 108 |
| channel | 76 |
| description | 0 |

## Valores imputados

| Regla | Filas |
|---|---:|
| channel=desconocido | 65 |
| category=sin_categoria | 96 |
| currency=USD | 52 |

## Formatos de fecha detectados

| Formato | Filas |
|---|---:|
| iso8601 | 431 |
| dd/mm/yyyy | 221 |
| epoch_ms | 219 |
| yyyy/mm/dd hh:mm:ss | 196 |
| epoch_s | 232 |
| dd/mm/yyyy hh:mm | 206 |
| dd-Mon-yyyy hh:mm | 222 |
