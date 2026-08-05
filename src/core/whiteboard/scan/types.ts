/**
 * The scan pipeline's vocabulary — a dependency-free leaf.
 *
 * Every stage of the photo→SVG pipeline is a pure function over typed arrays
 * (plan commitment 4): deterministic, DOM-free, and therefore golden-testable in
 * the node test env. The adapter's job is to DECODE an image into an
 * {@link RgbaImage} and ENCODE the result back out again; everything between
 * those two points lives here and in its sibling modules.
 */

/** A point in image (or scene) space. Structurally the same as geometry.ts's. */
export interface ScanPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A decoded raster: tightly packed RGBA, row-major, exactly like the
 * `ImageData` a canvas hands back — which is deliberate, so the adapter can
 * pass one straight through with no copy.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, R,G,B,A per pixel. */
  readonly data: Uint8ClampedArray;
}

/**
 * The four corners of the board in image coordinates, in the fixed order
 * top-left, top-right, bottom-right, bottom-left. "Top-left" means the corner
 * that BECOMES the top-left after rectification — {@link orderQuad} in `quad.ts`
 * is the only thing allowed to decide that, so every consumer can rely on it.
 */
export type Quad = readonly [ScanPoint, ScanPoint, ScanPoint, ScanPoint];

/**
 * A 3×3 projective transform, row-major: `[a,b,c, d,e,f, g,h,i]`.
 * Applied as `x' = (ax+by+c)/(gx+hy+i)`, `y' = (dx+ey+f)/(gx+hy+i)`.
 */
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Output resolution, long edge in pixels. The numbers are not arbitrary:
 * legible handwriting needs a marker stroke to survive as ≥5–6 px so a
 * skeleton is stable (phase 6), and OCR wants ≥25 px x-height (phase 7).
 * 1800 px across a 2 m board puts a 1 cm stroke at ~9 px; 1200 is the
 * "it's a diagram, not prose" preset.
 */
export const SCAN_PRESETS = {
  fast: 1200,
  balanced: 1800,
  detailed: 2400,
} as const;

export type ScanPreset = keyof typeof SCAN_PRESETS;

export const DEFAULT_SCAN_PRESET: ScanPreset = 'balanced';

/** How a quad was arrived at — the crop screen says so, and it matters. */
export type QuadSource =
  /** A bright quadrilateral really was found. */
  | 'detected'
  /** Nothing board-shaped stood out; the quad is the whole frame. */
  | 'frame';

export interface BoardDetection {
  readonly quad: Quad;
  readonly source: QuadSource;
}
