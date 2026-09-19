"""Orquestación del ETL:  CSV sucio -> limpieza -> Parquet -> features por cuenta -> reporte de calidad.

Uso:  python -m smartbancs_etl.pipeline --input data/sample/dirty_transactions.csv --out data/processed
"""
import argparse
import json
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .clean import clean_transactions
from .features import build_account_features
from .generate import generate_dirty
from .quality import build_report, write_report


def run(input_csv: Path | None, out_dir: Path, rows: int = 2000, seed: int = 42) -> dict:
    if input_csv is None or not input_csv.exists():
        raw = generate_dirty(rows, seed)  # sin archivo de entrada: se genera uno reproducible
        if input_csv is not None:
            input_csv.parent.mkdir(parents=True, exist_ok=True)
            raw.to_csv(input_csv, index=False, encoding="utf-8")
    else:
        # dtype=str: nada se interpreta antes de tiempo (los montos "1,234.50" no deben volverse float)
        raw = pd.read_csv(input_csv, dtype=str, keep_default_na=False)

    result = clean_transactions(raw)
    features = build_account_features(result.clean)

    out_dir.mkdir(parents=True, exist_ok=True)
    # Parquet columnar (compacto y rápido de leer por columna); amount se guarda como DECIMAL, no float
    table = pa.Table.from_pandas(result.clean, preserve_index=False)
    idx = table.schema.get_field_index("amount")
    table = table.set_column(idx, pa.field("amount", pa.decimal128(18, 2)), table.column("amount").cast(pa.decimal128(18, 2)))
    pq.write_table(table, out_dir / "transactions_clean.parquet")
    features.to_parquet(out_dir / "account_features.parquet", index=False)
    features.to_csv(out_dir / "account_features.csv", index=False)  # el ai-service lo consume sin pyarrow
    result.rejected.to_csv(out_dir / "rejected_rows.csv", index=False, encoding="utf-8")

    report = build_report(result, len(features))
    write_report(report, out_dir)
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="ETL de transacciones de SmartBancs")
    ap.add_argument("--input", type=Path, default=Path("data/sample/dirty_transactions.csv"))
    ap.add_argument("--out", type=Path, default=Path("data/processed"))
    ap.add_argument("--rows", type=int, default=2000, help="filas a generar si --input no existe")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    report = run(args.input, args.out, args.rows, args.seed)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if not report["balanced"]:
        raise SystemExit("ERROR: entrantes != salientes + rechazadas")


if __name__ == "__main__":
    main()
