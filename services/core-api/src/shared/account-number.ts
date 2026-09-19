import { randomInt } from 'node:crypto';

/** Dígito verificador Luhn para el cuerpo (9 dígitos) del número de cuenta. */
export function luhnCheckDigit(body: string): number {
  let sum = 0;
  let double = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let digit = Number(body[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** Número de cuenta = 9 dígitos + 1 dígito verificador (detecta errores de tipeo). */
export function isValidAccountNumber(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  return luhnCheckDigit(value.slice(0, 9)) === Number(value[9]);
}

export function generateAccountNumber(): string {
  const body = String(randomInt(100_000_000, 1_000_000_000)); // 9 dígitos, sin cero inicial
  return body + luhnCheckDigit(body);
}

/** Para respuestas y logs: nunca exponer el número completo de terceros. */
export function maskAccountNumber(value: string): string {
  return '******' + value.slice(-4);
}
