"""Configuración por variables de entorno (12-factor)."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    stream: str = os.getenv("STREAM", "transfers.completed")
    group: str = os.getenv("AI_GROUP", "ai-recs")  # grupo PROPIO: no compite con el worker (bancs-sync)
    consumer_name: str = os.getenv("AI_CONSUMER", "ai-service-1")
    # Candidatos en orden: salida del ETL local y muestra versionada en el repositorio.
    features_paths: tuple[str, ...] = tuple(
        os.getenv("FEATURES_CSV", "/data/processed/account_features.csv,/data/sample/account_features.csv").split(",")
    )
    enable_admin: bool = os.getenv("ENABLE_ADMIN", "true").lower() == "true"
    log_level: str = os.getenv("LOG_LEVEL", "info")
