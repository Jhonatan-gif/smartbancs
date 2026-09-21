// Prueba de extremo a extremo de la interfaz con un navegador real (Chrome headless). Necesita la pila levantada (docker compose up -d).
// Hace transferencias reales de la cuenta de Ana (usa saldo de la base de datos); repetirla solo reduce ese saldo.
// Requiere puppeteer (descarga Chrome, ~150 MB):  cd web && npm i --no-save puppeteer && node test/e2e.js
const puppeteer = require('puppeteer');
const OUT = process.argv[2] || 'test/out';
const BASE = process.env.BASE_URL || 'http://localhost:8080';
require('fs').mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '  -> ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  const shot = async (n) => { await sleep(600); await page.screenshot({ path: `${OUT}/${n}.png` }); };
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
  const visible = (sel) => page.$eval(sel, (e) => !e.hidden && e.getClientRects().length > 0).catch(() => false);
  const click = async (sel) => { await page.waitForSelector(sel, { visible: true }); await page.click(sel); };
  const fill = async (sel, val) => { await page.focus(sel); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); await page.type(sel, val); };
  const clickText = async (sel, txt) => {
    const h = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t)), sel, txt);
    await h.asElement().click();
  };

  // ---------- Acceso
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  ok('El modal de acceso aparece al abrir', await visible('#loginOverlay .modal'));
  ok('Muestra "SmartBancs" y el aviso de modo demostración', (await text('#loginTitle')) === 'SmartBancs' && (await text('.demo-note')).includes('no implementa autenticación'));
  ok('"Continuar" empieza deshabilitado', await page.$eval('#continueBtn', (b) => b.disabled));
  await shot('01-login');
  await page.type('#user', 'zzz');
  ok('Al escribir se habilita "Continuar"', !(await page.$eval('#continueBtn', (b) => b.disabled)));
  await click('#continueBtn');
  ok('Usuario desconocido: muestra error', (await text('#userError')).includes('no encontrado'));
  await fill('#user', 'ana');
  await page.click('#virtualKeyBtn');
  ok('"Generar clave virtual" avisa que no está disponible (honesto)', (await text('#toast')).includes('no disponible'));
  await click('#continueBtn');

  // ---------- Panel
  await page.waitForSelector('.acct.card', { visible: true });
  await sleep(700);
  ok('Saludo personalizado en la cabecera', (await text('#userName')) === 'Ana' && /Buen/.test(await text('#greeting')));
  const cards = await page.$$eval('.acct.card', (c) => c.length);
  ok('Ana tiene 2 cuentas en el carrusel', cards === 2, `cuentas=${cards}`);
  ok('Paginador con 2 puntos y el primero activo', (await page.$$eval('#dots i', (d) => d.length)) === 2 && (await page.$$eval('#dots i.on', (d) => d.length)) === 1);
  const bal = await text('[data-balance="1000000016"]');
  const initialCents = BigInt(bal.match(/^([\d,]+\.\d{2})/)[1].replace(/[,.]/g, ''));
  const fmt = (c) => { const t = c.toString().padStart(3, '0'); return t.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + t.slice(-2); };
  ok('Saldo real de la API con formato de miles', /^[\d,]+\.\d{2}USD$/.test(bal), bal);
  ok('Número de cuenta parcialmente oculto', (await text('.acct-num')).includes('••••••0016'));
  ok('Hay 4 pestañas y "Cuentas" está activa', (await page.$$eval('.tab', (t) => t.length)) === 4 && (await text('.tab.active')) === 'Cuentas');
  ok('Hay accesos rápidos reales (6)', (await page.$$eval('.qbtn', (q) => q.length)) === 6);
  await page.waitForFunction(() => document.querySelectorAll('.banner:not(.skeleton)').length > 0, { timeout: 8000 });
  ok('Novedades: banners con las recomendaciones de la IA', (await page.$$eval('.banner:not(.skeleton)', (b) => b.length)) > 0);
  await shot('02-panel');

  await click('.eye');
  ok('Ocultar saldo: se enmascara', (await text('[data-balance="1000000016"]')).startsWith('••••••'));
  await shot('03-saldo-oculto');
  await click('.eye');
  ok('Mostrar saldo: vuelve el monto', (await text('[data-balance="1000000016"]')).startsWith(bal.replace('USD', '')));

  await page.$eval('#carousel', (c) => { c.scrollTo({ left: c.clientWidth, behavior: 'instant' }); });
  await sleep(500);
  ok('Al deslizar cambia el punto activo del paginador', (await page.$$eval('#dots i', (d) => d.findIndex((x) => x.classList.contains('on')))) === 1);
  await page.$eval('#carousel', (c) => { c.scrollTo({ left: 0, behavior: 'instant' }); });
  await sleep(500);

  // ---------- Transferir
  await clickText('.qbtn', 'Transferir');
  await page.waitForSelector('#tTo', { visible: true });
  await shot('04-transferir');
  await page.type('#tTo', '1000000017');
  await page.type('#tAmount', '5');
  await click('#sheetBody button[type=submit]');
  ok('Destino con dígito verificador inválido: error en el cliente', (await text('.field-error')).includes('no es válido'));
  await fill('#tTo', '1000000032');
  await fill('#tAmount', '0');
  await click('#sheetBody button[type=submit]');
  ok('Monto cero: error en el cliente', (await text('.field-error')).includes('mayor a cero'));
  await fill('#tAmount', '25.50');
  await page.type('#tDesc', 'Pago <img src=x onerror=alert(1)>');
  await click('#sheetBody button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#sheetBody').textContent.includes('Confirmar transferencia'));
  await shot('05-confirmar');
  await clickText('#sheetBody button', 'Confirmar transferencia');
  await page.waitForFunction(() => /Transferencia realizada|No se pudo/.test(document.querySelector('#sheetBody').textContent), { timeout: 10000 });
  ok('Transferencia de 25.50 realizada', (await text('#sheetBody .result h3')) === 'Transferencia realizada');
  await shot('06-exito');
  await clickText('#sheetBody button', 'Listo');
  const expected = fmt(initialCents - 2550n);
  await page.waitForFunction((e) => document.querySelector('[data-balance="1000000016"]').textContent.startsWith(e), { timeout: 8000 }, expected)
    .then(() => ok(`El saldo se actualiza solo: ${expected}`, true)).catch(async () => ok(`El saldo se actualiza solo: ${expected}`, false, await text('[data-balance="1000000016"]')));

  // Error de negocio real del backend: fondos insuficientes
  await clickText('.qbtn', 'Transferir');
  await page.waitForSelector('#tTo', { visible: true });
  await page.type('#tTo', '1000000032'); await page.type('#tAmount', '999999');
  await click('#sheetBody button[type=submit]');
  await clickText('#sheetBody button', 'Confirmar transferencia');
  await page.waitForFunction(() => /No se pudo/.test(document.querySelector('#sheetBody').textContent), { timeout: 10000 });
  ok('Fondos insuficientes: mensaje claro (422 del backend)', (await text('#sheetBody .result.err p')).includes('Fondos insuficientes'));
  ok('Muestra una referencia de soporte (requestId)', (await text('#sheetBody .ref')).startsWith('Referencia de soporte'));
  await shot('07-error-fondos');
  await clickText('#sheetBody button', 'Cerrar');

  // ---------- Movimientos
  await clickText('.qbtn', 'Movimientos');
  await page.waitForSelector('.mv', { visible: true });
  const mv = await page.$$eval('.mv', (m) => m.length);
  ok('Movimientos reales del ledger', mv >= 1, `filas=${mv}`);
  ok('El débito se muestra en negativo y la contraparte enmascarada', /-25\.50/.test(await text('.mv-amt b')) && (await text('.mv-main b')).includes('******0032') && !(await text('.mv-main b')).includes('1000000032'), await text('.mv-main b'));
  ok('XSS: la descripción con HTML se muestra como TEXTO, no se ejecuta', (await page.$$eval('#sheetBody img', (i) => i.length)) === 0 && (await text('.mv-main span')).includes('<img'));
  await shot('08-movimientos');
  await click('#sheetClose');

  // ---------- Estado de cuenta
  await clickText('.qbtn', 'Estado de cuenta');
  await page.waitForSelector('#sMonth', { visible: true });
  await shot('09-estado-cuenta');
  await clickText('#sheetBody button', 'Descargar estado de cuenta');
  await page.waitForFunction(() => document.querySelector('#toast') && document.querySelector('#toast').textContent.includes('Descarga iniciada'), { timeout: 8000 })
    .then(() => ok('Estado de cuenta (PDF): descarga iniciada', true)).catch(async () => ok('Estado de cuenta (PDF): descarga iniciada', false, (await text('#sheetBody')) + ' | ' + (await text('#toast'))));
  await click('#sheetClose');

  // ---------- IA
  await click('#bellBtn');
  await page.waitForSelector('.rec', { visible: true });
  ok('Notificaciones = consejos de la IA con su origen', (await page.$$eval('.rec', (r) => r.length)) > 0 && /Modelo|respaldo/.test(await text('.srcline')), await text('.srcline'));
  await shot('10-consejos');
  await click('#sheetClose');

  // ---------- Pestañas
  await clickText('.tab', 'Tarjetas');
  ok('Pestaña sin backend: estado "próxima versión" (no inventa datos)', (await text('.empty p')).includes('próxima versión') && (await text('.tab.active')) === 'Tarjetas');
  await shot('11-tarjetas');
  await clickText('.tab', 'Cuentas');
  await page.waitForSelector('.acct.card', { visible: true });

  // ---------- Salir y perfil bloqueado
  await clickText('.qbtn', 'Salir');
  ok('Salir vuelve al modal de acceso', await visible('#loginOverlay .modal'));
  await fill('#user', 'carlos');
  await click('#continueBtn');
  await page.waitForSelector('.chip.blocked', { visible: true });
  ok('Cuenta bloqueada: se ve el estado "Bloqueada"', (await text('.chip.blocked')) === 'Bloqueada');
  await clickText('.qbtn', 'Transferir');
  await sleep(300);
  ok('Con cuenta bloqueada no se abre el formulario de transferencia', !(await visible('#sheetOverlay')) && (await text('#toast')).includes('bloqueada'));

  // ---------- Pantalla ancha
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await sleep(300);
  await shot('12-escritorio');

  const fatal = problems.filter((p) => !/favicon/.test(p) && !/status of 4\d\d/.test(p)); // los 4xx los provoca la propia prueba (fondos insuficientes)
  ok('Sin errores de consola, de CSP ni de red', fatal.length === 0, fatal.slice(0, 3).join(' | '));
  console.log(`\nINTERFAZ: ${pass}/${pass + fail} comprobaciones OK`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR en la prueba:', e); process.exit(2); });
