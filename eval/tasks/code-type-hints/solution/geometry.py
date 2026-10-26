from __future__ import annotations

import math

Point = tuple[float, float]


def distance(a: Point, b: Point) -> float:
    """Euclidean distance.

    >>> distance((0, 0), (3, 4))
    5.0
    """
    return math.hypot(b[0] - a[0], b[1] - a[1])


def centroid(points: list[Point]) -> Point | None:
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def perimeter(points: list[Point], closed: bool = True) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        total += distance(a, b)
    if closed and len(points) > 2:
        total += distance(points[-1], points[0])
    return total


def scale(points: list[Point], factor: float) -> list[Point]:
    return [(x * factor, y * factor) for x, y in points]
