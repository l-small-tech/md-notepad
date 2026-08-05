/**
 * S3, second half — decide ink PER CONNECTED COMPONENT, never per pixel.
 *
 * Per-pixel adaptive thresholds are exactly what turn eraser ghosting into
 * speckle: they force a light/dark split even where the board is uniformly
 * blank. So the unit of decision here is the blob:
 *
 * 1. HYSTERESIS — a weak component survives only if it contains at least one
 *    strong pixel (Canny's rule applied to blobs). A faint eraser smear never
 *    reaches strong anywhere along its length and dies wholesale; a genuinely
 *    light stroke that touches solid ink survives intact. This one rule does
 *    most of the artifact removal.
 * 2. Component FILTERS, every threshold in units of the page's stroke width
 *    `w` — never absolute pixels — so behaviour is identical at every preset
 *    and camera distance.
 * 3. The I-DOT RULE — a speckle-sized component is spared when kept ink lies
 *    within 2·w. That is what preserves i-dots, accents, colons, dashed lines
 *    and arrowheads while still dropping isolated grit.
 *
 * No blanket morphology anywhere: at these stroke widths a global open/close
 * or 3×3 median erodes thin diagonals and costs real legibility. All removal
 * is component-level, surgical, and explainable.
 */

import { labelComponents } from './image-ops';
import { distanceTransform, estimateStrokeWidth } from './distance';
import type { InkMasks } from './binarize';

/** Everything the filters (and colour voting after them) need per blob. */
export interface InkComponent {
  /** 1-based label in the `labels` array. */
  readonly label: number;
  readonly area: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Boundary pixel count (a 4-neighbour is background or the frame edge). */
  readonly perimeter: number;
  /** P²/A — high for strokes, low for blobs. */
  readonly thinness: number;
  /** Fraction of the component's pixels that passed the STRONG gate. */
  readonly strongRatio: number;
  /** Mean chroma (0–255) over the component. */
  readonly meanChroma: number;
  /** Largest distance-transform value inside — the half-width at the core. */
  readonly dtMax: number;
  readonly touchesBorder: boolean;
  /** Fraction of pixels inside the glare mask. */
  readonly glareRatio: number;
}

export interface InkExtraction {
  /** The kept-ink mask, `width × height`. */
  readonly mask: Uint8Array;
  /** Per-pixel component labels (kept components only; 0 = background). */
  readonly labels: Int32Array;
  /** Kept components, label-ordered. */
  readonly components: readonly InkComponent[];
  /** The page's characteristic stroke width, px. */
  readonly strokeWidth: number;
  /** Distance transform of the kept mask — colour voting reuses it. */
  readonly distance: Float32Array;
  /** How many components each filter removed, for honest review copy. */
  readonly removed: {
    readonly ghost: number;
    readonly speckle: number;
    readonly faint: number;
    readonly blob: number;
    readonly border: number;
    readonly glare: number;
  };
}

/** Reject: area < 0.5·w² — sensor noise, dust, dry-erase residue dots. */
const SPECKLE_AREA = 0.5;
/** Reject: strongRatio below this — eraser ghosting, shadow edges. */
const FAINT_STRONG_RATIO = 0.15;
/** Diffuse blob: thinness < 20 AND strongRatio < 0.5 AND area > 40·w². The
 *  strongRatio conjunct spares an intentionally filled-in shape, which is
 *  blobby but DARK. */
const BLOB_THINNESS = 20;
const BLOB_STRONG_RATIO = 0.5;
const BLOB_AREA = 40;
/** Frame/furniture: touches the border AND area > 200·w². */
const BORDER_AREA = 200;
/** Reject when ≥60% of the pixels sit inside the glare mask. */
const GLARE_RATIO = 0.6;
/** The i-dot rule's reach, in stroke widths. */
const IDOT_REACH = 2;

/** Gap between two bboxes (0 when they touch or overlap). */
function bboxGap(a: InkComponent, b: InkComponent): number {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

/**
 * Run hysteresis and the component filters over the binarized masks.
 * Deterministic: components are processed in label order, which
 * `labelComponents` derives from raster order.
 */
export function extractInk(
  masks: InkMasks,
  width: number,
  height: number,
  glare?: Uint8Array,
): InkExtraction {
  const { strong, weak } = masks;
  const labelled = labelComponents(weak, width, height);

  // Hysteresis: per weak component, count strong pixels; a component with
  // none is an artifact of the permissive gate, not ink.
  const strongCount = new Int32Array(labelled.components.length + 1);
  const chromaSum = new Float64Array(labelled.components.length + 1);
  const glareCount = new Int32Array(labelled.components.length + 1);
  for (let i = 0; i < labelled.labels.length; i++) {
    const label = labelled.labels[i]!;
    if (label === 0) {
      continue;
    }
    if (strong[i] !== 0) {
      strongCount[label]!++;
    }
    chromaSum[label] = chromaSum[label]! + masks.chroma[i]!;
    if (glare !== undefined && glare[i] !== 0) {
      glareCount[label]!++;
    }
  }

  let ghostRemoved = 0;
  const surviving = new Uint8Array(labelled.components.length + 1);
  for (const component of labelled.components) {
    if (strongCount[component.label]! > 0) {
      surviving[component.label] = 1;
    } else {
      ghostRemoved++;
    }
  }

  // The kept-so-far mask, for the stroke-width estimate and the filters.
  const survivorMask = new Uint8Array(width * height);
  for (let i = 0; i < survivorMask.length; i++) {
    const label = labelled.labels[i]!;
    if (label !== 0 && surviving[label] !== 0) {
      survivorMask[i] = 1;
    }
  }
  const distance = distanceTransform(survivorMask, width, height);
  const w = estimateStrokeWidth(distance, width, height);
  const w2 = w * w;

  // Perimeter and dtMax per surviving component, one pass each.
  const perimeter = new Int32Array(labelled.components.length + 1);
  const dtMax = new Float64Array(labelled.components.length + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const label = labelled.labels[i]!;
      if (label === 0 || surviving[label] === 0) {
        continue;
      }
      if (distance[i]! > dtMax[label]!) {
        dtMax[label] = distance[i]!;
      }
      const boundary =
        x === 0 ||
        x === width - 1 ||
        y === 0 ||
        y === height - 1 ||
        survivorMask[i - 1] === 0 ||
        survivorMask[i + 1] === 0 ||
        survivorMask[i - width] === 0 ||
        survivorMask[i + width] === 0;
      if (boundary) {
        perimeter[label]!++;
      }
    }
  }

  const candidates: InkComponent[] = [];
  for (const c of labelled.components) {
    if (surviving[c.label] === 0) {
      continue;
    }
    const p = perimeter[c.label]!;
    candidates.push({
      label: c.label,
      area: c.area,
      minX: c.minX,
      minY: c.minY,
      maxX: c.maxX,
      maxY: c.maxY,
      perimeter: p,
      thinness: (p * p) / c.area,
      strongRatio: strongCount[c.label]! / c.area,
      meanChroma: chromaSum[c.label]! / c.area,
      dtMax: dtMax[c.label]!,
      touchesBorder: c.touchesBorder.some(Boolean),
      glareRatio: glareCount[c.label]! / c.area,
    });
  }

  // The filters. Speckle rejections are provisional — the i-dot pass below
  // may revive them; every other rejection is final.
  const removed = { ghost: ghostRemoved, speckle: 0, faint: 0, blob: 0, border: 0, glare: 0 };
  const kept: InkComponent[] = [];
  const speckles: InkComponent[] = [];
  for (const c of candidates) {
    if (c.glareRatio >= GLARE_RATIO) {
      removed.glare++;
    } else if (c.strongRatio < FAINT_STRONG_RATIO) {
      removed.faint++;
    } else if (c.touchesBorder && c.area > BORDER_AREA * w2) {
      removed.border++;
    } else if (
      c.thinness < BLOB_THINNESS &&
      c.strongRatio < BLOB_STRONG_RATIO &&
      c.area > BLOB_AREA * w2
    ) {
      removed.blob++;
    } else if (c.area < SPECKLE_AREA * w2) {
      speckles.push(c);
    } else {
      kept.push(c);
    }
  }
  // The i-dot rule: spare a speckle when kept ink lies within 2·w of it.
  // Checked against confidently-kept components only, so two grains of grit
  // cannot vouch for each other.
  for (const speckle of speckles) {
    const reach = IDOT_REACH * w;
    if (kept.some((c) => bboxGap(speckle, c) <= reach)) {
      kept.push(speckle);
    } else {
      removed.speckle++;
    }
  }
  kept.sort((a, b) => a.label - b.label);

  const keptFlags = new Uint8Array(labelled.components.length + 1);
  for (const c of kept) {
    keptFlags[c.label] = 1;
  }
  const mask = new Uint8Array(width * height);
  const labels = new Int32Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const label = labelled.labels[i]!;
    if (label !== 0 && keptFlags[label] !== 0) {
      mask[i] = 1;
      labels[i] = label;
    }
  }
  return { mask, labels, components: kept, strokeWidth: w, distance, removed };
}
