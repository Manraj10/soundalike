"""Assemble the captured frames into docs/demo.gif.

Drops leading/trailing frames where nothing changes, so the GIF opens on the
action instead of three seconds of a static window, and quantises to a shared
palette to keep it small enough for GitHub to render inline.
"""
import os, glob
from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "..", "build", "frames")
OUT = os.path.join(HERE, "..", "docs", "demo.gif")
WIDTH = 760
FPS = 4

paths = sorted(glob.glob(os.path.join(FRAMES, "*.png")))
if not paths:
    raise SystemExit("no frames")

imgs = [Image.open(p).convert("RGB") for p in paths]

# Find the first and last frame that differ from the opening frame, so we trim
# dead air at both ends without hand-picking indices.
base = imgs[0]
def changed(im):
    d = ImageChops.difference(im, base).convert("L")
    return (d.point(lambda v: 255 if v > 18 else 0).getbbox() is not None)

idx = [i for i, im in enumerate(imgs) if changed(im)]
start = max(0, (idx[0] - 2) if idx else 0)
end = min(len(imgs), (idx[-1] + 8) if idx else len(imgs))
imgs = imgs[start:end]

w, h = imgs[0].size
size = (WIDTH, int(h * WIDTH / w))
imgs = [im.resize(size, Image.LANCZOS) for im in imgs]

# One shared adaptive palette across all frames avoids per-frame flicker.
pal = imgs[0].quantize(colors=128, method=Image.MEDIANCUT)
frames = [im.quantize(palette=pal, dither=Image.FLOYDSTEINBERG) for im in imgs]

os.makedirs(os.path.dirname(OUT), exist_ok=True)
frames[0].save(OUT, save_all=True, append_images=frames[1:],
               duration=int(1000 / FPS), loop=0, optimize=True)
mb = os.path.getsize(OUT) / 1e6
print(f"{OUT}: {len(frames)} frames, {size[0]}x{size[1]}, {mb:.2f} MB "
      f"(trimmed {start} lead / {len(paths)-end} tail)")
