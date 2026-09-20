import numpy as np
import pandas as pd

from smartbancs_etl.drift import drift_report, ks_statistic, psi, should_retrain, status_for
from smartbancs_etl.generate import generate_dirty


def sample(seed, mean=0.0, n=5000):
    return np.random.default_rng(seed).lognormal(mean, 0.6, n)


def test_psi_es_casi_cero_con_la_misma_distribucion():
    assert psi(sample(1), sample(2)) < 0.05


def test_psi_detecta_un_cambio_grande():
    assert psi(sample(1), sample(2, mean=0.6)) > 0.25  # el gasto sube ~80 %


def test_psi_no_falla_con_variable_constante():
    assert psi(np.ones(100), np.ones(100)) == 0.0


def test_ks_distingue_distribuciones():
    same, crit = ks_statistic(sample(1), sample(2))
    diff, _ = ks_statistic(sample(1), sample(2, mean=0.6))
    assert same < crit          # no significativo
    assert diff > crit and diff > same


def test_ks_de_muestras_identicas_es_cero():
    x = sample(3, n=200)
    assert ks_statistic(x, x)[0] == 0.0


def test_estados_y_criterio_de_reentrenamiento():
    assert status_for(0.05, 0.01, 0.05) == "ESTABLE"
    assert status_for(0.15, 0.01, 0.05) == "VIGILAR"
    assert status_for(0.05, 0.10, 0.05) == "VIGILAR"   # KS significativo aunque PSI sea bajo
    assert status_for(0.40, 0.01, 0.05) == "ALERTA"
    stable = [{"estado": "ESTABLE"}] * 3
    assert should_retrain(stable) is False
    assert should_retrain(stable + [{"estado": "ALERTA"}]) is True
    assert should_retrain([{"estado": "VIGILAR"}] * 3) is True
    assert should_retrain([{"estado": "VIGILAR"}] * 2) is False


def test_drift_report_sobre_dataframes():
    ref = pd.DataFrame({"x": sample(1), "y": sample(2)})
    cur = pd.DataFrame({"x": sample(3), "y": sample(4, mean=0.7)})
    rep = {r["variable"]: r for r in drift_report(ref, cur, ["x", "y"])}
    assert rep["x"]["estado"] == "ESTABLE" and rep["y"]["estado"] == "ALERTA"


def test_el_generador_reproduce_un_cambio_de_comportamiento():
    def amounts(scale):
        df = generate_dirty(3000, seed=5, amount_scale=scale)
        return pd.to_numeric(df["amount"].str.replace(r"[^0-9.]", "", regex=True), errors="coerce").dropna().to_numpy()

    assert psi(amounts(1.0), amounts(1.0)) < 0.05
    assert psi(amounts(1.0), amounts(1.8)) > 0.25
