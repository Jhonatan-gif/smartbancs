"""Motor de recomendaciones: reglas explicables + puntaje del modelo estadístico + actividad en vivo."""
from datetime import datetime, timedelta, timezone

from .live import LiveState
from .model import Model

MAX_RECOMMENDATIONS = 4
SEVERITY_ORDER = {"alert": 0, "warning": 1, "info": 2}


def _rec(rid: str, kind: str, severity: str, title: str, message: str) -> dict:
    return {"id": rid, "type": kind, "severity": severity, "title": title, "message": message}


class Engine:
    def __init__(self, features: dict[str, dict], model: Model, live: LiveState, now=None) -> None:
        self.features, self.model, self.live = features, model, live
        self._now = now or (lambda: datetime.now(timezone.utc))

    def recommend(self, account: str) -> dict:
        row = self.features.get(account)
        live = self.live.get(account)
        recs: list[dict] = []

        if row:
            recs += self._from_history(row)
        if live and live.sent:
            recs += self._from_live(row, live)
        cold_start = not row and not (live and live.sent)

        if not recs:
            recs.append(_rec("GENERAL_ALERTS", "general", "info", "Activa las alertas de movimientos",
                             "Recibe un aviso por cada transferencia para detectar a tiempo cualquier operación desconocida."))
        recs.sort(key=lambda r: SEVERITY_ORDER[r["severity"]])
        return {
            "account": account,
            "source": "model",
            "modelVersion": self.model.version,
            "coldStart": cold_start,
            "segment": self.model.segment(row) if row else None,
            "recommendations": recs[:MAX_RECOMMENDATIONS],
            "generatedAt": self._now().isoformat(),
        }

    # -- reglas sobre el historial (features del ETL) --
    def _from_history(self, r: dict) -> list[dict]:
        out: list[dict] = []
        trend, prev = r.get("spend_trend", 1.0), r.get("spend_prev_30d", 0.0)
        if prev > 0 and trend >= 1.3:
            out.append(_rec("SPEND_UP", "spending", "warning", "Tu gasto va en aumento",
                            f"Gastaste {round((trend - 1) * 100)} % más en los últimos 30 días que en los 30 anteriores. "
                            "Revisa tus gastos recientes y fija un límite mensual."))
        elif prev > 0 and trend <= 0.7:
            out.append(_rec("SPEND_DOWN", "saving", "info", "Estás gastando menos",
                            f"Tu gasto bajó {round((1 - trend) * 100)} % frente al periodo anterior. "
                            "Buen momento para mover esa diferencia a una cuenta de ahorro."))

        shares = {k[len("share_"):]: v for k, v in r.items() if k.startswith("share_") and k != "share_sin_categoria"}
        if shares:
            cat, share = max(shares.items(), key=lambda kv: kv[1])
            if share >= 0.4:
                out.append(_rec("CATEGORY_CONCENTRATION", "budget", "info", f"Mucho gasto en {cat}",
                                f"El {round(share * 100)} % de tu gasto va a {cat}. Define un presupuesto para esa categoría."))

        if r.get("n_outliers", 0) > 0:
            out.append(_rec("PAST_OUTLIERS", "security", "warning", "Movimientos poco habituales",
                            f"Detectamos {int(r['n_outliers'])} movimiento(s) muy por encima de tu gasto normal. "
                            "Si no los reconoces, bloquea tu cuenta y contáctanos."))

        if r.get("days_since_last_tx", 0) > 45:
            out.append(_rec("INACTIVE", "engagement", "info", "Tu cuenta está poco activa",
                            "Llevas más de 45 días sin movimientos. Configura una transferencia programada para no perder rendimiento."))

        score = self.model.atypicality(r)
        if score >= 2.0:
            out.append(_rec("ATYPICAL_PROFILE", "security", "warning", "Tu patrón de gasto es distinto al habitual",
                            "Tu forma de gastar se aleja bastante de la de clientes similares. Revisa tus últimos movimientos."))
        return out

    # -- reglas sobre la actividad reciente (stream) --
    def _from_live(self, r: dict | None, live) -> list[dict]:
        out: list[dict] = []
        last_when, last_amount = live.sent[-1]
        if r and r.get("avg_amount", 0) > 0:
            std = max(r.get("std_amount", 0.0), 0.1 * r["avg_amount"])
            z = (last_amount - r["avg_amount"]) / std
            if z >= 3 or last_amount > 3 * max(r.get("max_amount", 0.0), 1.0):
                out.append(_rec("UNUSUAL_TRANSFER", "security", "alert", "Transferencia inusual",
                                f"Tu última transferencia (${last_amount:,.2f}) es mucho mayor a tu promedio "
                                f"(${r['avg_amount']:,.2f}). Si no la reconoces, contáctanos de inmediato."))
        recent = [a for (t, a) in live.sent if t >= self._now() - timedelta(hours=1)]
        if len(recent) >= 5:
            out.append(_rec("HIGH_ACTIVITY", "security", "warning", "Mucha actividad en la última hora",
                            f"Hiciste {len(recent)} transferencias en la última hora por ${sum(recent):,.2f}. "
                            "Confirma que fuiste tú."))
        return out
