"""Tiny pure-Python QR encoder (byte mode, all versions, ECC L/M/Q/H) → SVG.

Condensed port of Project Nayuki's "QR Code generator library" (MIT License,
Copyright (c) Project Nayuki, https://www.nayuki.io/page/qr-code-generator-library).
"""
from __future__ import annotations

from typing import List

_ECC_ORD = {"L": 0, "M": 1, "Q": 2, "H": 3}
_ECC_FMT = {"L": 1, "M": 0, "Q": 3, "H": 2}
_ECC_CODEWORDS_PER_BLOCK = (
    (-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    (-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
    (-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    (-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
)
_NUM_ERROR_CORRECTION_BLOCKS = (
    (-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
    (-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
    (-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
    (-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81),
)
_PENALTY_N1, _PENALTY_N2, _PENALTY_N3, _PENALTY_N4 = 3, 3, 40, 10


def _num_raw_data_modules(ver: int) -> int:
    result = (16 * ver + 128) * ver + 64
    if ver >= 2:
        numalign = ver // 7 + 2
        result -= (25 * numalign - 10) * numalign - 55
        if ver >= 7:
            result -= 36
    return result


def _num_data_codewords(ver: int, ecl: str) -> int:
    e = _ECC_ORD[ecl]
    return _num_raw_data_modules(ver) // 8 - _ECC_CODEWORDS_PER_BLOCK[e][ver] * _NUM_ERROR_CORRECTION_BLOCKS[e][ver]


def _rs_multiply(x: int, y: int) -> int:
    z = 0
    for i in reversed(range(8)):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree: int) -> List[int]:
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _rs_multiply(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _rs_multiply(root, 0x02)
    return result


def _rs_remainder(data: List[int], divisor: List[int]) -> List[int]:
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _rs_multiply(coef, factor)
    return result


class QrCode:
    def __init__(self, data: bytes, ecl: str = "M"):
        bits_needed = 0
        for ver in range(1, 41):
            ccbits = 8 if ver <= 9 else 16
            cap = _num_data_codewords(ver, ecl) * 8
            bits_needed = 4 + ccbits + len(data) * 8
            if bits_needed <= cap:
                break
        else:
            raise ValueError("data too long for a QR code")
        # boost ECC level if it still fits
        for new in ("M", "Q", "H"):
            if _ECC_ORD[new] > _ECC_ORD[ecl] and bits_needed <= _num_data_codewords(ver, new) * 8:
                ecl = new
        self.version, self.ecl, self.size = ver, ecl, ver * 4 + 17
        bb: List[int] = []

        def app(val: int, n: int) -> None:
            bb.extend((val >> i) & 1 for i in reversed(range(n)))

        app(0x4, 4)
        app(len(data), 8 if ver <= 9 else 16)
        for b in data:
            app(b, 8)
        cap = _num_data_codewords(ver, ecl) * 8
        app(0, min(4, cap - len(bb)))
        app(0, -len(bb) % 8)
        pad = 0xEC
        while len(bb) < cap:
            app(pad, 8)
            pad ^= 0xEC ^ 0x11
        codewords = [0] * (len(bb) // 8)
        for i, bit in enumerate(bb):
            codewords[i >> 3] |= bit << (7 - (i & 7))

        n = self.size
        self.modules = [[False] * n for _ in range(n)]
        self.isfunc = [[False] * n for _ in range(n)]
        self._draw_function_patterns()
        allcw = self._add_ecc_and_interleave(codewords)
        self._draw_codewords(allcw)
        best, minpen = 0, None
        for m in range(8):
            self._apply_mask(m)
            self._draw_format_bits(m)
            pen = self._penalty()
            if minpen is None or pen < minpen:
                best, minpen = m, pen
            self._apply_mask(m)
        self._apply_mask(best)
        self._draw_format_bits(best)
        self.mask = best

    # drawing --------------------------------------------------------------
    def _set_func(self, x: int, y: int, dark: bool) -> None:
        self.modules[y][x] = dark
        self.isfunc[y][x] = True

    def _draw_function_patterns(self) -> None:
        n = self.size
        for i in range(n):
            self._set_func(6, i, i % 2 == 0)
            self._set_func(i, 6, i % 2 == 0)
        for (x, y) in ((3, 3), (n - 4, 3), (3, n - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < n and 0 <= yy < n:
                        self._set_func(xx, yy, max(abs(dx), abs(dy)) not in (2, 4))
        pos = self._alignment_positions()
        last = len(pos) - 1
        for i, a in enumerate(pos):
            for j, b in enumerate(pos):
                if (i == 0 and j == 0) or (i == 0 and j == last) or (i == last and j == 0):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self._set_func(a + dx, b + dy, max(abs(dx), abs(dy)) != 1)
        self._draw_format_bits(0)
        self._draw_version()

    def _alignment_positions(self) -> List[int]:
        ver = self.version
        if ver == 1:
            return []
        numalign = ver // 7 + 2
        step = (ver * 8 + numalign * 3 + 5) // (numalign * 4 - 4) * 2
        result = [(self.size - 7 - i * step) for i in range(numalign - 1)] + [6]
        return list(reversed(result))

    def _draw_format_bits(self, mask: int) -> None:
        data = _ECC_FMT[self.ecl] << 3 | mask
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = (data << 10 | rem) ^ 0x5412
        n = self.size
        g = lambda i: (bits >> i) & 1 != 0  # noqa: E731
        for i in range(0, 6):
            self._set_func(8, i, g(i))
        self._set_func(8, 7, g(6))
        self._set_func(8, 8, g(7))
        self._set_func(7, 8, g(8))
        for i in range(9, 15):
            self._set_func(14 - i, 8, g(i))
        for i in range(0, 8):
            self._set_func(n - 1 - i, 8, g(i))
        for i in range(8, 15):
            self._set_func(8, n - 15 + i, g(i))
        self._set_func(8, n - 8, True)

    def _draw_version(self) -> None:
        if self.version < 7:
            return
        rem = self.version
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = self.version << 12 | rem
        for i in range(18):
            bit = (bits >> i) & 1 != 0
            a, b = self.size - 11 + i % 3, i // 3
            self._set_func(a, b, bit)
            self._set_func(b, a, bit)

    def _add_ecc_and_interleave(self, data: List[int]) -> List[int]:
        ver, e = self.version, _ECC_ORD[self.ecl]
        numblocks = _NUM_ERROR_CORRECTION_BLOCKS[e][ver]
        blockecclen = _ECC_CODEWORDS_PER_BLOCK[e][ver]
        rawcodewords = _num_raw_data_modules(ver) // 8
        numshortblocks = numblocks - rawcodewords % numblocks
        shortblocklen = rawcodewords // numblocks
        blocks = []
        div = _rs_divisor(blockecclen)
        k = 0
        for i in range(numblocks):
            dat = data[k: k + shortblocklen - blockecclen + (0 if i < numshortblocks else 1)]
            k += len(dat)
            ecc = _rs_remainder(dat, div)
            if i < numshortblocks:
                dat = dat + [0]
            blocks.append(dat + ecc)
        result = []
        for i in range(len(blocks[0])):
            for j, blk in enumerate(blocks):
                if i != shortblocklen - blockecclen or j >= numshortblocks:
                    result.append(blk[i])
        return result

    def _draw_codewords(self, data: List[int]) -> None:
        n = self.size
        i = 0
        right = n - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(n):
                for j in range(2):
                    x = right - j
                    upward = (right + 1) & 2 == 0
                    y = (n - 1 - vert) if upward else vert
                    if not self.isfunc[y][x] and i < len(data) * 8:
                        self.modules[y][x] = (data[i >> 3] >> (7 - (i & 7))) & 1 != 0
                        i += 1
            right -= 2

    def _apply_mask(self, mask: int) -> None:
        f = (
            lambda x, y: (x + y) % 2,
            lambda x, y: y % 2,
            lambda x, y: x % 3,
            lambda x, y: (x + y) % 3,
            lambda x, y: (x // 3 + y // 2) % 2,
            lambda x, y: x * y % 2 + x * y % 3,
            lambda x, y: (x * y % 2 + x * y % 3) % 2,
            lambda x, y: ((x + y) % 2 + x * y % 3) % 2,
        )[mask]
        for y in range(self.size):
            row, frow = self.modules[y], self.isfunc[y]
            for x in range(self.size):
                if not frow[x] and f(x, y) == 0:
                    row[x] = not row[x]

    def _penalty(self) -> int:
        result, n, m = 0, self.size, self.modules

        def finder_count(h: List[int]) -> int:
            k = h[1]
            core = k > 0 and h[2] == k and h[3] == k * 3 and h[4] == k and h[5] == k
            return ((1 if core and h[0] >= k * 4 and h[6] >= k else 0)
                    + (1 if core and h[6] >= k * 4 and h[0] >= k else 0))

        def add_history(run: int, h: List[int]) -> None:
            if h[0] == 0:
                run += n
            h.pop()
            h.insert(0, run)

        def terminate(color: bool, run: int, h: List[int]) -> int:
            if color:
                add_history(run, h)
                run = 0
            run += n
            add_history(run, h)
            return finder_count(h)

        for axis in range(2):
            for a in range(n):
                color, run, h = False, 0, [0] * 7
                for b in range(n):
                    cell = m[a][b] if axis == 0 else m[b][a]
                    if cell == color:
                        run += 1
                        if run == 5:
                            result += _PENALTY_N1
                        elif run > 5:
                            result += 1
                    else:
                        add_history(run, h)
                        if not color:
                            result += finder_count(h) * _PENALTY_N3
                        color, run = cell, 1
                result += terminate(color, run, h) * _PENALTY_N3
        for y in range(n - 1):
            for x in range(n - 1):
                c = m[y][x]
                if c == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                    result += _PENALTY_N2
        dark = sum(sum(1 for c in row if c) for row in m)
        total = n * n
        k = (abs(dark * 20 - total * 10) + total - 1) // total - 1
        result += k * _PENALTY_N4
        return result

    def svg(self, border: int = 4, dark: str = "#000", light: str = "#fff") -> str:
        parts = []
        for y in range(self.size):
            for x in range(self.size):
                if self.modules[y][x]:
                    parts.append(f"M{x + border},{y + border}h1v1h-1z")
        dim = self.size + border * 2
        return (f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 {dim} {dim}" '
                f'shape-rendering="crispEdges"><rect width="100%" height="100%" fill="{light}"/>'
                f'<path d="{"".join(parts)}" fill="{dark}"/></svg>')


def svg(text: str, ecl: str = "M", **kw) -> str:
    return QrCode(text.encode("utf-8"), ecl).svg(**kw)
