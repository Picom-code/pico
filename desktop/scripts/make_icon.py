#!/usr/bin/env python3
"""Render the Pico app icon: the ASCII cat on charcoal with a hot-pink glow -> icons/pico-1024.png.

Then `npx tauri icon icons/pico-1024.png` generates every platform size (icns/ico/pngs).
Needs Pillow. Uses a system monospace font (Menlo / SF Mono / DejaVu Sans Mono / Consolas).
"""
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 1024
PINK = (255, 46, 153)
BG = (22, 22, 26)
CAT = [" /\\_/\\ ", "( o.o )", " > ^ < "]

FONTS = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/SFNSMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf",
    "C:/Windows/Fonts/consolab.ttf",
]


def font(size):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size, index=1 if f.endswith(".ttc") else 0)  # Menlo Bold
            except Exception:
                return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def main(out: Path):
    # macOS-style rounded square with transparent margin (Big Sur grid: ~824px body in 1024).
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    m, r = 100, 185
    body = Image.new("L", (S, S), 0)
    ImageDraw.Draw(body).rounded_rectangle([m, m, S - m, S - m], r, fill=255)
    bg = Image.new("RGBA", (S, S), BG + (255,))
    # faint radial pink wash
    wash = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(wash).ellipse([S * 0.18, S * 0.2, S * 0.82, S * 0.8], fill=PINK + (46,))
    wash = wash.filter(ImageFilter.GaussianBlur(120))
    bg = Image.alpha_composite(bg, wash)
    # subtle top highlight + border
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle([m, m, S - m, S - m], r, outline=(255, 255, 255, 22), width=4)
    bg = Image.alpha_composite(bg, hl)
    img.paste(bg, (0, 0), body)

    f = font(150)
    lines = CAT
    lh = 170
    widths = [ImageDraw.Draw(img).textlength(l, font=f) for l in lines]
    w = max(widths)
    x0 = (S - w) / 2
    y0 = (S - lh * len(lines)) / 2 - 10

    text = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(text)
    for i, l in enumerate(lines):
        d.text((x0, y0 + i * lh), l, font=f, fill=PINK + (255,))
    glow_big = text.filter(ImageFilter.GaussianBlur(38))
    glow_small = text.filter(ImageFilter.GaussianBlur(12))
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    for g, k in ((glow_big, 2), (glow_small, 1)):
        for _ in range(k):
            layer = Image.alpha_composite(layer, g)
    layer = Image.alpha_composite(layer, text)
    clipped = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    clipped.paste(layer, (0, 0), body)
    img = Image.alpha_composite(img, clipped)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print(out)


if __name__ == "__main__":
    here = Path(__file__).resolve().parent.parent
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else here / "src-tauri" / "icons" / "pico-1024.png")
