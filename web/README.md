# Interfaz web (móvil)

HTML + CSS + JavaScript sin dependencias ni compilación, servida por nginx en **http://localhost:8080** (`docker compose up -d`).
nginx reenvía `/api/*` a core-api, así que el navegador solo habla con un origen (sin CORS) y se pueden aplicar cabeceras de seguridad estrictas (CSP sin scripts ni estilos en línea).

## Qué muestra (solo lo que el backend realmente ofrece)
| Pantalla | Origen de los datos |
|---|---|
| Cabecera con saludo, campana y pestañas | La campana cuenta los consejos "importantes" de la IA |
| Tarjeta de cuenta (tipo, número enmascarado, saldo, ojo, paginador) | `GET /v1/accounts/{n}` |
| Accesos rápidos: Transferir, Movimientos, Estado de cuenta, Consejos IA, Copiar n.º de cuenta, Salir | `POST /v1/transfers`, `GET .../movements`, `GET .../statements`, `GET .../recommendations` |
| Novedades | Recomendaciones reales del ai-service, con la etiqueta "IA · modelo" o "Respaldo" |
| Pestañas Tarjetas / Créditos / Inversiones | "Próxima versión": el MVP no tiene backend para ellas (no se inventan datos) |

## Acceso (modo demostración)
El backend **no implementa autenticación**. El modal solo permite elegir un perfil de prueba (`ana`, `luis`, `sofia`, `carlos`, este último con la cuenta bloqueada) y lo dice en pantalla.
No se pide ni se valida ninguna clave. "Generar clave virtual" y "¿Tiene una invitación?" avisan de que no están disponibles. `?u=ana` en la URL entra directamente (útil para grabar).

## Decisiones
- **Dinero como texto:** los importes se formatean y se envían como texto decimal, nunca como `float`.
- **Idempotencia en la interfaz:** cada intención de transferencia lleva su `Idempotency-Key`; "Reintentar" tras un error de red reutiliza la misma clave, así que no puede duplicar la operación.
- **Errores claros:** cada código del backend (`INSUFFICIENT_FUNDS`, `ACCOUNT_NOT_ACTIVE`...) tiene un mensaje en español y se muestra la referencia de soporte (`requestId`, igual al `trace_id` de los logs y las trazas).
- **XSS:** todo texto de la API se inserta con `textContent`; una descripción con HTML se muestra como texto (hay una prueba).
- **Validación en el cliente** (dígito verificador, monto) solo para ayudar; la autoridad es siempre el backend.

## Prueba de extremo a extremo
`web/test/e2e.js` abre la app en Chrome móvil y recorre acceso, saldo, transferencia, errores, movimientos, estado de cuenta, IA, pestañas y perfil bloqueado (33 comprobaciones, además de errores de consola y de la CSP):
```bash
cd web && npm i --no-save puppeteer && node test/e2e.js      # necesita la pila levantada; descarga Chrome (~150 MB)
```
Ejecutada en el equipo de desarrollo: 33/33. Capturas en [`docs/capturas/`](../docs/capturas).

## Límites
Sin autenticación real; el listado de cuentas de cada perfil está en el cliente (el backend no tiene "cuentas de un cliente"); accesibilidad revisada a mano (etiquetas, foco, contraste) pero **sin auditoría formal**;
probada solo en Chrome (Puppeteer), no en Safari ni en dispositivos reales.
