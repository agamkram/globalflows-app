#!/usr/bin/env python3
"""Mint GlobalFlows PWA icons — three lights on black, current ease / pick / tight."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BG = (0, 0, 0, 255)           # --bg
EASE = (29, 184, 122, 255)    # --ease  #1db87a
PICK = (230, 184, 77, 255)    # --pick  #e6b84d
TIGHT = (242, 54, 69, 255)    # --tight #f23645
COLORS = (EASE, PICK, TIGHT)


def _glow(size, cx, cy, r, color):
    """Soft halo matching the on-screen dot (box-shadow: 0 0 8px)."""
    if size < 96:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    gr = r * 1.32
    d.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=(*color[:3], 48))
    return overlay.filter(ImageFilter.GaussianBlur(radius=max(1.2, r * 0.16)))


def draw_mark(size, *, pad_frac=0.22, radius_frac=0.10):
    img = Image.new("RGBA", (size, size), BG)
    cy = size / 2
    usable = size * (1 - 2 * pad_frac)
    r = max(2, size * radius_frac)
    gap = usable / 2
    x0 = size / 2 - gap
    glows = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for i, c in enumerate(COLORS):
        cx = x0 + i * gap
        glows = Image.alpha_composite(glows, _glow(size, cx, cy, r, c))
    img = Image.alpha_composite(img, glows)
    d = ImageDraw.Draw(img)
    for i, c in enumerate(COLORS):
        cx = x0 + i * gap
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    return img


def main():
    outs = [
        ("icon-192.png", draw_mark(192)),
        ("icon-512.png", draw_mark(512)),
        ("icon-maskable-512.png", draw_mark(512, pad_frac=0.28, radius_frac=0.07)),
        ("apple-touch-icon.png", draw_mark(180)),
        ("favicon-32.png", draw_mark(32, pad_frac=0.20, radius_frac=0.11)),
    ]
    for name, img in outs:
        path = ROOT / name
        img.save(path, "PNG", optimize=True)
        print(path.name, img.size)


if __name__ == "__main__":
    main()
