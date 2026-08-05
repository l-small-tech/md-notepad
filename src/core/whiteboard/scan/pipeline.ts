/**
 * The scan pipeline's front door — S0/S1 in phase 4 (acquire is the adapter's
 * job; this is detect + rectify). Phases 5–7 extend it in place: normalize,
 * binarize, colour, trace, OCR.
 *
 * Everything here is pure and resumable. `createRectifier` hands back a job the
 * caller pumps a band at a time, because the alternative — one synchronous
 * multi-megasample loop — is a frozen tab and a progress bar that only ever
 * shows 0% and 100%.
 */

import { quadAspectRatio, rectifyTransform, sideLengthAspect, warpRows } from './homography';
import { SCAN_PRESETS, type Quad, type RgbaImage, type ScanPreset } from './types';

/** Never emit a rectified board smaller than this on either edge. */
const MIN_OUTPUT_EDGE = 16;

export interface RectifyPlan {
  readonly width: number;
  readonly height: number;
  /** width / height of the recovered real-world rectangle. */
  readonly aspect: number;
  /**
   * `'perspective'` — Zhang & He recovered the true ratio from the projection.
   * `'sides'` — the shot was too close to fronto-parallel for that to mean
   * anything, so the ratio is the mean of the opposite side lengths (which is
   * the correct answer in precisely that case).
   */
  readonly aspectSource: 'perspective' | 'sides';
}

/**
 * Decide the rectified board's pixel size.
 *
 * The long edge is the preset, CLAMPED to what the source actually resolves:
 * upsampling a quad that only covers 900 px of photo to 1800 px invents no
 * detail, costs 4× the memory and makes every later stage slower for nothing.
 */
export function planRectify(
  image: RgbaImage,
  quad: Quad,
  preset: ScanPreset = 'balanced',
): RectifyPlan {
  const recovered = quadAspectRatio(quad, image.width, image.height);
  const aspect = recovered ?? sideLengthAspect(quad);
  const aspectSource = recovered !== null ? 'perspective' : 'sides';

  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);
  const nativeWidth = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const nativeHeight = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
  const longEdge = Math.max(
    MIN_OUTPUT_EDGE,
    Math.min(SCAN_PRESETS[preset], Math.round(Math.max(nativeWidth, nativeHeight))),
  );

  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const width = safeAspect >= 1 ? longEdge : Math.round(longEdge * safeAspect);
  const height = safeAspect >= 1 ? Math.round(longEdge / safeAspect) : longEdge;
  return {
    width: Math.max(MIN_OUTPUT_EDGE, width),
    height: Math.max(MIN_OUTPUT_EDGE, height),
    aspect: safeAspect,
    aspectSource,
  };
}

/** A rectification in progress: pump {@link step} until {@link done}. */
export interface RectifyJob {
  readonly plan: RectifyPlan;
  /** Rows completed so far, out of `plan.height`. */
  readonly progress: number;
  readonly done: boolean;
  /** Render the next band. Returns rows completed (for a progress readout). */
  step(rows?: number): number;
  /** The finished raster; null until `done`. */
  result(): RgbaImage | null;
}

/** Rows per {@link RectifyJob.step} call — ~1/40th of a second's work. */
const DEFAULT_BAND = 48;

/**
 * Start rectifying `quad` out of `image`. Returns null when the quad is
 * degenerate (three corners collinear), which a hand-dragged crop can produce.
 */
export function createRectifier(
  image: RgbaImage,
  quad: Quad,
  preset: ScanPreset = 'balanced',
): RectifyJob | null {
  const plan = planRectify(image, quad, preset);
  const h = rectifyTransform(quad, plan.width, plan.height);
  if (!h) {
    return null;
  }
  const data = new Uint8ClampedArray(plan.width * plan.height * 4);
  let y = 0;
  return {
    plan,
    get progress() {
      return y;
    },
    get done() {
      return y >= plan.height;
    },
    step(rows = DEFAULT_BAND) {
      const to = Math.min(plan.height, y + Math.max(1, rows));
      warpRows(image, h, data, plan.width, y, to);
      y = to;
      return y;
    },
    result() {
      return y >= plan.height ? { width: plan.width, height: plan.height, data } : null;
    },
  };
}
