/**
 * S6 prerequisite — group traced marks into text LINES before any recognizer
 * sees them. This is pure geometry over the trace, and it earns its keep twice:
 * it gates what gets submitted (never ask an engine to read an arrow), and it
 * positions the hidden `<text>` overlay so a consumer knows which label sits on
 * which box.
 *
 * The unit here is the EMITTED ELEMENT, not the raster component:
 * `layoutItemsFromTrace` walks the trace in exactly the order
 * `buildScanElements` does (one element per fill, one per stroke path), so a
 * layout index IS the element index — which is what lets recognition results
 * point at the `wb:id`s the insert will assign.
 *
 * Everything is a heuristic and says so: the classifier's job is to be right
 * about the obvious (handwriting rows vs boxes and arrows), and to fail toward
 * "diagram" — an unsubmitted word costs a line of `<desc>`, a submitted arrow
 * costs the engine hallucinating text onto geometry.
 */

import type { Point, Rect } from '../geometry';
import type { TraceResult } from './trace';

export interface LayoutItem {
  /** Index into the built element list (build order — see module doc). */
  readonly index: number;
  readonly bbox: Rect;
}

export interface TextLine {
  /** Element indices, left-to-right. */
  readonly items: readonly number[];
  readonly bbox: Rect;
  /** Median height of the line's body items — the type-size estimate. */
  readonly height: number;
}

export interface TextLayout {
  /** Reading order: top-to-bottom, then left-to-right. */
  readonly lines: readonly TextLine[];
  /** Element indices classified diagram-ish — never submitted to OCR. */
  readonly diagram: readonly number[];
}

/** Taller than this many page-median heights → diagram (a box, a bracket). */
const LARGE_HEIGHT_FACTOR = 4;
/** Wider than this many page-median heights → diagram (an arrow, a rule). */
const LARGE_WIDTH_FACTOR = 10;
/** Shorter than this fraction of the page median is a satellite (i-dot). */
const TINY_HEIGHT_FACTOR = 0.6;
/** Two items share a line when their vertical overlap covers this fraction
 *  of the shorter one. */
const BAND_OVERLAP = 0.5;
/** An x-gap wider than this many line heights splits the band into lines. */
const LINE_SPLIT_GAP_FACTOR = 3;
/** A satellite may sit this many line heights off the band and still join. */
const SATELLITE_REACH_FACTOR = 0.8;
/** Body items of one line must agree on height within this ratio. */
const HEIGHT_CONSISTENCY = 3;

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function bboxOfPoints(points: readonly Point[], pad: number): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
}

/** One bbox per element `buildScanElements` will emit, in build order. */
export function layoutItemsFromTrace(trace: TraceResult): LayoutItem[] {
  const items: LayoutItem[] = [];
  let index = 0;
  for (const component of trace.components) {
    if (component.kind === 'fill') {
      const all: Point[] = [];
      for (const loop of component.loops) {
        all.push(...loop);
      }
      items.push({ index: index++, bbox: bboxOfPoints(all, 0) });
      continue;
    }
    for (let i = 0; i < component.paths.length; i++) {
      const pad = component.pathWidths[i]! / 2;
      items.push({ index: index++, bbox: bboxOfPoints(component.paths[i]!, pad) });
    }
  }
  return items;
}

/**
 * The ink each element is made of, aligned with `layoutItemsFromTrace` — what
 * a stroke-based recognizer (ML Kit Digital Ink) is fed, per line, in reading
 * order. A fill contributes its boundary loops; that is not how the letter was
 * written, but it is where the ink is, and the engine's writing-area hint does
 * the rest.
 */
export function elementInk(trace: TraceResult): Point[][][] {
  const ink: Point[][][] = [];
  for (const component of trace.components) {
    if (component.kind === 'fill') {
      ink.push(component.loops.map((loop) => [...loop]));
      continue;
    }
    for (const path of component.paths) {
      ink.push([[...path]]);
    }
  }
  return ink;
}

interface Band {
  items: LayoutItem[];
  top: number;
  bottom: number;
}

function overlap(aTop: number, aBottom: number, bTop: number, bBottom: number): number {
  return Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
}

/**
 * Group items into text lines: y-band clustering, x-gap splitting, satellite
 * absorption, then the text-ish gate. `strokeWidth` is the page pen width `w`
 * from the trace — the floor under every "how small is small" question.
 */
export function groupTextLines(items: readonly LayoutItem[], strokeWidth: number): TextLayout {
  const diagram: number[] = [];
  if (items.length === 0) {
    return { lines: [], diagram };
  }

  // The page's own idea of a character height, from the non-degenerate items.
  const floor = Math.max(2, strokeWidth);
  const h0 = median(items.filter((i) => i.bbox.height > floor).map((i) => i.bbox.height));
  if (h0 === 0) {
    return { lines: [], diagram: items.map((i) => i.index) };
  }

  const large: LayoutItem[] = [];
  const tiny: LayoutItem[] = [];
  const body: LayoutItem[] = [];
  for (const item of items) {
    if (item.bbox.height > LARGE_HEIGHT_FACTOR * h0 || item.bbox.width > LARGE_WIDTH_FACTOR * h0) {
      large.push(item);
    } else if (item.bbox.height < TINY_HEIGHT_FACTOR * h0 && item.bbox.width < h0) {
      tiny.push(item);
    } else {
      body.push(item);
    }
  }
  diagram.push(...large.map((i) => i.index));

  // Vertical bands: an item joins a band when their y-extents overlap by half
  // the shorter one. Greedy over items sorted by centre-y is enough — text
  // rows are separated by more than half a character height or they are not
  // rows.
  const bands: Band[] = [];
  const sorted = [...body].sort(
    (a, b) => a.bbox.y + a.bbox.height / 2 - (b.bbox.y + b.bbox.height / 2),
  );
  for (const item of sorted) {
    const top = item.bbox.y;
    const bottom = item.bbox.y + item.bbox.height;
    let joined = false;
    for (const band of bands) {
      const shared = overlap(top, bottom, band.top, band.bottom);
      const shorter = Math.min(bottom - top, band.bottom - band.top);
      if (shared >= BAND_OVERLAP * shorter) {
        band.items.push(item);
        band.top = Math.min(band.top, top);
        band.bottom = Math.max(band.bottom, bottom);
        joined = true;
        break;
      }
    }
    if (!joined) {
      bands.push({ items: [item], top, bottom });
    }
  }

  // A band is not yet a line: columns and side-by-side labels share a band.
  // Split at x-gaps wider than a few line heights.
  interface Proto {
    items: LayoutItem[];
  }
  const protos: Proto[] = [];
  for (const band of bands) {
    const bandHeight = band.bottom - band.top;
    const byX = [...band.items].sort((a, b) => a.bbox.x - b.bbox.x);
    let current: LayoutItem[] = [byX[0]!];
    let reach = byX[0]!.bbox.x + byX[0]!.bbox.width;
    for (const item of byX.slice(1)) {
      if (item.bbox.x - reach > LINE_SPLIT_GAP_FACTOR * bandHeight) {
        protos.push({ items: current });
        current = [item];
      } else {
        current.push(item);
      }
      reach = Math.max(reach, item.bbox.x + item.bbox.width);
    }
    protos.push({ items: current });
  }

  // Satellites (i-dots, accents, colons' halves) attach to the nearest proto
  // they horizontally overlap and can vertically reach; the rest are diagram.
  for (const dot of tiny) {
    let best: Proto | null = null;
    let bestGap = Infinity;
    for (const proto of protos) {
      const bbox = protoBounds(proto.items);
      const height = bbox.height;
      const xOverlap = overlap(
        dot.bbox.x,
        dot.bbox.x + dot.bbox.width,
        bbox.x - height / 2,
        bbox.x + bbox.width + height / 2,
      );
      if (xOverlap <= 0) {
        continue;
      }
      const gap = Math.max(
        0,
        Math.max(bbox.y - (dot.bbox.y + dot.bbox.height), dot.bbox.y - (bbox.y + bbox.height)),
      );
      if (gap <= SATELLITE_REACH_FACTOR * height && gap < bestGap) {
        best = proto;
        bestGap = gap;
      }
    }
    if (best) {
      best.items.push(dot);
    } else {
      diagram.push(dot.index);
    }
  }

  // The text-ish gate. Multi-item lines must agree on height; a lone item may
  // pass as a single word when it is word-shaped.
  const lines: TextLine[] = [];
  for (const proto of protos) {
    const bbox = protoBounds(proto.items);
    const bodyHeights = proto.items
      .map((i) => i.bbox.height)
      .filter((h) => h >= TINY_HEIGHT_FACTOR * h0);
    const height = median(
      bodyHeights.length > 0 ? bodyHeights : proto.items.map((i) => i.bbox.height),
    );
    let textish: boolean;
    if (bodyHeights.length >= 2) {
      const max = Math.max(...bodyHeights);
      const min = Math.min(...bodyHeights);
      textish = max / Math.max(min, 1) <= HEIGHT_CONSISTENCY && bbox.width >= 0.8 * bbox.height;
    } else {
      const aspect = bbox.width / Math.max(bbox.height, 1);
      textish = aspect >= 0.8 && aspect <= 8 && bbox.height <= 2 * h0;
    }
    if (!textish) {
      diagram.push(...proto.items.map((i) => i.index));
      continue;
    }
    const ordered = [...proto.items].sort((a, b) => a.bbox.x - b.bbox.x);
    lines.push({ items: ordered.map((i) => i.index), bbox, height });
  }

  lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  diagram.sort((a, b) => a - b);
  return { lines, diagram };
}

function protoBounds(items: readonly LayoutItem[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.bbox.x);
    minY = Math.min(minY, item.bbox.y);
    maxX = Math.max(maxX, item.bbox.x + item.bbox.width);
    maxY = Math.max(maxY, item.bbox.y + item.bbox.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
