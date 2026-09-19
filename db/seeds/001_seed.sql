-- =====================================================================
-- SmartBancs - Datos de prueba (DML)
-- Los números de cuenta tienen dígito verificador válido (Luhn).
-- =====================================================================
INSERT INTO customers (id, full_name, email) VALUES
    (1, 'Ana Torres',     'ana.torres@example.com'),
    (2, 'Luis Mena',      'luis.mena@example.com'),
    (3, 'Sofía Andrade',  'sofia.andrade@example.com'),
    (4, 'Carlos Pérez',   'carlos.perez@example.com');

INSERT INTO accounts (customer_id, account_number, account_type, currency, balance, status) VALUES
    (1, '1000000016', 'SAVINGS',  'USD', 5000.00, 'ACTIVE'),
    (1, '1000000024', 'CHECKING', 'USD', 1200.00, 'ACTIVE'),
    (2, '1000000032', 'SAVINGS',  'USD', 3000.00, 'ACTIVE'),
    (3, '1000000040', 'CHECKING', 'USD',  800.00, 'ACTIVE'),
    (4, '1000000057', 'SAVINGS',  'USD',  100.00, 'BLOCKED');

SELECT setval(pg_get_serial_sequence('customers', 'id'), (SELECT max(id) FROM customers));
