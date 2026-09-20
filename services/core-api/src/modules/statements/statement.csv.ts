import { Statement } from './statements.service';

/**
 * Escapa un campo CSV (RFC 4180) y neutraliza la "inyección de fórmulas": si el texto empieza por = + - @ (o tab / retorno),
 * Excel y similares lo ejecutarían como fórmula; se antepone un apóstrofo para que se muestre como texto.
 * Los montos NO se pasan por aquí (son números legítimos, p. ej. "-5.00" no aparece porque se guardan positivos).
 */
export function csvField(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const row = (...cols: string[]) => cols.map(csvField).join(',');

/** CSV en UTF-8 con BOM (Excel lo abre con los acentos bien). Resumen arriba, una línea en blanco y el detalle. */
export function statementToCsv(s: Statement): string {
  const lines: string[] = [
    row('Estado de cuenta', 'SmartBancs'),
    row('Cuenta', s.accountNumber),
    row('Titular', s.holder),
    row('Periodo (UTC)', s.month),
    row('Moneda', s.currency),
    row('Saldo inicial', s.openingBalance),
    row('Total creditos', s.totalCredits),
    row('Total debitos', s.totalDebits),
    row('Saldo final', s.closingBalance),
    row('Movimientos', String(s.movementCount)),
    row('Generado (UTC)', s.generatedAt),
    '',
    row('Fecha (UTC)', 'Tipo', 'Contraparte', 'Descripcion', 'Monto', 'Saldo despues'),
    ...s.movements.map((m) => row(m.date, m.type === 'CREDIT' ? 'CREDITO' : 'DEBITO', m.counterparty, m.description, m.amount, m.balanceAfter)),
  ];
  return '﻿' + lines.join('\r\n') + '\r\n';
}
