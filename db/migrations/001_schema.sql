CREATE TABLE customers (
    id          BIGSERIAL PRIMARY KEY,
    full_name   TEXT        NOT NULL,
    email       TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id              BIGSERIAL PRIMARY KEY,
    account_number  TEXT          NOT NULL UNIQUE CHECK (account_number ~ '^[0-9]{10}$'),
    customer_id     BIGINT        NOT NULL REFERENCES customers (id),
    account_type    TEXT          NOT NULL DEFAULT 'SAVINGS' CHECK (account_type IN ('SAVINGS', 'CHECKING')),
    currency        CHAR(3)       NOT NULL DEFAULT 'USD',
    balance         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    version         BIGINT        NOT NULL DEFAULT 0,
    status          TEXT          NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'CLOSED')),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_customer ON accounts (customer_id);

CREATE TABLE transactions (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  TEXT          NOT NULL UNIQUE,
    request_hash     TEXT          NOT NULL,
    type             TEXT          NOT NULL DEFAULT 'TRANSFER' CHECK (type IN ('TRANSFER')),
    from_account_id  BIGINT        NOT NULL REFERENCES accounts (id),
    to_account_id    BIGINT        NOT NULL REFERENCES accounts (id),
    amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    currency         CHAR(3)       NOT NULL,
    status           TEXT          NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'FAILED')),
    description      TEXT,
    trace_id         TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CHECK (from_account_id <> to_account_id)
);
CREATE INDEX idx_transactions_from    ON transactions (from_account_id, created_at DESC);
CREATE INDEX idx_transactions_to      ON transactions (to_account_id, created_at DESC);

CREATE TABLE ledger_entries (
    id              BIGSERIAL     PRIMARY KEY,
    transaction_id  UUID          NOT NULL REFERENCES transactions (id),
    account_id      BIGINT        NOT NULL REFERENCES accounts (id),
    direction       TEXT          NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount          NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    balance_after   NUMERIC(18,2) NOT NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
-- Base de los movimientos y estados de cuenta (paginación por cursor)
CREATE INDEX idx_ledger_account_id ON ledger_entries (account_id, id DESC);
CREATE INDEX idx_ledger_transaction ON ledger_entries (transaction_id);

-- El libro mayor es inmutable: los errores se corrigen con asientos nuevos.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries es append-only (% no permitido)', TG_OP;
END;
$$;
CREATE TRIGGER trg_ledger_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE outbox_events (
    id            BIGSERIAL   PRIMARY KEY,
    aggregate_id  UUID        NOT NULL,
    event_type    TEXT        NOT NULL,
    payload       JSONB       NOT NULL,
    trace_id      TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);
-- Índice parcial: el worker solo lee los eventos pendientes
CREATE INDEX idx_outbox_pending ON outbox_events (id) WHERE published_at IS NULL;
