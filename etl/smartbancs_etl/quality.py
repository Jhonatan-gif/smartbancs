"""Reporte de calidad de datos (JSON para máquinas y Markdown para humanos)."""
import json
from pathlib import Path

from .clean import CleanResult


def build_report(result: CleanResult, n_accounts_with_features: int) -> dict:
    s = result.stats
    rows_in, rows_out, rows_rej = s["rows_in"], s["rows_out"], s["rows_rejected"]
    return {
        "rows_in": rows_in,
        "rows_out": rows_out,
        "rows_rejected": rows_rej,
        "balanced": rows_in == rows_out + rows_rej,  # ninguna fila se pierde en silencio
        "acceptance_rate_pct": round(100 * rows_out / rows_in, 2) if rows_in else 0.0,
        "rejected_by_reason": s["rejected_by_reason"],
        "nulls_before_cleaning": s["nulls_before"],
        "imputed_values": s["imputed"],
        "accounts_normalized": s["accounts_normalized"],
        "amounts_rounded_to_2_decimals": s["amounts_rounded"],
        "date_formats_detected": s["date_formats"],
        "outliers_flagged_not_removed": s["outliers_flagged"],
        "accounts_with_features": n_accounts_with_features,
    }


def _table(title: str, header: tuple[str, str], data: dict) -> list[str]:
    return ["", f"## {title}", "", f"| {header[0]} | {header[1]} |", "|---|---:|"] + [f"| {k} | {v} |" for k, v in data.items()]


def write_report(report: dict, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "quality_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    lines = [
        "# Reporte de calidad de datos", "",
        f"- Filas entrantes: **{report['rows_in']}**",
        f"- Filas limpias: **{report['rows_out']}** ({report['acceptance_rate_pct']} %)",
        f"- Filas rechazadas: **{report['rows_rejected']}**",
        f"- Cuadre entrantes = salientes + rechazadas: **{'OK' if report['balanced'] else 'ERROR'}**",
        f"- Outliers marcados (no eliminados): {report['outliers_flagged_not_removed']}",
        f"- Cuentas normalizadas (guiones/espacios): {report['accounts_normalized']}",
        f"- Montos redondeados a 2 decimales: {report['amounts_rounded_to_2_decimals']}",
        f"- Cuentas con features: {report['accounts_with_features']}",
    ]
    lines += _table("Rechazos por motivo", ("Motivo", "Filas"), report["rejected_by_reason"])
    lines += _table("Nulos en la entrada", ("Columna", "Nulos"), report["nulls_before_cleaning"])
    lines += _table("Valores imputados", ("Regla", "Filas"), report["imputed_values"])
    lines += _table("Formatos de fecha detectados", ("Formato", "Filas"), report["date_formats_detected"])
    (out_dir / "quality_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
