import os
from PIL import Image

# Build the macOS menu-bar template icon from the real QQ-penguin app artwork.
# Template images only use the alpha channel (system tints them), so we render
# the penguin BODY as ink and carve out the lighter SCARF as negative space.

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "..", "..", "..", "build", "icon-client-others.png")
OUT = os.path.join(HERE, "tray-template.rgba")
SIZE = 44
INK_MAX_LUM = 113  # body ~104 -> ink ; scarf/belly ~120 -> transparent

im = Image.open(SRC).convert("RGBA")
W, H = im.size
px = im.load()

# full-res ink mask (255 = ink), then downscale for anti-aliasing
mask = Image.new("L", (W, H), 0)
mpx = mask.load()
for y in range(H):
    for x in range(W):
        r, g, b, a = px[x, y]
        if a < 128:
            continue
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum < INK_MAX_LUM:
            mpx[x, y] = a  # keep edge anti-aliasing from the source alpha

# trim to the penguin's bounding box so it fills the icon, then fit into a
# square canvas with a little padding before the final downscale
bbox = mask.getbbox()
mask = mask.crop(bbox)
bw, bh = mask.size
side = max(bw, bh)
pad = int(side * 0.06)
canvas = Image.new("L", (side + 2 * pad, side + 2 * pad), 0)
canvas.paste(mask, (pad + (side - bw) // 2, pad + (side - bh) // 2))

small = canvas.resize((SIZE, SIZE), Image.LANCZOS)
spx = small.load()

buf = bytearray()
for y in range(SIZE):
    for x in range(SIZE):
        buf += bytes((0, 0, 0, spx[x, y]))
assert len(buf) == SIZE * SIZE * 4
with open(OUT, "wb") as f:
    f.write(buf)
print("wrote", OUT, "bytes:", len(buf))

for y in range(SIZE):
    row = ""
    for x in range(SIZE):
        a = spx[x, y]
        row += "#" if a > 180 else ("+" if a > 60 else ".")
    print(row)
