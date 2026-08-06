/**
 * S2 — flat-field normalization. The stage that makes "wide variety of lighting
 * situations" a solved problem instead of a per-photo tuning exercise.
 *
 * Every lighting failure on a whiteboard — side light, cast shadow, vignette,
 * warm or cool colour cast — is a smooth MULTIPLICATIVE field over a surface
 * that is white by definition. So: estimate that field (a wide grayscale
 * dilation recovers board, not ink, because the window is far wider than any
 * stroke), and divide it out per channel. Division does three jobs at once:
 * shadow/gradient removal, vignette removal, and automatic white balance —
 * the board is neutral, so dividing by its measured colour removes the
 * tungsten yellow or daylight blue cast. That last one is why the colour
 * classifier downstream can use fixed hue bins.
 *
 * Glare is the one thing division cannot fix: a blown highlight has no
 * information left. It is DETECTED here (bright and locally flat over a wide
 * window) and reported as a mask, so downstream stages can refuse to
 * manufacture ink out of it and the review screen can say so honestly.
 */

import { resample, sampleBilinear } from './image-ops';
import type { RgbaImage } from './types';

/** The illumination estimate runs at this fraction of full resolution. */
const FIELD_SCALE = 8;

/** Luminance at or above this (0–255) can be a blown highlight… */
const GLARE_LUMINANCE = 250;

/** …when the local standard deviation over a wide window is also below this. */
const GLARE_FLATNESS = 3;

export interface NormalizedImage {
  /** The flat-fielded, white-balanced image. Alpha is carried through. */
  readonly normalized: RgbaImage;
  /**
   * The estimated illumination field at full resolution — what the BOARD
   * looks like with the ink removed. Kept for glare detection and debugging.
   */
  readonly background: RgbaImage;
}

/**
 * Grayscale dilation (running maximum) along one axis — van Herk/Gil-Werman,
 * O(1) per pixel regardless of window size. `radius` pixels either side.
 */
function runningMaxAxis(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  lineCount: number,
  lineLength: number,
  stride: number,
  lineStride: number,
  radius: number,
): void {
  const window = 2 * radius + 1;
  const prefix = new Uint8ClampedArray(lineLength);
  const suffix = new Uint8ClampedArray(lineLength);
  for (let line = 0; line < lineCount; line++) {
    const base = line * lineStride;
    // Prefix maxima restart at every window boundary; suffix maxima run
    // backwards within each block. max(suffix[left], prefix[right]) is then
    // the window maximum — the classic two-pass trick.
    for (let i = 0; i < lineLength; i++) {
      const v = src[base + i * stride]!;
      prefix[i] = i % window === 0 ? v : Math.max(prefix[i - 1]!, v);
    }
    for (let i = lineLength - 1; i >= 0; i--) {
      const v = src[base + i * stride]!;
      suffix[i] = i === lineLength - 1 || (i + 1) % window === 0 ? v : Math.max(suffix[i + 1]!, v);
    }
    for (let i = 0; i < lineLength; i++) {
      const left = i - radius;
      const right = Math.min(lineLength - 1, i + radius);
      // Near the left edge the suffix block would reach beyond the clamped
      // window; prefix[right] alone covers [0, right] exactly there (right is
      // then always inside block 0, because right < window).
      dst[base + i * stride] = left < 0 ? prefix[right]! : Math.max(suffix[left]!, prefix[right]!);
    }
  }
}

/** Separable grayscale dilation over a single-channel plane. */
export function dilate(
  plane: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const horizontal = new Uint8ClampedArray(plane.length);
  runningMaxAxis(plane, horizontal, height, width, 1, width, radius);
  const out = new Uint8ClampedArray(plane.length);
  runningMaxAxis(horizontal, out, width, height, width, 1, radius);
  return out;
}

/** Separable box blur over a single-channel plane, `radius` either side. */
export function boxBlur(
  plane: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  if (radius <= 0) {
    return plane.slice();
  }
  const tmp = new Float64Array(plane.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += plane[base + Math.min(width - 1, Math.max(0, x))]!;
    }
    for (let x = 0; x < width; x++) {
      tmp[base + x] = sum / (2 * radius + 1);
      const leaving = Math.min(width - 1, Math.max(0, x - radius));
      const entering = Math.min(width - 1, x + radius + 1);
      sum += plane[base + entering]! - plane[base + leaving]!;
    }
  }
  const out = new Uint8ClampedArray(plane.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x]!;
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / (2 * radius + 1);
      const leaving = Math.min(height - 1, Math.max(0, y - radius)) * width + x;
      const entering = Math.min(height - 1, y + radius + 1) * width + x;
      sum += tmp[entering]! - tmp[leaving]!;
    }
  }
  return out;
}

/**
 * Estimate the illumination field: downscale ×⅛, dilate each channel with a
 * window far wider than any stroke (≈⅛ of the small image's width), blur the
 * blockiness off, and upsample back. Returned at FULL resolution.
 */
export function estimateBackground(image: RgbaImage): RgbaImage {
  const small = resample(
    image,
    Math.max(1, Math.round(image.width / FIELD_SCALE)),
    Math.max(1, Math.round(image.height / FIELD_SCALE)),
  );
  const radius = Math.max(2, Math.round(Math.max(small.width, small.height) / 16));
  const blurRadius = Math.max(1, Math.round(radius / 2));
  const out = new Uint8ClampedArray(small.data.length);
  const plane = new Uint8ClampedArray(small.width * small.height);
  for (let channel = 0; channel < 3; channel++) {
    for (let i = 0; i < plane.length; i++) {
      plane[i] = small.data[i * 4 + channel]!;
    }
    const dilated = dilate(plane, small.width, small.height, radius);
    const blurred = boxBlur(dilated, small.width, small.height, blurRadius);
    for (let i = 0; i < plane.length; i++) {
      out[i * 4 + channel] = blurred[i]!;
    }
  }
  for (let i = 0; i < plane.length; i++) {
    out[i * 4 + 3] = 255;
  }
  return upsampleBilinear(
    { width: small.width, height: small.height, data: out },
    image.width,
    image.height,
  );
}

/** Bilinear upsample to an explicit size (the field is smooth by design). */
function upsampleBilinear(image: RgbaImage, outW: number, outH: number): RgbaImage {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = image.width / outW;
  const sy = image.height / outH;
  for (let y = 0; y < outH; y++) {
    const srcY = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < outW; x++) {
      sampleBilinear(image, (x + 0.5) * sx - 0.5, srcY, out, (y * outW + x) * 4);
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * Flat-field the image: `clamp(255 · pixel / background)`, per channel.
 * After this the picture is "white board, coloured ink, near-uniform light",
 * and every threshold downstream can be a fixed constant.
 */
export function normalizeIllumination(image: RgbaImage): NormalizedImage {
  const background = estimateBackground(image);
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const field = Math.max(1, background.data[i + channel]!);
      data[i + channel] = (255 * image.data[i + channel]!) / field;
    }
    data[i + 3] = image.data[i + 3]!;
  }
  return {
    normalized: { width: image.width, height: image.height, data },
    background,
  };
}

export interface GlareMap {
  /** `width × height`; 1 marks a pixel inside a blown highlight. */
  readonly mask: Uint8Array;
  /** Fraction of the frame that is glare, 0–1 — the review hint's number. */
  readonly fraction: number;
}

/**
 * Blown highlights in the ORIGINAL rectified image: at or near the sensor
 * ceiling AND locally flat over a wide window (real board texture and ink
 * produce variance; a saturated patch produces none). Computed at the field's
 * ⅛ scale — glare has no fine structure by definition — then upsampled by
 * nearest neighbour.
 */
export function detectGlare(image: RgbaImage): GlareMap {
  const small = resample(
    image,
    Math.max(1, Math.round(image.width / FIELD_SCALE)),
    Math.max(1, Math.round(image.height / FIELD_SCALE)),
  );
  const w = small.width;
  const h = small.height;
  const lum = new Float64Array(w * h);
  for (let i = 0; i < lum.length; i++) {
    const p = i * 4;
    lum[i] = 0.2126 * small.data[p]! + 0.7152 * small.data[p + 1]! + 0.0722 * small.data[p + 2]!;
  }
  // Local mean/variance over a wide window via integral images.
  const radius = Math.max(2, Math.round(Math.max(w, h) / 20));
  const integral = new Float64Array((w + 1) * (h + 1));
  const integralSq = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x]!;
      rowSum += v;
      rowSumSq += v * v;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1]! + rowSum;
      integralSq[(y + 1) * (w + 1) + x + 1] = integralSq[y * (w + 1) + x + 1]! + rowSumSq;
    }
  }
  const smallMask = new Uint8Array(w * h);
  let glareCount = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x]! < GLARE_LUMINANCE) {
        continue;
      }
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * (w + 1) + x1 + 1]! -
        integral[y0 * (w + 1) + x1 + 1]! -
        integral[(y1 + 1) * (w + 1) + x0]! +
        integral[y0 * (w + 1) + x0]!;
      const sumSq =
        integralSq[(y1 + 1) * (w + 1) + x1 + 1]! -
        integralSq[y0 * (w + 1) + x1 + 1]! -
        integralSq[(y1 + 1) * (w + 1) + x0]! +
        integralSq[y0 * (w + 1) + x0]!;
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      if (Math.sqrt(variance) < GLARE_FLATNESS) {
        smallMask[y * w + x] = 1;
        glareCount++;
      }
    }
  }
  // Nearest-neighbour upsample — a glare boundary does not need subpixels.
  const mask = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / image.height));
    for (let x = 0; x < image.width; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / image.width));
      mask[y * image.width + x] = smallMask[sy * w + sx]!;
    }
  }
  return { mask, fraction: glareCount / (w * h) };
}
