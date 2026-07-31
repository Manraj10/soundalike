"""Generate the app icon: a voice waveform that doubles as a soundwave 'S'.

Drawn rather than hand-authored so every size is rendered at its native
resolution instead of downscaled from one bitmap -- small sizes get thicker
bars and fewer of them, which is the difference between a readable 16px taskbar
icon and grey mush.

    python scripts/make_icon.py
"""
import math
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
SIZES = [16, 24, 32, 48, 64, 128, 256]

BG_TOP = (22, 24, 31)      # matches the app's --panel
BG_BOT = (14, 15, 19)      # matches --bg
ACCENT = (110, 231, 168)   # --accent
ACCENT_DIM = (47, 107, 77) # --accent-dim


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return m


def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(bg)

    # Vertical gradient background.
    for y in range(size):
        t = y / max(size - 1, 1)
        d.line([(0, y), (size, y)], fill=(
            int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
            int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
            int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
            255,
        ))
    img.paste(bg, (0, 0), rounded_mask(size, max(2, int(size * 0.22))))

    d = ImageDraw.Draw(img)

    # Fewer, chunkier bars at small sizes or it turns to mush.
    n = 5 if size <= 32 else 7
    # Symmetric envelope, tallest in the middle -- reads as a voice waveform.
    env = [0.34, 0.62, 0.86, 1.0, 0.86, 0.62, 0.34] if n == 7 else [0.42, 0.78, 1.0, 0.78, 0.42]

    span = size * 0.60
    bar_w = max(1.0, span / (n * 2 - 1))
    gap = bar_w
    total = n * bar_w + (n - 1) * gap
    x = (size - total) / 2.0
    cy = size / 2.0
    max_h = size * 0.52
    r = bar_w / 2.0

    for i in range(n):
        h = max_h * env[i]
        x0, x1 = x, x + bar_w
        y0, y1 = cy - h / 2.0, cy + h / 2.0
        # Middle bars brightest; outer ones dimmer for a sense of falloff.
        t = 1.0 - abs(i - (n - 1) / 2.0) / ((n - 1) / 2.0)
        col = tuple(int(ACCENT_DIM[c] + (ACCENT[c] - ACCENT_DIM[c]) * (0.45 + 0.55 * t)) for c in range(3))
        if size <= 24:
            d.rectangle([x0, y0, x1, y1], fill=col + (255,))
        else:
            d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=col + (255,))
        x += bar_w + gap

    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    imgs = [make(s) for s in SIZES]
    ico = os.path.join(OUT, "icon.ico")
    # Pillow writes a real multi-resolution .ico from the largest image plus
    # the requested sizes; pass our own renders so each size is purpose-drawn.
    imgs[-1].save(ico, format="ICO", sizes=[(s, s) for s in SIZES],
                  append_images=imgs[:-1])
    imgs[-1].save(os.path.join(OUT, "icon.png"), format="PNG")
    print(f"wrote {ico} ({os.path.getsize(ico):,} bytes) at sizes {SIZES}")


if __name__ == "__main__":
    main()
