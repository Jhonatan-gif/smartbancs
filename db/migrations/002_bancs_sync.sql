-- =====================================================================
-- Estado de sincronización de cada transferencia con el core legado (Bancs)
-- El worker escribe aquí; sirve para conciliación y para observabilidad.
-- =====================================================================
CREATE TABLE IF NOT EXISTS bancs_sync (
    transaction_id  UUID        PRIMARY KEY REFERENCES transactions (id),
    status          TEXT        NOT NULL CHECK (status IN ('SYNCED', 'FAILED')),
    attempts        INT         NOT NULL DEFAULT 1,
    last_error      TEXT,
    synced_at       TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bancs_sync_status ON bancs_sync (status);
