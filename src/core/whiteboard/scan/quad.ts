/**
 * S1 — find the board.
 *
 * A whiteboard is a big bright quadrilateral on a darker wall, so the detector
 * is: Otsu the luminance, take the largest bright 8-connected blob, hull it,
 * decimate the hull to a handful of vertices, and pick the maximum-area
 * quadrilateral among them. That beats Hough lines on both robustness and code
 * size — a board's edges are frequently occluded, low-contrast or off-frame,
 * and none of that troubles a blob.
 *
 * Detection runs at ~480 px because it does not need pixels; the quad is scaled
 * back to the source's coordinates before it is returned.
 *
 * **The detector is allowed to be wrong.** Every result goes to the crop screen
 * with draggable corners, which is the Drive scanner's actual trick: correcting
 * a bad guess costs one drag. `source: 'frame'` says outright that nothing
 * board-shaped stood out.
 */

import { downscale, labelComponents, luminance, otsuThreshold } from './image-ops';
import type { BoardDetection, Quad, RgbaImage, ScanPoint } from './types';

/** Detection resolution, long edge. Pixels beyond this buy nothing. */
const DETECT_EDGE = 480;

/** A blob smaller than this fraction of the frame is not the board. */
const MIN_BOARD_FRACTION = 0.15;
/** A blob larger than this is the board filling the frame — use the frame. */
const MAX_BOARD_FRACTION = 0.98;

/** Hull vertices fed to the quad search. C(12,4) = 495 subsets: free. */
const MAX_HULL_VERTICES = 12;

/* --------------------------------- hulls ---------------------------------- */

/** Cross product of OA × OB; > 0 means counter-clockwise. */
function cross(o: ScanPoint, a: ScanPoint, b: ScanPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Andrew's monotone chain. Returns the hull counter-clockwise in a
 * y-down coordinate system (i.e. clockwise as drawn on screen), with no
 * repeated first point. Fewer than three input points come back unchanged.
 */
export function convexHull(points: readonly ScanPoint[]): ScanPoint[] {
  if (points.length < 3) {
    return [...points];
  }
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const build = (source: readonly ScanPoint[]): ScanPoint[] => {
    const chain: ScanPoint[] = [];
    for (const point of source) {
      while (
        chain.length >= 2 &&
        cross(chain[chain.length - 2]!, chain[chain.length - 1]!, point) <= 0
      ) {
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * Drop the least significant vertices of a closed polygon until at most `max`
 * remain, cheapest-first by the triangle area each one contributes
 * (Visvalingam–Whyatt). Preferred over an RDP epsilon sweep because it lands on
 * an exact vertex budget in one pass instead of a search over tolerances.
 */
export function decimatePolygon(polygon: readonly ScanPoint[], max: number): ScanPoint[] {
  const points = [...polygon];
  while (points.length > max) {
    let worst = 0;
    let worstArea = Infinity;
    for (let i = 0; i < points.length; i++) {
      const previous = points[(i - 1 + points.length) % points.length]!;
      const next = points[(i + 1) % points.length]!;
      const area = Math.abs(cross(previous, points[i]!, next)) / 2;
      if (area < worstArea) {
        worstArea = area;
        worst = i;
      }
    }
    points.splice(worst, 1);
  }
  return points;
}

/** Shoelace area of a polygon, always positive. */
export function polygonArea(polygon: readonly ScanPoint[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * The maximum-area quadrilateral whose corners are four of `polygon`'s
 * vertices, taken IN POLYGON ORDER so the result is never self-intersecting.
 * Brute force: the caller has already decimated to ≤12 vertices.
 */
export function maxAreaQuad(polygon: readonly ScanPoint[]): Quad | null {
  const n = polygon.length;
  if (n < 4) {
    return null;
  }
  let best: Quad | null = null;
  let bestArea = 0;
  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const candidate: Quad = [polygon[i]!, polygon[j]!, polygon[k]!, polygon[l]!];
          const area = polygonArea(candidate);
          if (area > bestArea) {
            bestArea = area;
            best = candidate;
          }
        }
      }
    }
  }
  return best;
}

/**
 * Put four corners into the canonical top-left, top-right, bottom-right,
 * bottom-left order. Sorting by angle about the centroid fixes the winding;
 * rotating so the corner nearest the top-left of the bounding box comes first
 * fixes the starting point. Doing it here, once, is what lets every other
 * module index a {@link Quad} without re-deriving which corner is which.
 */
export function orderQuad(corners: Quad): Quad {
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
  // atan2 in a y-down space increases clockwise on screen, which IS the
  // TL→TR→BR→BL direction we want.
  const sorted = [...corners].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let first = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const score = sorted[i]!.x + sorted[i]!.y;
    if (score < bestScore) {
      bestScore = score;
      first = i;
    }
  }
  return [
    sorted[first]!,
    sorted[(first + 1) % 4]!,
    sorted[(first + 2) % 4]!,
    sorted[(first + 3) % 4]!,
  ];
}

/** The whole image as a quad — the fallback, and "use whole image". */
export function frameQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/* ------------------------------- detection -------------------------------- */

/**
 * Find the board in `image`. Never fails: when nothing board-shaped stands out
 * the whole frame comes back with `source: 'frame'`, and the crop screen lets
 * the user place the corners themselves.
 */
export function detectBoardQuad(image: RgbaImage): BoardDetection {
  const frame: BoardDetection = {
    quad: frameQuad(image.width, image.height),
    source: 'frame',
  };
  if (image.width < 8 || image.height < 8) {
    return frame;
  }

  const small = downscale(image, DETECT_EDGE);
  const gray = luminance(small);
  const level = otsuThreshold(gray);
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    mask[i] = gray[i]! > level ? 1 : 0;
  }

  const { labels, components } = labelComponents(mask, small.width, small.height);
  let board = components[0];
  for (const component of components) {
    if (!board || component.area > board.area) {
      board = component;
    }
  }
  if (!board) {
    return frame;
  }

  const fraction = board.area / (small.width * small.height);
  const fillsFrame = board.touchesBorder.every(Boolean);
  if (fraction < MIN_BOARD_FRACTION || fraction > MAX_BOARD_FRACTION || fillsFrame) {
    return frame;
  }

  // The convex hull of a point set is the hull of each row's leftmost and
  // rightmost members — every other point is a convex combination of those two
  // — so scanning row extremes gives the same hull from O(height) points.
  const extremes: ScanPoint[] = [];
  for (let y = board.minY; y <= board.maxY; y++) {
    let left = -1;
    let right = -1;
    for (let x = board.minX; x <= board.maxX; x++) {
      if (labels[y * small.width + x] === board.label) {
        if (left < 0) {
          left = x;
        }
        right = x;
      }
    }
    if (left >= 0) {
      extremes.push({ x: left, y });
      if (right !== left) {
        extremes.push({ x: right, y });
      }
    }
  }

  const hull = convexHull(extremes);
  const quad = maxAreaQuad(decimatePolygon(hull, MAX_HULL_VERTICES));
  if (!quad) {
    return frame;
  }
  // A quad that recovers less than half its own hull is not a rectangle seen at
  // an angle; it is a blob that happens to be bright.
  if (polygonArea(quad) < polygonArea(hull) * 0.5) {
    return frame;
  }

  const sx = image.width / small.width;
  const sy = image.height / small.height;
  const scaled = quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as unknown as Quad;
  return { quad: orderQuad(scaled), source: 'detected' };
}
