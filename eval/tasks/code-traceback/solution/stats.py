def mean(xs):
    return sum(xs) / len(xs)


def median(xs):
    s = sorted(xs)
    mid = len(s) // 2
    if len(s) % 2 == 0:
        return (s[mid - 1] + s[mid]) / 2
    return s[mid]


def mode(xs):
    counts = {}
    for x in xs:
        counts[x] = counts.get(x, 0) + 1
    return max(counts, key=counts.get)


def variance(xs):
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)
