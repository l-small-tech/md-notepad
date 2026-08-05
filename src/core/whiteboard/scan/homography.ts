/**
 * S1 (second half) — rectify.
 *
 * Two jobs. Recover the board's TRUE aspect ratio from a photo taken at an
 * angle (Zhang & He, *Whiteboard Scanning and Image Enhancement*, MSR-TR-2003-39
 * §2.1 — the paper is about exactly this problem), and warp the quad onto a
 * rectangle of that shape.
 *
 * The warp is an INVERSE map: iterate the destination and pull each pixel from
 * the source with bilinear sampling. Forward-mapping a projective transform
 * leaves holes wherever the source stretches, which no amount of splatting
 * fixes cleanly.
 */

import { sampleBilinear } from './image-ops';
import type { Homography, Quad, RgbaImage, ScanPoint } from './types';

/**
 * The projective transform taking `src`'s four corners onto `dst`'s, by direct
 * linear transform: eight correspondences (two per corner) in eight unknowns,
 * with `i` fixed at 1. Gaussian elimination with partial pivoting.
 *
 * Returns null for a degenerate correspondence (three collinear corners), which
 * a hand-dragged crop quad can genuinely produce.
 */
export function solveHomography(src: Quad, dst: Quad): Homography | null {
  // Row-major 8×9 augmented matrix.
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    m.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    m.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) {
        pivot = row;
      }
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) {
      return null;
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const head = m[col]!;
    const scale = head[col]!;
    for (let c = col; c < 9; c++) {
      head[c] = head[c]! / scale;
    }
    for (let row = 0; row < 8; row++) {
      if (row === col) {
        continue;
      }
      const factor = m[row]![col]!;
      if (factor === 0) {
        continue;
      }
      for (let c = col; c < 9; c++) {
        m[row]![c] = m[row]![c]! - factor * head[c]!;
      }
    }
  }
  const h = m.map((row) => row[8]!);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** Apply a homography to a point. */
export function applyHomography(h: Homography, p: ScanPoint): ScanPoint {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** The inverse transform (the adjugate — scale is irrelevant to a homography). */
export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) {
    return null;
  }
  return [
    e * j - f * i,
    c * i - b * j,
    b * f - c * e,
    f * g - d * j,
    a * j - c * g,
    c * d - a * f,
    d * i - e * g,
    b * g - a * i,
    a * e - b * d,
  ];
}

/**
 * The aspect ratio (width / height) of the real-world rectangle that projects
 * to `quad`, assuming a pinhole camera whose principal point is the image
 * centre and whose pixels are square.
 *
 * Zhang & He's closed form: from the corners' homogeneous coordinates derive
 * the scale factors k2, k3 that make the projective relation consistent, form
 * the two vanishing directions n2, n3, and require them to be orthogonal under
 * the image of the absolute conic — which yields f², and then the ratio.
 *
 * Returns null when the shot is near fronto-parallel (n2 or n3 goes to
 * infinity) or when f² comes out non-positive, both of which mean the geometry
 * carries no perspective information to recover the ratio FROM. The caller
 * falls back to the mean of the opposite-side length ratios, which is exactly
 * right in that case.
 */
export function quadAspectRatio(
  quad: Quad,
  imageWidth: number,
  imageHeight: number,
): number | null {
  // The paper's corner naming: m1 top-left, m2 top-right, m3 BOTTOM-LEFT,
  // m4 bottom-right. Our Quad order is TL, TR, BR, BL.
  const m1 = [quad[0].x, quad[0].y, 1] as const;
  const m2 = [quad[1].x, quad[1].y, 1] as const;
  const m3 = [quad[3].x, quad[3].y, 1] as const;
  const m4 = [quad[2].x, quad[2].y, 1] as const;

  const cross3 = (a: readonly number[], b: readonly number[]): number[] => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
  const dot3 = (a: readonly number[], b: readonly number[]): number =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

  const m1xm4 = cross3(m1, m4);
  const denom2 = dot3(cross3(m2, m4), m3);
  const denom3 = dot3(cross3(m3, m4), m2);
  if (Math.abs(denom2) < 1e-9 || Math.abs(denom3) < 1e-9) {
    return null;
  }
  const k2 = dot3(m1xm4, m3) / denom2;
  const k3 = dot3(m1xm4, m2) / denom3;

  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  const u0 = imageWidth / 2;
  const v0 = imageHeight / 2;
  // Near-fronto-parallel: k2 → 1 (or k3 → 1) drives n2z (n3z) to zero and the
  // focal-length solve to infinity. There is no perspective to invert.
  if (Math.abs(n2[2]!) < 1e-6 || Math.abs(n3[2]!) < 1e-6) {
    return null;
  }

  const f2 =
    -(
      (n2[0]! - n2[2]! * u0) * (n3[0]! - n3[2]! * u0) +
      (n2[1]! - n2[2]! * v0) * (n3[1]! - n3[2]! * v0)
    ) /
    (n2[2]! * n3[2]!);
  if (!(f2 > 0) || !Number.isFinite(f2)) {
    return null;
  }

  const numerator = (n2[0]! - n2[2]! * u0) ** 2 + (n2[1]! - n2[2]! * v0) ** 2 + f2 * n2[2]! ** 2;
  const denominator = (n3[0]! - n3[2]! * u0) ** 2 + (n3[1]! - n3[2]! * v0) ** 2 + f2 * n3[2]! ** 2;
  if (!(denominator > 0)) {
    return null;
  }
  const ratio = Math.sqrt(numerator / denominator);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * The naive aspect estimate: the mean of the two horizontal side lengths over
 * the mean of the two vertical ones. Exactly right for a fronto-parallel shot,
 * and the honest fallback when {@link quadAspectRatio} declines.
 */
export function sideLengthAspect(quad: Quad): number {
  const distance = (a: ScanPoint, b: ScanPoint) => Math.hypot(b.x - a.x, b.y - a.y);
  const width = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
  const height = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  return height > 1e-6 ? width / height : 1;
}

/**
 * The destination→source transform for warping `quad` into an
 * `outWidth × outHeight` rectangle.
 *
 * Solved in that direction on purpose: the warp INVERSE-maps (iterate the
 * destination, pull each pixel from the source), so this way the map used in
 * the inner loop is the solved matrix itself, with no inversion — and no
 * inversion's conditioning — anywhere in the path.
 */
export function rectifyTransform(
  quad: Quad,
  outWidth: number,
  outHeight: number,
): Homography | null {
  return solveHomography(
    [
      { x: 0, y: 0 },
      { x: outWidth, y: 0 },
      { x: outWidth, y: outHeight },
      { x: 0, y: outHeight },
    ],
    quad,
  );
}

/**
 * Fill destination rows `[fromY, toY)` of `into` by inverse-mapping through
 * `h` and sampling `image` bilinearly.
 *
 * Row-banded rather than whole-image because a 1800 px warp is ~3.2 M samples
 * — a visible freeze on a tablet if it runs in one go — and the caller wants to
 * yield to the event loop and move a progress bar between bands.
 */
export function warpRows(
  image: RgbaImage,
  h: Homography,
  into: Uint8ClampedArray,
  outWidth: number,
  fromY: number,
  toY: number,
): void {
  for (let y = fromY; y < toY; y++) {
    const py = y + 0.5;
    for (let x = 0; x < outWidth; x++) {
      const px = x + 0.5;
      const w = h[6] * px + h[7] * py + h[8];
      const sx = (h[0] * px + h[1] * py + h[2]) / w;
      const sy = (h[3] * px + h[4] * py + h[5]) / w;
      sampleBilinear(image, sx - 0.5, sy - 0.5, into, (y * outWidth + x) * 4);
    }
  }
}

/** Warp `quad` into a whole `outWidth × outHeight` raster in one call. */
export function warpQuad(
  image: RgbaImage,
  quad: Quad,
  outWidth: number,
  outHeight: number,
): RgbaImage | null {
  const h = rectifyTransform(quad, outWidth, outHeight);
  if (!h) {
    return null;
  }
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);
  warpRows(image, h, data, outWidth, 0, outHeight);
  return { width: outWidth, height: outHeight, data };
}
