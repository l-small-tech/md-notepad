/**
 * S5, first step — thin a component's mask to a 1-px skeleton (Zhang–Suen,
 * IEEE TPAMI 1984). The skeleton is what turns a blob of ink pixels back into
 * the STROKE that made them: its pixels sit on the centerline the marker tip
 * actually travelled, which is why the traced output can be an ordinary
 * editable `<path wb:tool="pen">` instead of a locked outline.
 *
 * Cost discipline: the classic formulation rescans the whole window every
 * iteration, and a thick component needs ~half its stroke width in iterations.
 * Here each iteration examines only an ACTIVE FRONTIER — pixels that had a
 * background neighbour, plus the neighbours of pixels deleted last round —
 * so the total work is O(ink pixels), not O(window × iterations). Ink
 * coverage on a board is typically 2–6%, and this is the difference between
 * "instant" and "seconds" on a low-end tablet (plan risk 8).
 */

/**
 * Thin a binary window in place to an 8-connected, mostly-1-px skeleton.
 * `mask` holds 0/1; out-of-bounds counts as background. The caller passes a
 * component's own sub-window (bbox + 1 px pad), never the whole board —
 * per-component windows are what keep the frontier small.
 */
export function thinInPlace(mask: Uint8Array, width: number, height: number): void {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x]!;

  // Neighbour ring P2..P9, clockwise from north — the paper's numbering.
  const ring = (
    x: number,
    y: number,
  ): [number, number, number, number, number, number, number, number] => [
    at(x, y - 1),
    at(x + 1, y - 1),
    at(x + 1, y),
    at(x + 1, y + 1),
    at(x, y + 1),
    at(x - 1, y + 1),
    at(x - 1, y),
    at(x - 1, y - 1),
  ];

  /** Deletable under Zhang–Suen's sub-iteration `pass` (0 or 1). */
  const deletable = (x: number, y: number, pass: 0 | 1): boolean => {
    const p = ring(x, y);
    let b = 0;
    for (let i = 0; i < 8; i++) {
      b += p[i]!;
    }
    if (b < 2 || b > 6) {
      return false; // endpoint or interior — both must stay
    }
    let transitions = 0;
    for (let i = 0; i < 8; i++) {
      if (p[i] === 0 && p[(i + 1) % 8] === 1) {
        transitions++;
      }
    }
    if (transitions !== 1) {
      return false; // deleting would split the component
    }
    // The directional conditions: [north, east, south, west] = p[0], p[2], p[4], p[6].
    if (pass === 0) {
      return p[0]! * p[2]! * p[4]! === 0 && p[2]! * p[4]! * p[6]! === 0;
    }
    return p[0]! * p[2]! * p[6]! === 0 && p[0]! * p[4]! * p[6]! === 0;
  };

  // Seed the frontier with every ink pixel touching background — interior
  // pixels cannot be deletable until the erosion reaches them.
  let frontier: number[] = [];
  const queued = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] === 0) {
        continue;
      }
      if (
        at(x, y - 1) === 0 ||
        at(x + 1, y) === 0 ||
        at(x, y + 1) === 0 ||
        at(x - 1, y) === 0 ||
        at(x + 1, y - 1) === 0 ||
        at(x + 1, y + 1) === 0 ||
        at(x - 1, y + 1) === 0 ||
        at(x - 1, y - 1) === 0
      ) {
        frontier.push(i);
        queued[i] = 1;
      }
    }
  }

  while (frontier.length > 0) {
    let deletedAny = false;
    const next: number[] = [];
    const nextQueued = new Uint8Array(width * height);
    for (const pass of [0, 1] as const) {
      // Mark first, delete after: each sub-iteration's decisions must all be
      // made against the same image, or thinning becomes order-dependent.
      const doomed: number[] = [];
      for (const i of frontier) {
        if (mask[i] === 0) {
          continue;
        }
        const x = i % width;
        const y = (i / width) | 0;
        if (deletable(x, y, pass)) {
          doomed.push(i);
        }
      }
      for (const i of doomed) {
        mask[i] = 0;
        deletedAny = true;
        const x = i % width;
        const y = (i / width) | 0;
        // A deleted pixel exposes its neighbours — they are the next frontier.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              continue;
            }
            const n = ny * width + nx;
            if (mask[n] !== 0 && nextQueued[n] === 0) {
              next.push(n);
              nextQueued[n] = 1;
            }
          }
        }
      }
    }
    if (!deletedAny) {
      break;
    }
    // Survivors of this round stay candidates — a pixel skipped in pass 0 can
    // become deletable once its neighbours went in pass 1.
    for (const i of frontier) {
      if (mask[i] !== 0 && nextQueued[i] === 0) {
        next.push(i);
        nextQueued[i] = 1;
      }
    }
    frontier = next;
  }
}
