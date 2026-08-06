/**
 * Exact Euclidean distance transform — Felzenszwalb & Huttenlocher's
 * lower-envelope-of-parabolas algorithm, O(n), separable.
 *
 * The scan pipeline leans on it twice: the page's stroke width `w` is the
 * median of the transform's local maxima (so every filter threshold can be
 * expressed in units of `w` instead of absolute pixels), and colour voting
 * uses only "core" pixels — the ones far from a stroke's anti-aliased,
 * hue-shifted edge — which is precisely what the transform measures.
 */

/**
 * 1-D squared distance transform of a sampled function `f`, in place into
 * `out`. Standard F–H: maintain the lower envelope of the parabolas
 * `(i, f[i])`, then read it out.
 */
function transform1d(
  f: Float64Array,
  n: number,
  out: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) {
      k++;
    }
    const d = q - v[k]!;
    out[q] = d * d + f[v[k]!]!;
  }
}

/**
 * Euclidean distance from each non-zero mask pixel to the nearest zero pixel
 * (background). Pixels outside the mask read 0. Values are true distances
 * (already square-rooted). The image border does NOT count as background —
 * ink cropped by the frame edge keeps its real half-width.
 */
export function distanceTransform(
  mask: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const INF = 1e12;
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = mask[i] !== 0 ? INF : 0;
  }
  const maxDim = Math.max(width, height);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);
  // Columns first, then rows — the classic separable pass order.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = grid[y * width + x]!;
    }
    transform1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) {
      grid[y * width + x] = d[y]!;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      f[x] = grid[base + x]!;
    }
    transform1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) {
      out[base + x] = Math.sqrt(d[x]!);
    }
  }
  return out;
}

/**
 * The page's characteristic stroke width, in pixels: 2 × the median of the
 * distance transform's local maxima (a local max sits on a stroke's
 * centerline, where the distance is the half-width). Clamped to a sane range
 * so a pathological mask cannot zero out every downstream threshold.
 */
export function estimateStrokeWidth(distance: Float32Array, width: number, height: number): number {
  const maxima: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = distance[y * width + x]!;
      if (d < 0.5) {
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
      if (isMax) {
        maxima.push(d);
      }
    }
  }
  if (maxima.length === 0) {
    return 3;
  }
  maxima.sort((a, b) => a - b);
  const median = maxima[Math.floor(maxima.length / 2)]!;
  return Math.min(40, Math.max(1.5, 2 * median));
}
