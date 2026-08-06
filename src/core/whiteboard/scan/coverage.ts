/**
 * How much ink covers each pixel, 0–255 — the anti-aliasing the cleaned raster
 * paints with.
 *
 * Extraction answers a yes/no question (is this pixel ink?), and painting that
 * answer directly gives a 1-bit image: every stroke edge is a staircase, and a
 * stroke thinner than the display scale either snaps on or vanishes. That is
 * what made a lightly-drawn circle read as "missing pieces" in phase-5 UAT
 * even though the mask contained every pixel of it — the file was complete and
 * the *rendering* was not.
 *
 * The fix costs nothing, because the information was already measured and then
 * thrown away: the normalized image says how far each pixel sits from board
 * white, and that is coverage. So the mask still decides WHAT is ink and the
 * normalized image decides HOW MUCH, which is the division of labour the
 * binarizer's threshold destroyed.
 *
 * Two details make it correct rather than merely soft:
 *
 * - **Inkness is `255 − min(R,G,B)`, not darkness.** A yellow marker is
 *   brighter than the board in two channels and is found by the chroma gate,
 *   not the luminance one; measuring coverage by luminance would render it
 *   nearly transparent. Distance from white is the colour-agnostic question.
 * - **Each component is normalized against its OWN core** (the pixels colour
 *   voting trusts, `distance ≥ 0.6·dtMax`), so a light stroke reads as solidly
 *   present with soft edges rather than as a uniformly faint smear. Coverage
 *   answers "where is this stroke", not "how hard was it pressed"; the flat
 *   per-component colour already carries the marker's identity.
 *
 * Coverage also extends ONE pixel beyond the mask, into the ring the threshold
 * cut off. Without it the taper would start partway up and still land on a
 * hard step at the mask boundary.
 */

import type { InkExtraction } from './components';
import type { RgbaImage } from './types';

/** Core pixels are those the distance transform puts at ≥ this × the max. */
const CORE_FRACTION = 0.6;

/**
 * The core is BY DEFINITION fully inked, so the reference it sets must
 * saturate rather than land at exactly 1.0 — otherwise half the interior of
 * every stroke sits a hair under full opacity (the core mean has pixels on
 * both sides of it) and no pixel anywhere is the flat palette colour. Scaling
 * the reference down by a tenth makes the whole plateau clamp to solid and
 * leaves the taper to the rim, which is the only place it belongs.
 */
const CORE_SATURATION = 0.9;

/** Distance from board white, 0–255 — high for any ink of any colour. */
function inkness(data: Uint8ClampedArray, p: number): number {
  const r = data[p]!;
  const g = data[p + 1]!;
  const b = data[p + 2]!;
  return 255 - Math.min(r, g, b);
}

/**
 * Per-pixel ink coverage over the whole frame, 0 (board) to 255 (solid ink).
 *
 * Deterministic and allocation-light: two passes over each component's bbox,
 * no per-component arrays.
 */
export function inkCoverage(normalized: RgbaImage, extraction: InkExtraction): Uint8Array {
  const { width, height, data } = normalized;
  const { labels, distance, components } = extraction;
  const coverage = new Uint8Array(width * height);
  if (components.length === 0) {
    return coverage;
  }

  // Pass 1 — each component's reference inkness: the mean over its core. The
  // core excludes the anti-aliased rim, so this is the stroke's true depth
  // rather than an average dragged down by its own edges.
  let maxLabel = 0;
  for (const c of components) {
    if (c.label > maxLabel) {
      maxLabel = c.label;
    }
  }
  const sum = new Float64Array(maxLabel + 1);
  const count = new Int32Array(maxLabel + 1);
  for (const c of components) {
    const floor = CORE_FRACTION * c.dtMax;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * width + x;
        if (labels[i] !== c.label || distance[i]! < floor) {
          continue;
        }
        sum[c.label] = sum[c.label]! + inkness(data, i * 4);
        count[c.label]!++;
      }
    }
  }
  const reference = new Float64Array(maxLabel + 1);
  for (const c of components) {
    const n = count[c.label]!;
    // A component with no core pixel at all still needs a scale; its own
    // pixels are all rim, so they are what it is made of.
    reference[c.label] = n > 0 ? Math.max(1, (CORE_SATURATION * sum[c.label]!) / n) : 1;
  }

  // Pass 2 — coverage for mask pixels, then the one-pixel ring outside them.
  // The ring reads its scale from the neighbour it belongs to.
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    if (label === 0) {
      continue;
    }
    const value = (inkness(data, i * 4) / reference[label]!) * 255;
    coverage[i] = value >= 255 ? 255 : value <= 0 ? 0 : Math.round(value);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (labels[i] !== 0) {
        continue;
      }
      let label = 0;
      for (let dy = -1; dy <= 1 && label === 0; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) {
            continue;
          }
          const neighbour = labels[ny * width + nx]!;
          if (neighbour !== 0) {
            label = neighbour;
            break;
          }
        }
      }
      if (label === 0) {
        continue;
      }
      const value = (inkness(data, i * 4) / reference[label]!) * 255;
      coverage[i] = value >= 255 ? 255 : value <= 0 ? 0 : Math.round(value);
    }
  }
  return coverage;
}
