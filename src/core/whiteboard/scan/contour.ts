/**
 * S5's fallback for genuinely BLOBBY ink — a filled-in shape, a solid
 * arrowhead — where a centerline would be a lie. Marching squares walks the
 * 0.5 iso-contour of the component's mask into closed loops: the outer
 * boundary plus any holes, which is why the output path carries
 * `fill-rule="evenodd"` (a donut must stay a donut).
 *
 * Vertices sit on pixel-edge midpoints, so the loops land within half a pixel
 * of the mask boundary; RDP afterwards (at the tracer's ε) is what makes them
 * light enough to keep.
 */

import type { Point } from '../geometry';

/**
 * Trace every boundary loop of a binary window. Loops come back closed
 * (last point repeats the first) in window-local pixel coordinates. The
 * caller must pad the window with a background border — the marching grid
 * only sees transitions, and ink flush against the window edge would
 * otherwise leave its loop open.
 */
export function traceContours(mask: Uint8Array, width: number, height: number): Point[][] {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x]!;

  /*
   * Each 2×2 cell (corner = pixel centre) gets a case from its corners:
   * bit 0 = top-left, 1 = top-right, 2 = bottom-right, 3 = bottom-left.
   * A segment enters and leaves through edge midpoints, directed so that INK
   * STAYS ON THE LEFT — consistent orientation is what keeps evenodd sane
   * after RDP. Saddles (cases 5 and 10) split into two corner passes; with a
   * binary mask the disambiguation just has to be consistent, and "separate
   * the diagonals" is the choice that never fuses two touching strokes.
   */
  const segments = new Map<string, { to: Point; from: Point }>();
  const key = (p: Point): string => `${p.x},${p.y}`;
  const addSegment = (from: Point, to: Point): void => {
    segments.set(key(from), { from, to });
  };

  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const caseIndex = tl | (tr << 1) | (br << 2) | (bl << 3);
      if (caseIndex === 0 || caseIndex === 15) {
        continue;
      }
      // Edge midpoints of the cell, in pixel-centre coordinates.
      const top: Point = { x: x + 1, y: y + 0.5 };
      const right: Point = { x: x + 1.5, y: y + 1 };
      const bottom: Point = { x: x + 1, y: y + 1.5 };
      const left: Point = { x: x + 0.5, y: y + 1 };
      switch (caseIndex) {
        case 1:
          addSegment(left, top);
          break;
        case 2:
          addSegment(top, right);
          break;
        case 3:
          addSegment(left, right);
          break;
        case 4:
          addSegment(right, bottom);
          break;
        case 5: // saddle: TL+BR ink — keep the diagonals separate
          addSegment(left, top);
          addSegment(right, bottom);
          break;
        case 6:
          addSegment(top, bottom);
          break;
        case 7:
          addSegment(left, bottom);
          break;
        case 8:
          addSegment(bottom, left);
          break;
        case 9:
          addSegment(bottom, top);
          break;
        case 10: // saddle: TR+BL ink
          addSegment(top, right);
          addSegment(bottom, left);
          break;
        case 11:
          addSegment(bottom, right);
          break;
        case 12:
          addSegment(right, left);
          break;
        case 13:
          addSegment(right, top);
          break;
        case 14:
          addSegment(top, left);
          break;
      }
    }
  }

  // Link segments into loops: each vertex is the start of exactly one segment
  // (the saddle convention guarantees it), so following `to` walks the loop.
  const loops: Point[][] = [];
  const visited = new Set<string>();
  for (const [startKey, first] of segments) {
    if (visited.has(startKey)) {
      continue;
    }
    const loop: Point[] = [first.from];
    let cursor = first;
    for (;;) {
      visited.add(key(cursor.from));
      loop.push(cursor.to);
      const next = segments.get(key(cursor.to));
      if (!next || visited.has(key(next.from))) {
        break;
      }
      cursor = next;
    }
    if (loop.length >= 4) {
      loops.push(loop);
    }
  }
  return loops;
}
