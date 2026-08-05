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

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Gap between two bboxes (0 when they touch or overlap). */
function bboxGap(a: Bounds, b: Bounds): number {
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

  const surviving = new Uint8Array(labelled.components.length + 1);
  for (const component of labelled.components) {
    if (strongCount[component.label]! > 0) {
      surviving[component.label] = 1;
    }
  }

  // Strong-anchored ink only, for the stroke-width estimate — a faint smear
  // must not get a vote in what the page's stroke width is.
  const survivorMask = new Uint8Array(width * height);
  for (let i = 0; i < survivorMask.length; i++) {
    const label = labelled.labels[i]!;
    if (label !== 0 && surviving[label] !== 0) {
      survivorMask[i] = 1;
    }
  }
  const anchoredDistance = distanceTransform(survivorMask, width, height);
  const w = estimateStrokeWidth(anchoredDistance, width, height);
  const w2 = w * w;

  // The full weak-mask transform supplies shape stats for EVERY component —
  // the continuity rescue below needs the half-width of components hysteresis
  // rejected, and colour voting reuses the same values.
  const distance = distanceTransform(weak, width, height);

  // Perimeter and dtMax per component (kept or not), one pass each. Distinct
  // 8-connected components are never adjacent, so measuring against the whole
  // weak mask gives each component its own boundary.
  const perimeter = new Int32Array(labelled.components.length + 1);
  const dtMax = new Float64Array(labelled.components.length + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const label = labelled.labels[i]!;
      if (label === 0) {
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
        weak[i - 1] === 0 ||
        weak[i + 1] === 0 ||
        weak[i - width] === 0 ||
        weak[i + width] === 0;
      if (boundary) {
        perimeter[label]!++;
      }
    }
  }

  /*
   * The CONTINUITY RESCUE. Hysteresis alone has a real failure mode on light
   * marker: a stroke fades in and out of the strong gate, the weak mask holds
   * the whole stroke but in DISCONNECTED pieces, and every piece without a
   * strong pixel dies — a circle comes back as just its darkest arc (phase-5
   * UAT, on a real photo). So a weak-only component is revived when it
   * (a) is STROKE-SHAPED — its core half-width fits the page's ink,
   *     `dtMax ≤ w` — which a wide eraser smear or hand shadow never is, and
   * (b) CONTINUES kept ink — within the i-dot reach (2·w) of a kept
   *     component — which an isolated ghost band never does.
   * Applied to a fixpoint (BFS over newly kept components), so a long faded
   * tail is recovered piece by piece.
   */
  const rescued = new Uint8Array(labelled.components.length + 1);
  {
    let frontier = labelled.components.filter((c) => surviving[c.label] !== 0);
    let pending = labelled.components.filter(
      (c) => surviving[c.label] === 0 && dtMax[c.label]! <= w,
    );
    const reach = IDOT_REACH * w;
    while (frontier.length > 0 && pending.length > 0) {
      const found: typeof pending = [];
      const rest: typeof pending = [];
      for (const candidate of pending) {
        if (frontier.some((c) => bboxGap(candidate, c) <= reach)) {
          found.push(candidate);
        } else {
          rest.push(candidate);
        }
      }
      for (const c of found) {
        surviving[c.label] = 1;
        rescued[c.label] = 1;
      }
      frontier = found;
      pending = rest;
    }
  }
  let ghostRemoved = 0;
  for (const component of labelled.components) {
    if (surviving[component.label] === 0) {
      ghostRemoved++;
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
    // A component is STROKE-SHAPED when its core half-width fits the page's
    // ink and its outline is long relative to its area. Faint ink that keeps
    // this shape is a light pen stroke (phase-5 UAT: a circle drawn with a
    // drying marker lost everything but its darkest arc to the faint filter);
    // eraser ghosting and shadows are diffuse and fail it.
    const strokeShaped = c.dtMax <= w && c.thinness >= BLOB_THINNESS;
    if (c.glareRatio >= GLARE_RATIO) {
      removed.glare++;
    } else if (rescued[c.label] === 0 && c.strongRatio < FAINT_STRONG_RATIO && !strokeShaped) {
      // The faint filter judges diffuse strong-poor components; a rescued one
      // was admitted on shape + continuity and is exempt by construction.
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
