#!/usr/bin/env python3
"""Mint GlobalFlows PWA icons — three lights on #0b0e13 (matches brand mark)."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BG = (11, 14, 19, 255)
GREEN = (61, 206, 167, 255)
AMBER = (230, 184, 77, 255)
RED = (232, 106, 92, 255)
COLORS = (GREEN, AMBER, RED)


def draw_mark(size, *, pad_frac=0.22, radius_frac=0.10):
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    cy = size / 2
    usable = size * (1 - 2 * pad_frac)
    r = max(2, size * radius_frac)
    gap = usable / 2
    x0 = size / 2 - gap
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
