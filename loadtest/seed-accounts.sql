-- Cuentas para la prueba de carga (saldo inicial 1.000.000.000). Idempotente: se puede ejecutar varias veces sin reiniciar saldos.
-- Números de cuenta deterministas: '5' + 8 dígitos (i con ceros a la izquierda) + dígito Luhn.
-- k6 calcula los mismos números (loadtest/lib.js), así que no necesita consultar la base.
CREATE OR REPLACE FUNCTION pg_temp.luhn_digit(body text) RETURNS int AS $$
DECLARE
    total int := 0; dbl boolean := true; d int; i int;
BEGIN
    FOR i IN REVERSE length(body)..1 LOOP
        d := substr(body, i, 1)::int;
        IF dbl THEN d := d * 2; IF d > 9 THEN d := d - 9; END IF; END IF;
        total := total + d; dbl := NOT dbl;
    END LOOP;
    RETURN (10 - (total % 10)) % 10;
END $$ LANGUAGE plpgsql IMMUTABLE;

INSERT INTO customers (full_name, email)
VALUES ('Cliente de carga', 'carga@example.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO accounts (customer_id, account_number, account_type, currency, balance, status)
SELECT (SELECT id FROM customers WHERE email = 'carga@example.com'),
       b || pg_temp.luhn_digit(b)::text,
       'CHECKING', 'USD', 1000000000.00, 'ACTIVE'
  FROM (SELECT '5' || lpad(g::text, 8, '0') AS b FROM generate_series(1, 1000) g) s
-- Si la cuenta ya existe NO se toca su saldo: reiniciarlo rompería la coherencia con el ledger.
ON CONFLICT (account_number) DO NOTHING;

SELECT count(*) AS cuentas_de_carga FROM accounts WHERE account_number LIKE '5_________' AND customer_id =
       (SELECT id FROM customers WHERE email = 'carga@example.com');
