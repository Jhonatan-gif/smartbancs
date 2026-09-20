// Utilidades compartidas por los escenarios de k6.

// Dígito verificador Luhn (mismo algoritmo que core-api y db/seeds).
export function luhnDigit(body) {
  let total = 0;
  let dbl = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = Number(body[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
    dbl = !dbl;
  }
  return (10 - (total % 10)) % 10;
}

// Cuenta i-ésima de la prueba de carga (1..1000): '5' + i con 8 dígitos + Luhn. Igual que loadtest/seed-accounts.sql.
export function account(i) {
  const body = '5' + String(i).padStart(8, '0');
  return body + luhnDigit(body);
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Monto decimal como string con 2 decimales (nunca float en la API): "1.00" .. "20.99"
export function randomAmount() {
  return `${randInt(1, 20)}.${String(randInt(0, 99)).padStart(2, '0')}`;
}

export function uuid() {
  return 'k6-xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
