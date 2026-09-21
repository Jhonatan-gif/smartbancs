# Defensa: guion de 3 minutos, guion del video y preguntas probables

Formato del reto: **3 minutos de exposición + 4 minutos de preguntas**. Video demostrativo de **hasta 5 minutos**.
Regla de oro: cada afirmación lleva **su cifra medida y su límite**. Todos los números de este documento están medidos y documentados en `docs/`.

> **Antes de defender:** lee `docs/documento-tecnico.md` completo y ejecuta al menos una vez cada verificador. `AI_USAGE.md` declara que una IA escribió gran parte
> del código: el jurado puede pedirte que expliques cualquier parte, así que conviene poder explicar por qué existe cada pieza (la sección "Cómo sustentar" de esta guía te da el hilo).

---

## 1. Guion de exposición (3 minutos, unas 400 palabras)

**[0:00-0:25] El problema y el principio.**
"SmartBancs procesa transferencias en tiempo real. El reto tiene tres tensiones: mucha concurrencia, un core legado, Bancs, que no aguanta volumen, y una IA que no puede retrasar el dinero.
Mi principio de diseño es uno: **la transferencia solo depende de PostgreSQL**. Todo lo demás (Bancs, la IA, la observabilidad) se entera después y no puede romperla."

**[0:25-1:10] La arquitectura** *(mostrar el diagrama de `docs/diagrams/`)*.
"Una transferencia es una sola transacción: bloquea las dos cuentas en orden de id, así que no hay deadlocks; el débito es un `UPDATE ... WHERE balance >= monto`, así que no hay sobregiros;
la clave de idempotencia es única, así que un reintento no duplica; y escribe dos asientos inmutables en el ledger y un evento en el outbox, todo en la misma transacción.
Un worker publica ese evento en Redis Streams. Bancs lo recibe en lotes de 25, con máximo 5 llamadas por segundo, breaker y reintentos; y la IA lo lee en su propio grupo."

**[1:10-2:10] La demostración** *(mostrar la app: `docker compose up`, http://localhost:8080)*.
"Entro como Ana, veo su saldo, transfiero 25,50. Repito y no se cobra dos veces. Pruebo fondos insuficientes y el error es claro.
Ahora **apago Bancs**: las transferencias siguen dando 201. **Pongo la IA a 5 segundos**: las transferencias no cambian y las recomendaciones responden el respaldo en menos de 500 milisegundos."

**[2:10-2:45] Lo medido.**
"Medí, no supuse. Una instancia sostiene unas 400 transferencias por segundo con p95 de 66 milisegundos; con 4 réplicas, 1.000 por segundo. Reproduje el incidente de deadlocks:
el p95 pasó de 7 milisegundos a 4,2 segundos con 94 % de errores; las métricas y las trazas señalaron el paso exacto; y tras la corrección volvió a 7 milisegundos **con el dinero conciliado al centavo**."

**[2:45-3:00] Límites y cierre.**
"**No alcancé los 10.000 TPS**: el techo medido es ~570 por instancia y explico cómo se llegaría. Tampoco hay autenticación en este MVP. Lo que sí garantizo es que el dinero nunca se pierde ni se duplica, y que puedo demostrarlo."

---

## 2. Guion del video (≤ 5 minutos)

Grabar la pantalla en este orden (cada tramo con su comando):

| Tiempo | Qué mostrar | Cómo |
|---|---|---|
| 0:00-0:30 | Qué es y el principio de diseño | Diagrama de `docs/diagrams/arquitectura.mmd` (o `docs/capturas/`) |
| 0:30-1:30 | **La app**: entrar como Ana, ver saldo, ocultar/mostrar, transferir, repetir (no duplica), error de fondos, movimientos, estado de cuenta PDF | http://localhost:8080 (`?u=ana` entra directo) |
| 1:30-2:15 | **Bancs cae y las transferencias siguen**; al volver se sincroniza sin duplicar | `curl -X POST localhost:4000/bancs/admin/outage -H 'content-type: application/json' -d '{"down":true}'`; transferir en la app; `curl localhost:4000/bancs/stats` |
| 2:15-2:50 | **La IA lenta**: consejos con respaldo; transferencias intactas | `curl -X POST localhost:8000/admin/mode -H 'content-type: application/json' -d '{"mode":"slow","delay_ms":5000}'` y abrir "Consejos IA" (etiqueta "Respaldo") |
| 2:50-3:50 | **Observabilidad**: Grafana con carga, el dashboard *Incidente*, una traza | `scripts\run-loadtest.ps1 -Scenario load` en otra terminal; http://localhost:3001 |
| 3:50-4:30 | **El incidente**: salida de `simulate-incident.ps1` (o `docs/evidencias/incidente-salida.txt`) | Mostrar la tabla base → incidente → corrección |
| 4:30-5:00 | Pruebas y límites | `docs/evidencias/clon-limpio.md`; decir que 10.000 TPS no se alcanzaron |

**Consejos:** grabar con datos limpios (`docker compose --profile obs down -v` y `up -d --build` antes); tener abiertas las pestañas antes de grabar; no improvisar comandos largos (copiarlos de este archivo);
al apagar Bancs o la IA, restaurarlos al final (`"down":false`, `"mode":"normal"`).

---

## 3. Cómo sustentar cada decisión (problema → decisión → evidencia → límite)

| Decisión | Problema que resuelve | Evidencia | Límite honesto |
|---|---|---|---|
| **PostgreSQL** + `NUMERIC` + `CHECK` + ledger inmutable | Dinero: ni se pierde ni se duplica | 50 débitos sobre 1.000 de saldo → exactamente 10 aprobados | Un solo primario es el techo de escritura a gran escala |
| **Orden de bloqueo por id** | Deadlocks en A→B y B→A | Con el orden apagado: 137 deadlocks y 94 % de errores; con orden: 0 | La bandera que lo apaga existe solo para la demo |
| **Idempotency-Key + hash** | Reintentos duplican | 20 peticiones simultáneas → una transferencia | La clave la genera el cliente |
| **Outbox + Redis Streams** | Perder eventos / acoplar a Bancs | 0 eventos perdidos; Bancs: 1.927 llamadas, 0 respuestas 429, máx. 5/s | Consistencia eventual: el legado va detrás (7,5 min para vaciar 23.000) |
| **Lotes + rate limit + breaker + DLQ** | Bancs frágil y limitado | Caída simulada: 20/20 en 201; breaker: 7 llamadas en 15 s | Bancs es un simulador |
| **IA desacoplada + fallback** | La IA no puede retrasar el dinero | Con IA a 5 s: transferencias p50 17,3 ms (17,0 sin carga) | Modelo estadístico, sin evaluación con etiquetas |
| **Observabilidad correlacionada** | Diagnosticar el incidente | Métrica, log y traza señalan el paso exacto (`lock_from`/`lock_to`) | Sin Alertmanager; Dynatrace no se probó |
| **Escalado con réplicas** | Techo del CPU de un hilo | 1 → 4 réplicas: ~570 → ~1.100 tps | ×2, no ×4, en un solo portátil |
| **Estados de cuenta desde el ledger** | Totales que cuadren | inicial + créditos − débitos = final; contraste con SQL independiente | Sin autenticación; periodo en UTC |

---

## 4. Preguntas probables (respuesta corta, ~20-30 s)

**1. ¿Por qué PostgreSQL y no algo NoSQL?**
Porque para dinero necesito transacciones ACID y bloqueos de fila. `NUMERIC(18,2)`, el `CHECK (balance >= 0)` y el trigger que hace inmutable el ledger son garantías de la base, no del código. Lo comprobé con 400 transferencias simultáneas: el dinero total se conserva.

**2. ¿Cómo evitas transferencias duplicadas?**
Con `Idempotency-Key` única y un hash de la petición: mismos datos devuelven 200 *replayed*, datos distintos 422. En la app, un reintento reutiliza la misma clave. Probé 20 peticiones simultáneas con la misma clave: una sola transferencia.

**3. ¿Qué pasa con los deadlocks?**
Se evitan bloqueando ambas cuentas en una sola sentencia y en orden de id. Y lo reproduje a propósito: con el orden desactivado hubo 137 deadlocks y 94 % de errores; las métricas señalaron `lock_from` y `lock_to`; al restaurar el orden, cero.

**4. ¿Qué pasa si Bancs cae?**
Nada para el cliente: la API nunca llama a Bancs. El evento queda en el outbox, el worker abre el *circuit breaker* (7 llamadas en 15 s en la prueba) y, al volver Bancs, sincroniza todo sin duplicar gracias a que la referencia es el id de la transacción.

**5. ¿Por qué no llamas a Bancs directamente en la transferencia?**
Porque su latencia y sus fallos pasarían a ser los nuestros, y no soporta volumen. Con outbox más lotes limitados a 5 llamadas/s, en toda la prueba recibió 0 respuestas 429.

**6. ¿Llegaste a 10.000 TPS?**
No. Medí ~570 por instancia y ~1.100 con 4 réplicas, en un solo portátil compartido. El techo es el CPU de un hilo de Node. Para 10.000 haría falta del orden de 18-20 instancias en hardware dedicado, PostgreSQL particionado y netear los movimientos hacia Bancs; eso es diseño, no está probado.

**7. ¿Y si la IA falla o se demora?**
Está desacoplada: timeout de 300 ms, *circuit breaker* y *fallback*. Con la IA a 5 segundos las transferencias no cambian de latencia y las recomendaciones responden el respaldo en menos de 500 ms. La IA nunca mueve dinero.

**8. ¿Por qué un modelo tan simple?**
Es explicable, barato y se entrena en milisegundos; además no tengo etiquetas reales para un modelo supervisado. Lo digo abiertamente: no puedo afirmar una precisión.

**9. ¿Cómo monitoreas el data drift y cuándo reentrenas?**
Con PSI y KS entre la distribución de referencia y la actual. Lo medí: con el mismo comportamiento PSI = 0,0026 (no reentrenar); con el gasto subiendo un 80 % PSI = 0,45 (alerta). Reentreno si una variable está en alerta o tres en vigilancia.

**10. ¿Qué ve el usuario si la sincronización con Bancs va atrasada?**
Su saldo operativo local, correcto al instante. El legado se actualiza después (consistencia eventual). Tras un pico de 23.000 transferencias, la cola tardaba ~7,5 minutos en vaciarse; la métrica y la alerta lo muestran.

**11. ¿Qué pasa si cae Redis? ¿Y PostgreSQL?**
Sin Redis la transferencia sigue funcionando: los eventos quedan en el outbox y el relay los publica cuando Redis vuelve. Sin PostgreSQL la API responde 503 y el worker y core-api se reconectan solos (lo corregí tras ver que caían al reiniciar la base).

**12. ¿Cómo sabes que el dinero cuadra?**
Tras cada carga verifico: cada transacción tiene 2 asientos que suman cero, el saldo de cada cuenta es su último `balance_after`, la cadena de saldos es continua y el total se conserva. También pasó tras el incidente simulado (9.862 transacciones con 137 deadlocks).

**13. ¿Qué seguridad tiene?**
Validación estricta, SQL parametrizado, cuentas enmascaradas en respuestas y logs, ledger inmutable e idempotencia. **No tiene autenticación ni autorización**: es un MVP y en producción sería obligatorio (OIDC, control por titular, TLS/mTLS). Está declarado en el documento técnico.

**14. ¿Por qué Redis Streams y no Kafka?**
Para este alcance da grupos de consumidores independientes, reprocesamiento y persistencia (AOF) con mucha menos infraestructura. Con volúmenes de 10.000 TPS evaluaría Kafka.

**15. ¿Qué hallaste mientras probabas?**
Varias cosas reales que corregí: alertas que no se disparaban con contadores sin inicializar, números de cuenta completos en los logs, conexiones nuevas en pleno pico y un error mal clasificado como 500. Eso demuestra que probé de verdad.

**16. ¿Usaste IA?**
Sí, y está declarado en `AI_USAGE.md`: Claude y Claude Code escribieron gran parte del código, las pruebas y los documentos a partir de mis requisitos y decisiones. Yo definí el alcance, el stack y las reglas, aprobé cada plan y todo se ejecutó y verificó; puedo explicar cualquier parte.

**17. ¿Qué harías con más tiempo?**
Autenticación, CI con las pruebas de concurrencia, Alertmanager, pruebas de carga en hardware dedicado, PostgreSQL particionado y neteo hacia Bancs.

---

## 5. Lista de comprobación antes de grabar o defender

- [ ] `docker compose --profile obs down -v` y luego `docker compose --profile obs up -d --build`; todos `healthy` (`docker compose ps`).
- [ ] App en http://localhost:8080 (probar `?u=ana`) y Grafana en http://localhost:3001.
- [ ] Bancs y la IA en modo normal (`"down":false`, `"mode":"normal"`).
- [ ] `git status` limpio y `git push` hecho; el enlace del repositorio abre para el jurado.
- [ ] Tener a mano: `docs/documento-tecnico.md`, `docs/carga-resultados.md`, `docs/evidencias/`, el diagrama.
