/**
 * Grid geometry — pure cell math shared by the renderer (pixel size → grid) and
 * the pty layer (grid → resize call). Lives in core/ because it has no DOM and
 * no Tauri dependency, which keeps it trivially testable.
 */

export interface GridSize {
  cols: number;
  rows: number;
}

export interface CellMetrics {
  /** Advance width of one cell in CSS pixels (measured from the real font). */
  width: number;
  /** Line height of one cell in CSS pixels. */
  height: number;
}

/** A pty with zero columns or rows is meaningless — every shell wants at least this. */
export const MIN_COLS = 1;
export const MIN_ROWS = 1;

/**
 * How many whole cells fit in a viewport of `widthPx` × `heightPx`, after
 * `padding` CSS pixels are removed from each edge.
 *
 * Always returns at least a 1×1 grid: a collapsed pane (mid-drag, minimized
 * window, zero-height flex child) must never produce a 0-column resize, which
 * some TUIs divide by.
 */
export function fitGrid(
  widthPx: number,
  heightPx: number,
  cell: CellMetrics,
  padding = 0,
): GridSize {
  if (!(cell.width > 0) || !(cell.height > 0)) {
    return { cols: MIN_COLS, rows: MIN_ROWS };
  }
  const usableWidth = widthPx - padding * 2;
  const usableHeight = heightPx - padding * 2;
  return {
    cols: Math.max(MIN_COLS, Math.floor(usableWidth / cell.width)),
    rows: Math.max(MIN_ROWS, Math.floor(usableHeight / cell.height)),
  };
}

/** True when two grid sizes are the same — the resize path's "nothing to do" test. */
export function sameGrid(a: GridSize, b: GridSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}
