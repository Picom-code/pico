from dataclasses import dataclass


@dataclass
class Expense:
    amount: float
    desc: str

    def __post_init__(self):
        if self.amount <= 0:
            raise ValueError("amount must be positive")
