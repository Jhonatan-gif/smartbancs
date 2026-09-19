"""Estado "en vivo" por cuenta, alimentado por el stream de transferencias completadas."""
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal


@dataclass
class LiveAccount:
    sent: deque = field(default_factory=lambda: deque(maxlen=100))  # (momento, monto) de los últimos envíos
    received_total: float = 0.0
    received_count: int = 0


class LiveState:
    def __init__(self, on_event=None) -> None:
        self._on_event = on_event  # gancho para contar eventos en las métricas
        self.accounts: dict[str, LiveAccount] = defaultdict(LiveAccount)
        self.processed = 0
        self.last_event_at: str | None = None

    def apply(self, event: dict) -> None:
        """Aplica un evento del stream. Es idempotente en efecto práctico: repetir uno solo suma una vez más al
        contador, lo cual es aceptable para recomendaciones (no es contabilidad)."""
        amount = float(Decimal(event["amount"]))  # el dinero llega como texto decimal; float solo para el modelo
        when = datetime.fromisoformat(event["occurredAt"].replace("Z", "+00:00"))
        self.accounts[event["fromAccount"]].sent.append((when, amount))
        rec = self.accounts[event["toAccount"]]
        rec.received_total += amount
        rec.received_count += 1
        self.processed += 1
        if self._on_event:
            self._on_event()
        self.last_event_at = datetime.now(timezone.utc).isoformat()

    def get(self, account: str) -> LiveAccount | None:
        return self.accounts.get(account)
