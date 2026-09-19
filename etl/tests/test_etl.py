from datetime import datetime, timezone
from decimal import Decimal

import pandas as pd
import pyarrow.parquet as pq
import pytest

from smartbancs_etl.accounts import is_valid_account, make_account
from smartbancs_etl.clean import RAW_COLUMNS, clean_transactions
from smartbancs_etl.features import build_account_features
from smartbancs_etl.generate import generate_dirty
from smartbancs_etl.parsing import parse_amount, parse_timestamp
from smartbancs_etl.pipeline import run

AS_OF = datetime(2026, 9, 19, tzinfo=timezone.utc)
A, B = "1000000016", "1000000032"  # cuentas de la semilla, con dígito verificador válido


def row(**over):
    base = {"transaction_id": "T1", "account_number": A, "counterparty_account": B, "amount": "10.00",
            "currency": "USD", "timestamp": "2026-09-01T10:00:00Z", "category": "ocio", "channel": "app",
            "description": "x"}
    base.update(over)
    return base


def clean(*rows):
    return clean_transactions(pd.DataFrame(list(rows), columns=RAW_COLUMNS), as_of=AS_OF)


# --- Montos: siempre Decimal, nunca float ---
@pytest.mark.parametrize("raw,expected", [
    ("1234.50", "1234.50"), ("1,234.50", "1234.50"), ("$12.30", "12.30"), ("USD 45.00", "45.00"),
    ("  7.5 ", "7.5"), ("12,50", "12.50"), ("1.234,50", "1234.50"), ("1,234", "1234"),
    ("1.234.567,89", "1234567.89"), ("-5.00", "-5.00"),
])
def test_parse_amount_formatos(raw, expected):
    value = parse_amount(raw)
    assert isinstance(value, Decimal)
    assert value == Decimal(expected)


@pytest.mark.parametrize("raw", [None, "", "abc", "--", "N/A"])
def test_parse_amount_ilegible(raw):
    assert parse_amount(raw) is None


def test_el_dinero_no_pasa_por_float():
    # 0.1 + 0.2 != 0.3 en float; en Decimal sí
    assert parse_amount("0.10") + parse_amount("0.20") == Decimal("0.30")


# --- Fechas ---
@pytest.mark.parametrize("raw,utc_iso", [
    ("2026-09-01T10:00:00Z", "2026-09-01T10:00:00"),
    ("2026-09-01 05:00:00", "2026-09-01T10:00:00"),   # sin zona: hora de Ecuador (UTC-5)
    ("01/09/2026 05:00", "2026-09-01T10:00:00"),
    ("2026/09/01 05:00:00", "2026-09-01T10:00:00"),
    ("01-Sep-2026 05:00", "2026-09-01T10:00:00"),
    ("1788256800", "2026-09-01T10:00:00"),
    ("1788256800000", "2026-09-01T10:00:00"),
])
def test_parse_timestamp_formatos(raw, utc_iso):
    dt, _ = parse_timestamp(raw)
    assert dt.strftime("%Y-%m-%dT%H:%M:%S") == utc_iso


def test_parse_timestamp_ilegible():
    assert parse_timestamp("ayer por la tarde") == (None, None)
    assert parse_timestamp(None) == (None, None)


# --- Cuentas ---
def test_cuentas_luhn():
    assert is_valid_account(A) and is_valid_account(make_account("123456789"))
    assert not is_valid_account("1000000017") and not is_valid_account("12345")


# --- Reglas de limpieza: cada fila cae en clean o rejected con motivo ---
@pytest.mark.parametrize("over,reason", [
    ({"transaction_id": None}, "ID_FALTANTE"),
    ({"account_number": None}, "CUENTA_FALTANTE"),
    ({"counterparty_account": ""}, "CONTRAPARTE_FALTANTE"),
    ({"account_number": "1000000017"}, "CUENTA_INVALIDA"),
    ({"counterparty_account": "999"}, "CONTRAPARTE_INVALIDA"),
    ({"counterparty_account": A}, "MISMA_CUENTA"),
    ({"amount": None}, "MONTO_FALTANTE"),
    ({"amount": "abc"}, "MONTO_ILEGIBLE"),
    ({"amount": "-3.00"}, "MONTO_NO_POSITIVO"),
    ({"amount": "0.00"}, "MONTO_NO_POSITIVO"),
    ({"timestamp": None}, "FECHA_FALTANTE"),
    ({"timestamp": "nunca"}, "FECHA_ILEGIBLE"),
    ({"timestamp": "2030-01-01T00:00:00Z"}, "FECHA_FUTURA"),
    ({"currency": "XXX"}, "MONEDA_INVALIDA"),
])
def test_cada_regla_rechaza_con_su_motivo(over, reason):
    res = clean(row(**over))
    assert len(res.clean) == 0
    assert res.rejected["motivo_rechazo"].tolist() == [reason]


def test_duplicados_se_rechazan_y_se_conserva_el_primero():
    res = clean(row(), row(), row(transaction_id="T2"))
    assert res.clean["transaction_id"].tolist() == ["T1", "T2"]
    assert res.stats["rejected_by_reason"] == {"DUPLICADO": 1}


def test_estandariza_formatos_e_imputa_nulos():
    res = clean(row(currency="usd", category=None, channel="", account_number="1000-000016", amount="$1,234.567"))
    r = res.clean.iloc[0]
    assert r["currency"] == "USD"
    assert r["category"] == "sin_categoria" and r["channel"] == "desconocido"
    assert r["account_number"] == A
    assert r["amount"] == Decimal("1234.57")  # 1234.567 -> 2 decimales
    assert res.stats["accounts_normalized"] == 1 and res.stats["amounts_rounded"] == 1
    assert res.stats["imputed"] == {"category=sin_categoria": 1, "channel=desconocido": 1}


def test_moneda_nula_se_imputa_como_usd():
    assert clean(row(currency=None)).clean.iloc[0]["currency"] == "USD"


def test_outliers_se_marcan_no_se_eliminan():
    rows = [row(transaction_id=f"T{i}", amount=f"{10 + (i % 5)}.00") for i in range(30)]
    rows.append(row(transaction_id="GRANDE", amount="9000.00"))
    res = clean(*rows)
    assert len(res.clean) == 31  # el outlier sigue en el dataset
    flagged = res.clean[res.clean["is_outlier"]]["transaction_id"].tolist()
    assert flagged == ["GRANDE"]


# --- Features ---
def test_features_por_cuenta():
    rows = [
        row(transaction_id="T1", amount="100.00", category="ocio", timestamp="2026-09-10T00:00:00Z"),
        row(transaction_id="T2", amount="50.00", category="salud", timestamp="2026-09-15T00:00:00Z"),
        row(transaction_id="T3", amount="30.00", category="ocio", timestamp="2026-07-25T00:00:00Z"),
    ]
    feats = build_account_features(clean(*rows).clean).set_index("account_number").loc[A]
    assert feats["n_tx"] == 3
    assert feats["total_spent"] == pytest.approx(180.0)
    assert feats["tx_last_30d"] == 2 and feats["spend_last_30d"] == pytest.approx(150.0)
    assert feats["spend_prev_30d"] == pytest.approx(30.0)
    assert feats["spend_trend"] == pytest.approx(5.0)
    assert feats["top_category"] == "ocio"
    assert feats["share_ocio"] + feats["share_salud"] == pytest.approx(1.0)


# --- Generador y pipeline completo ---
def test_generador_es_reproducible():
    assert generate_dirty(300, seed=7).equals(generate_dirty(300, seed=7))
    assert not generate_dirty(300, seed=7).equals(generate_dirty(300, seed=8))


def test_pipeline_completo_cuadra_y_escribe_salidas(tmp_path):
    report = run(tmp_path / "sucio.csv", tmp_path / "out", rows=500, seed=1)
    assert report["balanced"] is True
    assert report["rows_in"] == 500
    assert report["rows_in"] == report["rows_out"] + report["rows_rejected"]
    assert report["rows_rejected"] > 0 and report["outliers_flagged_not_removed"] >= 0
    for name in ["transactions_clean.parquet", "account_features.parquet", "account_features.csv",
                 "rejected_rows.csv", "quality_report.json", "quality_report.md"]:
        assert (tmp_path / "out" / name).exists(), name
    schema = pq.read_table(tmp_path / "out" / "transactions_clean.parquet").schema
    assert str(schema.field("amount").type) == "decimal128(18, 2)"  # dinero nunca float
    # Segunda pasada con el CSV ya escrito: mismo resultado (idempotente)
    assert run(tmp_path / "sucio.csv", tmp_path / "out2")["rows_out"] == report["rows_out"]
