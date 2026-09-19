"""Modelo estadístico simple y explicable, entrenado sobre las features por cuenta del ETL.

  * Perfil atípico: puntaje z robusto de cada cuenta frente a la población (qué tan distinta es su forma de gastar).
  * Segmento de gasto: terciles de gasto total (bajo / medio / alto).

Se eligió a propósito un modelo simple: es barato, se explica en una frase, se entrena en milisegundos y no requiere GPU.
El ciclo de vida completo (reentrenamiento, drift, despliegue) está descrito en el documento técnico.
"""
import csv
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

MODEL_VERSION = "zscore-seg-v1"
# Variables usadas para medir qué tan atípica es una cuenta (todas positivas -> se aplica log1p)
_FEATURES = ("avg_amount", "total_spent", "n_counterparties", "n_tx")


def load_features(paths: tuple[str, ...]) -> tuple[dict[str, dict], str | None]:
    """Lee el CSV de features. account_number se lee SIEMPRE como texto (un entero perdería ceros iniciales)."""
    for p in paths:
        path = Path(p.strip())
        if path.exists():
            with path.open(newline="", encoding="utf-8") as fh:
                rows = {r["account_number"]: _coerce(r) for r in csv.DictReader(fh)}
            return rows, str(path)
    return {}, None


def _coerce(row: dict) -> dict:
    out: dict = {}
    for k, v in row.items():
        if k in ("account_number", "top_category"):
            out[k] = v
        else:
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                out[k] = 0.0
    return out


def _mean_std(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    if n == 0:
        return 0.0, 1.0
    m = sum(xs) / n
    var = sum((x - m) ** 2 for x in xs) / n
    return m, math.sqrt(var) or 1.0


@dataclass
class Model:
    version: str = MODEL_VERSION
    trained_at: str = ""
    n_accounts: int = 0
    stats: dict = field(default_factory=dict)  # feature -> (media, desviación) de log1p
    spend_terciles: tuple[float, float] = (0.0, 0.0)

    @classmethod
    def train(cls, features: dict[str, dict]) -> "Model":
        stats = {f: _mean_std([math.log1p(r.get(f, 0.0)) for r in features.values()]) for f in _FEATURES}
        totals = sorted(r.get("total_spent", 0.0) for r in features.values())
        terciles = (totals[len(totals) // 3], totals[2 * len(totals) // 3]) if totals else (0.0, 0.0)
        return cls(trained_at=datetime.now(timezone.utc).isoformat(), n_accounts=len(features),
                   stats=stats, spend_terciles=terciles)

    def atypicality(self, row: dict) -> float:
        """Promedio de |z| de la cuenta frente a la población. ~0.8 es lo normal; > 2 es muy distinto."""
        if not self.stats or not row:
            return 0.0
        zs = []
        for f in _FEATURES:
            mean, std = self.stats[f]
            zs.append(abs((math.log1p(row.get(f, 0.0)) - mean) / std))
        return sum(zs) / len(zs)

    def segment(self, row: dict) -> str:
        total = row.get("total_spent", 0.0)
        low, high = self.spend_terciles
        return "bajo" if total <= low else "alto" if total > high else "medio"

    def describe(self) -> dict:
        return {"version": self.version, "trainedAt": self.trained_at, "accounts": self.n_accounts,
                "features": list(_FEATURES), "spendTerciles": list(self.spend_terciles),
                "stats": {k: {"mean": round(v[0], 4), "std": round(v[1], 4)} for k, v in self.stats.items()}}
