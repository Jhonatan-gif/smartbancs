import os
from datetime import datetime, timedelta, timezone

from app.engine import Engine
from app.live import LiveState
from app.model import Model, load_features

NOW = datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc)
# Local: lo fija conftest.py. En Docker: la muestra montada en /data.
SAMPLE = os.environ.get("FEATURES_CSV", "/data/sample/account_features.csv").split(",")[0]


def base(**over):
    row = {"account_number": "1000000016", "n_tx": 20, "total_spent": 1000.0, "avg_amount": 50.0, "max_amount": 90.0,
           "std_amount": 15.0, "n_counterparties": 6, "n_outliers": 0, "days_since_last_tx": 2.0, "tx_last_30d": 10,
           "spend_last_30d": 500.0, "spend_prev_30d": 500.0, "spend_trend": 1.0,
           "share_ocio": 0.25, "share_salud": 0.25, "share_compras": 0.25, "share_transporte": 0.25,
           "top_category": "ocio"}
    row.update(over)
    return row


def engine_for(row=None, live=None):
    features = {"1000000016": row} if row else {}
    return Engine(features, Model.train(features or {"x": base()}), live or LiveState(), now=lambda: NOW)


def ids(result):
    return [r["id"] for r in result["recommendations"]]


def event(frm="1000000016", to="1000000032", amount="10.00", when=NOW):
    return {"fromAccount": frm, "toAccount": to, "amount": amount, "occurredAt": when.isoformat(), "currency": "USD",
            "transactionId": "t"}


def test_gasto_en_aumento():
    assert "SPEND_UP" in ids(engine_for(base(spend_last_30d=800, spend_prev_30d=500, spend_trend=1.6)).recommend("1000000016"))


def test_gasto_a_la_baja_sugiere_ahorrar():
    r = engine_for(base(spend_last_30d=200, spend_prev_30d=500, spend_trend=0.4)).recommend("1000000016")
    assert "SPEND_DOWN" in ids(r)


def test_sin_historia_previa_no_dispara_reglas_de_tendencia():
    r = engine_for(base(spend_prev_30d=0.0, spend_trend=1.0)).recommend("1000000016")
    assert "SPEND_UP" not in ids(r) and "SPEND_DOWN" not in ids(r)


def test_concentracion_por_categoria():
    r = engine_for(base(share_ocio=0.7, share_salud=0.1, share_compras=0.1, share_transporte=0.1)).recommend("1000000016")
    assert "CATEGORY_CONCENTRATION" in ids(r)


def test_la_categoria_sin_categoria_no_cuenta_como_concentracion():
    r = engine_for(base(share_sin_categoria=0.9, share_ocio=0.05, share_salud=0.05)).recommend("1000000016")
    assert "CATEGORY_CONCENTRATION" not in ids(r)


def test_outliers_y_cuenta_inactiva():
    r = engine_for(base(n_outliers=2, days_since_last_tx=60)).recommend("1000000016")
    assert {"PAST_OUTLIERS", "INACTIVE"} <= set(ids(r))


def test_transferencia_inusual_en_vivo_es_alerta_y_va_primero():
    live = LiveState()
    live.apply(event(amount="5000.00"))
    r = engine_for(base(), live).recommend("1000000016")
    assert r["recommendations"][0]["id"] == "UNUSUAL_TRANSFER"
    assert r["recommendations"][0]["severity"] == "alert"


def test_transferencia_normal_en_vivo_no_alerta():
    live = LiveState()
    live.apply(event(amount="55.00"))
    assert "UNUSUAL_TRANSFER" not in ids(engine_for(base(), live).recommend("1000000016"))


def test_mucha_actividad_en_la_ultima_hora():
    live = LiveState()
    for i in range(6):
        live.apply(event(amount="10.00", when=NOW - timedelta(minutes=i)))
    assert "HIGH_ACTIVITY" in ids(engine_for(base(), live).recommend("1000000016"))


def test_actividad_antigua_no_cuenta():
    live = LiveState()
    for i in range(6):
        live.apply(event(amount="10.00", when=NOW - timedelta(hours=3, minutes=i)))
    assert "HIGH_ACTIVITY" not in ids(engine_for(base(), live).recommend("1000000016"))


def test_cuenta_desconocida_recibe_consejo_general_y_cold_start():
    r = engine_for(None).recommend("1000000099")
    assert r["coldStart"] is True and ids(r) == ["GENERAL_ALERTS"] and r["source"] == "model"


def test_como_maximo_4_recomendaciones_y_ordenadas_por_severidad():
    live = LiveState()
    live.apply(event(amount="5000.00"))
    row = base(spend_trend=1.6, spend_prev_30d=500, n_outliers=1, days_since_last_tx=90, share_ocio=0.8)
    r = engine_for(row, live).recommend("1000000016")
    order = {"alert": 0, "warning": 1, "info": 2}
    sev = [order[x["severity"]] for x in r["recommendations"]]
    assert len(r["recommendations"]) <= 4 and sev == sorted(sev)


def test_evento_suma_recibido_al_destino():
    live = LiveState()
    live.apply(event(amount="12.50"))
    assert live.get("1000000032").received_total == 12.5 and live.get("1000000032").received_count == 1


def test_modelo_entrena_con_la_muestra_del_etl_y_conserva_ceros_iniciales():
    features, source = load_features((SAMPLE,))
    assert source and len(features) >= 30
    assert all(len(k) == 10 for k in features)  # "0273625954" no se convierte en entero
    model = Model.train(features)
    scores = [model.atypicality(r) for r in features.values()]
    assert model.n_accounts == len(features) and all(s >= 0 for s in scores)
    assert {model.segment(r) for r in features.values()} == {"bajo", "medio", "alto"}
