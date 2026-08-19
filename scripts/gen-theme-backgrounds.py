#!/usr/bin/env python3
"""Generate the console background images seeded with the built-in themes.

Each image is deep space seen through frosted glass — the acrylic material
recipe (Windows/macOS): render a nebula starfield, put it behind a heavy
gaussian blur, lift saturation so the frost doesn't grey it out, let the
bright stars bloom into soft bokeh discs, then finish with the fine noise
grain that makes acrylic read as a material instead of a gradient.

Deliberately DARK overall — the image sits behind terminal text, so the
constraint that matters is that light text stays readable everywhere.

Deterministic (fixed seed per theme) so a re-run reproduces the shipped
assets byte-for-byte-ish (webp encoder version permitting).

Requires: numpy, Pillow.  Output: src/assets/theme-backgrounds/<id>-bg.webp
"""

from __future__ import annotations

import os
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

W, H = 2560, 1440
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "theme-backgrounds")


def hex_rgb(s: str) -> np.ndarray:
    s = s.lstrip("#")
    return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def nebula_sky(
    rng: np.random.Generator, top: str, bottom: str, nebulae: list[str], strength: float
) -> np.ndarray:
    """The scene BEHIND the glass: gradient space with billowing nebula clouds.
    Detail is pointless (the frost erases it) — what matters is where the
    color masses sit. Returns float RGB [0,1]."""
    t = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    sky = hex_rgb(top)[None, None, :] * (1 - t) + hex_rgb(bottom)[None, None, :] * t
    sky = np.repeat(sky, W, axis=1)

    # Each nebula: a cluster of overlapping soft blobs drifting along a line,
    # so the color reads as a cloud bank rather than one circular spot.
    for color in nebulae:
        layer = Image.new("L", (W // 8, H // 8), 0)
        d = ImageDraw.Draw(layer)
        cx, cy = rng.uniform(0.15, 0.85) * W / 8, rng.uniform(0.15, 0.85) * H / 8
        ang = rng.uniform(0, 2 * np.pi)
        for k in range(7):
            step = (k - 3) * rng.uniform(14, 26)
            bx, by = cx + np.cos(ang) * step, cy + np.sin(ang) * step * 0.5
            r = rng.uniform(20, 46)
            d.ellipse([bx - r, by - r * 0.7, bx + r, by + r * 0.7], fill=int(rng.uniform(120, 220)))
        layer = layer.filter(ImageFilter.GaussianBlur(24))
        a = np.asarray(layer.resize((W, H), Image.BILINEAR), dtype=np.float32) / 255.0
        sky += a[:, :, None] * hex_rgb(color)[None, None, :] * strength
    return sky


def bokeh_stars(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Stars as frosted glass shows them: no points survive the blur, only
    discs of bloom. Returns (small dust, big discs) as float L [0,1] fields."""
    field = np.zeros((H, W), dtype=np.float32)
    # Layer 1: a dust of small dim discs (distant stars just barely blooming).
    small = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(small)
    for _ in range(300):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        r = rng.uniform(1.2, 3.6)
        d.ellipse([x - r, y - r, x + r, y + r], fill=int(rng.uniform(45, 115)))
    small = small.filter(ImageFilter.GaussianBlur(3.5))
    field += np.asarray(small, dtype=np.float32) / 255.0

    # Layer 2: brighter stars → wide soft bokeh discs with a hotter core.
    big = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(big)
    for _ in range(52):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        r = rng.uniform(6, 30)
        b = rng.uniform(0.35, 1.0)
        d.ellipse([x - r, y - r, x + r, y + r], fill=int(140 * b))
        rc = r * 0.45
        d.ellipse([x - rc, y - rc, x + rc, y + rc], fill=int(195 * b))
    big = big.filter(ImageFilter.GaussianBlur(7))
    return np.clip(field, 0, 1), np.asarray(big, dtype=np.float32) / 255.0


def acrylic(
    theme_id: str,
    seed: int,
    sky_top: str,
    sky_bottom: str,
    nebulae: list[str],
    star_tint: str = "#e8f2ff",
    nebula_strength: float = 0.34,
) -> None:
    rng = np.random.default_rng(seed)
    scene = nebula_sky(rng, sky_top, sky_bottom, nebulae, nebula_strength)

    # ——— The frost. Heavy blur is what says "glass"; the saturation lift
    # afterwards is what keeps the frost from greying the color out.
    img = Image.fromarray((np.clip(scene, 0, 1) * 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(48))
    img = ImageEnhance.Color(img).enhance(1.35)
    out = np.asarray(img, dtype=np.float32) / 255.0

    # Bokeh star bloom sits ON the frosted layer (light sources bloom against
    # the glass; they don't get erased like detail does). The small dust stays
    # near-white; the big discs pick up the glass's own color where they sit,
    # like light sources seen THROUGH the tint rather than painted on it.
    dust, big = bokeh_stars(rng)
    out += dust[:, :, None] * hex_rgb(star_tint)[None, None, :] * 0.36
    local = np.clip(out / np.maximum(out.mean(axis=2, keepdims=True), 1e-4), 0.6, 1.6)
    out += big[:, :, None] * hex_rgb(star_tint)[None, None, :] * local * 0.38

    # A faint diagonal sheen — one broad highlight, like light raking a pane.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    band = (xx / W) * 0.6 + (yy / H) * 0.4
    sheen = np.exp(-(((band - 0.32) / 0.16) ** 2))
    out += sheen[:, :, None] * 0.020

    # Acrylic's signature: fine monochrome grain at a few percent.
    grain = rng.standard_normal((H, W)).astype(np.float32)
    out += grain[:, :, None] * 0.015

    # Gentle vignette, then hold the level down: this sits behind text.
    vx = (xx / W - 0.5) ** 2 + (yy / H - 0.5) ** 2
    out *= (1.0 - 0.35 * vx * 2.2)[:, :, None]
    out = np.clip(out, 0, 1) * 0.92

    save(theme_id, out)


def save(theme_id: str, out: np.ndarray) -> None:
    img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{theme_id}-bg.webp")
    img.save(path, "WEBP", quality=80, method=6)
    arr = np.asarray(img).astype(np.float32)
    lum = (0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]).mean()
    print(f"{path}: {os.path.getsize(path) // 1024} KiB, mean luminance {lum:.1f}/255")


def acrylic_light(
    theme_id: str,
    seed: int,
    sky_top: str,
    sky_bottom: str,
    tints: list[str],
    wash_strength: float = 0.16,
    bokeh_strength: float = 0.10,
) -> None:
    """The light-mode variant: bright milk-glass frost with DARK text on top.

    On a near-white ground nothing can be added (white clips), so color goes
    in subtractively — washes and bokeh discs MULTIPLY the ground toward a
    tint, like colored light pooling behind frosted glass. Levels are held
    high everywhere; the final lift toward white caps how far any wash dips.
    """
    rng = np.random.default_rng(seed)
    scene = nebula_sky(rng, sky_top, sky_bottom, tints, 0.0)  # gradient only

    # Colored washes: multiply toward each tint where its cloud sits.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    for color in tints:
        layer = Image.new("L", (W // 8, H // 8), 0)
        d = ImageDraw.Draw(layer)
        cx, cy = rng.uniform(0.15, 0.85) * W / 8, rng.uniform(0.15, 0.85) * H / 8
        ang = rng.uniform(0, 2 * np.pi)
        for k in range(7):
            step = (k - 3) * rng.uniform(14, 26)
            bx, by = cx + np.cos(ang) * step, cy + np.sin(ang) * step * 0.5
            r = rng.uniform(24, 50)
            d.ellipse([bx - r, by - r * 0.7, bx + r, by + r * 0.7], fill=int(rng.uniform(120, 220)))
        layer = layer.filter(ImageFilter.GaussianBlur(26))
        a = np.asarray(layer.resize((W, H), Image.BILINEAR), dtype=np.float32) / 255.0
        wash = 1 - a[:, :, None] * wash_strength * (1 - hex_rgb(color)[None, None, :])
        scene = scene * wash

    # The frost blur + saturation lift, same as the dark variant.
    img = Image.fromarray((np.clip(scene, 0, 1) * 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(48))
    img = ImageEnhance.Color(img).enhance(1.25)
    out = np.asarray(img, dtype=np.float32) / 255.0

    # Bokeh as gentle tinted pools (a dip toward the tint), never bright spots.
    dust, big = bokeh_stars(rng)
    tint = hex_rgb(tints[0])
    pool = np.clip(dust * 0.6 + big, 0, 1)[:, :, None]
    out = out * (1 - pool * bokeh_strength * (1 - tint[None, None, :]))

    # Sheen still works near white as a faint extra brightening band.
    band = (xx / W) * 0.6 + (yy / H) * 0.4
    sheen = np.exp(-(((band - 0.32) / 0.16) ** 2))
    out += sheen[:, :, None] * 0.012

    # Grain, then LIFT toward white: caps how dark any wash can get, keeping
    # the whole surface safe under dark text.
    grain = rng.standard_normal((H, W)).astype(np.float32)
    out += grain[:, :, None] * 0.010
    out = 1 - (1 - np.clip(out, 0, 1)) * 0.85

    save(theme_id, out)


if __name__ == "__main__":
    # ——— Dark themes: deep space behind the frost, nebulae in the palette. ———
    # Abyss: lightless blue water column — cyan / lure-green / jelly-violet.
    acrylic(
        "abyss",
        seed=7,
        sky_top="#071528",
        sky_bottom="#02060c",
        nebulae=["#38b6d8", "#8f9ff0", "#5fe0b7", "#2c2f6e"],
    )
    # Nightjar: nocturnal Okabe–Ito — sky blue, amber, mauve on slate.
    acrylic(
        "nightjar",
        seed=11,
        sky_top="#161a22",
        sky_bottom="#0a0d12",
        nebulae=["#56b4e9", "#e69f00", "#cc79a7", "#274a63"],
    )
    # Cyanotype: the blueprint — Prussian ground, process-cyan clouds.
    acrylic(
        "cyanotype",
        seed=13,
        sky_top="#0e2440",
        sky_bottom="#071322",
        nebulae=["#4fc3e8", "#2e86ab", "#7fd4ee", "#1f4568"],
        star_tint="#dcebf5",
    )
    # Garnet: wine-dark ground, cut-stone red, candlelight amber.
    acrylic(
        "garnet",
        seed=17,
        sky_top="#251318",
        sky_bottom="#10070a",
        nebulae=["#d65858", "#e8a04c", "#c97b9d", "#57262e"],
        star_tint="#f5e6dc",
    )
    # Amethyst: the gemstone at dusk — violet, gold glint, orchid.
    acrylic(
        "amethyst",
        seed=19,
        sky_top="#221836",
        sky_bottom="#0e0a16",
        nebulae=["#a678e8", "#e8c268", "#d78ac2", "#3d2c5c"],
        star_tint="#efe6fa",
    )
    # Vantablack: the high-contrast theme — the merest breath of its neon trio
    # over true black, so the a11y contrast promise survives the image.
    acrylic(
        "vantablack",
        seed=23,
        sky_top="#030304",
        sky_bottom="#000000",
        nebulae=["#4dd9ff", "#ff5c8a", "#ffd400"],
        nebula_strength=0.10,
    )

    # ——— Light themes: bright milk-glass frost, color pooled subtractively. ———
    # Skylark: color-vision-friendly daylight — Okabe–Ito blue/vermilion/amber.
    acrylic_light(
        "skylark",
        seed=29,
        sky_top="#f4f7fa",
        sky_bottom="#ffffff",
        tints=["#0072b2", "#e69f00", "#d55e00"],
    )
    # Lagoon: sun on a sandy reef — teal water, a coral accent.
    acrylic_light(
        "lagoon",
        seed=31,
        sky_top="#e4f2f0",
        sky_bottom="#fbfefd",
        tints=["#0e8a94", "#2ea8c9", "#d96a3e"],
    )
    # Marmalade: breakfast warmth — orange peel, honey, a teal saucer.
    acrylic_light(
        "marmalade",
        seed=37,
        sky_top="#faf0e2",
        sky_bottom="#fffaf2",
        tints=["#c9660d", "#e09a2b", "#2a7f8c"],
    )
    # Honeycomb: wax and honey — gold, old gold, a violet counterpoint.
    acrylic_light(
        "honeycomb",
        seed=41,
        sky_top="#faf3dd",
        sky_bottom="#fffdf4",
        tints=["#d4a017", "#a87708", "#6b4fae"],
    )
    # Ultramarine: ground lapis — cool blue pigment on gessoed white.
    acrylic_light(
        "ultramarine",
        seed=43,
        sky_top="#eaeef8",
        sky_bottom="#fafbfe",
        tints=["#2f52c9", "#5a7de0", "#bf5b2d"],
    )
    # Dragonfruit: blush skin, magenta flesh, green scales.
    acrylic_light(
        "dragonfruit",
        seed=47,
        sky_top="#fbebf2",
        sky_bottom="#fefafc",
        tints=["#c2186f", "#e05a9a", "#3f9e6f"],
    )
    # Beacon: the high-contrast light theme — barely-there primary washes on
    # white, so the a11y contrast promise survives the image.
    acrylic_light(
        "beacon",
        seed=53,
        sky_top="#ffffff",
        sky_bottom="#fdfdfe",
        tints=["#0033cc", "#cc0000", "#008055"],
        wash_strength=0.05,
        bokeh_strength=0.035,
    )
