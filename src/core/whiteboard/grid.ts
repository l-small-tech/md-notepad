/**
 * The grid, as a typed view over the `wb:doc` metadata.
 *
 * Three decisions are baked in here and worth stating once:
 *
 * - **It is document state, not app state.** A diagram drawn on a 20-unit grid
 *   should come back on a 20-unit grid — on another machine, for another
 *   person, a year later. So it rides in the file's metadata, next to
 *   `colorMode`, and `setGrid` is an ordinary pure `(doc, patch) → doc`.
 * - **It is never RENDERED into the file.** The dots are chrome the adapter
 *   injects into the adopted DOM after adoption; the serializer knows nothing
 *   about them. A board with a grid and a board without it differ by a few
 *   bytes of JSON and nothing else, so a `.svg` still renders identically
 *   anywhere.
 * - **A default grid emits NO key at all.** Only fields that differ from
 *   {@link DEFAULT_GRID} are written, in a fixed order, which is the same
 *   promise every other field added since phase A makes: a file written before
 *   this round re-serializes byte-for-byte.
 *
 * Invalid metadata degrades rather than throws, exactly like the rest of the
 * `wb:doc` blob — a hand-edited `"grid": "on"` is simply not a grid.
 */

import { DEFAULT_GRID, DEFAULT_GRID_SIZE, type GridSettings } from './tool-settings';
import type { SceneDoc } from './scene';

export { DEFAULT_GRID, DEFAULT_GRID_SIZE, GRID_SIZES, type GridSettings } from './tool-settings';

/** Field order inside the emitted object — determinism, like everything else. */
const FIELDS = ['show', 'size', 'snap'] as const;

/**
 * The grid this document asks for. Every field falls back to its default
 * independently, so a partially-written or partially-corrupt object still
 * yields a usable grid instead of nothing.
 */
export function gridOf(doc: SceneDoc): GridSettings {
  const raw = doc.meta.grid;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return DEFAULT_GRID;
  }
  const value = raw as Record<string, unknown>;
  const size = value.size;
  return {
    show: typeof value.show === 'boolean' ? value.show : DEFAULT_GRID.show,
    size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : DEFAULT_GRID_SIZE,
    snap: typeof value.snap === 'boolean' ? value.snap : DEFAULT_GRID.snap,
  };
}

/**
 * The document with `patch` merged into its grid. Returns the input unchanged
 * when nothing moves, so a caller can compare by identity — and a document
 * whose grid is back to the default loses the key entirely rather than
 * carrying `{"show":false,"size":20,"snap":true}` around forever.
 */
export function setGrid(doc: SceneDoc, patch: Partial<GridSettings>): SceneDoc {
  const current = gridOf(doc);
  const next: GridSettings = { ...current, ...patch };
  const size = Number.isFinite(next.size) && next.size > 0 ? next.size : DEFAULT_GRID_SIZE;
  const settled: GridSettings = { ...next, size };
  const encoded = encode(settled);
  // Compared as JSON, not by identity: this also NORMALIZES a hand-written
  // blob that meant the same thing (`{"size":20}`, a stray key) the first time
  // something touches the grid, and leaves a document alone otherwise.
  if (JSON.stringify(doc.meta.grid ?? null) === JSON.stringify(encoded)) {
    return doc;
  }
  const meta = { ...doc.meta };
  if (encoded === null) {
    delete meta.grid;
  } else {
    meta.grid = encoded;
  }
  return { ...doc, meta };
}

/**
 * `doc` wearing `from`'s grid — the one thing undo and redo must NOT rewind.
 *
 * Toggling the grid is not an edit to the drawing, so it is committed without
 * an undo step; but the snapshots already on the stack were taken with
 * whatever grid was current then, and restoring one would silently put the
 * dots back. Every restore therefore carries the LIVE grid over the restored
 * document, which is the only way "Ctrl+Z never turns my grid back on" can be
 * true for a stack that is a pile of whole documents.
 */
export function carryGrid(doc: SceneDoc, from: SceneDoc): SceneDoc {
  return setGrid(doc, gridOf(from));
}

/** Whether a gesture on this document should snap to the grid's lines. */
export function gridSnaps(grid: GridSettings): boolean {
  // `show` is the master switch on purpose: invisible snapping is a board that
  // moves things for reasons the user cannot see.
  return grid.show && grid.snap && grid.size > 0;
}

/** The nearest multiple of `size` to `value` — the whole of grid snapping. */
export function snapToGrid(value: number, size: number): number {
  return size > 0 ? Math.round(value / size) * size : value;
}

/** Only the non-default fields, in a fixed order; null when there are none. */
function encode(grid: GridSettings): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const field of FIELDS) {
    if (grid[field] !== DEFAULT_GRID[field]) {
      out[field] = grid[field];
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}
