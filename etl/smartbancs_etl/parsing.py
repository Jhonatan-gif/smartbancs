"""Conversión de montos y fechas "sucios" a tipos estándar. El dinero es siempre Decimal, nunca float."""
import re
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

# Las fechas sin zona horaria se asumen en hora de Ecuador (UTC-5, sin horario de verano).
ECUADOR = timezone(timedelta(hours=-5))

_NAIVE_FORMATS = [
    ("dd/mm/yyyy hh:mm", "%d/%m/%Y %H:%M"),
    ("dd/mm/yyyy", "%d/%m/%Y"),
    ("yyyy/mm/dd hh:mm:ss", "%Y/%m/%d %H:%M:%S"),
    ("dd-Mon-yyyy hh:mm", "%d-%b-%Y %H:%M"),
]


def parse_amount(raw) -> Decimal | None:
    """Acepta "1,234.50", "1.234,50", "12,50", "$ 12", "USD 45.00", " 7.5 ". None si no se entiende."""
    if raw is None:
        return None
    s = re.sub(r"[^\d,.\-]", "", str(raw))  # quita símbolos, letras y espacios
    if not s or not re.search(r"\d", s):
        return None
    negative = s.startswith("-")
    s = s.replace("-", "")
    if "," in s and "." in s:
        # El último separador es el decimal; el otro es de miles.
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        head, _, tail = s.rpartition(",")
        if len(tail) == 3 or "," in head:
            s = s.replace(",", "")  # "1,234" o "1,234,567": miles (caso ambiguo: se prefiere miles)
        else:
            s = head + "." + tail  # "12,50" o "12,5": decimal
    elif s.count(".") > 1:
        s = s.replace(".", "")  # "1.234.567": miles
    try:
        value = Decimal(s)
    except InvalidOperation:
        return None
    return -value if negative else value


def quantize_money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_EVEN)


def parse_timestamp(raw) -> tuple[datetime | None, str | None]:
    """Devuelve (fecha en UTC, nombre del formato detectado). (None, None) si no se entiende."""
    if raw is None:
        return None, None
    s = str(raw).strip()
    if not s:
        return None, None
    if re.fullmatch(r"\d{13}", s):
        return datetime.fromtimestamp(int(s) / 1000, tz=timezone.utc), "epoch_ms"
    if re.fullmatch(r"\d{10}", s):
        return datetime.fromtimestamp(int(s), tz=timezone.utc), "epoch_s"
    if re.match(r"\d{4}-\d{2}-\d{2}", s):
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None, None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ECUADOR)
        return dt.astimezone(timezone.utc), "iso8601"
    for name, fmt in _NAIVE_FORMATS:
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=ECUADOR)
            return dt.astimezone(timezone.utc), name
        except ValueError:
            continue
    return None, None
