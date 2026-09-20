# Evidencias y datos de prueba

Todo lo que hay aquí se **generó ejecutando el código de este repositorio**; ninguna cifra está escrita a mano. Cada archivo indica el comando que lo produce.
Las cifras de rendimiento son de un **único portátil** (Windows + Docker Desktop, 20 CPU lógicas y 8 GB para Docker, con k6 y todos los servicios en la misma máquina).

## Salidas de las verificaciones (PASS/FAIL)
| Archivo | Comando | Resultado |
|---|---|---|
| `paso3-verificacion.txt` | `scripts\verificar-paso3.ps1 -SinTests` | IA lenta/apagada: transferencias intactas y *fallback* < 500 ms |
| `paso4-verificacion.txt` | `scripts\verificar-paso4.ps1` | 52/52: métricas, logs, trazas, dashboards, alertas y deadlock real |
| `estados-cuenta-verificacion.txt` | `scripts\verificar-estados-cuenta.ps1` | 26/26: CSV y PDF cuadran con el ledger |
| `incidente-salida.txt` | `scripts\simulate-incident.ps1` | 10/10: incidente reproducido, corregido y dinero conservado |

## Prueba en clon limpio
| Archivo | Contenido |
|---|---|
| `clon-limpio.md` | Repositorio clonado en una carpeta nueva, levantado desde cero y verificado (resultados, fallos que encontró y cómo se corrigieron) |

## Simulación del incidente (3.5)
| Archivo | Contenido |
|---|---|
| `incidente-resultado.json` | Métricas por fase: línea base, incidente, corrección |
| `incidente-diagnostico.txt` | Diagnóstico en vivo durante el incidente (pool esperando, quién bloquea a quién, errores por paso SQL) |
| `incidente-linea-base.json`, `incidente-incidente.json`, `incidente-correccion.json` | Resumen k6 de cada fase |

## Pruebas de carga con k6 (`docs/carga-resultados.md` las interpreta)
| Archivo | Escenario |
|---|---|
| `k6-smoke.*`, `k6-load.*`, `k6-ramp.*` | Humo (20 tps), carga sostenida (100→300 tps) y escalera hasta 2.000 tps (`.txt` = salida de k6, `.json` = resumen, `-resumen.json` = resumen con la corrección posterior) |
| `k6-1replica-{400,600,800,1300}.json` | Una instancia, tasa fija |
| `k6-4replicas-{700,900,1000,1200,1800,2400,3000}.json`, `k6-4replicas-1000-repeticion.*` | Cuatro réplicas detrás de nginx |

## ETL y data drift
| Archivo | Contenido |
|---|---|
| `etl-reporte-calidad.md` | Reporte de calidad sobre la muestra de 2.000 filas (1.716 limpias, 284 rechazadas por motivo) |
| `drift-demo.md` | Demostración de *data drift* con PSI y KS (mismo comportamiento frente a gasto x1,8) |

## Datos de prueba utilizados
| Datos | Dónde | Para qué |
|---|---|---|
| 4 clientes y 5 cuentas (una bloqueada) con números Luhn válidos | `db/seeds/001_seed.sql` | Pruebas manuales y de la API |
| 2.000 filas sucias (semilla 42) | `etl/data/sample/dirty_transactions.csv` (se regenera con `python -m smartbancs_etl.generate`) | ETL |
| Features por cuenta de esa muestra | `etl/data/sample/account_features.csv` | ai-service en un clon limpio |
| 1.000 cuentas de carga (saldo 1.000.000.000) | `loadtest/seed-accounts.sql` | k6 |
| Cuentas y movimientos sintéticos por prueba | dentro de cada suite de pruebas (fechas fijas de 2020 para los estados de cuenta) | Pruebas automáticas |

## Pendientes de entrega (los aporta el candidato)
Video demostrativo (≤ 5 min), material de presentación y guion de la exposición.
