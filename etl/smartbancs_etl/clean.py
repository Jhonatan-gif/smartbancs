"""Limpieza de transacciones crudas.

Regla de oro: NINGUNA fila desaparece en silencio. Cada fila de entrada termina en `clean` o en
`rejected` con un motivo, así entrantes = salientes + rechazadas (se verifica en el reporte).
"""
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .accounts import is_valid_account
from .parsing import parse_amount, parse_timestamp, quantize_money

RAW_COLUMNS = ["transaction_id", "account_number", "counterparty_account", "amount", "currency",
               "timestamp", "category", "channel", "description"]
ALLOWED_CURRENCIES = {"USD", "EUR"}
CLEAN_COLUMNS = ["transaction_id", "account_number", "counterparty_account", "amount", "currency",
                 "occurred_at", "date", "category", "channel", "is_outlier"]

# Motivos de rechazo (se cuentan en el reporte de calidad)
MISSING_ID, DUPLICATE = "ID_FALTANTE", "DUPLICADO"
MISSING_ACCOUNT, INVALID_ACCOUNT = "CUENTA_FALTANTE", "CUENTA_INVALIDA"
MISSING_COUNTERPARTY, INVALID_COUNTERPARTY = "CONTRAPARTE_FALTANTE", "CONTRAPARTE_INVALIDA"
SAME_ACCOUNT = "MISMA_CUENTA"
MISSING_AMOUNT, UNPARSEABLE_AMOUNT, NON_POSITIVE_AMOUNT = "MONTO_FALTANTE", "MONTO_ILEGIBLE", "MONTO_NO_POSITIVO"
MISSING_TS, UNPARSEABLE_TS, FUTURE_TS = "FECHA_FALTANTE", "FECHA_ILEGIBLE", "FECHA_FUTURA"
INVALID_CURRENCY = "MONEDA_INVALIDA"


@dataclass
class CleanResult:
    clean: pd.DataFrame
    rejected: pd.DataFrame
    stats: dict = field(default_factory=dict)


def _blank_to_none(value):
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    s = str(value).strip()
    return s if s else None


def _digits(value: str | None) -> str | None:
    """Quita guiones y espacios de un número de cuenta ("1000-000016" -> "1000000016")."""
    return re.sub(r"[\s\-]", "", value) if value else value


def flag_outliers(df: pd.DataFrame, threshold: float = 3.5) -> pd.Series:
    """Outlier por categoría con z-score robusto (mediana y MAD sobre log(monto)).

    Se MARCA, no se elimina: un monto grande puede ser legítimo y el modelo decide qué hacer.
    """
    flags = pd.Series(False, index=df.index)
    logs = np.log(df["amount"].map(float))
    for _, idx in df.groupby("category").groups.items():
        x = logs.loc[idx]
        if len(x) < 8:
            continue
        med = x.median()
        mad = (x - med).abs().median()
        if mad == 0:
            continue
        flags.loc[idx] = (0.6745 * (x - med).abs() / mad) > threshold
    return flags


def clean_transactions(raw: pd.DataFrame, as_of: datetime | None = None) -> CleanResult:
    as_of = as_of or datetime.now(timezone.utc)
    stats: dict = {
        "rows_in": int(len(raw)),
        "nulls_before": {c: int(raw[c].map(_blank_to_none).isna().sum()) for c in RAW_COLUMNS if c in raw},
        "date_formats": Counter(),
        "accounts_normalized": 0,
        "amounts_rounded": 0,
        "imputed": Counter(),
    }
    seen: set[str] = set()
    good: list[dict] = []
    bad: list[dict] = []

    def reject(row: dict, reason: str):
        bad.append({**row, "motivo_rechazo": reason})

    for rec in raw.to_dict("records"):
        row = {c: _blank_to_none(rec.get(c)) for c in RAW_COLUMNS}

        if row["transaction_id"] is None:
            reject(row, MISSING_ID)
            continue
        if row["transaction_id"] in seen:
            reject(row, DUPLICATE)
            continue
        seen.add(row["transaction_id"])

        acc, cp = _digits(row["account_number"]), _digits(row["counterparty_account"])
        if acc is None:
            reject(row, MISSING_ACCOUNT)
            continue
        if cp is None:
            reject(row, MISSING_COUNTERPARTY)
            continue
        if acc != row["account_number"] or cp != row["counterparty_account"]:
            stats["accounts_normalized"] += 1
        if not is_valid_account(acc):
            reject(row, INVALID_ACCOUNT)
            continue
        if not is_valid_account(cp):
            reject(row, INVALID_COUNTERPARTY)
            continue
        if acc == cp:
            reject(row, SAME_ACCOUNT)
            continue

        if row["amount"] is None:
            reject(row, MISSING_AMOUNT)
            continue
        amount = parse_amount(row["amount"])
        if amount is None:
            reject(row, UNPARSEABLE_AMOUNT)
            continue
        if amount <= 0:
            reject(row, NON_POSITIVE_AMOUNT)
            continue
        rounded = quantize_money(amount)
        if rounded != amount:
            stats["amounts_rounded"] += 1
        if rounded <= 0:
            reject(row, NON_POSITIVE_AMOUNT)
            continue

        if row["timestamp"] is None:
            reject(row, MISSING_TS)
            continue
        ts, fmt = parse_timestamp(row["timestamp"])
        if ts is None:
            reject(row, UNPARSEABLE_TS)
            continue
        if ts > as_of:
            reject(row, FUTURE_TS)
            continue
        stats["date_formats"][fmt] += 1

        currency = (row["currency"] or "").upper()
        if not currency:
            currency = "USD"
            stats["imputed"]["currency=USD"] += 1
        if currency not in ALLOWED_CURRENCIES:
            reject(row, INVALID_CURRENCY)
            continue

        category = (row["category"] or "").lower()
        if not category:
            category = "sin_categoria"
            stats["imputed"]["category=sin_categoria"] += 1
        channel = (row["channel"] or "").lower()
        if not channel:
            channel = "desconocido"
            stats["imputed"]["channel=desconocido"] += 1

        good.append({
            "transaction_id": row["transaction_id"], "account_number": acc, "counterparty_account": cp,
            "amount": rounded, "currency": currency, "occurred_at": ts, "date": ts.date().isoformat(),
            "category": category, "channel": channel,
        })

    clean = pd.DataFrame(good, columns=CLEAN_COLUMNS[:-1])
    if len(clean):
        clean["is_outlier"] = flag_outliers(clean)
        clean["occurred_at"] = pd.to_datetime(clean["occurred_at"], utc=True)
        clean = clean.sort_values("occurred_at").reset_index(drop=True)
    else:
        clean["is_outlier"] = pd.Series(dtype=bool)
    rejected = pd.DataFrame(bad, columns=RAW_COLUMNS + ["motivo_rechazo"])

    stats["rows_out"] = int(len(clean))
    stats["rows_rejected"] = int(len(rejected))
    stats["rejected_by_reason"] = dict(Counter(rejected["motivo_rechazo"]).most_common())
    stats["outliers_flagged"] = int(clean["is_outlier"].sum()) if len(clean) else 0
    stats["date_formats"] = dict(stats["date_formats"])
    stats["imputed"] = dict(stats["imputed"])
    return CleanResult(clean, rejected, stats)
