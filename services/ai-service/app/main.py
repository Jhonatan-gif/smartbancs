"""ai-service: recomendaciones financieras. Servicio independiente y NO crítico para las transferencias."""
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Header, HTTPException, Path, Response
from pydantic import BaseModel, Field
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from redis.asyncio import Redis

from .config import Settings
from .consumer import StreamConsumer
from .engine import Engine
from .live import LiveState
from .model import Model, load_features
from .observability import (consumer_errors_total, events_processed_total, mode_gauge, model_accounts, recommendations_duration,
                            recommendations_total, registry, setup_logging)

ACCOUNT = Path(pattern=r"^\d{10}$", description="Número de cuenta (10 dígitos)")


class Mode(BaseModel):
    mode: Literal["normal", "slow", "down"] = "normal"
    delay_ms: int = Field(default=5000, ge=0, le=60_000)


def create_app(settings: Settings | None = None, start_consumer: bool = True) -> FastAPI:
    cfg = settings or Settings()
    setup_logging(cfg.log_level)
    log = logging.getLogger("ai-service")

    features, source = load_features(cfg.features_paths)
    model = Model.train(features)
    live = LiveState(on_event=events_processed_total.inc)
    model_accounts.set(model.n_accounts)
    engine = Engine(features, model, live)
    state = {"mode": "normal", "delay_ms": 0}
    consumer: StreamConsumer | None = None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal consumer
        redis = None
        if start_consumer:
            redis = Redis.from_url(cfg.redis_url, decode_responses=True)
            consumer = StreamConsumer(redis, live, cfg.stream, cfg.group, cfg.consumer_name, on_error=consumer_errors_total.inc)
            consumer.start()
        log.info("modelo entrenado", extra={"ctx": {"model": model.version, "accounts": model.n_accounts, "features": source or "ninguno"}})
        yield
        if consumer:
            await consumer.stop()
        if redis:
            await redis.aclose()

    app = FastAPI(title="SmartBancs ai-service", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "model": model.version,
            "featuresSource": source,
            "accountsWithHistory": len(features),
            "stream": {"processed": live.processed, "lastEventAt": live.last_event_at,
                       "consumerErrors": consumer.errors if consumer else None},
        }

    @app.get("/model")
    async def model_info():
        return model.describe()

    @app.get("/recommendations/{account}")
    async def recommendations(account: str = ACCOUNT, x_request_id: str | None = Header(default=None)):
        started = time.perf_counter()
        # Modos de prueba (caos): permiten demostrar que un ai-service lento o caído no afecta a las transferencias.
        if state["mode"] == "down":
            raise HTTPException(status_code=503, detail="ai-service en modo down")
        if state["mode"] == "slow":
            await asyncio.sleep(state["delay_ms"] / 1000)
        body = engine.recommend(account)
        elapsed = time.perf_counter() - started
        recommendations_total.labels(cold_start=str(body["coldStart"]).lower()).inc()
        recommendations_duration.observe(elapsed)
        # trace_id = x-request-id que envía core-api: une este log con el de la petición original
        log.info("recomendaciones generadas", extra={"ctx": {
            "trace_id": x_request_id, "account": f"****{account[-4:]}", "count": len(body["recommendations"]),
            "cold_start": body["coldStart"], "ms": round(elapsed * 1000, 1)}})
        return body

    @app.get("/metrics")
    async def metrics():
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    if cfg.enable_admin:
        @app.post("/admin/mode")
        async def set_mode(m: Mode):
            state["mode"], state["delay_ms"] = m.mode, m.delay_ms
            mode_gauge.set({"normal": 0, "slow": 1, "down": 2}[m.mode])
            return {"mode": m.mode, "delayMs": m.delay_ms}

    return app


app = create_app()
