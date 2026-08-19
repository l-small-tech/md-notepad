#!/usr/bin/env python3
"""Generate the console background images seeded with the built-in themes.

Every image is the same MATERIAL — acrylic frost (heavy blur, saturation
lift, soft bokeh, fine grain) — but each theme gets its own SCENE behind
the glass, drawn from the theme's design notes in core/theme-seeds.ts:
bioluminescence rising in Abyss, a blueprint grid ghosting through
Cyanotype, candlelight and embers in Garnet, a honeycomb lattice in
Honeycomb, a lighthouse sweep across Beacon, and so on.

Structure that must survive recognizably (grids, lattices, beams, rings)
is painted ON the frosted layer with only a light blur of its own — the
same trick the bokeh uses — while color masses go BEHIND the heavy blur.

Deliberately restrained everywhere: dark themes stay dark (mean luminance
~20–35/255, Vantablack under 10), light themes stay near white (~240/255),
because every one of these sits behind terminal text.

Deterministic (fixed seed per theme). Requires numpy + Pillow.
Output: src/assets/theme-backgrounds/<id>-bg.webp
"""

from __future__ import annotations

import os
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

W, H = 2560, 1440
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "theme-backgrounds")

YY, XX = np.mgrid[0:H, 0:W].astype(np.float32)


def hex_rgb(s: str) -> np.ndarray:
    s = s.lstrip("#")
    return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def gradient(top: str, bottom: str) -> np.ndarray:
    t = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    sky = hex_rgb(top)[None, None, :] * (1 - t) + hex_rgb(bottom)[None, None, :] * t
    return np.repeat(sky, W, axis=1)


def cloud(rng: np.random.Generator, cx: float, cy: float, n: int = 7, size: float = 1.0) -> np.ndarray:
    """A soft cloud bank alpha [0,1] centered near (cx, cy) in 0–1 fractions."""
    layer = Image.new("L", (W // 8, H // 8), 0)
    d = ImageDraw.Draw(layer)
    px, py = cx * W / 8, cy * H / 8
    ang = rng.uniform(0, 2 * np.pi)
    for k in range(n):
        step = (k - n / 2) * rng.uniform(14, 26) * size
        bx, by = px + np.cos(ang) * step, py + np.sin(ang) * step * 0.5
        r = rng.uniform(20, 46) * size
        d.ellipse([bx - r, by - r * 0.7, bx + r, by + r * 0.7], fill=int(rng.uniform(120, 220)))
    layer = layer.filter(ImageFilter.GaussianBlur(24 * size))
    return np.asarray(layer.resize((W, H), Image.BILINEAR), dtype=np.float32) / 255.0


def discs(
    rng: np.random.Generator,
    n: int,
    rmin: float,
    rmax: float,
    blur: float,
    region: tuple[float, float, float, float] = (0, 0, 1, 1),
    core: bool = False,
) -> np.ndarray:
    """Soft bokeh discs [0,1] scattered in a region (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = region
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    for _ in range(n):
        x, y = rng.uniform(x0 * W, x1 * W), rng.uniform(y0 * H, y1 * H)
        r = rng.uniform(rmin, rmax)
        b = rng.uniform(0.35, 1.0)
        d.ellipse([x - r, y - r, x + r, y + r], fill=int(140 * b))
        if core:
            rc = r * 0.45
            d.ellipse([x - rc, y - rc, x + rc, y + rc], fill=int(195 * b))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(layer, dtype=np.float32) / 255.0


def lines_layer(draw_fn, blur: float) -> np.ndarray:
    """Run `draw_fn(ImageDraw)` on a fresh L canvas, blur it, return [0,1]."""
    layer = Image.new("L", (W, H), 0)
    draw_fn(ImageDraw.Draw(layer))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(layer, dtype=np.float32) / 255.0


def frost(scene: np.ndarray, blur: float = 48, sat: float = 1.35) -> np.ndarray:
    """The glass: heavy blur erases detail, the saturation lift keeps color."""
    img = Image.fromarray((np.clip(scene, 0, 1) * 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(blur))
    img = ImageEnhance.Color(img).enhance(sat)
    return np.asarray(img, dtype=np.float32) / 255.0


def sheen(center: float = 0.32) -> np.ndarray:
    band = (XX / W) * 0.6 + (YY / H) * 0.4
    return np.exp(-(((band - center) / 0.16) ** 2))


def finish_dark(theme_id: str, rng: np.random.Generator, out: np.ndarray, vignette: float = 0.18) -> None:
    out += sheen()[:, :, None] * 0.010
    out += rng.standard_normal((H, W)).astype(np.float32)[:, :, None] * 0.009
    vx = (XX / W - 0.5) ** 2 + (YY / H - 0.5) ** 2
    out *= (1.0 - vignette * vx * 2.2)[:, :, None]
    save(theme_id, np.clip(out, 0, 1) * 0.92)


def finish_light(theme_id: str, rng: np.random.Generator, out: np.ndarray) -> None:
    out += sheen()[:, :, None] * 0.007
    out += rng.standard_normal((H, W)).astype(np.float32)[:, :, None] * 0.006
    # Lift toward white: caps how dark any wash gets under dark text.
    save(theme_id, 1 - (1 - np.clip(out, 0, 1)) * 0.6)


# One knob for how far any scene departs from the theme's base color. The
# authored strengths keep the COMPOSITION; this pulls the whole set toward
# "barely there" uniformly.
SUBTLE = 0.4


def wash(out: np.ndarray, alpha: np.ndarray, color: str, strength: float) -> np.ndarray:
    """Light-mode color: MULTIPLY the near-white ground toward a tint."""
    return out * (1 - alpha[:, :, None] * strength * SUBTLE * (1 - hex_rgb(color)[None, None, :]))


def glow(out: np.ndarray, alpha: np.ndarray, color: str, strength: float) -> np.ndarray:
    """Dark-mode color: ADD tinted light where the alpha sits."""
    return out + alpha[:, :, None] * hex_rgb(color)[None, None, :] * strength * SUBTLE


def save(theme_id: str, out: np.ndarray) -> None:
    img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{theme_id}-bg.webp")
    img.save(path, "WEBP", quality=80, method=6)
    arr = np.asarray(img).astype(np.float32)
    lum = (0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]).mean()
    print(f"{path}: {os.path.getsize(path) // 1024} KiB, mean luminance {lum:.1f}/255")


# ————————————————————————— dark themes —————————————————————————


def abyss() -> None:
    """The lightless water column: god rays dying from above, bioluminescent
    drift below — the glow rises to meet the last of the light."""
    rng = np.random.default_rng(7)
    scene = gradient("#081627", "#040c17")
    scene = glow(scene, cloud(rng, 0.35, 0.85, size=1.2), "#38b6d8", 0.30)  # cyan bloom, deep
    scene = glow(scene, cloud(rng, 0.72, 0.95, size=0.9), "#5fe0b7", 0.24)  # lure-green, deeper
    scene = glow(scene, cloud(rng, 0.6, 0.15), "#8f9ff0", 0.16)  # violet, near the light
    out = frost(scene)

    # God rays: three broad beams slanting down from the surface.
    def rays(d: ImageDraw.ImageDraw) -> None:
        for fx, hw in ((0.28, 90), (0.45, 60), (0.66, 110)):
            x = fx * W
            d.polygon([(x - hw, -50), (x + hw, -50), (x + hw * 3.2, H), (x - hw * 3.2, H)], fill=60)

    out = glow(out, lines_layer(rays, 60) * np.linspace(1, 0.15, H, dtype=np.float32)[:, None], "#cfe2ee", 0.10)
    # Bioluminescent plankton: a dust of tiny specks, denser toward the bottom.
    out = glow(out, discs(rng, 240, 1.2, 3.0, 3, region=(0, 0.35, 1, 1)), "#5fe0b7", 0.30)
    out = glow(out, discs(rng, 60, 1.5, 3.5, 3, region=(0, 0, 1, 0.5)), "#a8d8e8", 0.22)
    # A few larger jellies of light drifting mid-frame.
    out = glow(out, discs(rng, 14, 8, 22, 9, core=True), "#38b6d8", 0.26)
    finish_dark("abyss", rng, out)


def nightjar() -> None:
    """The nocturnal bird's hour: last amber of dusk on the horizon, a slate
    sky settling above, soft stars, one low moon."""
    rng = np.random.default_rng(11)
    scene = gradient("#14171e", "#101319")
    horizon = np.exp(-(((YY / H) - 0.88) / 0.16) ** 2)  # dusk band low in frame
    scene = glow(scene, horizon, "#e69f00", 0.16)
    scene = glow(scene, cloud(rng, 0.3, 0.75), "#cc79a7", 0.10)  # mauve cloud on the dusk
    scene = glow(scene, cloud(rng, 0.7, 0.25), "#56b4e9", 0.12)  # night blue above
    out = frost(scene)
    # Sparse stars, thinning toward the horizon; one soft moon high left.
    stars = discs(rng, 190, 1.2, 3.2, 3, region=(0, 0, 1, 0.7))
    out = glow(out, stars * np.linspace(1, 0.2, H, dtype=np.float32)[:, None], "#e8f2ff", 0.30)

    def moon(d: ImageDraw.ImageDraw) -> None:
        x, y, r = 0.2 * W, 0.18 * H, 46
        d.ellipse([x - r, y - r, x + r, y + r], fill=150)

    out = glow(out, lines_layer(moon, 12), "#f2ead8", 0.30)
    finish_dark("nightjar", rng, out)


def cyanotype() -> None:
    """The blueprint process: a drafting grid and compass work ghosting
    through Prussian blue, photogram blotches where objects lay on the paper."""
    rng = np.random.default_rng(13)
    scene = gradient("#102540", "#0a1728")
    scene = glow(scene, cloud(rng, 0.7, 0.3, size=1.3), "#2e86ab", 0.22)
    scene = glow(scene, cloud(rng, 0.25, 0.8), "#4fc3e8", 0.16)
    out = frost(scene)

    # The drafting grid, slightly stronger toward the top-left like a sheet
    # caught in raking light.
    def grid(d: ImageDraw.ImageDraw) -> None:
        for x in range(0, W + 1, 176):
            d.line([(x, 0), (x, H)], fill=44, width=3)
        for y in range(0, H + 1, 176):
            d.line([(0, y), (W, y)], fill=44, width=3)

    fade = np.clip(1.1 - ((XX / W) * 0.5 + (YY / H) * 0.5), 0.25, 1.0)
    out = glow(out, lines_layer(grid, 5) * fade, "#dcebf5", 0.38)

    # Compass work: two circle outlines and an arc, like a lens drawing.
    def compass(d: ImageDraw.ImageDraw) -> None:
        d.ellipse([0.58 * W - 300, 0.42 * H - 300, 0.58 * W + 300, 0.42 * H + 300], outline=70, width=7)
        d.ellipse([0.58 * W - 190, 0.42 * H - 190, 0.58 * W + 190, 0.42 * H + 190], outline=52, width=5)
        d.arc([0.06 * W, 0.55 * H, 0.5 * W, 1.35 * H], start=200, end=340, fill=64, width=7)

    out = glow(out, lines_layer(compass, 7), "#dcebf5", 0.30)
    # Photogram blotches — pale where something rested on the paper.
    out = glow(out, discs(rng, 9, 26, 60, 22), "#dcebf5", 0.10)
    finish_dark("cyanotype", rng, out)


def garnet() -> None:
    """Candlelight on cut stone: a warm hearth-glow low in the frame, flame
    bokeh above it, embers drifting up and to the right."""
    rng = np.random.default_rng(17)
    scene = gradient("#1f1116", "#12080b")
    scene = glow(scene, cloud(rng, 0.45, 0.95, size=1.4), "#d65858", 0.26)  # hearth mass
    scene = glow(scene, cloud(rng, 0.6, 0.8), "#e8a04c", 0.18)  # candle amber
    scene = glow(scene, cloud(rng, 0.2, 0.3), "#c97b9d", 0.08)  # rose reflection high
    out = frost(scene)
    # Flame bokeh: warm discs clustered in the lower band.
    out = glow(out, discs(rng, 26, 7, 24, 8, region=(0.1, 0.55, 0.9, 1), core=True), "#e8a04c", 0.28)
    # Embers: tiny hot specks streaming up the right side.
    out = glow(out, discs(rng, 80, 1.2, 3.0, 2.5, region=(0.45, 0.15, 1, 0.9)), "#f0a060", 0.30)
    finish_dark("garnet", rng, out, vignette=0.25)


def amethyst() -> None:
    """The geode at dusk: long crystal facets catching light at a shared
    angle, a gold glint among the violet."""
    rng = np.random.default_rng(19)
    scene = gradient("#1e1730", "#120d1b")
    scene = glow(scene, cloud(rng, 0.65, 0.7, size=1.3), "#a678e8", 0.22)
    scene = glow(scene, cloud(rng, 0.25, 0.3), "#d78ac2", 0.14)
    out = frost(scene)

    # Facets: parallel shards at ~64°, one of them gold.
    def facets(d: ImageDraw.ImageDraw) -> None:
        ca, sa = np.cos(np.radians(64)), np.sin(np.radians(64))
        for k, (f, span, wdt) in enumerate(
            ((0.16, 900, 46), (0.34, 1400, 26), (0.52, 1100, 60), (0.68, 1500, 30), (0.84, 800, 44))
        ):
            cx, cy = f * W + 120, (0.9 - f * 0.55) * H
            p = [(cx - ca * span, cy + sa * span), (cx + ca * span, cy - sa * span)]
            d.line(p, fill=54 if k != 2 else 40, width=wdt)

    shard = lines_layer(facets, 16)
    out = glow(out, shard, "#c9b3f2", 0.20)

    def gold(d: ImageDraw.ImageDraw) -> None:
        ca, sa = np.cos(np.radians(64)), np.sin(np.radians(64))
        cx, cy = 0.44 * W, 0.62 * H
        d.line([(cx - ca * 700, cy + sa * 700), (cx + ca * 700, cy - sa * 700)], fill=60, width=18)

    out = glow(out, lines_layer(gold, 10), "#e8c268", 0.22)
    # Sparkle where facets catch: a few crisp-ish glints along the shards.
    out = glow(out, discs(rng, 26, 2, 6, 3), "#efe6fa", 0.22)
    finish_dark("amethyst", rng, out)


def vantablack() -> None:
    """The void. One remote galaxy smudge and a handful of neon pinpricks —
    the merest proof of depth, holding the high-contrast promise."""
    rng = np.random.default_rng(23)
    out = np.zeros((H, W, 3), dtype=np.float32) + hex_rgb("#010102")[None, None, :]
    # The galaxy: a tilted elliptical smear, cyan core fading pink at the rim.
    r2 = (((XX - 0.68 * W) * 0.85 + (YY - 0.3 * H) * 0.5) / 260) ** 2 + (
        ((YY - 0.3 * H) * 0.85 - (XX - 0.68 * W) * 0.18) / 640
    ) ** 2
    galaxy = np.exp(-r2).astype(np.float32)
    out = glow(out, galaxy, "#4dd9ff", 0.055)
    out = glow(out, np.exp(-r2 * 0.35).astype(np.float32) - galaxy * 0.8, "#ff5c8a", 0.028)
    # Pinpricks in the neon trio.
    for color, n in (("#4dd9ff", 5), ("#ff5c8a", 4), ("#ffd400", 4)):
        out = glow(out, discs(rng, n, 1.4, 2.6, 1.6), color, 0.5)
    finish_dark("vantablack", rng, out, vignette=0.1)


# ————————————————————————— light themes —————————————————————————


def skylark() -> None:
    """The bird's morning: sun pooling in one corner, cloud banks lit from
    that side, Okabe–Ito blue overhead thinning to white."""
    rng = np.random.default_rng(29)
    out = frost(gradient("#eef4fa", "#ffffff"), sat=1.25)
    out = wash(out, np.exp(-(((YY / H) + 0.1) / 0.5) ** 2), "#0072b2", 0.15)  # sky, top
    # Sun: a bright pool upper-right (a lift, since white can't be added to).
    sun = np.exp(-(((XX - 0.82 * W) / 500) ** 2 + ((YY - 0.16 * H) / 380) ** 2)).astype(np.float32)
    out = 1 - (1 - out) * (1 - sun[:, :, None] * 0.5 * SUBTLE)
    out = wash(out, cloud(rng, 0.3, 0.45, size=1.2), "#d55e00", 0.05)  # sunlit cloud shadow
    out = wash(out, cloud(rng, 0.6, 0.75), "#e69f00", 0.07)  # amber ground haze
    out = wash(out, discs(rng, 30, 6, 20, 9), "#0072b2", 0.05)
    finish_light("skylark", rng, out)


def lagoon() -> None:
    """Sun through shallow water: a caustic net of light rings wobbling on
    the sandy floor, one coral glint."""
    rng = np.random.default_rng(31)
    out = frost(gradient("#e2f1ee", "#fbfefd"), sat=1.25)
    out = wash(out, cloud(rng, 0.5, 0.3, size=1.4), "#0e8a94", 0.13)
    out = wash(out, cloud(rng, 0.2, 0.85), "#e0c9a8", 0.10)  # sand warmth

    # Caustics: overlapping wobbly rings, multiplied toward teal.
    def rings(d: ImageDraw.ImageDraw) -> None:
        for _ in range(26):
            x, y = rng.uniform(0, W), rng.uniform(0, H)
            rx, ry = rng.uniform(70, 200), rng.uniform(50, 150)
            d.ellipse([x - rx, y - ry, x + rx, y + ry], outline=70, width=int(rng.uniform(8, 18)))

    out = wash(out, lines_layer(rings, 9), "#2ea8c9", 0.10)
    out = wash(out, discs(rng, 4, 14, 26, 8), "#d96a3e", 0.10)  # coral
    finish_light("lagoon", rng, out)


def marmalade() -> None:
    """The breakfast table in morning light: round jar-lid bokeh in orange
    and honey, one teal saucer off to the side."""
    rng = np.random.default_rng(37)
    out = frost(gradient("#faf0e2", "#fffaf2"), sat=1.25)
    out = wash(out, cloud(rng, 0.7, 0.75, size=1.3), "#c9660d", 0.12)
    out = wash(out, cloud(rng, 0.25, 0.25), "#e09a2b", 0.10)
    # Jar lids: big round pools of orange, a couple of honey ones.
    out = wash(out, discs(rng, 9, 40, 110, 16), "#c9660d", 0.09)
    out = wash(out, discs(rng, 7, 20, 60, 12), "#e09a2b", 0.08)
    out = wash(out, discs(rng, 3, 30, 60, 12, region=(0, 0.5, 0.35, 1)), "#2a7f8c", 0.09)  # the saucer
    finish_light("marmalade", rng, out)


def honeycomb() -> None:
    """Wax and honey: the comb itself — a hex lattice fading in from one
    corner, honey pooling in a few cells, one violet counterpoint."""
    rng = np.random.default_rng(41)
    out = frost(gradient("#faf3dd", "#fffdf4"), sat=1.25)
    out = wash(out, cloud(rng, 0.75, 0.7, size=1.3), "#d4a017", 0.12)
    out = wash(out, cloud(rng, 0.2, 0.2), "#a87708", 0.08)

    # The lattice: pointy-top hexagons, fading toward the lower left.
    s = 120.0  # hex edge

    def lattice(d: ImageDraw.ImageDraw) -> None:
        dx, dy = s * np.sqrt(3), s * 1.5
        for row in range(-1, int(H / dy) + 2):
            for col in range(-1, int(W / dx) + 2):
                cx = col * dx + (dx / 2 if row % 2 else 0)
                cy = row * dy
                pts = [
                    (cx + s * np.sqrt(3) / 2 * np.sin(a), cy + s * np.cos(a))
                    for a in np.radians([0, 60, 120, 180, 240, 300])
                ]
                d.polygon(pts, outline=60, width=7)

    fade = np.clip(((XX / W) * 0.6 - (YY / H) * 0.25 + 0.35), 0.05, 1.0)
    out = wash(out, lines_layer(lattice, 6) * fade, "#a87708", 0.16)
    # Honey pooling in a few cells; the violet counterpoint in one.
    out = wash(out, discs(rng, 6, 40, 80, 14, region=(0.45, 0.1, 1, 0.9)), "#d4a017", 0.10)
    out = wash(out, discs(rng, 1, 50, 60, 12, region=(0.05, 0.55, 0.3, 0.9)), "#6b4fae", 0.07)
    finish_light("honeycomb", rng, out)


def ultramarine() -> None:
    """Ground lapis on gesso: broad diagonal pigment strokes, granulating
    where the wash sits heaviest, a burnt-sienna fleck of the mordant."""
    rng = np.random.default_rng(43)
    out = frost(gradient("#eaeef8", "#fafbfe"), sat=1.25)
    # Brush strokes: diagonal bands of blue, each with soft edges.
    band = (XX / W) * 0.55 + (YY / H) * 0.45
    for center, width, color, strength in (
        (0.22, 0.10, "#2f52c9", 0.14),
        (0.48, 0.07, "#5a7de0", 0.11),
        (0.74, 0.12, "#2f52c9", 0.09),
    ):
        stroke = np.exp(-(((band - center) / width) ** 2)).astype(np.float32)
        ripple = 1 + 0.25 * np.sin(YY / 34 + center * 40).astype(np.float32) * stroke
        out = wash(out, np.clip(stroke * ripple, 0, 1.2), color, strength)
    # Granulation: coarse pigment specks inside the heaviest stroke.
    heavy = np.exp(-(((band - 0.22) / 0.10) ** 2)).astype(np.float32)
    out = wash(out, discs(rng, 160, 1.5, 4, 2.5) * heavy, "#2f52c9", 0.12)
    out = wash(out, discs(rng, 2, 16, 30, 8, region=(0.6, 0.6, 0.95, 0.95)), "#bf5b2d", 0.11)
    finish_light("ultramarine", rng, out)


def dragonfruit() -> None:
    """The fruit itself: magenta flesh pooling at the heart, a scatter of
    tiny seeds, green scale-tips curling in from the edges."""
    rng = np.random.default_rng(47)
    out = frost(gradient("#fbebf2", "#fefafc"), sat=1.25)
    out = wash(out, cloud(rng, 0.55, 0.6, size=1.5), "#c2186f", 0.13)  # the flesh
    out = wash(out, cloud(rng, 0.3, 0.3), "#e05a9a", 0.09)
    # Seeds: a sparse scatter of small dark specks, only where the flesh is.
    flesh = cloud(rng, 0.55, 0.6, size=1.5)
    out = wash(out, discs(rng, 90, 2, 4.5, 2.5) * np.clip(flesh * 2.2, 0, 1), "#3a2430", 0.16)
    # Scale tips: green wisps hooking in from two corners.
    out = wash(out, cloud(rng, 0.06, 0.12, n=4, size=0.8), "#3f9e6f", 0.10)
    out = wash(out, cloud(rng, 0.92, 0.88, n=4, size=0.8), "#3f9e6f", 0.10)
    finish_light("dragonfruit", rng, out)


def beacon() -> None:
    """The lighthouse: one broad beam sweeping across a white field, three
    faint signal glints — primary blue, red, green — far apart."""
    rng = np.random.default_rng(53)
    out = frost(gradient("#ffffff", "#fcfcfe"), sat=1.0)
    # The beam: everything OUTSIDE it carries a whisper of cool shadow, so
    # the sweep reads as light without ever darkening under text.
    ang = np.arctan2(YY - 0.05 * H, XX - 0.08 * W)
    beam = np.exp(-(((ang - np.radians(38)) / 0.13) ** 2)).astype(np.float32)
    out = wash(out, (1 - beam) * 0.9, "#8a94ad", 0.045)
    # Signal glints.
    out = wash(out, discs(rng, 1, 20, 26, 8, region=(0.15, 0.6, 0.3, 0.8)), "#0033cc", 0.055)
    out = wash(out, discs(rng, 1, 16, 22, 8, region=(0.7, 0.2, 0.85, 0.4)), "#cc0000", 0.05)
    out = wash(out, discs(rng, 1, 16, 22, 8, region=(0.55, 0.75, 0.7, 0.9)), "#008055", 0.05)
    finish_light("beacon", rng, out)


if __name__ == "__main__":
    abyss()
    nightjar()
    cyanotype()
    garnet()
    amethyst()
    vantablack()
    skylark()
    lagoon()
    marmalade()
    honeycomb()
    ultramarine()
    dragonfruit()
    beacon()
