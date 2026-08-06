/**
 * Phase 5's front door: rectified photo in, CLEANED board out — S2 (flat-field
 * + glare), S3 (binarize + component ink extraction), S4 (colour voting) —
 * composed as one resumable job the UI pumps from requestAnimationFrame,
 * exactly like `createRectifier`.
 *
 * The output is still a raster (vectorizing is phase 6): a pure white sheet
 * with each ink component painted in one flat colour. Which colour is the
 * caller's choice, and switching it does NOT re-run the pipeline —
 * `composeCleaned` re-paints from the cached extraction in one cheap pass:
 *
 * - `'themed'` (the DEFAULT) — the component's snapped canonical palette
 *   colour. Scanned ink then matches drawn ink exactly, and when phase 6
 *   vectorizes these components the snapped colours pick up the theme's
 *   palette-slot classes for free.
 * - `'true'` — the component's measured median core colour: what the marker
 *   actually looked like, still one colour per component (this is the colour
 *   VOTING output, not the raw pixels).
 */

import { normalizeIllumination, detectGlare } from './illumination';
import { binarize } from './binarize';
import { extractInk, type InkExtraction } from './components';
import { assignColors, type ColorAssignment, type ComponentColor } from './color';
import type { RgbaImage } from './types';

/** How ink components are coloured in the cleaned output. */
export type ScanColorMode = 'themed' | 'true';

export const DEFAULT_SCAN_COLOR_MODE: ScanColorMode = 'themed';

/** Above this glare fraction the review screen shows the off-axis hint. */
export const GLARE_HINT_FRACTION = 0.04;

export interface CleanResult {
  readonly extraction: InkExtraction;
  readonly colors: ColorAssignment;
  /** Fraction of the frame lost to blown highlights, 0–1. */
  readonly glareFraction: number;
  readonly width: number;
  readonly height: number;
}

/** A clean in progress: pump {@link CleanJob.step} until {@link CleanJob.done}. */
export interface CleanJob {
  /** 0–1, monotonic. Stage-weighted, so the bar moves honestly. */
  readonly progress: number;
  readonly done: boolean;
  /** Run the next slice of work. Returns the new progress. */
  step(): number;
  /** The finished result; null until `done`. */
  result(): CleanResult | null;
}

/**
 * The stage weights the progress bar reports. Rough measured proportions;
 * exactness does not matter, monotonicity does.
 */
const STAGES = { light: 0.35, glare: 0.1, ink: 0.3, components: 0.2, color: 0.05 } as const;

/**
 * Start cleaning a rectified board photo. Each `step()` runs ONE stage of the
 * pipeline — the stages are internally single passes over typed arrays and
 * finish in tens of milliseconds each at Balanced resolution, which is a
 * coarse but honest granularity: the caller repaints its progress bar between
 * stages and can drop the job (there is no partial state to unwind).
 */
export function createCleaner(image: RgbaImage): CleanJob {
  type Stage = keyof typeof STAGES | 'done';
  let stage: Stage = 'light';
  let progress = 0;
  let normalized: RgbaImage | null = null;
  let glare: ReturnType<typeof detectGlare> | null = null;
  let masks: ReturnType<typeof binarize> | null = null;
  let extraction: InkExtraction | null = null;
  let final: CleanResult | null = null;

  return {
    get progress() {
      return progress;
    },
    get done() {
      return stage === 'done';
    },
    step() {
      switch (stage) {
        case 'light':
          normalized = normalizeIllumination(image).normalized;
          progress += STAGES.light;
          stage = 'glare';
          break;
        case 'glare':
          glare = detectGlare(image);
          progress += STAGES.glare;
          stage = 'ink';
          break;
        case 'ink':
          masks = binarize(normalized!, glare!.mask);
          progress += STAGES.ink;
          stage = 'components';
          break;
        case 'components':
          extraction = extractInk(masks!, image.width, image.height, glare!.mask);
          progress += STAGES.components;
          stage = 'color';
          break;
        case 'color':
          final = {
            extraction: extraction!,
            colors: assignColors(normalized!, extraction!),
            glareFraction: glare!.fraction,
            width: image.width,
            height: image.height,
          };
          progress = 1;
          stage = 'done';
          break;
        case 'done':
          break;
      }
      return progress;
    },
    result: () => final,
  };
}

function parseHex(hex: string): readonly [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export interface ComposeOptions {
  /**
   * `'white'` (default) paints the sheet; `'transparent'` leaves the board
   * showing through — what a themed scan wants, so ink sits directly on the
   * board surface instead of on a white card.
   */
  readonly background?: 'white' | 'transparent';
  /**
   * Override the ink RGB per component. The scan panel uses this to paint
   * themed ink in the RESOLVED app-theme palette (which core cannot read —
   * it lives in CSS variables), so what lands in the file is what the board
   * around it looks like. Omitted, ink falls back to the mode's own colour.
   */
  readonly inkFor?: (color: ComponentColor) => readonly [number, number, number];
}

/**
 * Paint the cleaned board: one flat colour per ink component. Pure and cheap
 * (one pass), so the review screen switches colour modes without touching
 * the pipeline.
 */
export function composeCleaned(
  result: CleanResult,
  mode: ScanColorMode,
  options: ComposeOptions = {},
): RgbaImage {
  const { width, height } = result;
  const { labels } = result.extraction;
  const backgroundAlpha = options.background === 'transparent' ? 0 : 255;
  const data = new Uint8ClampedArray(width * height * 4);
  // Per-label RGB lookup, densely indexed for the hot loop.
  let maxLabel = 0;
  for (const c of result.extraction.components) {
    if (c.label > maxLabel) {
      maxLabel = c.label;
    }
  }
  const lut = new Uint8ClampedArray((maxLabel + 1) * 3);
  for (const [label, color] of result.colors.byLabel) {
    const [r, g, b] =
      options.inkFor?.(color) ?? parseHex(mode === 'themed' ? color.snapped : color.measured);
    lut[label * 3] = r;
    lut[label * 3 + 1] = g;
    lut[label * 3 + 2] = b;
  }
  for (let i = 0; i < labels.length; i++) {
    const p = i * 4;
    const label = labels[i]!;
    if (label === 0) {
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
      data[p + 3] = backgroundAlpha;
    } else {
      data[p] = lut[label * 3]!;
      data[p + 1] = lut[label * 3 + 1]!;
      data[p + 2] = lut[label * 3 + 2]!;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}
