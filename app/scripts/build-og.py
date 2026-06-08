#!/usr/bin/env python3
# Generate og.png -- the 1200x630 social-share image for abnormies.art.
#
# One-shot: re-run when the visual or copy goes stale. Writes to the repo root so
# build.mjs picks it up via the rootFiles allowlist (and re-hashes the ?v= cache
# bust on every social/canonical meta tag automatically).
#
# The left preview is NOT a hand-drawn approximation: build-og-grid.mjs runs the
# actual teaser renderer (extracted verbatim from newsite/pages/index.html) and
# returns a real 40x40 grid, which we paint with the renderer's own palette. The
# wordmark uses Robotastic -- the same display face the live site loads -- decoded
# from the @font-face in public/styles.css so there is one source of truth for the
# font. The tagline uses Georgia, the site's body face.

import base64
import json
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1200, 630
BG = (236, 232, 222)   # --bg  #ece8de (live site body background)
TEXT = (28, 26, 23)    # --text  #1c1a17
MUTED = (107, 102, 94) # --muted #6b665e

# Renderer cloud palette, indices 0..3 matching COLORS in index.html
# (Sky, Cirrus, Altocumulus, Nimbostratus).
PALETTE = [(0xE3, 0xE5, 0xE4), (0xB0, 0xB1, 0xB0), (0x7C, 0x7D, 0x7E), (0x48, 0x49, 0x4B)]

# Grid placement -- same proportions and left placement as the prior OG card.
GRID = 40
CELL = 12
GRID_W = GRID * CELL  # 480
GRID_X = 90
GRID_Y = (HEIGHT - GRID_W) // 2  # 75

# Right text column. Kept well inside the right edge so Twitter/Facebook center
# crops never clip the wordmark or tagline.
TEXT_X = GRID_X + GRID_W + 90  # 660
RIGHT_SAFE = WIDTH - 70        # 1130
COL_W = RIGHT_SAFE - TEXT_X    # 470

TAGLINE = ("A constantly evolving on-chain experiment in network effects, "
           "lack of control, and randomness.")

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.normpath(os.path.join(HERE, ".."))
REPO_ROOT = os.path.normpath(os.path.join(APP_ROOT, ".."))


def load_grid():
    """Run the real renderer and return its 1600-int grid (0..3)."""
    out = subprocess.run(
        ["node", os.path.join(HERE, "build-og-grid.mjs")],
        capture_output=True, text=True, cwd=APP_ROOT,
    )
    if out.returncode != 0:
        sys.stderr.write(out.stderr)
        raise SystemExit("build-og-grid.mjs failed")
    data = json.loads(out.stdout)
    return data["grid"], data["spec"]


def robotastic_font_path():
    """Decode the Robotastic TTF from the @font-face in public/styles.css."""
    css = open(os.path.join(APP_ROOT, "public", "styles.css"), "r", encoding="utf-8").read()
    m = re.search(r"data:font/ttf;base64,([A-Za-z0-9+/=]+)", css)
    if not m:
        raise SystemExit("Could not find the Robotastic @font-face base64 in styles.css")
    ttf = base64.b64decode(m.group(1))
    fd, path = tempfile.mkstemp(suffix=".ttf", prefix="robotastic-")
    os.write(fd, ttf)
    os.close(fd)
    return path


def fit_font(draw, path, text, max_w, start, floor=40, step=2):
    """Largest size at which `text` fits within max_w."""
    size = start
    while size > floor:
        f = ImageFont.truetype(path, size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= step
    return ImageFont.truetype(path, floor)


def wrap(draw, text, font, max_w):
    lines, cur = [], ""
    for word in text.split():
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def main():
    grid, spec = load_grid()
    robotastic = robotastic_font_path()

    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)

    # Left: the real 40x40 render. Every cell is painted (Sky included), so the
    # canvas field reads clearly against the cream even for a minimal Abnormie.
    for y in range(GRID):
        for x in range(GRID):
            v = grid[y * GRID + x]
            x0 = GRID_X + x * CELL
            y0 = GRID_Y + y * CELL
            draw.rectangle([x0, y0, x0 + CELL - 1, y0 + CELL - 1], fill=PALETTE[v])

    # Hairline border around the grid.
    draw.rectangle([GRID_X - 1, GRID_Y - 1, GRID_X + GRID_W, GRID_Y + GRID_W],
                   outline=TEXT, width=1)

    # Right: wordmark + tagline, sized to stay inside the right safe margin and
    # vertically centered against the grid.
    title_font = fit_font(draw, robotastic, "ABNORMIES", COL_W, start=104)
    sub_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 28)
    sub_lines = wrap(draw, TAGLINE, sub_font, COL_W)

    t0, t1 = title_font.getbbox("ABNORMIES")[1], title_font.getbbox("ABNORMIES")[3]
    title_h = t1 - t0
    line_h = sub_font.getbbox("Ag")[3] - sub_font.getbbox("Ag")[1]
    line_gap = 10
    sub_block_h = len(sub_lines) * line_h + (len(sub_lines) - 1) * line_gap
    title_gap = 34

    block_h = title_h + title_gap + sub_block_h
    top = GRID_Y + (GRID_W - block_h) // 2

    # Draw title (compensate for the font's top bearing so `top` is the visual top).
    draw.text((TEXT_X, top - t0), "ABNORMIES", font=title_font, fill=TEXT)

    y = top + title_h + title_gap
    for line in sub_lines:
        ly0 = sub_font.getbbox(line)[1]
        draw.text((TEXT_X, y - ly0), line, font=sub_font, fill=MUTED)
        y += line_h + line_gap

    out = os.path.join(REPO_ROOT, "og.png")
    img.save(out, "PNG", optimize=True)
    print(f"Wrote {out} ({os.path.getsize(out)} bytes) -- "
          f"normie #{spec['normieId']}, {spec['state']}"
          f"{', inverted' if spec.get('inverted') else ''}")
    os.remove(robotastic)


if __name__ == "__main__":
    main()
