/**
 * S3, first half — decide which pixels COULD be ink, without yet deciding
 * which blobs ARE ink (that is `components.ts`).
 *
 * Post-normalization the image is "white board, coloured ink, near-uniform
 * light", so ink is anything dark OR anything saturated — light markers
 * (yellow, orange, pink) are bright but chromatic, and a luminance-only test
 * loses them.
 *
 * The luminance gates are additionally modulated by Sauvola's threshold,
 * `T = m·(1 + k·(s/R − 1))`, rather than Bradley's. Sauvola's dynamic-range
 * term is the point: in a low-variance window the threshold DROPS well below
 * the local mean, so a uniformly blank patch of board declines to produce
 * "ink" at all. Bradley has no such term and is a speckle generator on empty
 * regions. The chroma gates stand on their own — a white-balanced blank board
 * has chroma ≈ 0, so chroma cannot speckle, while a yellow stroke's luminance
 * sits above any sane threshold and NEEDS the chroma path to survive.
 */

import type { RgbaImage } from './types';

/** Sauvola window radius (the window is ≈ 2·radius, spec says ≈ 24 px). */
const SAUVOLA_RADIUS = 12;

/** Sauvola dynamic range of standard deviation. */
const SAUVOLA_R = 128;

/** k for the strong (confident) gate; higher k = stricter. */
const K_STRONG = 0.2;

/** k for the weak (permissive) gate. */
const K_WEAK = 0.08;

/**
 * Below this luminance a pixel is ink REGARDLESS of Sauvola. Sauvola's job is
 * to veto low-contrast speckle on blank board; but inside a solid filled
 * region larger than its window the local mean IS ink-dark, the variance is
 * zero, and the threshold drops below the ink itself — hollowing every filled
 * shape into a ring (found by the phase-6 blob-tracing golden). Absolute
 * darkness needs no local evidence: a normalized blank board sits near 255,
 * and nothing on it — noise, ghosting, shadow residue — comes anywhere near
 * 0.35·255 ≈ 89. Sauvola may veto contrast decisions, never darkness.
 */
const ABSOLUTE_INK_LUM = 0.35;

/** The fixed gates from the plan, luminance 0–1 and chroma 0–1. */
const STRONG_LUM = 0.62;
const STRONG_CHROMA = 0.28;
const STRONG_CHROMA_LUM = 0.88;
const WEAK_LUM = 0.8;
const WEAK_CHROMA = 0.14;
const WEAK_CHROMA_LUM = 0.94;

export interface InkMasks {
  /** Confidently ink. Always a subset of `weak`. */
  readonly strong: Uint8Array;
  /** Possibly ink; a weak-only blob survives only via hysteresis. */
  readonly weak: Uint8Array;
  /** Rec. 709 luminance of the normalized image, 0–255, for reuse. */
  readonly luminance: Uint8ClampedArray;
  /** max(R,G,B) − min(R,G,B) per pixel, 0–255, for reuse. */
  readonly chroma: Uint8ClampedArray;
}

/**
 * Classify every pixel of the NORMALIZED image as strong / weak / blank.
 * `exclude` (the glare mask) pre-empts both gates: a blown highlight has no
 * information and must not manufacture ink.
 */
export function binarize(normalized: RgbaImage, exclude?: Uint8Array): InkMasks {
  const { width, height, data } = normalized;
  const n = width * height;
  const lum = new Uint8ClampedArray(n);
  const chroma = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  // Integral images over luminance for the Sauvola windows.
  const integral = new Float64Array((width + 1) * (height + 1));
  const integralSq = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < width; x++) {
      const v = lum[y * width + x]!;
      rowSum += v;
      rowSumSq += v * v;
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1]! + rowSum;
      integralSq[(y + 1) * (width + 1) + x + 1] = integralSq[y * (width + 1) + x + 1]! + rowSumSq;
    }
  }

  const strong = new Uint8Array(n);
  const weak = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - SAUVOLA_RADIUS);
    const y1 = Math.min(height - 1, y + SAUVOLA_RADIUS);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (exclude !== undefined && exclude[i] !== 0) {
        continue;
      }
      const l = lum[i]! / 255;
      const c = chroma[i]! / 255;
      const chromaStrong = c > STRONG_CHROMA && l < STRONG_CHROMA_LUM;
      const chromaWeak = c > WEAK_CHROMA && l < WEAK_CHROMA_LUM;
      let lumStrong = false;
      let lumWeak = false;
      if (l < WEAK_LUM) {
        const x0 = Math.max(0, x - SAUVOLA_RADIUS);
        const x1 = Math.min(width - 1, x + SAUVOLA_RADIUS);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          integral[(y1 + 1) * (width + 1) + x1 + 1]! -
          integral[y0 * (width + 1) + x1 + 1]! -
          integral[(y1 + 1) * (width + 1) + x0]! +
          integral[y0 * (width + 1) + x0]!;
        const sumSq =
          integralSq[(y1 + 1) * (width + 1) + x1 + 1]! -
          integralSq[y0 * (width + 1) + x1 + 1]! -
          integralSq[(y1 + 1) * (width + 1) + x0]! +
          integralSq[y0 * (width + 1) + x0]!;
        const mean = sum / count;
        const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        const value = lum[i]!;
        lumWeak = value < mean * (1 + K_WEAK * (std / SAUVOLA_R - 1));
        lumStrong = l < STRONG_LUM && value < mean * (1 + K_STRONG * (std / SAUVOLA_R - 1));
        if (l < ABSOLUTE_INK_LUM) {
          lumWeak = true;
          lumStrong = true;
        }
      }
      if (lumStrong || chromaStrong) {
        strong[i] = 1;
        weak[i] = 1;
      } else if (lumWeak || chromaWeak) {
        weak[i] = 1;
      }
    }
  }
  return { strong, weak, luminance: lum, chroma };
}
