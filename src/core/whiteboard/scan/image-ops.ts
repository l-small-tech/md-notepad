/**
 * Raster primitives the scan pipeline shares: downscaling, luminance, Otsu, and
 * connected components. Pure, allocation-explicit, and typed-array only.
 *
 * Nothing here is clever. It is here so that `quad.ts` (phase 4) and the
 * illumination/ink stages (phase 5) draw from ONE implementation of each —
 * three subtly different box filters is exactly how a pipeline stops being
 * reproducible.
 */

import type { RgbaImage } from './types';

/** Rec. 709 luma, 0–255, one byte per pixel. */
export function luminance(image: RgbaImage): Uint8ClampedArray {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
  }
  return out;
}

/**
 * Box-average downscale to at most `maxEdge` on the long side. Returns the
 * SAME image object when it already fits, so callers can skip a copy.
 *
 * Averaging rather than nearest-neighbour is load-bearing for detection: a
 * subsampled photo aliases marker strokes into speckle, and Otsu then splits
 * the speckle instead of the board.
 */
export function downscale(image: RgbaImage, maxEdge: number): RgbaImage {
  const { width, height } = image;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge || maxEdge <= 0) {
    return image;
  }
  const scale = maxEdge / longEdge;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  return resample(image, outW, outH);
}

/** Box-average resample to an explicit size (source must not be smaller). */
export function resample(image: RgbaImage, outW: number, outH: number): RgbaImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = width / outW;
  const sy = height / outH;
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * width + xx) * 4;
          r += data[p]!;
          g += data[p + 1]!;
          b += data[p + 2]!;
          a += data[p + 3]!;
          n++;
        }
      }
      const q = (y * outW + x) * 4;
      out[q] = r / n;
      out[q + 1] = g / n;
      out[q + 2] = b / n;
      out[q + 3] = a / n;
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * Otsu's threshold over a 0–255 histogram: the level that maximizes
 * between-class variance. Returns the level itself; "bright" means `> level`.
 */
export function otsuThreshold(gray: Uint8ClampedArray): number {
  const histogram = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) {
    const level = gray[i]!;
    histogram[level] = (histogram[level] ?? 0) + 1;
  }
  const total = gray.length;
  let sum = 0;
  for (let level = 0; level < 256; level++) {
    sum += level * histogram[level]!;
  }
  let sumBelow = 0;
  let countBelow = 0;
  let best = 0;
  let bestVariance = -1;
  for (let level = 0; level < 256; level++) {
    countBelow += histogram[level]!;
    if (countBelow === 0) {
      continue;
    }
    const countAbove = total - countBelow;
    if (countAbove === 0) {
      break;
    }
    sumBelow += level * histogram[level]!;
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sum - sumBelow) / countAbove;
    const variance = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = level;
    }
  }
  return best;
}

/** One labelled blob: which pixels, where, and how it meets the frame edge. */
export interface Component {
  readonly label: number;
  readonly area: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Whether the blob reaches the left/top/right/bottom image border. */
  readonly touchesBorder: readonly [boolean, boolean, boolean, boolean];
}

export interface LabelledImage {
  /** `width * height` labels; 0 = background, 1..n = component index + 1. */
  readonly labels: Int32Array;
  readonly components: readonly Component[];
}

/**
 * 8-connected labelling of a boolean mask, iterative (an explicit stack, not
 * recursion — a full-frame blob at 480 px is 300 k pixels deep and would blow
 * the JS stack on the first bright wall).
 */
export function labelComponents(
  mask: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): LabelledImage {
  const labels = new Int32Array(width * height);
  const components: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < labels.length; start++) {
    if (mask[start] === 0 || labels[start] !== 0) {
      continue;
    }
    const label = components.length + 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const touches: [boolean, boolean, boolean, boolean] = [false, false, false, false];
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      area++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x === 0) touches[0] = true;
      if (y === 0) touches[1] = true;
      if (x === width - 1) touches[2] = true;
      if (y === height - 1) touches[3] = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) {
            continue;
          }
          const n = ny * width + nx;
          if (mask[n] !== 0 && labels[n] === 0) {
            labels[n] = label;
            stack.push(n);
          }
        }
      }
    }
    components.push({ label, area, minX, minY, maxX, maxY, touchesBorder: touches });
  }
  return { labels, components };
}

/**
 * Rotate a quarter turn clockwise — the crop screen's "the camera guessed the
 * orientation wrong" button. Pure index arithmetic, and therefore here rather
 * than in the DOM module: an off-by-one in the destination index is invisible
 * by eye on a photograph and obvious to a 2×3 fixture.
 */
export function rotate90(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      // (x, y) → (height - 1 - y, x); the rotated image's width is `height`.
      const to = (x * height + (height - 1 - y)) * 4;
      out[to] = data[from]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from + 2]!;
      out[to + 3] = data[from + 3]!;
    }
  }
  return { width: height, height: width, data: out };
}

/** Bilinear RGBA sample; out-of-bounds coordinates clamp to the edge. */
export function sampleBilinear(
  image: RgbaImage,
  x: number,
  y: number,
  out: Uint8ClampedArray,
  at: number,
): void {
  const { width, height, data } = image;
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const p00 = (y0 * width + x0) * 4;
  const p10 = (y0 * width + x1) * 4;
  const p01 = (y1 * width + x0) * 4;
  const p11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = data[p00 + c]! + (data[p10 + c]! - data[p00 + c]!) * fx;
    const bottom = data[p01 + c]! + (data[p11 + c]! - data[p01 + c]!) * fx;
    out[at + c] = top + (bottom - top) * fy;
  }
}
