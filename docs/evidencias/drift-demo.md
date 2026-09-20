# Demostración de data drift (PSI y KS)

Referencia: 12.000 filas sucias limpias con semilla 42 (300 cuentas). Se compara con (a) otro lote del mismo comportamiento y (b) un lote donde el gasto sube un 80 %.
Umbrales: PSI < 0.1 estable · 0.1-0.25 vigilar · > 0.25 alerta. Reentrenar si alguna variable está en ALERTA o 3 o más en VIGILAR.

## mismo_comportamiento

### Monto de las transacciones

| Variable | n ref. | n actual | PSI | KS | KS crítico (5 %) | Estado |
|---|---:|---:|---:|---:|---:|---|
| amount_f | 10257 | 10295 | 0.0026 | 0.0205 | 0.019 | **VIGILAR** |

### Features por cuenta

| Variable | n ref. | n actual | PSI | KS | KS crítico (5 %) | Estado |
|---|---:|---:|---:|---:|---:|---|
| avg_amount | 309 | 306 | 0.0478 | 0.0472 | 0.1097 | **ESTABLE** |
| total_spent | 309 | 306 | 0.0227 | 0.0596 | 0.1097 | **ESTABLE** |
| n_tx | 309 | 306 | 0.0471 | 0.0414 | 0.1097 | **ESTABLE** |
| n_counterparties | 309 | 306 | 0.0245 | 0.0408 | 0.1097 | **ESTABLE** |
| spend_trend | 309 | 306 | 0.0158 | 0.0403 | 0.1097 | **ESTABLE** |

**¿Reentrenar?** NO

## con_drift_gasto_x1.8

### Monto de las transacciones

| Variable | n ref. | n actual | PSI | KS | KS crítico (5 %) | Estado |
|---|---:|---:|---:|---:|---:|---|
| amount_f | 10257 | 10332 | 0.4508 | 0.275 | 0.019 | **ALERTA** |

### Features por cuenta

| Variable | n ref. | n actual | PSI | KS | KS crítico (5 %) | Estado |
|---|---:|---:|---:|---:|---:|---|
| avg_amount | 309 | 308 | 0.7659 | 0.3583 | 0.1095 | **ALERTA** |
| total_spent | 309 | 308 | 0.5687 | 0.3356 | 0.1095 | **ALERTA** |
| n_tx | 309 | 308 | 0.0779 | 0.07 | 0.1095 | **ESTABLE** |
| n_counterparties | 309 | 308 | 0.0701 | 0.0538 | 0.1095 | **ESTABLE** |
| spend_trend | 309 | 308 | 0.0449 | 0.0569 | 0.1095 | **ESTABLE** |

**¿Reentrenar?** SÍ
