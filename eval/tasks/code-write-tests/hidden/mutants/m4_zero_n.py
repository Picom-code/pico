def split_bill(total_cents, n):
    if total_cents < 0:
        raise ValueError("total must be >= 0")
    if n == 0:
        return []
    base, extra = divmod(total_cents, n)
    return [base + 1] * extra + [base] * (n - extra)
