"""Logs JSON estructurados y métricas Prometheus del ai-service."""
import json
import logging
from datetime import datetime, timezone

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

SERVICE = "ai-service"


class JsonFormatter(logging.Formatter):
    """Una línea JSON por log (lo que Loki indexa). Los campos extra van en `ctx` (p. ej. trace_id)."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "level": record.levelname.lower(),
            "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "service": SERVICE,
            "msg": record.getMessage(),
            **getattr(record, "ctx", {}),
        }
        if record.exc_info:
            entry["error"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())


# Un registro propio: create_app() puede llamarse varias veces (pruebas) sin duplicar métricas.
registry = CollectorRegistry()
_BUCKETS = (0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10)

recommendations_total = Counter(
    "ai_recommendations_total", "Recomendaciones servidas", ["cold_start"], registry=registry)
recommendations_duration = Histogram(
    "ai_recommendation_duration_seconds", "Duración de generar una recomendación (incluye retraso simulado)",
    buckets=_BUCKETS, registry=registry)
events_processed_total = Counter(
    "ai_stream_events_processed_total", "Eventos del stream aplicados al estado en vivo", registry=registry)
consumer_errors_total = Counter(
    "ai_stream_consumer_errors_total", "Errores de conexión del consumidor del stream", registry=registry)
mode_gauge = Gauge(
    "ai_admin_mode", "Modo de prueba: 0 normal, 1 slow, 2 down", registry=registry)
model_accounts = Gauge(
    "ai_model_accounts", "Cuentas con las que se entrenó el modelo", registry=registry)
