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
import type { InkExtraction } from './components';

/** Chroma (0–1) below which a component votes black regardless of hue. */
const BLACK_CHROMA = 0.12;

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
  return chroma < BLACK_CHROMA ? 'black' : binHue(hue);
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
    count: number;
  }
  const accumulators = new Map<number, Accumulator>();
  const coreFloor = new Map<number, number>();
  for (const c of components) {
    accumulators.set(c.label, { r: [], g: [], b: [], sin: 0, cos: 0, chromaSum: 0, count: 0 });
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
        acc.count++;
      }
    }
  }

  const byLabel = new Map<number, ComponentColor>();
  const counts = new Map<MarkerColor, number>();
  for (const c of components) {
    const acc = accumulators.get(c.label)!;
    let bucket: MarkerColor;
    let measured: string;
    if (acc.count === 0) {
      bucket = 'black';
      measured = SCAN_PALETTE.black;
    } else {
      measured = toHex(channelMedian(acc.r), channelMedian(acc.g), channelMedian(acc.b));
      const meanChroma = acc.chromaSum / acc.count;
      if (meanChroma < BLACK_CHROMA) {
        bucket = 'black';
      } else {
        const hue = (Math.atan2(acc.sin, acc.cos) * 180) / Math.PI;
        bucket = binHue(hue);
      }
    }
    byLabel.set(c.label, { label: c.label, bucket, snapped: SCAN_PALETTE[bucket], measured });
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
