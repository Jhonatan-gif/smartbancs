/* SmartBancs: interfaz web móvil.
 *
 * Solo usa lo que el backend REALMENTE ofrece: cuentas, transferencias, movimientos, estados de cuenta y recomendaciones.
 * Sin dependencias ni paso de compilación. Todo texto que viene de la API se inserta con textContent (nunca innerHTML),
 * y el dinero se maneja siempre como texto decimal (nunca como float), igual que la API.
 */
(() => {
  'use strict';

  const API = '/api'; // nginx (servicio "web") reenvía /api/* a core-api

  // El MVP no tiene autenticación ni endpoint para listar las cuentas de un cliente: los perfiles de prueba
  // están en el cliente y coinciden con db/seeds/001_seed.sql.
  const USERS = {
    ana: { name: 'Ana', full: 'Ana Torres', accounts: ['1000000016', '1000000024'] },
    luis: { name: 'Luis', full: 'Luis Mena', accounts: ['1000000032'] },
    sofia: { name: 'Sofía', full: 'Sofía Andrade', accounts: ['1000000040'] },
    carlos: { name: 'Carlos', full: 'Carlos Pérez', accounts: ['1000000057'] },
  };

  const S = { user: null, accounts: [], active: 0, hidden: store('sb.hidden') === '1', recs: null, tab: 'cuentas' };

  // ------------------------------------------------------------------ utilidades
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* almacenamiento bloqueado: se ignora */ }
    return null;
  }
  const session = {
    get: () => { try { return sessionStorage.getItem('sb.user'); } catch { return null; } },
    set: (v) => { try { v ? sessionStorage.setItem('sb.user', v) : sessionStorage.removeItem('sb.user'); } catch { /* */ } },
  };

  const $ = (id) => document.getElementById(id);

  /** Crea elementos de forma segura. `html` solo se usa con constantes internas (iconos). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const PATHS = {
    bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
    eyeoff: 'M17.9 17.9A10.7 10.7 0 0112 20C5 20 1 12 1 12a18.5 18.5 0 015.1-5.9M9.9 4.2A9.1 9.1 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.2 3.2M14.1 14.1a3 3 0 11-4.2-4.2M1 1l22 22',
    send: 'M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    doc: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h5',
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
    copy: 'M9 9h11v11H9zM5 15V4h11',
    logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
    close: 'M6 6l12 12M18 6L6 18',
    info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M19 12l-7 7-7-7',
    check: 'M20 6L9 17l-5-5',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
    card: 'M2 6h20v12H2zM2 10h20',
    coins: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    chart: 'M3 3v18h18M7 14l4-4 3 3 5-6',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  };
  function icon(name, size = 22) {
    return h('span', {
      class: 'ico',
      'aria-hidden': 'true',
      html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`,
    });
  }

  /** "5000.5" -> "5,000.50". Trabaja sobre el texto: el dinero nunca pasa por float. */
  function fmtMoney(s) {
    if (s == null || s === '') return '—';
    const neg = String(s).startsWith('-');
    const [int, dec = ''] = String(s).replace('-', '').split('.');
    return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (dec + '00').slice(0, 2);
  }
  const last4 = (n) => String(n).slice(-4);
  const maskNum = (n) => '••••••' + last4(n);
  const typeLabel = (t) => (t === 'CHECKING' ? 'Cuenta corriente' : t === 'SAVINGS' ? 'Cuenta ahorros' : 'Cuenta');
  const shortId = (id) => (id ? String(id).slice(0, 8) : '');

  /** Dígito verificador Luhn: mismo algoritmo que el backend (9 dígitos + verificador). */
  function luhnOk(n) {
    if (!/^\d{10}$/.test(n)) return false;
    let sum = 0;
    let dbl = true;
    for (let i = 8; i >= 0; i--) {
      let d = Number(n[i]);
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      dbl = !dbl;
    }
    return (10 - (sum % 10)) % 10 === Number(n[9]);
  }
  const AMOUNT_RE = /^(?!0+(\.0{1,2})?$)[0-9]{1,16}(\.[0-9]{1,2})?$/;

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3400);
  }

  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetch(API + path, opts); } catch { return { status: 0, body: null, res: null }; }
    let data = null;
    try { data = await res.json(); } catch { /* respuesta sin cuerpo JSON */ }
    return { status: res.status, body: data, res };
  }

  const ERRORS = {
    INSUFFICIENT_FUNDS: 'Fondos insuficientes en la cuenta de origen.',
    ACCOUNT_NOT_ACTIVE: 'Una de las cuentas no está activa (bloqueada o cerrada).',
    ACCOUNT_NOT_FOUND: 'La cuenta no existe.',
    INVALID_ACCOUNT_NUMBER: 'El número de cuenta no es válido.',
    SAME_ACCOUNT: 'La cuenta de origen y la de destino deben ser distintas.',
    IDEMPOTENCY_KEY_REUSED: 'Esta operación ya se registró con otros datos. Inicie una nueva.',
    CURRENCY_MISMATCH: 'Las cuentas tienen monedas distintas.',
    VALIDATION_ERROR: 'Revise los datos ingresados.',
    STATEMENT_TOO_LARGE: 'El período tiene demasiados movimientos para un estado de cuenta.',
  };
  function friendlyError({ status, body }) {
    const code = body && body.error && body.error.code;
    if (status === 0) return 'No hay conexión con el servidor. Puede reintentar: la operación no se duplicará.';
    if (code && ERRORS[code]) return ERRORS[code];
    if (status === 503 || status === 409) return 'El sistema tiene alta demanda en este momento. Puede reintentar: no se cobrará dos veces.';
    return 'No se pudo completar la operación. Intente de nuevo.';
  }
  const refOf = (r) => (r.body && r.body.error && r.body.error.requestId ? `Referencia de soporte: ${shortId(r.body.error.requestId)}` : '');

  // ------------------------------------------------------------------ hojas (bottom sheets)
  let lastFocus = null;
  function openSheet(title, ...content) {
    lastFocus = document.activeElement;
    $('sheetTitle').textContent = title;
    $('sheetBody').replaceChildren(...content);
    $('sheetOverlay').hidden = false;
    $('sheetClose').focus();
  }
  function closeSheet() {
    $('sheetOverlay').hidden = true;
    $('sheetBody').replaceChildren();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  const setSheetBody = (...content) => $('sheetBody').replaceChildren(...content);

  // ------------------------------------------------------------------ acceso (modo demostración)
  function greeting() {
    const hr = new Date().getHours();
    return hr < 12 ? 'Buenos días,' : hr < 19 ? 'Buenas tardes,' : 'Buenas noches,';
  }

  function initLogin() {
    const input = $('user');
    const btn = $('continueBtn');
    const err = $('userError');
    const remembered = store('sb.remember');
    if (remembered) { input.value = remembered; $('remember').checked = true; btn.disabled = false; }

    input.addEventListener('input', () => {
      btn.disabled = input.value.trim() === '';
      input.classList.remove('invalid');
      err.hidden = true;
    });
    $('loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const key = input.value.trim().toLowerCase();
      if (!USERS[key]) {
        input.classList.add('invalid');
        err.textContent = 'Usuario no encontrado. Pruebe con: ana, luis, sofia o carlos.';
        err.hidden = false;
        return;
      }
      store('sb.remember', $('remember').checked ? key : null);
      enter(key);
    });
    $('virtualKeyBtn').addEventListener('click', () => toast('Clave virtual: no disponible en este MVP (no hay autenticación).'));
    $('inviteBtn').addEventListener('click', () => toast('Invitaciones: no disponible en este MVP.'));
    $('loginOverlay').hidden = false;
    input.focus();
  }

  function enter(key) {
    S.user = USERS[key];
    S.userKey = key;
    session.set(key);
    $('loginOverlay').hidden = true;
    $('greeting').textContent = greeting();
    $('userName').textContent = S.user.name;
    $('bellBtn').hidden = false;
    S.tab = 'cuentas';
    setTab('cuentas');
  }

  function logout() {
    session.set(null);
    S.user = null; S.accounts = []; S.recs = null; S.active = 0;
    closeSheet();
    $('bellBtn').hidden = true;
    $('greeting').textContent = 'Bienvenido,';
    $('userName').textContent = 'SmartBancs';
    $('main').replaceChildren();
    $('user').value = store('sb.remember') || '';
    $('continueBtn').disabled = $('user').value === '';
    $('loginOverlay').hidden = false;
    $('user').focus();
  }

  // ------------------------------------------------------------------ pestañas
  function setTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!S.user) return;
    if (tab === 'cuentas') return loadAccounts();
    const info = {
      tarjetas: ['card', 'Tarjetas'],
      creditos: ['coins', 'Créditos'],
      inversiones: ['chart', 'Inversiones'],
    }[tab];
    $('main').replaceChildren(
      h('div', { class: 'card empty' },
        h('div', { class: 'eicon' }, icon(info[0], 30)),
        h('h2', { text: info[1] }),
        h('p', { text: 'Este módulo llegará en una próxima versión. El MVP cubre cuentas, transferencias, movimientos, estados de cuenta y recomendaciones.' })),
    );
  }

  // ------------------------------------------------------------------ cuentas (panel principal)
  async function loadAccounts() {
    $('main').replaceChildren(
      h('div', { class: 'carousel' }, h('div', { class: 'acct skeleton', style: null, 'aria-label': 'Cargando cuentas' })),
      h('div', { class: 'loading', text: 'Cargando sus cuentas…' }),
    );
    const results = await Promise.all(S.user.accounts.map((n) => api(`/v1/accounts/${n}`)));
    const failed = results.find((r) => r.status !== 200);
    if (failed) {
      $('main').replaceChildren(
        h('div', { class: 'errorbox' },
          h('b', { text: 'No pudimos cargar sus cuentas.' }),
          h('div', { text: friendlyError(failed) }),
          h('button', { class: 'btn primary small', type: 'button', text: 'Reintentar', onclick: loadAccounts })),
      );
      return;
    }
    S.accounts = results.map((r) => r.body);
    S.active = Math.min(S.active, S.accounts.length - 1);
    renderDashboard();
    loadRecs();
  }

  function accountCard(a) {
    const blocked = a.status !== 'ACTIVE';
    return h('article', { class: 'acct card', 'aria-label': `${typeLabel(a.accountType)} terminada en ${last4(a.accountNumber)}` },
      h('div', { class: 'acct-top' },
        h('div', {},
          h('div', { class: 'acct-type', text: typeLabel(a.accountType) }),
          h('div', { class: 'acct-num', text: `N.º ${maskNum(a.accountNumber)}` })),
        h('span', { class: 'chip' + (blocked ? ' blocked' : ''), text: blocked ? 'Bloqueada' : 'Activa' })),
      h('div', { class: 'acct-label', text: 'Saldo disponible' }),
      h('div', { class: 'balance-row' },
        h('div', { class: 'balance', 'data-balance': a.accountNumber }, balanceText(a)),
        h('button', {
          class: 'eye', type: 'button', 'aria-label': S.hidden ? 'Mostrar saldo' : 'Ocultar saldo', 'aria-pressed': S.hidden ? 'true' : 'false',
          onclick: toggleBalance,
        }, icon(S.hidden ? 'eyeoff' : 'eye'))),
      h('div', { class: 'holder' }, 'Titular: ', h('b', { text: a.holder })),
    );
  }
  function balanceText(a) {
    return S.hidden
      ? [document.createTextNode('••••••'), h('small', { text: a.currency })]
      : [document.createTextNode(fmtMoney(a.balance)), h('small', { text: a.currency })];
  }
  function toggleBalance() {
    S.hidden = !S.hidden;
    store('sb.hidden', S.hidden ? '1' : '0');
    document.querySelectorAll('.eye').forEach((b) => {
      b.replaceChildren(icon(S.hidden ? 'eyeoff' : 'eye'));
      b.setAttribute('aria-label', S.hidden ? 'Mostrar saldo' : 'Ocultar saldo');
      b.setAttribute('aria-pressed', S.hidden ? 'true' : 'false');
    });
    S.accounts.forEach((a) => {
      const el = document.querySelector(`[data-balance="${a.accountNumber}"]`);
      if (el) el.replaceChildren(...balanceText(a));
    });
  }

  function renderDashboard() {
    const carousel = h('div', { class: 'carousel', id: 'carousel', role: 'group', 'aria-label': 'Sus cuentas' }, S.accounts.map(accountCard));
    const dots = h('div', { class: 'dots', id: 'dots', 'aria-hidden': 'true' }, S.accounts.map((_, i) => h('i', { class: i === S.active ? 'on' : '' })));
    const quick = h('div', { class: 'quick' },
      qbtn('send', 'Transferir', openTransfer, true),
      qbtn('list', 'Movimientos', openMovements),
      qbtn('doc', 'Estado de cuenta', openStatement),
      qbtn('spark', 'Consejos IA', openRecs),
      qbtn('copy', 'Copiar n.º de cuenta', copyAccount),
      qbtn('logout', 'Salir', logout),
    );
    $('main').replaceChildren(
      carousel, dots,
      h('h2', { class: 'section-title', text: 'Accesos rápidos' }), quick,
      h('h2', { class: 'section-title', text: 'Novedades para ti' }), h('div', { class: 'news', id: 'news' }, newsSkeleton()),
    );
    if (S.active > 0) carousel.scrollLeft = S.active * carousel.clientWidth;
    let t;
    carousel.addEventListener('scroll', () => {
      const i = Math.round(carousel.scrollLeft / (carousel.firstElementChild.getBoundingClientRect().width + 12));
      if (i !== S.active && i >= 0 && i < S.accounts.length) {
        S.active = i;
        dots.querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === i));
        clearTimeout(t);
        t = setTimeout(loadRecs, 250);
      }
    }, { passive: true });
  }
  const qbtn = (ic, label, fn, gold) =>
    h('button', { class: 'qbtn' + (gold ? ' gold' : ''), type: 'button', onclick: fn }, h('span', { class: 'qicon' }, icon(ic)), label);
  const newsSkeleton = () => [h('div', { class: 'banner skeleton' })];
  const active = () => S.accounts[S.active];

  async function copyAccount() {
    const n = active().accountNumber;
    try { await navigator.clipboard.writeText(n); toast('Número de cuenta copiado.'); }
    catch { toast(`Número de cuenta: ${n}`); }
  }

  // ------------------------------------------------------------------ recomendaciones (IA con respaldo)
  async function loadRecs() {
    if (!S.accounts.length) return;
    const number = active().accountNumber;
    const r = await api(`/v1/accounts/${number}/recommendations`);
    if (!active() || active().accountNumber !== number) return; // el usuario ya cambió de cuenta
    S.recs = r.status === 200 ? r.body : null;
    renderNews();
    const urgent = S.recs ? S.recs.recommendations.filter((x) => x.severity !== 'info').length : 0;
    $('bellBadge').textContent = String(urgent);
    $('bellBadge').hidden = urgent === 0;
  }
  function sourceText(recs) {
    if (!recs) return '';
    return recs.source === 'model'
      ? `Modelo ${recs.modelVersion}${recs.coldStart ? ' · cuenta sin historial' : ''}`
      : 'Sugerencias generales (respaldo)';
  }
  function renderNews() {
    const box = $('news');
    if (!box) return;
    if (!S.recs) { box.replaceChildren(h('div', { class: 'card empty' }, h('p', { text: 'Las recomendaciones no están disponibles por ahora.' }))); return; }
    box.replaceChildren(...S.recs.recommendations.map((r) =>
      h('article', { class: `banner ${r.severity}` },
        h('div', { class: 'bicon' }, icon(r.severity === 'info' ? 'spark' : r.severity === 'alert' ? 'shield' : 'alert', 28)),
        h('h3', { text: r.title }),
        h('p', { text: r.message }),
        h('div', { class: 'src', text: S.recs.source === 'model' ? 'IA · modelo' : 'Respaldo' }))));
  }
  function openRecs() {
    if (!S.recs) { toast('Las recomendaciones no están disponibles por ahora.'); return; }
    openSheet('Consejos para su cuenta',
      ...S.recs.recommendations.map((r) => h('div', { class: 'rec' },
        h('span', { class: `tag ${r.severity}`, text: r.severity === 'alert' ? 'Importante' : r.severity === 'warning' ? 'Atención' : 'Consejo' }),
        h('b', { text: r.title }), h('p', { text: r.message }))),
      h('div', { class: 'srcline', text: sourceText(S.recs) }));
  }

  // ------------------------------------------------------------------ transferir
  let pending = null; // { sig, key }: misma intención => misma Idempotency-Key (un reintento nunca duplica)

  function openTransfer() {
    const usable = S.accounts.filter((a) => a.status === 'ACTIVE');
    if (!usable.length) { toast('Su cuenta está bloqueada: no puede realizar transferencias.'); return; }
    const from = h('select', { class: 'select', id: 'tFrom', 'aria-label': 'Cuenta de origen' },
      S.accounts.map((a, i) => h('option', { value: a.accountNumber, selected: i === S.active && a.status === 'ACTIVE', disabled: a.status !== 'ACTIVE',
        text: `${typeLabel(a.accountType)} ${maskNum(a.accountNumber)} — ${S.hidden ? '••••' : fmtMoney(a.balance)} ${a.currency}${a.status !== 'ACTIVE' ? ' (bloqueada)' : ''}` })));
    const to = h('input', { class: 'input', id: 'tTo', inputmode: 'numeric', maxlength: '10', placeholder: '10 dígitos', autocomplete: 'off', 'aria-label': 'Cuenta de destino' });
    const amount = h('input', { class: 'input', id: 'tAmount', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', 'aria-label': 'Monto' });
    const desc = h('input', { class: 'input', id: 'tDesc', maxlength: '140', placeholder: 'Opcional', autocomplete: 'off', 'aria-label': 'Descripción' });
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const next = h('button', { class: 'btn primary', type: 'submit', text: 'Continuar' });

    const form = h('form', { novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const d = { from: from.value, to: to.value.trim(), amount: amount.value.trim().replace(',', '.'), desc: desc.value.trim() };
      const problem = validateTransfer(d);
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      err.hidden = true;
      confirmTransfer(d);
    } },
    h('label', { class: 'field-label', for: 'tFrom', text: 'Desde' }), from,
    h('label', { class: 'field-label', for: 'tTo', text: 'Cuenta de destino' }), to,
    h('label', { class: 'field-label', for: 'tAmount', text: 'Monto' }), amount,
    h('p', { class: 'hint', text: 'Use punto para los decimales (máximo 2).' }),
    h('label', { class: 'field-label', for: 'tDesc', text: 'Descripción' }), desc,
    err, h('div', { style: null, class: 'spacer' }), next);
    openSheet('Transferir', form);
    to.focus();
  }
  function validateTransfer(d) {
    if (!luhnOk(d.to)) return 'El número de cuenta de destino no es válido (10 dígitos con dígito verificador).';
    if (d.to === d.from) return 'La cuenta de destino debe ser distinta a la de origen.';
    if (!AMOUNT_RE.test(d.amount)) return 'Ingrese un monto mayor a cero, con hasta 2 decimales.';
    return '';
  }

  function confirmTransfer(d) {
    const acc = S.accounts.find((a) => a.accountNumber === d.from);
    const go = h('button', { class: 'btn primary', type: 'button', text: 'Confirmar transferencia', onclick: () => submitTransfer(d, acc, go) });
    setSheetBody(
      h('p', { class: 'hint', text: 'Revise los datos antes de confirmar.' }),
      h('div', { class: 'kv' },
        kv('Desde', `${typeLabel(acc.accountType)} ${maskNum(acc.accountNumber)}`),
        kv('Para', `Cuenta ${maskNum(d.to)}`),
        kv('Monto', `${fmtMoney(d.amount)} ${acc.currency}`),
        d.desc ? kv('Descripción', d.desc) : null),
      go,
      h('button', { class: 'btn ghost', type: 'button', text: 'Volver', onclick: openTransfer }),
    );
    go.focus();
  }
  const kv = (k, v) => h('div', {}, h('span', { text: k }), h('b', { text: v }));

  async function submitTransfer(d, acc, btn) {
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spinner' }), 'Procesando…');
    const sig = [d.from, d.to, d.amount, d.desc].join('|');
    if (!pending || pending.sig !== sig) pending = { sig, key: crypto.randomUUID() };
    const r = await api('/v1/transfers', {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.key },
      body: { fromAccount: d.from, toAccount: d.to, amount: d.amount, ...(d.desc ? { description: d.desc } : {}) },
    });
    if (r.status === 201 || r.status === 200) {
      pending = null;
      const replayed = r.status === 200 && r.body && r.body.replayed;
      setSheetBody(
        h('div', { class: 'result' },
          h('div', { class: 'ricon' }, icon('check', 34)),
          h('h3', { text: replayed ? 'Esta operación ya estaba registrada' : 'Transferencia realizada' }),
          h('p', { text: replayed ? 'No se cobró dos veces: la misma solicitud se reconoció como repetida.' : `Se enviaron ${fmtMoney(d.amount)} ${acc.currency} a la cuenta ${maskNum(d.to)}.` })),
        h('div', { class: 'kv' }, kv('Estado', r.body.status === 'COMPLETED' ? 'Completada' : r.body.status), kv('Comprobante', shortId(r.body.transactionId))),
        h('button', { class: 'btn primary', type: 'button', text: 'Listo', onclick: closeSheet }),
      );
      refreshAfterTransfer();
      return;
    }
    // Error: se conserva la misma clave para que "Reintentar" no pueda duplicar la operación
    setSheetBody(
      h('div', { class: 'result err' },
        h('div', { class: 'ricon' }, icon('alert', 34)),
        h('h3', { text: 'No se pudo transferir' }),
        h('p', { text: friendlyError(r) }),
        h('p', { class: 'ref', text: refOf(r) })),
      h('button', { class: 'btn primary', type: 'button', text: 'Reintentar', onclick: () => confirmTransfer(d) }),
      h('button', { class: 'btn ghost', type: 'button', text: 'Cerrar', onclick: closeSheet }),
    );
  }
  async function refreshAfterTransfer() {
    const results = await Promise.all(S.user.accounts.map((n) => api(`/v1/accounts/${n}`)));
    if (results.every((r) => r.status === 200)) {
      S.accounts = results.map((r) => r.body);
      S.accounts.forEach((a) => {
        const el = document.querySelector(`[data-balance="${a.accountNumber}"]`);
        if (el) el.replaceChildren(...balanceText(a));
      });
    }
    loadRecs();
  }

  // ------------------------------------------------------------------ movimientos
  async function openMovements() {
    const a = active();
    const list = h('div', {});
    const more = h('button', { class: 'btn ghost', type: 'button', text: 'Cargar más', hidden: true });
    openSheet(`Movimientos ${maskNum(a.accountNumber)}`, h('div', { class: 'loading', text: 'Cargando movimientos…' }));
    let cursor = null;
    let first = true;
    const load = async () => {
      more.disabled = true;
      const r = await api(`/v1/accounts/${a.accountNumber}/movements?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      if (r.status !== 200) {
        setSheetBody(h('div', { class: 'errorbox' }, h('b', { text: 'No se pudieron cargar los movimientos.' }), h('div', { text: friendlyError(r) })));
        return;
      }
      if (first) {
        first = false;
        setSheetBody(list, more);
        if (!r.body.items.length) list.append(h('div', { class: 'loading', text: 'Todavía no hay movimientos en esta cuenta.' }));
      }
      r.body.items.forEach((m) => list.append(movementRow(m, a.currency)));
      cursor = r.body.nextCursor;
      more.hidden = !cursor;
      more.disabled = false;
    };
    more.addEventListener('click', load);
    load();
  }
  function movementRow(m, cur) {
    const out = m.type === 'DEBIT';
    const when = new Date(m.createdAt).toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return h('div', { class: 'mv' },
      h('div', { class: 'mv-ico' + (out ? '' : ' in') }, icon(out ? 'up' : 'down', 20)),
      h('div', { class: 'mv-main' }, h('b', { text: (out ? 'Enviado a ' : 'Recibido de ') + m.counterparty }), h('span', { text: `${m.description || 'Transferencia'} · ${when}` })),
      h('div', { class: 'mv-amt' }, h('b', { class: out ? '' : 'in', text: `${out ? '-' : '+'}${fmtMoney(m.amount)} ${cur}` }), h('span', { text: `Saldo ${S.hidden ? '••••' : fmtMoney(m.balanceAfter)}` })));
  }

  // ------------------------------------------------------------------ estado de cuenta
  function openStatement() {
    const a = active();
    const now = new Date();
    const month = h('input', { class: 'input', type: 'month', id: 'sMonth', value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, 'aria-label': 'Mes' });
    const fmt = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Formato' },
      h('label', {}, h('input', { type: 'radio', name: 'fmt', value: 'pdf', checked: true }), h('span', { text: 'PDF' })),
      h('label', {}, h('input', { type: 'radio', name: 'fmt', value: 'csv' }), h('span', { text: 'CSV (Excel)' })));
    const msg = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Descargar estado de cuenta' });
    const form = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month.value)) { msg.textContent = 'Elija un mes válido.'; msg.hidden = false; return; }
      msg.hidden = true;
      const format = form.querySelector('input[name=fmt]:checked').value;
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spinner' }), 'Generando…');
      const res = await fetch(`${API}/v1/accounts/${a.accountNumber}/statements?month=${month.value}&format=${format}`).catch(() => null);
      btn.disabled = false;
      btn.textContent = 'Descargar estado de cuenta';
      if (!res || !res.ok) {
        const body = res ? await res.json().catch(() => null) : null;
        msg.textContent = friendlyError({ status: res ? res.status : 0, body });
        msg.hidden = false;
        return;
      }
      const blob = await res.blob();
      const link = h('a', { href: URL.createObjectURL(blob), download: `estado-cuenta-${last4(a.accountNumber)}-${month.value}.${format}` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      toast('Descarga iniciada.');
    } },
    h('p', { class: 'hint', text: `Cuenta ${maskNum(a.accountNumber)}. El período se calcula en hora UTC.` }),
    h('label', { class: 'field-label', for: 'sMonth', text: 'Mes' }), month,
    h('div', { class: 'field-label', text: 'Formato' }), fmt,
    msg, h('div', { class: 'spacer' }), btn);
    openSheet('Estado de cuenta', form);
  }

  // ------------------------------------------------------------------ estado del servicio
  async function checkHealth() {
    const r = await api('/health');
    const up = r.status === 200;
    $('healthDot').className = 'dot ' + (up ? 'up' : 'down');
    $('healthText').textContent = up ? 'Servicio en línea' : 'Sin conexión con el servicio';
  }

  // ------------------------------------------------------------------ arranque
  function init() {
    $('bellIcon').replaceChildren(icon('bell', 24));
    $('sheetClose').replaceChildren(icon('close', 20));
    $('infoIcon').replaceChildren(icon('info', 18));
    $('sheetClose').addEventListener('click', closeSheet);
    $('sheetOverlay').addEventListener('click', (e) => { if (e.target === $('sheetOverlay')) closeSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheetOverlay').hidden) closeSheet(); });
    $('bellBtn').addEventListener('click', openRecs);
    $('tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) setTab(t.dataset.tab); });
    $('tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = [...document.querySelectorAll('.tab')];
      const i = tabs.findIndex((t) => t.dataset.tab === S.tab) + (e.key === 'ArrowRight' ? 1 : -1);
      const next = tabs[(i + tabs.length) % tabs.length];
      next.focus();
      setTab(next.dataset.tab);
    });
    initLogin();
    checkHealth();
    setInterval(checkHealth, 15000);

    // Atajo de demostración para grabar o probar: ?u=ana entra directamente con ese perfil
    const wanted = new URLSearchParams(location.search).get('u') || session.get();
    if (wanted && USERS[wanted.toLowerCase()]) enter(wanted.toLowerCase());
  }
  init();
})();
