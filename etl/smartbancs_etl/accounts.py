"""Validación de números de cuenta (misma regla Luhn que core-api: 9 dígitos + dígito verificador)."""
import re


def luhn_check_digit(body: str) -> int:
    total, double = 0, True
    for ch in reversed(body):
        d = int(ch)
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return (10 - total % 10) % 10


def is_valid_account(value: str) -> bool:
    return bool(re.fullmatch(r"\d{10}", value)) and luhn_check_digit(value[:9]) == int(value[9])


def make_account(body: str) -> str:
    return body + str(luhn_check_digit(body))
