"""Features por cuenta para el modelo de recomendaciones (ai-service).

El dinero permanece como Decimal en el dataset limpio; aquí se convierte a float SOLO porque son
variables de entrada de un modelo estadístico (no se usan para contabilidad).
"""
import pandas as pd

WINDOW_DAYS = 30


def build_account_features(clean: pd.DataFrame, as_of: pd.Timestamp | None = None) -> pd.DataFrame:
    if clean.empty:
        return pd.DataFrame()
    df = clean.copy()
    df["amount_f"] = df["amount"].map(float)
    as_of = as_of or df["occurred_at"].max()
    df["age_days"] = (as_of - df["occurred_at"]).dt.total_seconds() / 86400

    g = df.groupby("account_number")
    feats = pd.DataFrame({
        "n_tx": g.size(),
        "total_spent": g["amount_f"].sum(),
        "avg_amount": g["amount_f"].mean(),
        "max_amount": g["amount_f"].max(),
        "std_amount": g["amount_f"].std().fillna(0.0),
        "n_counterparties": g["counterparty_account"].nunique(),
        "n_outliers": g["is_outlier"].sum(),
        "days_since_last_tx": g["age_days"].min(),
    })
    recent = df[df["age_days"] <= WINDOW_DAYS].groupby("account_number")
    previous = df[(df["age_days"] > WINDOW_DAYS) & (df["age_days"] <= 2 * WINDOW_DAYS)].groupby("account_number")
    feats["tx_last_30d"] = recent.size()
    feats["spend_last_30d"] = recent["amount_f"].sum()
    feats["spend_prev_30d"] = previous["amount_f"].sum()
    feats = feats.fillna({"tx_last_30d": 0, "spend_last_30d": 0.0, "spend_prev_30d": 0.0})
    feats["spend_trend"] = feats["spend_last_30d"] / feats["spend_prev_30d"].where(feats["spend_prev_30d"] > 0)
    feats["spend_trend"] = feats["spend_trend"].fillna(1.0)  # sin historia previa = tendencia neutra

    share = df.pivot_table(index="account_number", columns="category", values="amount_f", aggfunc="sum", fill_value=0.0)
    share = share.div(share.sum(axis=1), axis=0).add_prefix("share_")
    feats = feats.join(share)
    by_cat = df.groupby(["account_number", "category"])["amount_f"].sum()
    feats["top_category"] = by_cat.groupby(level=0).idxmax().map(lambda t: t[1])
    feats["n_tx"] = feats["n_tx"].astype(int)
    feats["tx_last_30d"] = feats["tx_last_30d"].astype(int)
    feats["n_outliers"] = feats["n_outliers"].astype(int)
    return feats.round(4).reset_index()
