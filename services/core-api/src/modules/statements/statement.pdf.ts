import { Statement } from './statements.service';

/**
 * Generador mínimo de PDF (sin dependencias): texto con la fuente estándar Courier (ancho fijo: las columnas quedan alineadas), A4, varias páginas.
 * Los flujos NO van comprimidos a propósito: el contenido es auditable con cualquier editor de texto.
 * Solo se admite Latin-1 (WinAnsi); cualquier otro carácter se sustituye por "?".
 */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const ROWS_PER_PAGE = 46;

const latin1 = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
const esc = (s: string) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

interface Text {
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  text: string;
}

function pageStream(items: Text[]): string {
  return items
    .map((t) => `BT /${t.bold ? 'F2' : 'F1'} ${t.size} Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET`)
    .join('\n');
}

const money = (v: string) => v.padStart(16, ' ');

export function statementToPdf(s: Statement): Buffer {
  const pages: Text[][] = [];
  const totalPages = Math.max(1, Math.ceil(s.movements.length / ROWS_PER_PAGE));

  for (let p = 0; p < totalPages; p++) {
    const items: Text[] = [];
    let y = PAGE_H - MARGIN;
    const line = (text: string, size = 9, bold = false, x = MARGIN) => {
      items.push({ x, y, size, bold, text });
      y -= size + 5;
    };

    if (p === 0) {
      line('SmartBancs - Estado de cuenta', 16, true);
      y -= 4;
      line(`Cuenta: ${s.accountNumber}      Moneda: ${s.currency}      Periodo (UTC): ${s.month}`, 10);
      line(`Titular: ${s.holder}`, 10);
      y -= 6;
      line(`Saldo inicial:  ${s.openingBalance}`, 10, true);
      line(`Total creditos: ${s.totalCredits}`, 10);
      line(`Total debitos:  ${s.totalDebits}`, 10);
      line(`Saldo final:    ${s.closingBalance}`, 10, true);
      line(`Movimientos:    ${s.movementCount}`, 10);
      y -= 8;
    } else {
      line(`SmartBancs - Estado de cuenta ${s.accountNumber} - ${s.month} (continuacion)`, 10, true);
      y -= 6;
    }

    line('Fecha (UTC)            Tipo      Contraparte    Descripcion                       Monto           Saldo', 8, true);
    const slice = s.movements.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
    for (const m of slice) {
      const date = m.date.replace('T', ' ').slice(0, 19);
      const type = (m.type === 'CREDIT' ? 'CREDITO' : 'DEBITO').padEnd(8, ' ');
      const desc = m.description.slice(0, 26).padEnd(26, ' ');
      line(`${date}   ${type}  ${m.counterparty.padEnd(12, ' ')}   ${desc}${money(m.amount)}${money(m.balanceAfter)}`, 8);
    }
    if (slice.length === 0) line('Sin movimientos en el periodo.', 9);

    items.push({ x: PAGE_W / 2 - 30, y: 22, size: 8, text: `Pagina ${p + 1} de ${totalPages}` });
    pages.push(items);
  }

  // --- Estructura del PDF: 1 catálogo, 2 árbol de páginas, 3-4 fuentes, luego (página, contenido) por cada página ---
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((items, i) => {
    const pageId = 5 + i * 2;
    const stream = pageStream(items);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(latin1(stream), 'latin1')} >>\nstream\n${latin1(stream)}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
