"""Consumidor del stream de transferencias completadas (grupo propio `ai-recs`).

Es totalmente ajeno al flujo transaccional: la transferencia ya terminó y respondió 201 antes de que este
servicio se entere. Si el servicio está caído o lento, los eventos se quedan en el stream y se procesan al volver.
"""
import asyncio
import logging

from redis.asyncio import Redis
from redis.exceptions import RedisError, ResponseError

from .live import LiveState

log = logging.getLogger("ai-service.consumer")


def parse_entry(fields: dict) -> dict:
    return {k: fields.get(k, "") for k in ("transactionId", "fromAccount", "toAccount", "amount", "currency", "occurredAt")}


class StreamConsumer:
    def __init__(self, redis: Redis, live: LiveState, stream: str, group: str, name: str, block_ms: int = 1000):
        self.redis, self.live = redis, live
        self.stream, self.group, self.name, self.block_ms = stream, group, name, block_ms
        self._task: asyncio.Task | None = None
        self.errors = 0

    async def ensure_group(self) -> None:
        try:
            # '0': procesar también lo publicado antes de que existiera el grupo
            await self.redis.xgroup_create(self.stream, self.group, id="0", mkstream=True)
        except ResponseError as err:
            if "BUSYGROUP" not in str(err):
                raise

    async def poll_once(self) -> int:
        """Lee un lote, lo aplica y lo confirma (ACK). Devuelve cuántos eventos procesó."""
        resp = await self.redis.xreadgroup(self.group, self.name, {self.stream: ">"}, count=100, block=self.block_ms)
        if not resp:
            return 0
        entries = resp[0][1]
        ids = []
        for entry_id, fields in entries:
            try:
                self.live.apply(parse_entry(fields))
            except (KeyError, ValueError, ArithmeticError) as err:
                # Un evento mal formado no debe bloquear la cola: se registra y se confirma.
                log.warning("evento descartado %s: %s", entry_id, err)
            ids.append(entry_id)
        await self.redis.xack(self.stream, self.group, *ids)
        return len(ids)

    async def run(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self.ensure_group()
                while True:
                    await self.poll_once()
                    backoff = 1.0
            except asyncio.CancelledError:
                raise
            except (RedisError, OSError) as err:
                self.errors += 1
                log.warning("redis no disponible (%s); reintento en %.0fs", err, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 15.0)

    def start(self) -> None:
        self._task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
