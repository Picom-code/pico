def split_bill(total_cents, n):
    if not isinstance(n, int) or n < 1:
        raise ValueError("n must be >= 1")
    base, extra = divmod(total_cents, n)
    return [base + 1] * extra + [base] * (n - extra)
