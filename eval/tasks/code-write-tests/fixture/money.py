def split_bill(total_cents, n):
    if not isinstance(n, int) or n < 1:
        raise ValueError("n must be >= 1")
    if total_cents < 0:
        raise ValueError("total must be >= 0")
    base, extra = divmod(total_cents, n)
    return [base + 1] * extra + [base] * (n - extra)
