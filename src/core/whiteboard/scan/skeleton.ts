/**
 * S5, second step — a thinned skeleton back into POLYLINES that read like the
 * strokes a person drew.
 *
 * 1. Classify skeleton pixels by 8-neighbour count: 1 = endpoint, 2 = path,
 *    ≥3 = junction. Adjacent junction pixels are clustered into ONE node —
 *    thinning leaves 2-px junction knots, and treating each knot pixel as its
 *    own junction would shatter every crossing.
 * 2. Walk the degree-2 chains between nodes into edges; closed loops with no
 *    node at all (a drawn "O") become their own cycle edge.
 * 3. Prune SPURS — edges shorter than `spurLength` hanging off a junction.
 *    Thinning always grows little barbs at stroke ends and crossings; a real
 *    short stroke is endpoint-to-endpoint and is never pruned. When the caller
 *    provides ink widths, pruning is also WIDTH-AWARE: a dangling edge much
 *    thinner than the pen (a binarization wisp along a rough stroke edge) is
 *    pruned even past the spur length, because the junction it fakes is what
 *    fragments the real stroke it hangs off.
 * 4. Continue THROUGH junctions: at each junction, pair the incident edge
 *    ends whose directions best continue each other, so an "X" becomes two
 *    smooth strokes rather than four stubs and a crossed-out word stays
 *    readable. Pairs are only accepted below a bend threshold — a "T"'s stem
 *    must NOT fuse with half its crossbar. Pen-width edges pair first; residue
 *    wisps never steal a continuation from the stroke they cling to.
 *
 * Everything is in window-local pixel coordinates; the tracer offsets to the
 *  board and hands the result to the same smoothing the pen tool uses.
 */

import type { Point } from '../geometry';

/** Neighbour offsets, clockwise from north. */
const DX = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const DY = [-1, -1, 0, 1, 1, 1, 0, -1] as const;

/**
 * Only merge two edges through a junction when their directions deviate from
 * a straight continuation by less than this. 75° is deliberately permissive:
 * handwriting corners are sharp, but a fused right angle still reads as one
 * pen movement, while refusing a genuine crossing shatters it into stubs —
 * the worse error, per the phase-3/5 pattern of preferring continuity.
 */
const CONTINUATION_LIMIT = (75 * Math.PI) / 180;

/** How many pixels into an edge the junction-direction estimate looks. */
const DIRECTION_SPAN = 5;

interface Edge {
  /** Node ids at each end; -1 for a closed cycle (both ends). */
  a: number;
  b: number;
  /** Pixel-centre points from the `a` end to the `b` end. */
  points: Point[];
  length: number;
  alive: boolean;
  /** Much thinner than the pen — a binarization wisp, not drawn ink. */
  residue: boolean;
}

export interface SkeletonWidthOptions {
  /** Full ink width (2 × EDT) at a skeleton point, in pixels. */
  readonly widthAt: (p: Point) => number;
  /** Median edge width below this is residue (typically 0.5 × pen width). */
  readonly residueWidth: number;
  /** Dangling residue edges shorter than this are pruned (typically 3 × w). */
  readonly residueLength: number;
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

/**
 * Skeleton → polylines. `spurLength` is 1.2·w at the call site; pixels are
 * window-local. Deterministic: pixels are visited in raster order.
 */
export function traceSkeletonPaths(
  skeleton: Uint8Array,
  width: number,
  height: number,
  spurLength: number,
  widths?: SkeletonWidthOptions,
): Point[][] {
  const on = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && skeleton[y * width + x] !== 0;

  /**
   * Skeleton adjacency: orthogonal always; DIAGONAL only when neither
   * orthogonal bridge pixel is ink. A thinned staircase corner keeps both the
   * step and its diagonal shortcut, and counting the shortcut manufactures a
   * fake junction at every corner — the standard redundant-diagonal rule
   * removes exactly those without ever disconnecting anything (the bridge
   * pixel IS the connection).
   */
  const adjacent = (x1: number, y1: number, x2: number, y2: number): boolean => {
    if (!on(x2, y2)) {
      return false;
    }
    if (x1 !== x2 && y1 !== y2 && (on(x2, y1) || on(x1, y2))) {
      return false;
    }
    return true;
  };

  const degree = new Int8Array(width * height);
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (skeleton[i] === 0) {
        continue;
      }
      pixels.push(i);
      let d = 0;
      for (let n = 0; n < 8; n++) {
        if (adjacent(x, y, x + DX[n]!, y + DY[n]!)) {
          d++;
        }
      }
      degree[i] = d;
    }
  }

  /*
   * Node ids. Junction pixels (degree ≥3) cluster with adjacent junction
   * pixels; endpoints (degree 1) stand alone; isolated pixels (degree 0) are
   * dots and short-circuit to a single-point path.
   */
  const nodeId = new Int32Array(width * height).fill(-1);
  let nodes = 0;
  const paths: Point[][] = [];
  for (const i of pixels) {
    if (degree[i] === 0) {
      paths.push([{ x: (i % width) + 0.5, y: ((i / width) | 0) + 0.5 }]);
    } else if (degree[i] === 1 && nodeId[i] === -1) {
      nodeId[i] = nodes++;
    } else if (degree[i]! >= 3 && nodeId[i] === -1) {
      // Flood the junction cluster.
      const id = nodes++;
      const stack = [i];
      nodeId[i] = id;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const px = p % width;
        const py = (p / width) | 0;
        for (let n = 0; n < 8; n++) {
          const nx = px + DX[n]!;
          const ny = py + DY[n]!;
          if (!adjacent(px, py, nx, ny)) {
            continue;
          }
          const q = ny * width + nx;
          if (degree[q]! >= 3 && nodeId[q] === -1) {
            nodeId[q] = id;
            stack.push(q);
          }
        }
      }
    }
  }

  const centre = (i: number): Point => ({ x: (i % width) + 0.5, y: ((i / width) | 0) + 0.5 });

  /*
   * Walk edges. From every node pixel, follow each neighbour outward through
   * degree-2 pixels until another node pixel terminates the walk. Path pixels
   * are consumed (`used`), so each chain is walked exactly once; direct
   * node-to-node adjacencies dedupe through a pair set.
   */
  const used = new Uint8Array(width * height);
  const edges: Edge[] = [];
  const nodeEdges: number[][] = Array.from({ length: nodes }, () => []);
  const directPairs = new Set<string>();

  const isResidue = (points: readonly Point[]): boolean => {
    if (!widths) {
      return false;
    }
    const sampled = points.map((p) => widths.widthAt(p)).sort((a, b) => a - b);
    return (sampled[Math.floor(sampled.length / 2)] ?? Infinity) < widths.residueWidth;
  };

  const addEdge = (edge: Edge): void => {
    edge.length = polylineLength(edge.points);
    edge.residue = isResidue(edge.points);
    const index = edges.length;
    edges.push(edge);
    if (edge.a >= 0) {
      nodeEdges[edge.a]!.push(index);
    }
    if (edge.b >= 0 && edge.b !== edge.a) {
      nodeEdges[edge.b]!.push(index);
    } else if (edge.b === edge.a && edge.b >= 0) {
      nodeEdges[edge.b]!.push(index); // a self-loop occupies two slots
    }
  };

  for (const start of pixels) {
    if (nodeId[start] === -1) {
      continue;
    }
    const sx = start % width;
    const sy = (start / width) | 0;
    for (let n = 0; n < 8; n++) {
      const nx = sx + DX[n]!;
      const ny = sy + DY[n]!;
      if (!adjacent(sx, sy, nx, ny)) {
        continue;
      }
      const first = ny * width + nx;
      if (nodeId[first] !== -1) {
        // Node touching node. Within one junction cluster this is internal
        // wiring, not an edge; across nodes it is a (tiny) edge.
        if (nodeId[first] === nodeId[start]) {
          continue;
        }
        const key = start < first ? `${start},${first}` : `${first},${start}`;
        if (directPairs.has(key)) {
          continue;
        }
        directPairs.add(key);
        addEdge({
          a: nodeId[start]!,
          b: nodeId[first]!,
          points: [centre(start), centre(first)],
          length: 0,
          alive: true,
          residue: false,
        });
        continue;
      }
      if (used[first] !== 0) {
        continue;
      }
      // Walk the chain.
      const points: Point[] = [centre(start)];
      let previous = start;
      let current = first;
      for (;;) {
        used[current] = 1;
        points.push(centre(current));
        if (nodeId[current] !== -1) {
          break;
        }
        const cx = current % width;
        const cy = (current / width) | 0;
        let next = -1;
        for (let m = 0; m < 8; m++) {
          const mx = cx + DX[m]!;
          const my = cy + DY[m]!;
          if (!adjacent(cx, cy, mx, my)) {
            continue;
          }
          const q = my * width + mx;
          if (q === previous) {
            continue;
          }
          if (nodeId[q] !== -1 || used[q] === 0) {
            next = q;
            break;
          }
        }
        if (next === -1) {
          break; // chain end with no node — a 2-px stub; keep what we have
        }
        previous = current;
        current = next;
        if (nodeId[current] !== -1) {
          used[current] = 0; // node pixels are never consumed
          points.push(centre(current));
          break;
        }
      }
      const endNode = nodeId[current] !== -1 ? nodeId[current]! : -2;
      addEdge({
        a: nodeId[start]!,
        b: endNode === -2 ? nodeId[start]! : endNode,
        points,
        length: 0,
        alive: true,
        residue: false,
      });
    }
  }

  /*
   * Closed cycles: degree-2 pixels no walk consumed (an "O" has no node
   * anywhere). Walk them round and close the loop explicitly.
   */
  for (const start of pixels) {
    if (degree[start] !== 2 || used[start] !== 0 || nodeId[start] !== -1) {
      continue;
    }
    const points: Point[] = [];
    let previous = -1;
    let current = start;
    for (;;) {
      used[current] = 1;
      points.push(centre(current));
      const cx = current % width;
      const cy = (current / width) | 0;
      let next = -1;
      for (let m = 0; m < 8; m++) {
        const mx = cx + DX[m]!;
        const my = cy + DY[m]!;
        if (!adjacent(cx, cy, mx, my)) {
          continue;
        }
        const q = my * width + mx;
        if (q !== previous && used[q] === 0) {
          next = q;
          break;
        }
      }
      if (next === -1) {
        break;
      }
      previous = current;
      current = next;
    }
    if (points.length >= 3) {
      points.push(points[0]!); // close the loop
    }
    edges.push({
      a: -1,
      b: -1,
      points,
      length: polylineLength(points),
      alive: true,
      residue: isResidue(points),
    });
  }

  /*
   * Spur pruning. A spur ends at an endpoint node, hangs off a junction, and
   * is shorter than `spurLength` — a thinning barb, not drawn ink. Iterate to
   * a fixpoint: removing one barb can expose another underneath it.
   */
  const isJunction = (node: number): boolean =>
    nodeEdges[node]!.filter((e) => edges[e]!.alive).length >= 2;
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const edge of edges) {
      // A residue wisp gets the longer leash: it fakes junctions that
      // fragment the pen-width stroke it hangs off, so it is pruned up to
      // `residueLength` — but never past it (a fading stroke's tapering tail
      // is thin AND long, and losing ink is still the worse error).
      const limit =
        edge.residue && widths ? Math.max(spurLength, widths.residueLength) : spurLength;
      if (!edge.alive || edge.a < 0 || edge.length >= limit) {
        continue;
      }
      const aFree = nodeEdges[edge.a]!.filter((e) => edges[e]!.alive).length === 1;
      const bFree = nodeEdges[edge.b]!.filter((e) => edges[e]!.alive).length === 1;
      // One end dangling, the other still a junction → barb. Both ends
      // dangling is a real (short) stroke and stays.
      if ((aFree && !bFree && isJunction(edge.b)) || (bFree && !aFree && isJunction(edge.a))) {
        edge.alive = false;
        pruned = true;
      }
    }
  }

  /*
   * Junction continuation. At each node, the incident edge ends propose
   * directions (a short look into the edge); the straightest-continuing pair
   * merges, repeatedly, while the bend stays under the limit.
   */
  interface EdgeEnd {
    edge: number;
    /** true = the edge's `a` end sits at this node. */
    atA: boolean;
  }
  /** partner[edge] holds the paired end at each side, or null. */
  const partners: Array<{ atA: EdgeEnd | null; atB: EdgeEnd | null }> = edges.map(() => ({
    atA: null,
    atB: null,
  }));

  const endDirection = (end: EdgeEnd): Point => {
    const edge = edges[end.edge]!;
    const points = end.atA ? edge.points : [...edge.points].reverse();
    const anchor = points[0]!;
    const span = Math.min(DIRECTION_SPAN, points.length - 1);
    const target = points[span]!;
    const length = Math.hypot(target.x - anchor.x, target.y - anchor.y) || 1;
    return { x: (target.x - anchor.x) / length, y: (target.y - anchor.y) / length };
  };

  for (let node = 0; node < nodes; node++) {
    const ends: EdgeEnd[] = [];
    for (const e of nodeEdges[node]!) {
      const edge = edges[e]!;
      if (!edge.alive) {
        continue;
      }
      if (edge.a === node) {
        ends.push({ edge: e, atA: true });
      }
      // A self-loop contributes both of its ends — unless it is degenerate.
      if (edge.b === node && (edge.a !== node || edge.points.length > 2)) {
        ends.push({ edge: e, atA: false });
      }
    }
    const available = ends.filter((end) => {
      const p = partners[end.edge]!;
      return end.atA ? p.atA === null : p.atB === null;
    });
    // Pen-width edges pair among themselves FIRST: a wisp that survives
    // pruning often leaves a junction at a shallower angle than the true
    // continuation, and letting it win would route the stroke onto the wisp.
    const pairPool = (candidates: EdgeEnd[]): EdgeEnd[] => {
      let pool = candidates;
      while (pool.length >= 2) {
        let bestI = -1;
        let bestJ = -1;
        let bestBend = Infinity;
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const di = endDirection(pool[i]!);
            const dj = endDirection(pool[j]!);
            // Continuation quality: entering along di, leaving along dj should
            // be a straight line, i.e. dj ≈ −di.
            const dot = -(di.x * dj.x + di.y * dj.y);
            const bend = Math.acos(Math.max(-1, Math.min(1, dot)));
            if (bend < bestBend) {
              bestBend = bend;
              bestI = i;
              bestJ = j;
            }
          }
        }
        if (bestBend > CONTINUATION_LIMIT) {
          break;
        }
        const endA = pool[bestI]!;
        const endB = pool[bestJ]!;
        if (endA.atA) {
          partners[endA.edge]!.atA = endB;
        } else {
          partners[endA.edge]!.atB = endB;
        }
        if (endB.atA) {
          partners[endB.edge]!.atA = endA;
        } else {
          partners[endB.edge]!.atB = endA;
        }
        pool = pool.filter((_, index) => index !== bestI && index !== bestJ);
      }
      return pool;
    };
    const solid = available.filter((end) => !edges[end.edge]!.residue);
    const residue = available.filter((end) => edges[end.edge]!.residue);
    pairPool([...pairPool(solid), ...residue]);
  }

  /*
   * Assemble chains: start from every unconsumed edge end that has no partner
   * (a true stroke end) and follow pairings; anything left after that is a
   * fully-paired cycle.
   */
  const consumed = new Uint8Array(edges.length);
  const chainFrom = (start: EdgeEnd): Point[] => {
    const out: Point[] = [];
    let end: EdgeEnd | null = start;
    while (end !== null && consumed[end.edge] === 0) {
      consumed[end.edge] = 1;
      const edge: Edge = edges[end.edge]!;
      // Entering at this end means traversing toward the other one.
      const points = end.atA ? edge.points : [...edge.points].reverse();
      // Drop the duplicated junction point between merged edges. Pushed in a
      // loop, not a spread — a long scanned stroke can be thousands of points
      // and a spread that size overflows the call stack.
      for (let i = out.length > 0 ? 1 : 0; i < points.length; i++) {
        out.push(points[i]!);
      }
      const exit: { atA: EdgeEnd | null; atB: EdgeEnd | null } = partners[end.edge]!;
      end = end.atA ? exit.atB : exit.atA;
    }
    return out;
  };

  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e]!;
    if (!edge.alive || consumed[e] !== 0 || edge.a < 0) {
      continue;
    }
    const p = partners[e]!;
    if (p.atA === null) {
      paths.push(chainFrom({ edge: e, atA: true }));
    } else if (p.atB === null) {
      paths.push(chainFrom({ edge: e, atA: false }));
    }
  }
  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e]!;
    if (!edge.alive || consumed[e] !== 0) {
      continue;
    }
    if (edge.a < 0) {
      consumed[e] = 1;
      paths.push(edge.points); // a nodeless cycle
    } else {
      paths.push(chainFrom({ edge: e, atA: true })); // a fully-paired ring
    }
  }

  return paths.filter((p) => p.length > 0);
}
