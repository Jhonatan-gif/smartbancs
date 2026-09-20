# ADR-0007: Estados de cuenta mensuales generados desde el ledger (CSV y PDF)

- **Estado:** Aceptada
- **Fecha:** 2026-09-20

## Contexto
Un cliente debe poder descargar el estado de cuenta de un mes con saldo inicial, créditos, débitos, saldo final y el detalle. Es un documento
financiero: los totales tienen que cuadrar **exactamente** con el libro mayor y con el saldo, y no puede haber errores de redondeo.

## Opciones evaluadas
| Opción | A favor | En contra |
|---|---|---|
| Guardar un saldo al cierre de cada mes (tabla de cierres) | Lectura muy rápida | Un cálculo más que puede descuadrarse; hay que hacer el cierre y corregirlo si algo cambia |
| Sumar en la aplicación (JS) | Simple | `float`/redondeos; totales y detalle pueden salir de lecturas distintas |
| **Calcular en PostgreSQL con NUMERIC, en una transacción de solo lectura con snapshot** | Exacto, una sola fuente de verdad (el ledger), sin tablas nuevas | Cada estado recorre los asientos del mes (hay índice por cuenta e id) |

## Decisión
1. `GET /v1/accounts/{n}/statements?month=YYYY-MM&format=csv|pdf`, periodo **en UTC** (día 1 00:00 inclusivo a día 1 del mes siguiente exclusivo).
2. **Todo sale del ledger y del saldo actual**, en una sola transacción `REPEATABLE READ READ ONLY`: totales y detalle no pueden descuadrarse aunque entren transferencias mientras se genera.
   `saldo final = saldo actual − movimientos netos posteriores al periodo`; `saldo inicial = saldo final − (créditos − débitos)`. Así es correcto también para cuentas que nacieron con saldo (sin asiento) y para meses sin movimientos.
3. Importes en `NUMERIC(18,2)` calculados en PostgreSQL y devueltos como texto: **nunca float**. Escala fija de 2 decimales (`0.00`, no `0`).
4. **CSV** en UTF-8 con BOM y CRLF (abre bien en Excel), RFC 4180 y **neutralización de inyección de fórmulas** (`=`, `+`, `-`, `@` al inicio se prefijan con `'`).
5. **PDF** generado sin dependencias (fuente estándar Courier, varias páginas, sin compresión para que sea auditable). Se comprobó con un lector de terceros (pypdf).
6. Seguridad y privacidad: cuenta enmascarada en el nombre del archivo, contraparte enmascarada, `Cache-Control: no-store`, tope de 20.000 movimientos (`STATEMENT_MAX_ROWS`, 422 si se supera).

## Consecuencias
- **Comprobado:** 15 pruebas (bordes de mes inclusivo/exclusivo, invariante `inicial + créditos − débitos = final`, continuidad entre meses, contraste contra SQL independiente sobre el ledger, escapes del CSV, estructura del PDF, límites) y `scripts/verificar-estados-cuenta.ps1` (26 chequeos).
- **Límites conocidos:** no hay autenticación ni autorización (cualquiera que conozca el número de cuenta puede pedir su estado): es un MVP y en producción exige identidad del cliente; el periodo es UTC (no hora de Ecuador); el PDF es funcional y sencillo, sin logotipo ni tipografías personalizadas.
- **Producción:** autenticación y control de acceso por titular, generación asíncrona con enlace firmado para estados muy grandes, réplica de lectura para no cargar el primario, cierres mensuales materializados si el volumen lo exige, firma electrónica del PDF.
