import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool } from '../src/infra/db';
import { statementToCsv, csvField } from '../src/modules/statements/statement.csv';
import { buildApp } from '../src/server';
import { generateAccountNumber } from '../src/shared/account-number';

const app = buildApp();
let A = { id: '', number: '' };
let B = { id: '', number: '' };

const cents = (v: string) => BigInt(v.replace('.', '')); // 2 decimales exactos
const monthNow = new Date().toISOString().slice(0, 7);

/** Inserta un movimiento en el pasado dentro de una transacción coherente: transacción + 2 asientos + saldos (el ledger no se puede UPDATE). */
async function addMovement(from: typeof A, to: typeof B, amount: string, at: string, description = 'historico') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const tx = await c.query(
      `INSERT INTO transactions (idempotency_key, request_hash, from_account_id, to_account_id, amount, currency, description, created_at)
       VALUES ($1, 'x', $2, $3, $4::numeric, 'USD', $5, $6) RETURNING id`,
      [randomUUID(), from.id, to.id, amount, description, at],
    );
    const d = await c.query(`UPDATE accounts SET balance = balance - $1::numeric WHERE id = $2 RETURNING balance::text AS b`, [amount, from.id]);
    const cr = await c.query(`UPDATE accounts SET balance = balance + $1::numeric WHERE id = $2 RETURNING balance::text AS b`, [amount, to.id]);
    await c.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, balance_after, created_at) VALUES
         ($1, $2, 'DEBIT',  $3::numeric, $4::numeric, $7), ($1, $5, 'CREDIT', $3::numeric, $6::numeric, $7)`,
      [tx.rows[0].id, from.id, amount, d.rows[0].b, to.id, cr.rows[0].b, at],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function newAccount(balance: string) {
  const customer = await pool.query(`INSERT INTO customers (full_name, email) VALUES ('Titular de prueba, "S.A."', $1) RETURNING id`, [
    `st-${randomUUID()}@example.com`,
  ]);
  const number = generateAccountNumber();
  const { rows } = await pool.query(
    `INSERT INTO accounts (customer_id, account_number, balance) VALUES ($1, $2, $3::numeric) RETURNING id`,
    [customer.rows[0].id, number, balance],
  );
  return { id: rows[0].id as string, number };
}

beforeAll(async () => {
  await app.ready();
  A = await newAccount('1000.00');
  B = await newAccount('1000.00');
  // Historial en 2020 (fechas fijas: no dependen de "hoy"). Saldo inicial de ambas: 1000.00 SIN asiento (cuenta que nació con saldo).
  await addMovement(A, B, '100.00', '2020-07-05T10:00:00Z');
  await addMovement(B, A, '30.50', '2020-07-20T10:00:00Z');
  await addMovement(A, B, '200.00', '2020-08-01T00:00:00.000Z'); // primer instante de agosto: entra en agosto
  await addMovement(B, A, '50.25', '2020-08-15T12:00:00Z');
  await addMovement(A, B, '10.00', '2020-08-31T23:59:59.999Z'); // último instante de agosto: entra en agosto
  await addMovement(A, B, '5.00', '2020-09-01T00:00:00.000Z'); // primer instante de septiembre: NO entra en agosto
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = (acc: string, qs: string) => app.inject({ method: 'GET', url: `/v1/accounts/${acc}/statements?${qs}` });

/** Lee el resumen del CSV (líneas "Etiqueta,valor") y las filas de detalle. */
function parseCsv(body: string) {
  const lines = body.replace(/^﻿/, '').split('\r\n').filter((l) => l !== '');
  const summary: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length && !lines[i].startsWith('Fecha (UTC)'); i++) {
    const [k, ...v] = lines[i].split(',');
    summary[k] = v.join(',');
  }
  return { summary, rows: lines.slice(i + 1) };
}

describe('Estado de cuenta: saldo inicial, créditos, débitos y saldo final', () => {
  it('agosto: incluye los instantes de borde correctos (inicio inclusivo, fin exclusivo)', async () => {
    const res = await get(A.number, 'month=2020-08&format=csv');
    expect(res.statusCode).toBe(200);
    const { summary, rows } = parseCsv(res.body);
    expect(summary['Saldo inicial']).toBe('930.50'); // 1000 - 100 + 30.50
    expect(summary['Total creditos']).toBe('50.25');
    expect(summary['Total debitos']).toBe('210.00'); // 200 + 10 (el de septiembre 5.00 NO entra)
    expect(summary['Saldo final']).toBe('770.75');
    expect(summary['Movimientos']).toBe('3');
    expect(rows).toHaveLength(3);
  });

  it('julio (mes con saldo inicial sin asiento) y septiembre', async () => {
    const jul = parseCsv((await get(A.number, 'month=2020-07&format=csv')).body).summary;
    expect(jul).toMatchObject({ 'Saldo inicial': '1000.00', 'Total creditos': '30.50', 'Total debitos': '100.00', 'Saldo final': '930.50' });
    const sep = parseCsv((await get(A.number, 'month=2020-09&format=csv')).body).summary;
    expect(sep).toMatchObject({ 'Saldo inicial': '770.75', 'Total creditos': '0.00', 'Total debitos': '5.00', 'Saldo final': '765.75' });
  });

  it('INVARIANTE: saldo inicial + créditos - débitos = saldo final, y cada mes empieza donde terminó el anterior', async () => {
    const months = ['2020-06', '2020-07', '2020-08', '2020-09', '2020-10'];
    let previousClosing: bigint | null = null;
    for (const m of months) {
      const s = parseCsv((await get(A.number, `month=${m}&format=csv`)).body).summary;
      const opening = cents(s['Saldo inicial']);
      expect(opening + cents(s['Total creditos']) - cents(s['Total debitos'])).toBe(cents(s['Saldo final']));
      if (previousClosing !== null) expect(opening).toBe(previousClosing); // continuidad entre meses
      previousClosing = cents(s['Saldo final']);
    }
  });

  it('cuadra con el LEDGER: el saldo final de un mes = balance_after del último asiento de ese mes (calculado por SQL independiente)', async () => {
    const { rows } = await pool.query(
      `SELECT balance_after::text AS b,
              (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='CREDIT'),0)::text FROM ledger_entries WHERE account_id=$1 AND created_at >= '2020-08-01' AND created_at < '2020-09-01') AS credits,
              (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DEBIT'),0)::text FROM ledger_entries WHERE account_id=$1 AND created_at >= '2020-08-01' AND created_at < '2020-09-01') AS debits
         FROM ledger_entries WHERE account_id=$1 AND created_at < '2020-09-01' ORDER BY id DESC LIMIT 1`,
      [A.id],
    );
    const s = parseCsv((await get(A.number, 'month=2020-08&format=csv')).body).summary;
    expect(s['Saldo final']).toBe(rows[0].b);
    expect(s['Total creditos']).toBe(rows[0].credits);
    expect(s['Total debitos']).toBe(rows[0].debits);
  });

  it('mes sin movimientos: saldo inicial = final y totales en cero; mes futuro: el saldo actual', async () => {
    const empty = parseCsv((await get(A.number, 'month=2020-06&format=csv')).body).summary;
    expect(empty).toMatchObject({ 'Saldo inicial': '1000.00', 'Saldo final': '1000.00', 'Total creditos': '0.00', 'Total debitos': '0.00', Movimientos: '0' });
    const now = await pool.query(`SELECT balance::text AS b FROM accounts WHERE id = $1`, [A.id]);
    const future = parseCsv((await get(A.number, 'month=2099-01&format=csv')).body).summary;
    expect(future['Saldo inicial']).toBe(now.rows[0].b);
    expect(future['Saldo final']).toBe(now.rows[0].b);
  });

  it('el detalle es coherente: cada fila trae monto y saldo posterior, y la contraparte va enmascarada', async () => {
    const { rows } = parseCsv((await get(A.number, 'month=2020-08&format=csv')).body);
    const cols = rows.map((r) => r.split(','));
    expect(cols.map((c) => c[1])).toEqual(['DEBITO', 'CREDITO', 'DEBITO']);
    expect(cols.map((c) => c[4])).toEqual(['200.00', '50.25', '10.00']);
    expect(cols.map((c) => c[5])).toEqual(['730.50', '780.75', '770.75']);
    expect(cols[0][2]).toBe(`******${B.number.slice(-4)}`);
    expect(rows.join('\n')).not.toContain(B.number); // nunca el número completo de terceros
  });
});

describe('Formatos y cabeceras', () => {
  it('CSV: text/csv UTF-8 con BOM, descarga y nombre con cuenta enmascarada, sin caché', async () => {
    const res = await get(A.number, 'month=2020-08');
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(`xxxxxx${A.number.slice(-4)}-2020-08.csv`);
    expect(res.headers['content-disposition']).not.toContain(A.number);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
  });

  it('CSV: escapa comas y comillas del titular (RFC 4180)', async () => {
    const line = parseCsv((await get(A.number, 'month=2020-08')).body);
    expect(line.summary['Titular']).toBe('"Titular de prueba, ""S.A."""');
  });

  it('CSV: neutraliza inyección de fórmulas en la descripción', async () => {
    expect(csvField('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvField('+1234')).toBe("'+1234");
    expect(csvField('@cmd')).toBe("'@cmd");
    expect(csvField('normal')).toBe('normal');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': randomUUID() },
      payload: { fromAccount: A.number, toAccount: B.number, amount: '1.00', description: '=1+1' },
    });
    expect(res.statusCode).toBe(201);
    const csv = (await get(A.number, `month=${monthNow}`)).body;
    expect(csv).toContain("'=1+1");
    expect(csv).not.toMatch(/,=1\+1/);
  });

  it('PDF: documento válido (cabecera, xref coherente, %%EOF) con los totales en texto legible', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/accounts/${A.number}/statements?month=2020-08&format=pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const pdf = res.rawPayload;
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref'); // el desplazamiento del xref apunta de verdad a "xref"
    for (const [id, offset] of [...text.matchAll(/(\d{10}) 00000 n /g)].map((m, i) => [i + 1, Number(m[1])])) {
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`); // cada objeto está donde dice la tabla
    }
    expect(text).toContain('Saldo inicial:  930.50');
    expect(text).toContain('Saldo final:    770.75');
    expect(text).toContain('Total debitos:  210.00');
    expect(text).toContain('Pagina 1 de 1');
  });

  it('PDF y CSV de muchos movimientos: varias páginas y todas las filas', async () => {
    for (let i = 0; i < 100; i++) await addMovement(B, A, '1.00', `2020-10-${String((i % 28) + 1).padStart(2, '0')}T08:00:00Z`);
    const pdf = (await app.inject({ method: 'GET', url: `/v1/accounts/${A.number}/statements?month=2020-10&format=pdf` })).rawPayload.toString('latin1');
    expect(pdf).toContain('/Count 3'); // 100 filas a 46 por página
    expect(pdf).toContain('Pagina 3 de 3');
    const csv = parseCsv((await get(A.number, 'month=2020-10&format=csv')).body);
    expect(csv.rows).toHaveLength(100);
    expect(csv.summary['Total creditos']).toBe('100.00');
  });
});

describe('Validaciones y límites', () => {
  it('400 con mes ausente o inválido, formato desconocido o número de cuenta mal formado', async () => {
    expect((await get(A.number, '')).statusCode).toBe(400);
    expect((await get(A.number, 'month=2020-13')).statusCode).toBe(400);
    expect((await get(A.number, 'month=2020-8')).statusCode).toBe(400);
    expect((await get(A.number, 'month=2020-08&format=xls')).statusCode).toBe(400);
    expect((await get('123', 'month=2020-08')).statusCode).toBe(400);
  });

  it('404 si la cuenta no existe', async () => {
    expect((await get(generateAccountNumber(), 'month=2020-08')).statusCode).toBe(404);
  });

  it('422 STATEMENT_TOO_LARGE si el periodo supera el tope de movimientos', async () => {
    const before = config.statementMaxRows;
    config.statementMaxRows = 5;
    const res = await get(A.number, 'month=2020-10');
    config.statementMaxRows = before;
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('STATEMENT_TOO_LARGE');
  });

  it('el generador de CSV es puro y usa CRLF (compatible con Excel)', () => {
    const csv = statementToCsv({
      accountNumber: '******0016', holder: 'Ana', currency: 'USD', month: '2020-08', periodStart: '', periodEnd: '',
      openingBalance: '1.00', totalCredits: '0.00', totalDebits: '0.00', closingBalance: '1.00', movementCount: 0, movements: [], generatedAt: 'x',
    });
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')[0]).toBe('﻿Estado de cuenta,SmartBancs');
  });
});
