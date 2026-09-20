"""Generador de transacciones "sucias" y reproducibles (semilla fija).

Simula un extracto crudo de varios sistemas: fechas y montos en formatos mezclados, nulos, duplicados,
cuentas inválidas, montos negativos y outliers. Sirve para demostrar y probar la limpieza.
"""
import argparse
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from .accounts import make_account
from .clean import RAW_COLUMNS
from .parsing import ECUADOR

CATEGORIES = ["supermercado", "transporte", "servicios", "restaurantes", "ocio", "salud", "educacion", "compras"]
CHANNELS = ["app", "web", "cajero", "sucursal"]
# Cuentas de la semilla de la base de datos + cuentas sintéticas con dígito verificador válido
SEED_ACCOUNTS = ["1000000016", "1000000024", "1000000032", "1000000040"]

# Probabilidades de cada tipo de suciedad (por fila)
RATES = {
    "null_amount": 0.02, "null_account": 0.015, "null_timestamp": 0.015, "null_category": 0.06,
    "null_channel": 0.04, "null_currency": 0.03, "invalid_account": 0.025, "dashed_account": 0.02,
    "negative_amount": 0.015, "zero_amount": 0.005, "garbage_amount": 0.005, "outlier": 0.012,
    "future_date": 0.005, "bad_currency": 0.005, "same_account": 0.005, "duplicate": 0.04,
}


def _accounts(rng: random.Random, n: int) -> list[str]:
    accounts = list(SEED_ACCOUNTS)
    while len(accounts) < n:
        acc = make_account(str(rng.randint(200_000_000, 899_999_999)))
        if acc not in accounts:
            accounts.append(acc)
    return accounts


def _fmt_amount(rng: random.Random, value: float) -> str:
    style = rng.choice(["plain", "plain", "thousands", "symbol", "comma_decimal", "european", "code", "padded"])
    plain = f"{value:.2f}"
    whole, frac = plain.split(".")
    grouped = f"{int(whole):,}"
    return {
        "plain": plain,
        "thousands": f"{grouped}.{frac}",
        "symbol": f"${plain}",
        "comma_decimal": f"{whole},{frac}",
        "european": f"{int(whole):,}".replace(",", ".") + f",{frac}",
        "code": f"USD {plain}",
        "padded": f"  {plain} ",
    }[style]


def _fmt_date(rng: random.Random, dt: datetime) -> str:
    local = dt.astimezone(ECUADOR)
    style = rng.choice(["iso_z", "iso_local", "dmy_hm", "dmy", "ymd_slash", "dmon", "epoch_s", "epoch_ms"])
    return {
        "iso_z": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "iso_local": local.strftime("%Y-%m-%d %H:%M:%S"),
        "dmy_hm": local.strftime("%d/%m/%Y %H:%M"),
        "dmy": local.strftime("%d/%m/%Y"),
        "ymd_slash": local.strftime("%Y/%m/%d %H:%M:%S"),
        "dmon": local.strftime("%d-%b-%Y %H:%M"),
        "epoch_s": str(int(dt.timestamp())),
        "epoch_ms": str(int(dt.timestamp() * 1000)),
    }[style]


def generate_dirty(n_rows: int = 2000, seed: int = 42, end: datetime | None = None, n_accounts: int = 40,
                   amount_scale: float = 1.0) -> pd.DataFrame:
    """`amount_scale` multiplica los montos: sirve para simular un cambio de comportamiento (drift) en las pruebas."""
    rng = random.Random(seed)
    end = end or datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
    accounts = _accounts(rng, n_accounts)
    # Cada cuenta tiene un perfil: nivel de gasto y categorías preferidas
    profiles = {a: (rng.uniform(8, 60), rng.sample(CATEGORIES, 3)) for a in accounts}

    base = round(n_rows / (1 + RATES["duplicate"]))
    rows = []
    for i in range(base):
        acc = rng.choice(accounts)
        cp = rng.choice([a for a in accounts if a != acc])
        level, favorite = profiles[acc]
        category = rng.choice(favorite) if rng.random() < 0.7 else rng.choice(CATEGORIES)
        amount = round(max(0.5, rng.lognormvariate(0, 0.6) * level * amount_scale), 2)
        when = end - timedelta(seconds=rng.randint(0, 90 * 86400))
        row = {
            "transaction_id": f"TX{i + 1:07d}",
            "account_number": acc,
            "counterparty_account": cp,
            "amount": _fmt_amount(rng, amount),
            "currency": rng.choice(["USD", "USD", "USD", "usd"]),
            "timestamp": _fmt_date(rng, when),
            "category": category,
            "channel": rng.choice(CHANNELS),
            "description": f"pago {category}",
        }
        r = rng.random
        if r() < RATES["null_amount"]: row["amount"] = rng.choice([None, "", "N/A"])
        if r() < RATES["null_account"]: row["account_number"] = rng.choice([None, ""])
        if r() < RATES["null_timestamp"]: row["timestamp"] = rng.choice([None, ""])
        if r() < RATES["null_category"]: row["category"] = rng.choice([None, ""])
        if r() < RATES["null_channel"]: row["channel"] = None
        if r() < RATES["null_currency"]: row["currency"] = None
        if r() < RATES["invalid_account"]:
            row[rng.choice(["account_number", "counterparty_account"])] = "".join(rng.choices("0123456789", k=10)) if rng.random() < 0.5 else "12345"
        if r() < RATES["dashed_account"] and row["account_number"]:
            a = row["account_number"]
            row["account_number"] = f"{a[:4]}-{a[4:]}"
        if r() < RATES["negative_amount"]: row["amount"] = f"-{amount:.2f}"
        if r() < RATES["zero_amount"]: row["amount"] = "0.00"
        if r() < RATES["garbage_amount"]: row["amount"] = rng.choice(["abc", "12..5.x", "--"])
        if r() < RATES["outlier"]: row["amount"] = _fmt_amount(rng, round(amount * rng.uniform(60, 250), 2))
        if r() < RATES["future_date"]: row["timestamp"] = (end + timedelta(days=400)).strftime("%Y-%m-%dT%H:%M:%SZ")
        if r() < RATES["bad_currency"]: row["currency"] = rng.choice(["XXX", "PESOS"])
        if r() < RATES["same_account"]: row["counterparty_account"] = acc
        rows.append(row)

    # Duplicados exactos (reintentos de un sistema origen), mezclados en posiciones aleatorias
    for row in rng.sample(rows, round(base * RATES["duplicate"])):
        rows.insert(rng.randint(0, len(rows)), dict(row))
    return pd.DataFrame(rows, columns=RAW_COLUMNS)


def main() -> None:
    ap = argparse.ArgumentParser(description="Genera un CSV de transacciones sucias")
    ap.add_argument("--rows", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", type=Path, default=Path("data/sample/dirty_transactions.csv"))
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    df = generate_dirty(args.rows, args.seed)
    df.to_csv(args.out, index=False, encoding="utf-8")
    print(f"{len(df)} filas sucias -> {args.out}")


if __name__ == "__main__":
    main()
