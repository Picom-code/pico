from dataclasses import dataclass


@dataclass
class Expense:
    amount: float
    desc: str
    currency: str = "USD"

    def __post_init__(self):
        if self.amount <= 0:
            raise ValueError("amount must be positive")
        c = (self.currency or "").upper()
        if len(c) != 3 or not c.isalpha():
            raise ValueError("bad currency")
        self.currency = c
