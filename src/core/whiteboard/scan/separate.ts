/**
 * S4.5 — SEPARATE mixed-marker components before colour voting.
 *
 * S4's premise is "one component, one marker" — and it breaks exactly where
 * whiteboard diagrams live: wires CROSS. A black wire crossing a red bus line
 * binarizes into one 8-connected component, the mixed vote lands on whichever
 * marker has more chroma-weighted pixels, and the black wire is painted red
 * (phase-7 UAT, a real wiring board — one merged component spanned a fifth of
 * the page). No per-component threshold can fix a component that genuinely
 * holds two markers, so this stage splits it:
 *
 * 1. RIDGE pixels (local maxima of the distance transform — the stroke
 *    centerlines, present in thin and fat strokes alike, and the purest
 *    colour samples) are classified into page-level colour clusters: black
 *    (`isBlackVote`) or the nearest page marker hue (`estimateMarkerHues`
 *    over all ridge votes).
 * 2. A component is MIXED when at least two clusters each own a real share
 *    of its ridge (≥ `MIN_SHARE` and ≥ `minRidge` pixels — one noisy fleck
 *    must not split a stroke).
 * 3. A mixed component's pixels are claimed by multi-source BFS from the
 *    classified ridge seeds; each cluster's take becomes a NEW component
 *    (fresh label). Geometry stats (area, bbox, dtMax, perimeter, thinness —
 *    the ones tracing consults) are recomputed; provenance stats
 *    (strongRatio, meanChroma, glare, border) are inherited from the parent,
 *    whose evidence they describe.
 *
 * Non-mixed components pass through UNTOUCHED — same labels, same stats — so
 * a board without crossings is byte-identical to the pre-split pipeline.
 */

import { estimateMarkerHues, isBlackVote, rgbToHueChroma } from './color';
import type { InkComponent, InkExtraction } from './components';
import type { RgbaImage } from './types';

/** Minimum fraction of a component's ridge a cluster needs to force a split. */
const MIN_SHARE = 0.05;
/** Ridge pixels below this distance are anti-aliased edge, not centerline. */
const RIDGE_FLOOR = 1;
/** Circular distance between two hues, 0–180. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function separateColors(normalized: RgbaImage, extraction: InkExtraction): InkExtraction {
  const { width, data } = normalized;
  const height = normalized.height;
  const { labels, distance, components, strokeWidth: w } = extraction;

  // 1. Ridge pixels of kept ink, classified. Cluster 0 is black; chromatic
  // votes are collected first so the page's marker hues can be estimated.
  interface RidgeVote {
    readonly index: number;
    readonly label: number;
    readonly hue: number;
    readonly chroma: number;
    readonly black: boolean;
  }
  const ridge: RidgeVote[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const label = labels[i]!;
      const d = distance[i]!;
      if (label === 0 || d < RIDGE_FLOOR) {
        continue;
      }
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) {
            continue;
          }
          if (distance[ny * width + nx]! > d) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) {
        continue;
      }
      const p = i * 4;
      const r = data[p]!;
      const g = data[p + 1]!;
      const b = data[p + 2]!;
      const { hue, chroma } = rgbToHueChroma(r, g, b);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      ridge.push({ index: i, label, hue, chroma, black: isBlackVote(chroma, lum) });
    }
  }

  const peaks = estimateMarkerHues(
    ridge.filter((v) => !v.black).map((v) => ({ hue: v.hue, weight: v.chroma })),
  );

  // Cluster id per ridge pixel: 0 = black, 1 + peak index for chromatic ones.
  // A chromatic vote always takes the NEAREST peak — the peak list is derived
  // from these very votes, and an outlier must not found its own cluster.
  const clusterOf = (v: RidgeVote): number => {
    if (v.black || peaks.length === 0) {
      return 0;
    }
    let best = 0;
    let bestDist = Infinity;
    for (let p = 0; p < peaks.length; p++) {
      const dist = hueDistance(v.hue, peaks[p]!);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best + 1;
  };

  // 2. Ridge tallies per component.
  const tallies = new Map<number, Map<number, number>>();
  const votesByLabel = new Map<number, RidgeVote[]>();
  for (const v of ridge) {
    const cluster = clusterOf(v);
    let t = tallies.get(v.label);
    if (t === undefined) {
      t = new Map();
      tallies.set(v.label, t);
    }
    t.set(cluster, (t.get(cluster) ?? 0) + 1);
    let list = votesByLabel.get(v.label);
    if (list === undefined) {
      list = [];
      votesByLabel.set(v.label, list);
    }
    list.push(v);
  }

  const minRidge = Math.max(6, Math.round(w));
  let maxLabel = 0;
  for (const c of components) {
    maxLabel = Math.max(maxLabel, c.label);
  }
  for (const r of extraction.removedComponents) {
    maxLabel = Math.max(maxLabel, r.component.label);
  }

  let nextLabel = maxLabel + 1;
  let newLabels: Int32Array | null = null;
  const keptComponents: InkComponent[] = [];

  for (const c of components) {
    const t = tallies.get(c.label);
    const total = t === undefined ? 0 : [...t.values()].reduce((a, b) => a + b, 0);
    const real =
      t === undefined
        ? []
        : [...t.entries()]
            .filter(([, n]) => n >= minRidge && n / total >= MIN_SHARE)
            .map(([cluster]) => cluster)
            .sort((a, b) => a - b);
    if (real.length < 2) {
      keptComponents.push(c);
      continue;
    }

    // 3. Split: BFS from classified ridge seeds over the component's pixels.
    newLabels ??= labels.slice();
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const local = (x: number, y: number) => (y - c.minY) * bw + (x - c.minX);
    const claim = new Int32Array(bw * bh); // 0 = unclaimed, else 1 + cluster
    const labelForCluster = new Map<number, number>();
    for (const cluster of real) {
      labelForCluster.set(cluster, nextLabel++);
    }
    let frontier: number[] = [];
    for (const v of votesByLabel.get(c.label)!) {
      const cluster = clusterOf(v);
      // Seeds of non-real clusters join the nearest real one by BFS instead.
      if (!labelForCluster.has(cluster)) {
        continue;
      }
      const x = v.index % width;
      const y = (v.index / width) | 0;
      claim[local(x, y)] = 1 + cluster;
      frontier.push(v.index);
    }
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const p of frontier) {
        const px = p % width;
        const py = (p / width) | 0;
        const cls = claim[local(px, py)]!;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if (nx < c.minX || nx > c.maxX || ny < c.minY || ny > c.maxY) {
              continue;
            }
            const n = ny * width + nx;
            if (labels[n] === c.label && claim[local(nx, ny)] === 0) {
              claim[local(nx, ny)] = cls;
              next.push(n);
            }
          }
        }
      }
      frontier = next;
    }

    // Write labels and recompute the geometry stats tracing consults.
    interface Acc {
      area: number;
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      dtMax: number;
      perimeter: number;
    }
    const accs = new Map<number, Acc>();
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * width + x;
        if (labels[i] !== c.label) {
          continue;
        }
        const cls = claim[local(x, y)]!;
        const label =
          cls === 0 ? labelForCluster.get(real[0]!)! : (labelForCluster.get(cls - 1) ?? null);
        if (label === null) {
          continue;
        }
        newLabels[i] = label;
        let acc = accs.get(label);
        if (acc === undefined) {
          acc = { area: 0, minX: x, minY: y, maxX: x, maxY: y, dtMax: 0, perimeter: 0 };
          accs.set(label, acc);
        }
        acc.area++;
        acc.minX = Math.min(acc.minX, x);
        acc.minY = Math.min(acc.minY, y);
        acc.maxX = Math.max(acc.maxX, x);
        acc.maxY = Math.max(acc.maxY, y);
        if (distance[i]! > acc.dtMax) {
          acc.dtMax = distance[i]!;
        }
      }
    }
    // Perimeter in a second pass, against the FINAL labels, so the cut line
    // between two clusters counts as boundary for both sides.
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        const i = y * width + x;
        const label = newLabels[i]!;
        const acc = accs.get(label);
        if (acc === undefined) {
          continue;
        }
        const boundary =
          x === 0 ||
          x === width - 1 ||
          y === 0 ||
          y === height - 1 ||
          newLabels[i - 1] !== label ||
          newLabels[i + 1] !== label ||
          newLabels[i - width] !== label ||
          newLabels[i + width] !== label;
        if (boundary) {
          acc.perimeter++;
        }
      }
    }
    for (const [label, a] of [...accs.entries()].sort((x, y) => x[0] - y[0])) {
      keptComponents.push({
        label,
        area: a.area,
        minX: a.minX,
        minY: a.minY,
        maxX: a.maxX,
        maxY: a.maxY,
        perimeter: a.perimeter,
        thinness: (a.perimeter * a.perimeter) / a.area,
        strongRatio: c.strongRatio,
        meanChroma: c.meanChroma,
        dtMax: a.dtMax,
        touchesBorder: c.touchesBorder,
        glareRatio: c.glareRatio,
      });
    }
  }

  if (newLabels === null) {
    return extraction;
  }
  keptComponents.sort((a, b) => a.label - b.label);
  return {
    mask: extraction.mask,
    labels: newLabels,
    components: keptComponents,
    strokeWidth: w,
    distance: extraction.distance,
    removed: extraction.removed,
    removedComponents: extraction.removedComponents,
    weakLabels: extraction.weakLabels,
  };
}
