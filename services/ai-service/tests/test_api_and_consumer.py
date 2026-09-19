import asyncio
import os
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from redis.asyncio import Redis

from app.config import Settings
from app.consumer import StreamConsumer
from app.live import LiveState
from app.main import create_app

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")  # en Docker: redis://redis:6379


@pytest.fixture()
def client():
    app = create_app(Settings(), start_consumer=False)  # sin Redis: solo la API
    with TestClient(app) as c:
        yield c


def test_health_y_modelo(client):
    h = client.get("/health").json()
    assert h["status"] == "ok" and h["accountsWithHistory"] > 0
    m = client.get("/model").json()
    assert m["version"] == "zscore-seg-v1" and m["accounts"] == h["accountsWithHistory"]


def test_recomendaciones_de_cuenta_con_historial(client):
    r = client.get("/recommendations/1000000016")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "model" and body["account"] == "1000000016" and body["coldStart"] is False
    assert 1 <= len(body["recommendations"]) <= 4
    assert {"id", "type", "severity", "title", "message"} <= set(body["recommendations"][0])


def test_numero_de_cuenta_invalido_es_422(client):
    assert client.get("/recommendations/123").status_code == 422
    assert client.get("/recommendations/abcdefghij").status_code == 422


def test_modo_down_responde_503(client):
    client.post("/admin/mode", json={"mode": "down"})
    assert client.get("/recommendations/1000000016").status_code == 503
    assert client.get("/health").status_code == 200  # el proceso sigue vivo
    client.post("/admin/mode", json={"mode": "normal"})
    assert client.get("/recommendations/1000000016").status_code == 200


def test_modo_slow_agrega_retraso(client):
    client.post("/admin/mode", json={"mode": "slow", "delay_ms": 300})
    t0 = time.perf_counter()
    assert client.get("/recommendations/1000000016").status_code == 200
    assert time.perf_counter() - t0 >= 0.29
    client.post("/admin/mode", json={"mode": "normal"})


# --- Consumidor del stream (necesitan Redis, REDIS_URL o localhost:6379; se omiten si no está) ---
def _redis_or_skip():
    try:
        import redis
        r = redis.Redis.from_url(REDIS_URL, socket_connect_timeout=1)
        r.ping()
    except Exception:
        pytest.skip(f"Redis no disponible en {REDIS_URL}")


def _entry(tx: str, frm="1000000016", to="1000000032", amount="20.00"):
    return {"transactionId": tx, "fromAccount": frm, "toAccount": to, "amount": amount, "currency": "USD",
            "occurredAt": "2026-09-19T10:00:00Z", "eventId": "1", "traceId": ""}


def test_consumidor_procesa_confirma_y_no_compite_con_otro_grupo():
    _redis_or_skip()
    stream = f"test.transfers.{uuid.uuid4().hex[:8]}"

    async def scenario():
        redis = Redis.from_url(REDIS_URL, decode_responses=True)
        try:
            live = LiveState()
            consumer = StreamConsumer(redis, live, stream, "ai-recs", "test-1", block_ms=200)
            await consumer.ensure_group()
            await redis.xgroup_create(stream, "bancs-sync", id="0")  # el grupo del worker existe en paralelo
            await redis.xadd(stream, _entry("a"))
            await redis.xadd(stream, _entry("b", amount="30.50"))
            await redis.xadd(stream, {"transactionId": "malo", "amount": "no-es-un-numero"})  # evento roto
            n = await consumer.poll_once()
            pending = (await redis.xpending(stream, "ai-recs"))["pending"]
            other_group_pending = (await redis.xinfo_groups(stream))
            return live, n, pending, {g["name"]: g["lag"] for g in other_group_pending}
        finally:
            await redis.delete(stream)
            await redis.aclose()

    live, n, pending, lags = asyncio.run(scenario())
    assert n == 3 and live.processed == 2       # el evento roto se descarta pero se confirma
    assert pending == 0                          # todo confirmado (ACK): nada queda colgado
    assert lags["bancs-sync"] == 3               # el grupo del worker sigue viendo los 3 eventos: no se los quitamos
    assert live.get("1000000016").sent[-1][1] == 30.5


def test_consumidor_sobrevive_a_redis_caido():
    async def scenario():
        redis = Redis.from_url("redis://localhost:1", decode_responses=True, socket_connect_timeout=0.2)
        consumer = StreamConsumer(redis, LiveState(), "x", "ai-recs", "t", block_ms=100)
        consumer.start()
        await asyncio.sleep(0.6)
        alive = not consumer._task.done()  # sigue reintentando en vez de morir
        await consumer.stop()
        await redis.aclose()
        return alive, consumer.errors

    alive, errors = asyncio.run(scenario())
    assert alive and errors >= 1
