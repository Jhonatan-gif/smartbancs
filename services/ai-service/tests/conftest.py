import os
from pathlib import Path

# Antes de importar la app: en local se usa la muestra de features versionada en el repositorio;
# dentro de Docker se usa la ruta por defecto (/data montado desde ./etl/data).
_parents = Path(__file__).resolve().parents
if len(_parents) > 3:
    sample = _parents[3] / "etl" / "data" / "sample" / "account_features.csv"
    if sample.exists():
        os.environ.setdefault("FEATURES_CSV", str(sample))
os.environ.setdefault("LOG_LEVEL", "warning")
