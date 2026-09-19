"""ai-service: recomendaciones financieras. Servicio independiente y NO crítico para las transferencias."""
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Path
from pydantic import BaseModel, Field
from redis.asyncio import Redis

from .config import Settings
from .consumer import StreamConsumer
from .engine import Engine
from .live import LiveState
from .model import Model, load_features

ACCOUNT = Path(pattern=r"^\d{10}$", description="Número de cuenta (10 dígitos)")


class Mode(BaseModel):
    mode: Literal["normal", "slow", "down"] = "normal"
    delay_ms: int = Field(default=5000, ge=0, le=60_000)


def create_app(settings: Settings | None = None, start_consumer: bool = True) -> FastAPI:
    cfg = settings or Settings()
    logging.basicConfig(level=cfg.log_level.upper(), format='{"time":"%(asctime)s","level":"%(levelname)s","service":"ai-service","msg":"%(message)s"}')
    log = logging.getLogger("ai-service")

    features, source = load_features(cfg.features_paths)
    model = Model.train(features)
    live = LiveState()
    engine = Engine(features, model, live)
    state = {"mode": "normal", "delay_ms": 0}
    consumer: StreamConsumer | None = None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal consumer
        redis = None
        if start_consumer:
            redis = Redis.from_url(cfg.redis_url, decode_responses=True)
            consumer = StreamConsumer(redis, live, cfg.stream, cfg.group, cfg.consumer_name)
            consumer.start()
        log.info("modelo %s entrenado con %d cuentas (features: %s)", model.version, model.n_accounts, source or "ninguno")
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
    async def recommendations(account: str = ACCOUNT):
        started = time.perf_counter()
        # Modos de prueba (caos): permiten demostrar que un ai-service lento o caído no afecta a las transferencias.
        if state["mode"] == "down":
            raise HTTPException(status_code=503, detail="ai-service en modo down")
        if state["mode"] == "slow":
            await asyncio.sleep(state["delay_ms"] / 1000)
        body = engine.recommend(account)
        log.info("recomendaciones cuenta=****%s n=%d cold=%s ms=%.1f", account[-4:], len(body["recommendations"]),
                 body["coldStart"], (time.perf_counter() - started) * 1000)
        return body

    if cfg.enable_admin:
        @app.post("/admin/mode")
        async def set_mode(m: Mode):
            state["mode"], state["delay_ms"] = m.mode, m.delay_ms
            return {"mode": m.mode, "delayMs": m.delay_ms}

    return app


app = create_app()
