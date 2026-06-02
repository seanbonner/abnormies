#!/usr/bin/env python3
# Generate og.png — the 1200x630 social-share image for abnormies.art.
# One-shot: re-run when the visual or copy goes stale (e.g. phase changes).
# Writes to the repo root so build.mjs picks it up via the rootFiles allowlist.

import os
import random
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1200, 630
BG = (236, 232, 222)     # --bg #ece8de
TEXT = (28, 26, 23)      # --text #1c1a17
MUTED = (107, 102, 94)   # --muted #6b665e
ACCENT = (138, 79, 48)   # --accent #8a4f30

# Cloud palette — lightest to darkest, mirroring the renderer's mark shading.
PALETTE = [
    (227, 229, 228),  # Sky
    (198, 200, 198),
    (162, 165, 162),
    (122, 125, 122),
    (74, 77, 74),
    (40, 42, 40),
]

img = Image.new("RGB", (WIDTH, HEIGHT), BG)
draw = ImageDraw.Draw(img)

# Left half: 40x40 procedural grid, ~50% coverage, deterministic seed.
GRID = 40
CELL = 12
GRID_W = GRID * CELL  # 480
GRID_X = 90
GRID_Y = (HEIGHT - GRID_W) // 2

random.seed(1729)
for y in range(GRID):
    for x in range(GRID):
        r = random.random()
        if r < 0.50:
            shade = random.choices(PALETTE, weights=[6, 4, 3, 2, 2, 1])[0]
            draw.rectangle(
                [GRID_X + x * CELL, GRID_Y + y * CELL,
                 GRID_X + (x + 1) * CELL - 1, GRID_Y + (y + 1) * CELL - 1],
                fill=shade,
            )

# Hairline border around the grid.
draw.rectangle(
    [GRID_X - 1, GRID_Y - 1, GRID_X + GRID_W, GRID_Y + GRID_W],
    outline=TEXT, width=1,
)

# Right half: wordmark + tagline + status.
TEXT_X = GRID_X + GRID_W + 90

title_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Courier New Bold.ttf", 92)
sub_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 30)
status_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Courier New Bold.ttf", 22)

draw.text((TEXT_X, GRID_Y + 20), "ABNORMIES", font=title_font, fill=TEXT)

draw.text(
    (TEXT_X, GRID_Y + 140),
    "A fully on-chain art\ncollection paired 1:1\nwith Normies.",
    font=sub_font, fill=MUTED, spacing=10,
)

draw.text(
    (TEXT_X, GRID_Y + GRID_W - 32),
    "PHASE II · MINT OPEN",
    font=status_font, fill=ACCENT,
)

# Write to site repo root (one dir up from app/, then one more for site/).
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.normpath(os.path.join(here, "..", "..", "og.png"))
img.save(out, "PNG", optimize=True)
print(f"Wrote {out} ({os.path.getsize(out)} bytes)")
