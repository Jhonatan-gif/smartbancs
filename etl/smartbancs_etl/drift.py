"""Detección de DATA DRIFT: ¿los datos de hoy se parecen a los datos con los que se entrenó el modelo?

Dos medidas estándar, sin dependencias extra:
  * PSI (Population Stability Index): compara la distribución por tramos (deciles del periodo de referencia).
      PSI < 0.10 estable · 0.10-0.25 cambio moderado (vigilar) · > 0.25 cambio importante (reentrenar/investigar)
  * KS (Kolmogorov-Smirnov, dos muestras): distancia máxima entre las dos distribuciones acumuladas. Se compara con el
    valor crítico al 5 % (1.36 * sqrt((n+m)/(n*m))); si lo supera, las distribuciones difieren de forma significativa.

Uso de demostración:  python -m smartbancs_etl.drift     (genera datos de referencia y datos "con drift" y compara)
"""
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

PSI_WARN, PSI_ALERT = 0.10, 0.25
KS_COEF_5PCT = 1.36


def psi(reference: np.ndarray, current: np.ndarray, bins: int = 10) -> float:
    """PSI con tramos por cuantiles del periodo de referencia. Se acota con un epsilon para no dividir por cero."""
    reference, current = np.asarray(reference, float), np.asarray(current, float)
    edges = np.unique(np.quantile(reference, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:  # variable casi constante: no hay distribución que comparar
        return 0.0
    edges[0], edges[-1] = -np.inf, np.inf
    eps = 1e-6
    ref_pct = np.histogram(reference, edges)[0] / len(reference) + eps
    cur_pct = np.histogram(current, edges)[0] / len(current) + eps
    return float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))


def ks_statistic(reference: np.ndarray, current: np.ndarray) -> tuple[float, float]:
    """Devuelve (estadístico KS, valor crítico al 5 %)."""
    a, b = np.sort(np.asarray(reference, float)), np.sort(np.asarray(current, float))
    grid = np.concatenate([a, b])
    cdf_a = np.searchsorted(a, grid, side="right") / len(a)
    cdf_b = np.searchsorted(b, grid, side="right") / len(b)
    critical = KS_COEF_5PCT * math.sqrt((len(a) + len(b)) / (len(a) * len(b)))
    return float(np.max(np.abs(cdf_a - cdf_b))), critical


def status_for(psi_value: float, ks_value: float, ks_critical: float) -> str:
    if psi_value > PSI_ALERT:
        return "ALERTA"
    if psi_value > PSI_WARN or ks_value > ks_critical:
        return "VIGILAR"
    return "ESTABLE"


def drift_report(reference: pd.DataFrame, current: pd.DataFrame, columns: list[str]) -> list[dict]:
    rows = []
    for c in columns:
        r, k = reference[c].dropna().astype(float).to_numpy(), current[c].dropna().astype(float).to_numpy()
        p = psi(r, k)
        ks, crit = ks_statistic(r, k)
        rows.append({"variable": c, "n_referencia": len(r), "n_actual": len(k), "psi": round(p, 4), "ks": round(ks, 4),
                     "ks_critico_5pct": round(crit, 4), "estado": status_for(p, ks, crit)})
    return rows


def should_retrain(report: list[dict]) -> bool:
    """Criterio de reentrenamiento: alguna variable en ALERTA, o 3 o más variables en VIGILAR."""
    return any(r["estado"] == "ALERTA" for r in report) or sum(r["estado"] == "VIGILAR" for r in report) >= 3


def to_markdown(title: str, report: list[dict]) -> str:
    lines = [f"### {title}", "", "| Variable | n ref. | n actual | PSI | KS | KS crítico (5 %) | Estado |", "|---|---:|---:|---:|---:|---:|---|"]
    lines += [f"| {r['variable']} | {r['n_referencia']} | {r['n_actual']} | {r['psi']} | {r['ks']} | {r['ks_critico_5pct']} | **{r['estado']}** |" for r in report]
    return "\n".join(lines)


def main() -> None:
    """Demostración reproducible: referencia (semilla 42) frente a (a) datos del mismo tipo y (b) datos con drift real."""
    from .clean import clean_transactions
    from .features import build_account_features
    from .generate import generate_dirty

    def prepare(seed: int, scale: float):
        raw = generate_dirty(n_rows=12000, seed=seed, n_accounts=300, amount_scale=scale)
        clean = clean_transactions(raw).clean
        feats = build_account_features(clean)
        # el dinero sigue siendo Decimal en el dataset limpio; para medir la distribución se usa una copia float
        return clean.assign(amount_f=clean["amount"].map(float)), feats

    ref_tx, ref_ft = prepare(seed=42, scale=1.0)
    same_tx, same_ft = prepare(seed=43, scale=1.0)   # otro lote del mismo comportamiento: NO debería haber drift
    drift_tx, drift_ft = prepare(seed=44, scale=1.8)  # el gasto sube un 80 %: SÍ debe detectarse

    tx_cols, ft_cols = ["amount_f"], ["avg_amount", "total_spent", "n_tx", "n_counterparties", "spend_trend"]
    out = {
        "mismo_comportamiento": {"transacciones": drift_report(ref_tx, same_tx, tx_cols), "features": drift_report(ref_ft, same_ft, ft_cols)},
        "con_drift_gasto_x1.8": {"transacciones": drift_report(ref_tx, drift_tx, tx_cols), "features": drift_report(ref_ft, drift_ft, ft_cols)},
    }
    md = ["# Demostración de data drift (PSI y KS)", "",
          "Referencia: 12.000 filas sucias limpias con semilla 42 (300 cuentas). Se compara con (a) otro lote del mismo comportamiento y (b) un lote donde el gasto sube un 80 %.",
          f"Umbrales: PSI < {PSI_WARN} estable · {PSI_WARN}-{PSI_ALERT} vigilar · > {PSI_ALERT} alerta. Reentrenar si alguna variable está en ALERTA o 3 o más en VIGILAR.", ""]
    for name, parts in out.items():
        md += [f"## {name}", "", to_markdown("Monto de las transacciones", parts["transacciones"]), "", to_markdown("Features por cuenta", parts["features"]), ""]
        md.append(f"**¿Reentrenar?** {'SÍ' if should_retrain(parts['transacciones'] + parts['features']) else 'NO'}\n")
    text = "\n".join(md)
    print(text)
    dest = Path("data/processed")
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "drift_demo.md").write_text(text, encoding="utf-8")
    (dest / "drift_demo.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
