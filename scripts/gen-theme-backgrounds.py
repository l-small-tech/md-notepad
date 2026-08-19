#!/usr/bin/env python3
"""Generate the console background images seeded with the built-in themes.

Each image is "deep space through thick stained glass": a starfield seen
through irregular leaded glass panes tinted in the owning theme's palette.
Deliberately DARK overall — the image sits behind terminal text, so the
constraint that matters is that light text stays readable on every pane.

Deterministic (fixed seed per theme) so a re-run reproduces the shipped
assets byte-for-byte-ish (webp encoder version permitting).

Requires: numpy, Pillow.  Output: src/assets/theme-backgrounds/<id>-bg.webp
"""

from __future__ import annotations

import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 2560, 1440
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "theme-backgrounds")


def hex_rgb(s: str) -> np.ndarray:
    s = s.lstrip("#")
    return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def make_starfield(rng: np.random.Generator, top: str, bottom: str, nebulae: list[str]) -> np.ndarray:
    """Dark gradient sky + soft nebula washes + stars. Returns float RGB [0,1]."""
    t = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    sky = hex_rgb(top)[None, None, :] * (1 - t) + hex_rgb(bottom)[None, None, :] * t
    sky = np.repeat(sky, W, axis=1)

    # Nebulae: a few big gaussian blobs of low-alpha tinted light.
    for color in nebulae:
        blob = Image.new("L", (W // 4, H // 4), 0)
        d = ImageDraw.Draw(blob)
        cx, cy = rng.uniform(0.1, 0.9) * W / 4, rng.uniform(0.1, 0.9) * H / 4
        r = rng.uniform(0.18, 0.32) * W / 4
        d.ellipse([cx - r, cy - r * 0.6, cx + r, cy + r * 0.6], fill=255)
        blob = blob.filter(ImageFilter.GaussianBlur(r * 0.55))
        a = np.asarray(blob.resize((W, H), Image.BILINEAR), dtype=np.float32) / 255.0
        sky += a[:, :, None] * hex_rgb(color)[None, None, :] * 0.16

    # Stars: power-law brightness, mostly tiny; drawn on a full-res layer.
    stars = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(stars)
    n = 1600
    xs, ys = rng.uniform(0, W, n), rng.uniform(0, H, n)
    mags = rng.power(6.0, n)  # skewed toward dim
    for x, y, m in zip(xs, ys, mags):
        b = int(255 * (0.25 + 0.75 * m))
        r = 0.6 + 2.2 * (m**3)
        d.ellipse([x - r, y - r, x + r, y + r], fill=b)
    # A handful of bright stars with a soft glow halo.
    glow = Image.new("L", (W, H), 0)
    dg = ImageDraw.Draw(glow)
    for _ in range(22):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        r = rng.uniform(5, 11)
        dg.ellipse([x - r, y - r, x + r, y + r], fill=217)
        d.ellipse([x - 1.6, y - 1.6, x + 1.6, y + 1.6], fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(9))
    s = (np.asarray(stars, dtype=np.float32) + np.asarray(glow, dtype=np.float32) * 0.45) / 255.0

    # Thick glass softens points of light a touch.
    s_img = Image.fromarray((np.clip(s, 0, 1) * 255).astype(np.uint8))
    s = np.asarray(s_img.filter(ImageFilter.GaussianBlur(0.8)), dtype=np.float32) / 255.0

    star_tint = np.array([0.92, 0.96, 1.0], dtype=np.float32)
    return sky + s[:, :, None] * star_tint[None, None, :]


def voronoi_maps(rng: np.random.Generator, n_cells: int) -> tuple[np.ndarray, np.ndarray]:
    """Cell index map (H,W) and lead-line mask (H,W) in [0,1], computed at
    quarter res and upscaled — plenty for panes this large."""
    w, h = W // 4, H // 4
    # Jittered grid of seeds → evenly sized panes with organic edges.
    cols = int(np.ceil(np.sqrt(n_cells * w / h)))
    rows = int(np.ceil(n_cells / cols))
    pts = []
    for j in range(rows):
        for i in range(cols):
            pts.append(
                [
                    (i + 0.5 + rng.uniform(-0.42, 0.42)) * w / cols,
                    (j + 0.5 + rng.uniform(-0.42, 0.42)) * h / rows,
                ]
            )
    pts = np.array(pts, dtype=np.float32)

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((xx[None] - pts[:, 0, None, None]) ** 2 + (yy[None] - pts[:, 1, None, None]) ** 2)
    order = np.argsort(d, axis=0)
    idx = order[0]
    d1 = np.take_along_axis(d, order[0:1], axis=0)[0]
    d2 = np.take_along_axis(d, order[1:2], axis=0)[0]

    # Lead line where the two nearest seeds are almost equidistant.
    edge = d2 - d1
    lead_w = 2.6  # at quarter res ≈ 10px leading at full res
    lead = np.clip(1.0 - edge / lead_w, 0.0, 1.0) ** 1.5

    idx_full = np.asarray(
        Image.fromarray(idx.astype(np.uint8)).resize((W, H), Image.NEAREST), dtype=np.int32
    )
    lead_full = np.asarray(
        Image.fromarray((lead * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    return idx_full, lead_full


def stained_glass(
    theme_id: str,
    seed: int,
    sky_top: str,
    sky_bottom: str,
    nebulae: list[str],
    pane_tints: list[str],
    lead_color: str = "#05070c",
) -> None:
    rng = np.random.default_rng(seed)
    base = make_starfield(rng, sky_top, sky_bottom, nebulae)
    idx, lead = voronoi_maps(rng, n_cells=26)
    n = int(idx.max()) + 1

    # Per-pane transmission color: mostly-clear glass multiplied by a tint,
    # plus a faint body glow so the glass reads as material, not a filter.
    tints = np.stack([hex_rgb(pane_tints[i % len(pane_tints)]) for i in rng.permutation(n)])
    strength = rng.uniform(0.55, 0.8, n).astype(np.float32)
    brightness = rng.uniform(0.85, 1.1, n).astype(np.float32)

    trans = (1 - strength[:, None]) + strength[:, None] * tints  # (n,3)
    px_trans = trans[idx] * brightness[idx, None]
    glow = tints[idx] * 0.050

    out = base * px_trans + glow

    # Subtle directional streaks inside each pane (rolled glass texture).
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    angles = rng.uniform(0, np.pi, n).astype(np.float32)
    freq = rng.uniform(0.010, 0.022, n).astype(np.float32)
    phase = rng.uniform(0, 2 * np.pi, n).astype(np.float32)
    coord = xx * np.cos(angles[idx]) + yy * np.sin(angles[idx])
    streak = 1.0 + 0.028 * np.sin(coord * freq[idx] + phase[idx])
    out *= streak[:, :, None]

    # Leading: dark cames with a hair of top-light bevel.
    lead_rgb = hex_rgb(lead_color)
    bevel = np.roll(lead, 3, axis=0) - lead  # lighter just below the top edge
    out = out * (1 - lead[:, :, None]) + lead_rgb[None, None, :] * lead[:, :, None]
    out += np.clip(bevel, 0, 1)[:, :, None] * 0.05

    # Vignette, then hold the overall level down: this sits behind text.
    vx = (xx / W - 0.5) ** 2 + (yy / H - 0.5) ** 2
    out *= (1.0 - 0.55 * vx * 2.2)[:, :, None]
    out = np.clip(out, 0, 1) * 0.92

    img = Image.fromarray((out * 255).astype(np.uint8))
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{theme_id}-bg.webp")
    img.save(path, "WEBP", quality=78, method=6)
    arr = np.asarray(img).astype(np.float32)
    lum = (0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]).mean()
    print(f"{path}: {os.path.getsize(path) // 1024} KiB, mean luminance {lum:.1f}/255")


if __name__ == "__main__":
    # Abyss: lightless blue water column — cyan / lure-green / jelly-violet.
    stained_glass(
        "abyss",
        seed=7,
        sky_top="#050b16",
        sky_bottom="#020509",
        nebulae=["#38b6d8", "#8f9ff0", "#5fe0b7"],
        pane_tints=["#38b6d8", "#5fe0b7", "#8f9ff0", "#1b3a5f", "#123a55", "#2c2f6e"],
    )
