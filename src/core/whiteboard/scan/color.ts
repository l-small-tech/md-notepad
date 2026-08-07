/**
 * S4 — colour, decided at COMPONENT level so a stroke is never a rainbow.
 *
 * Votes use core pixels only: pixels whose distance-transform value is at
 * least 0.6× the component's maximum. Anti-aliased stroke edges are
 * desaturated and hue-shifted, and black strokes routinely show blue/purple
 * fringing from demosaicing — core-only voting removes both effects.
 *
 * Two answers come out per component, and both are kept:
 *
 * - `snapped` — the nearest of the eight canonical marker colours. These are
 *   the SAME hexes as the drawing `PALETTE` (tool-settings.ts), which is what
 *   makes scanned ink themeable: when phase 6 turns components into strokes,
 *   a snapped colour picks up the palette-slot classes for free, and even the
 *   phase-5 cleaned raster reads as "this app's ink" rather than "a photo".
 *   This is the DEFAULT output.
 * - `measured` — the median core RGB, for the "true colours" option (and the
 *   escape hatch when a dying marker genuinely is ambiguous).
 */

import { PALETTE } from '../tool-settings';
import type { RgbaImage } from './types';
import { bboxGap } from './components';
import type { InkExtraction } from './components';

/** Chroma (0–1) below which a component votes black regardless of hue. */
const BLACK_CHROMA = 0.12;
/**
 * The 2-D arm of the black test: black ink under a warm residual cast picks
 * up chroma just past `BLACK_CHROMA`, but stays DARK in every channel —
 * measured on a real board, black cores sit at luminance 0.26–0.33 while the
 * dimmest real marker core (a dark blue) is above 0.35 and every marker with
 * chroma this low is far brighter. So: black also when chroma < 0.20 AND
 * luminance < 0.30.
 */
const BLACK_DARK_CHROMA = 0.2;
const BLACK_DARK_LUM = 0.3;

/** Is a (chroma, luminance) vote black? Both in 0–1. The table tests pin this. */
export function isBlackVote(chroma: number, lum: number): boolean {
  return chroma < BLACK_CHROMA || (chroma < BLACK_DARK_CHROMA && lum < BLACK_DARK_LUM);
}

/**
 * Half-width, in units of the page's stroke width `w`, below which a component
 * has no trustworthy core at all: every one of its pixels is an anti-aliased
 * edge pixel, which is desaturated by construction. Such a component votes
 * `black` no matter what colour the marker was — a phase-5 UAT defect, where
 * the surviving specks and faint dashes of a GREEN board all came out pure
 * black and were therefore the most visible thing on it.
 *
 * A stroke's own half-width is ≈ 0.5·w by the definition of `w` (the median of
 * the distance transform's local maxima), so 0.4 clears real ink with margin
 * while catching the one- and two-pixel-thick fragments.
 */
const CORE_TRUST = 0.4;
/** How far, in `w`, a coreless component may look for ink to take colour from. */
const INHERIT_REACH = 3;

/** The colour vocabulary, in the plan's bin order. */
export type MarkerColor =
  'black' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple';

/**
 * Canonical hex per bucket — the phase-5 spec's palette. Each MUST be a
 * member of `PALETTE` (a test asserts it), because being a palette slot is
 * exactly what makes a scanned colour themeable.
 */
export const SCAN_PALETTE: Readonly<Record<MarkerColor, string>> = {
  black: '#1a1a1a',
  red: '#d02f2f',
  orange: '#e07b00',
  yellow: '#c9a400',
  green: '#1f9d55',
  teal: '#0f8f8f',
  blue: '#1f6fd0',
  purple: '#8a3fd1',
};

/** Sanity used by tests: every scan colour is a drawing-palette slot. */
export function scanPaletteIsThemeable(): boolean {
  return Object.values(SCAN_PALETTE).every((hex) => PALETTE.includes(hex));
}

/** Hue bins in degrees, per the plan. Red wraps around 0. */
export function binHue(hue: number): Exclude<MarkerColor, 'black'> {
  const h = ((hue % 360) + 360) % 360;
  if (h < 20 || h > 340) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 200) return 'teal';
  if (h < 260) return 'blue';
  return 'purple';
}

/** RGB (0–255) → hue in degrees and chroma 0–1. */
export function rgbToHueChroma(r: number, g: number, b: number): { hue: number; chroma: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c === 0) {
    return { hue: 0, chroma: 0 };
  }
  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / c) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / c + 2);
  } else {
    hue = 60 * ((r - g) / c + 4);
  }
  return { hue: ((hue % 360) + 360) % 360, chroma: c / 255 };
}

/** Classify a single (white-balanced) RGB — the table tests target this. */
export function classifyRgb(r: number, g: number, b: number): MarkerColor {
  const { hue, chroma } = rgbToHueChroma(r, g, b);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return isBlackVote(chroma, lum) ? 'black' : binHue(hue);
}

/**
 * Estimate the page's marker hues from weighted hue votes: a 360-bin circular
 * histogram, smoothed with a triangular kernel (±15°), local maxima at least
 * 30° apart (strongest first), at most 6, sorted ascending. Deterministic —
 * no seeding, no iteration-order dependence.
 *
 * This is what makes colour assignment PAGE-CONSISTENT: a marker whose per-
 * component votes straddle a hue-bin edge (teal at 160–175 against the 165°
 * green/teal boundary — a real board split one pen across two buckets) snaps
 * to one peak, and the PEAK is binned, so every stroke of that pen lands in
 * one bucket.
 */
export function estimateMarkerHues(
  votes: readonly { readonly hue: number; readonly weight: number }[],
): number[] {
  if (votes.length === 0) {
    return [];
  }
  const RADIUS = 15;
  const SEPARATION = 30;
  const histogram = new Float64Array(360);
  for (const v of votes) {
    const bin = ((Math.round(v.hue) % 360) + 360) % 360;
    histogram[bin] = histogram[bin]! + v.weight;
  }
  const smoothed = new Float64Array(360);
  for (let bin = 0; bin < 360; bin++) {
    let sum = 0;
    for (let d = -RADIUS; d <= RADIUS; d++) {
      sum += histogram[(bin + d + 360) % 360]! * (RADIUS + 1 - Math.abs(d));
    }
    smoothed[bin] = sum;
  }
  // Local maxima: strictly above everything within ±SEPARATION that isn't an
  // equal-valued earlier bin (plateaus yield their first bin).
  const candidates: { bin: number; value: number }[] = [];
  for (let bin = 0; bin < 360; bin++) {
    const value = smoothed[bin]!;
    if (value === 0) {
      continue;
    }
    let isPeak = true;
    for (let d = 1; d <= SEPARATION && isPeak; d++) {
      const before = smoothed[(bin - d + 360) % 360]!;
      const after = smoothed[(bin + d) % 360]!;
      if (before >= value || after > value) {
        isPeak = false;
      }
    }
    if (isPeak) {
      candidates.push({ bin, value });
    }
  }
  candidates.sort((a, b) => b.value - a.value || a.bin - b.bin);
  const peaks: number[] = [];
  for (const c of candidates) {
    if (peaks.length >= 6) {
      break;
    }
    if (
      peaks.every((p) => Math.min(Math.abs(p - c.bin), 360 - Math.abs(p - c.bin)) >= SEPARATION)
    ) {
      peaks.push(c.bin);
    }
  }
  return peaks.sort((a, b) => a - b);
}

export interface ComponentColor {
  /** The component's 1-based label. */
  readonly label: number;
  readonly bucket: MarkerColor;
  /** Canonical palette hex for the bucket — the themeable identity. */
  readonly snapped: string;
  /** Median core RGB as `#rrggbb` — the true measured colour. */
  readonly measured: string;
}

export interface ColorTally {
  readonly bucket: MarkerColor;
  readonly snapped: string;
  /** Components (not pixels) that voted for this bucket. */
  readonly count: number;
}

export interface ColorAssignment {
  /** Indexable by component label (sparse; label-keyed). */
  readonly byLabel: ReadonlyMap<number, ComponentColor>;
  /** Buckets present, in the vocabulary's fixed order, with counts. */
  readonly tallies: readonly ColorTally[];
}

function channelMedian(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

const BUCKET_ORDER: readonly MarkerColor[] = [
  'black',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
];

/**
 * Vote a colour for every kept component from the white-balanced normalized
 * image. Hue votes are chroma-weighted circular means over core pixels — a
 * mean rather than a true circular median, which for a cluster of samples
 * from one marker is the same answer without the sort.
 */
export function assignColors(normalized: RgbaImage, extraction: InkExtraction): ColorAssignment {
  const { width, data } = normalized;
  const { labels, distance, components } = extraction;

  interface Accumulator {
    r: number[];
    g: number[];
    b: number[];
    sin: number;
    cos: number;
    chromaSum: number;
    lumSum: number;
    count: number;
  }
  const accumulators = new Map<number, Accumulator>();
  const coreFloor = new Map<number, number>();
  for (const c of components) {
    accumulators.set(c.label, {
      r: [],
      g: [],
      b: [],
      sin: 0,
      cos: 0,
      chromaSum: 0,
      lumSum: 0,
      count: 0,
    });
    coreFloor.set(c.label, 0.6 * c.dtMax);
  }
  for (const c of components) {
    const floor = coreFloor.get(c.label)!;
    const acc = accumulators.get(c.label)!;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * width + x;
        if (labels[i] !== c.label || distance[i]! < floor) {
          continue;
        }
        const p = i * 4;
        const r = data[p]!;
        const g = data[p + 1]!;
        const b = data[p + 2]!;
        acc.r.push(r);
        acc.g.push(g);
        acc.b.push(b);
        const { hue, chroma } = rgbToHueChroma(r, g, b);
        const radians = (hue * Math.PI) / 180;
        acc.sin += Math.sin(radians) * chroma;
        acc.cos += Math.cos(radians) * chroma;
        acc.chromaSum += chroma;
        acc.lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        acc.count++;
      }
    }
  }

  // Page-level hue peaks from the chromatic components' votes: a component's
  // own hue snaps to the nearest peak and the PEAK is binned, so a marker
  // whose strokes straddle a bin edge still lands in one bucket page-wide.
  interface Vote {
    readonly hue: number | null; // null = black
    readonly measured: string;
  }
  const votes = new Map<number, Vote>();
  for (const c of components) {
    const acc = accumulators.get(c.label)!;
    if (acc.count === 0) {
      votes.set(c.label, { hue: null, measured: SCAN_PALETTE.black });
      continue;
    }
    const measured = toHex(channelMedian(acc.r), channelMedian(acc.g), channelMedian(acc.b));
    const meanChroma = acc.chromaSum / acc.count;
    const meanLum = acc.lumSum / acc.count;
    if (isBlackVote(meanChroma, meanLum)) {
      votes.set(c.label, { hue: null, measured });
    } else {
      const hue = ((Math.atan2(acc.sin, acc.cos) * 180) / Math.PI + 360) % 360;
      votes.set(c.label, { hue, measured });
    }
  }
  const peaks = estimateMarkerHues(
    components.flatMap((c) => {
      const vote = votes.get(c.label)!;
      const acc = accumulators.get(c.label)!;
      return vote.hue === null ? [] : [{ hue: vote.hue, weight: acc.chromaSum }];
    }),
  );
  const snapHue = (hue: number): number => {
    let best = hue;
    let bestDist = Infinity;
    for (const p of peaks) {
      const d = Math.abs(hue - p) % 360;
      const dist = d > 180 ? 360 - d : d;
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
  };

  const byLabel = new Map<number, ComponentColor>();
  for (const c of components) {
    const vote = votes.get(c.label)!;
    const bucket: MarkerColor = vote.hue === null ? 'black' : binHue(snapHue(vote.hue));
    byLabel.set(c.label, {
      label: c.label,
      bucket,
      snapped: SCAN_PALETTE[bucket],
      measured: vote.measured,
    });
  }

  /*
   * Coreless components INHERIT. A one- or two-pixel-thick fragment — a dashed
   * arrow shaft, a fading box edge, an i-dot from a dry marker — is all edge
   * and no core, so the vote above measured anti-aliasing and returned black.
   * It belongs to the ink beside it, so it takes that ink's answer: nearest
   * confidently-cored component within 3·w, by bbox gap. With nothing in reach
   * it keeps its own vote, which is the honest answer for an isolated mark.
   * Donors are chosen from cored components only, so fragments cannot chain.
   */
  const trusted = components.filter((c) => c.dtMax >= CORE_TRUST * extraction.strokeWidth);
  const inheritReach = INHERIT_REACH * extraction.strokeWidth;
  for (const c of components) {
    if (c.dtMax >= CORE_TRUST * extraction.strokeWidth) {
      continue;
    }
    let donor: ComponentColor | null = null;
    let best = inheritReach;
    for (const other of trusted) {
      const gap = bboxGap(c, other);
      if (gap <= best) {
        best = gap;
        donor = byLabel.get(other.label) ?? null;
      }
    }
    if (donor !== null) {
      byLabel.set(c.label, { ...donor, label: c.label });
    }
  }

  const counts = new Map<MarkerColor, number>();
  for (const c of components) {
    const bucket = byLabel.get(c.label)!.bucket;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const tallies: ColorTally[] = [];
  for (const bucket of BUCKET_ORDER) {
    const count = counts.get(bucket);
    if (count !== undefined) {
      tallies.push({ bucket, snapped: SCAN_PALETTE[bucket], count });
    }
  }
  return { byLabel, tallies };
}
