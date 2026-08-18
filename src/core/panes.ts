/**
 * The split layout: a binary tree of panes, one tree per tab.
 *
 * Pure and immutable — every operation returns a new tree (or the same
 * reference when nothing changed, which lets React skip re-rendering untouched
 * subtrees). The pane *contents* live elsewhere: a leaf is nothing but an id,
 * so a tab can be re-laid-out without any pty being touched.
 *
 *   split right ──►  { direction: 'row',    first, second }   side by side
 *   split down  ──►  { direction: 'column', first, second }   stacked
 *
 * `ratio` is the fraction of the split's main axis given to `first`.
 * `layoutPanes` turns a tree into flat rectangles for the DOM — see the comment
 * there for why the layout is flattened rather than nested.
 */

export type SplitDirection = 'row' | 'column';

export interface PaneLeaf {
  kind: 'leaf';
  id: string;
}

export interface PaneSplit {
  kind: 'split';
  /** Ids are needed because a divider drag has to name the split it resizes. */
  id: string;
  direction: SplitDirection;
  /** Fraction of the axis for `first`, clamped to [MIN_RATIO, 1 - MIN_RATIO]. */
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

/**
 * A pane narrower than this fraction of its split has no usable grid left, and
 * a divider dragged past the edge is almost always a slip.
 */
export const MIN_RATIO = 0.1;

export function leaf(id: string): PaneLeaf {
  return { kind: 'leaf', id };
}

export function isLeaf(node: PaneNode): node is PaneLeaf {
  return node.kind === 'leaf';
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
}

/** Every pane id, in visual order (left to right, top to bottom). */
export function paneIds(node: PaneNode): string[] {
  if (isLeaf(node)) return [node.id];
  return [...paneIds(node.first), ...paneIds(node.second)];
}

export function paneCount(node: PaneNode): number {
  return isLeaf(node) ? 1 : paneCount(node.first) + paneCount(node.second);
}

export function hasPane(node: PaneNode, id: string): boolean {
  return isLeaf(node) ? node.id === id : hasPane(node.first, id) || hasPane(node.second, id);
}

export interface SplitOptions {
  direction: SplitDirection;
  /** Id of the pane being created. */
  newId: string;
  /** Id of the split node being created (dividers are addressed by it). */
  splitId: string;
  ratio?: number;
}

/**
 * Split the pane `targetId` in two, the new pane taking the second half.
 * Returns the tree unchanged when the target is not in it.
 */
export function splitPane(node: PaneNode, targetId: string, options: SplitOptions): PaneNode {
  if (isLeaf(node)) {
    if (node.id !== targetId) return node;
    return {
      kind: 'split',
      id: options.splitId,
      direction: options.direction,
      ratio: clampRatio(options.ratio ?? 0.5),
      first: node,
      second: leaf(options.newId),
    };
  }
  const first = splitPane(node.first, targetId, options);
  if (first !== node.first) return { ...node, first };
  const second = splitPane(node.second, targetId, options);
  if (second !== node.second) return { ...node, second };
  return node;
}

/**
 * Remove a pane, promoting its sibling into the split's place. Returns null
 * when the pane was the last one in the tree — the caller's cue to close the
 * whole tab.
 */
export function removePane(node: PaneNode, id: string): PaneNode | null {
  if (isLeaf(node)) return node.id === id ? null : node;
  if (isLeaf(node.first) && node.first.id === id) return node.second;
  if (isLeaf(node.second) && node.second.id === id) return node.first;

  const first = removePane(node.first, id);
  if (first !== node.first) return first === null ? node.second : { ...node, first };
  const second = removePane(node.second, id);
  if (second !== node.second) return second === null ? node.first : { ...node, second };
  return node;
}

/** Set a split's ratio (a divider drag). */
export function setSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (isLeaf(node)) return node;
  if (node.id === splitId) {
    const clamped = clampRatio(ratio);
    return clamped === node.ratio ? node : { ...node, ratio: clamped };
  }
  const first = setSplitRatio(node.first, splitId, ratio);
  if (first !== node.first) return { ...node, first };
  const second = setSplitRatio(node.second, splitId, ratio);
  if (second !== node.second) return { ...node, second };
  return node;
}

/**
 * The pane `delta` steps away from `id` in visual order, wrapping around.
 * Falls back to the first pane when `id` is not in the tree.
 */
export function neighborPane(node: PaneNode, id: string, delta: number): string {
  const ids = paneIds(node);
  const index = ids.indexOf(id);
  if (index === -1) return ids[0]!;
  const next = (index + delta) % ids.length;
  return ids[next < 0 ? next + ids.length : next]!;
}

/**
 * A rectangle in fractions of the tab area: 0–1 on both axes, so the layout is
 * resolution-independent and maps straight onto CSS percentages.
 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneLayout {
  id: string;
  rect: Rect;
}

export interface DividerLayout {
  splitId: string;
  direction: SplitDirection;
  /** The seam: zero-width for a 'row' split, zero-height for a 'column' one. */
  rect: Rect;
}

export interface Layout {
  panes: PaneLayout[];
  dividers: DividerLayout[];
}

const FULL: Rect = { left: 0, top: 0, width: 1, height: 1 };

/**
 * Flatten the tree into absolute rectangles.
 *
 * Why flat: nesting the DOM the way the tree nests would move a pane's element
 * deeper on every split, and React reconciles by position — the pane would
 * remount, taking its pty with it. A flat list keyed by pane id cannot do that,
 * whatever the tree does.
 */
export function layoutPanes(node: PaneNode, rect: Rect = FULL): Layout {
  if (isLeaf(node)) return { panes: [{ id: node.id, rect }], dividers: [] };

  const row = node.direction === 'row';
  const span = row ? rect.width : rect.height;
  const firstSpan = span * node.ratio;

  const firstRect: Rect = row ? { ...rect, width: firstSpan } : { ...rect, height: firstSpan };
  const secondRect: Rect = row
    ? { ...rect, left: rect.left + firstSpan, width: span - firstSpan }
    : { ...rect, top: rect.top + firstSpan, height: span - firstSpan };

  const first = layoutPanes(node.first, firstRect);
  const second = layoutPanes(node.second, secondRect);
  const seam: Rect = row
    ? { left: rect.left + firstSpan, top: rect.top, width: 0, height: rect.height }
    : { left: rect.left, top: rect.top + firstSpan, width: rect.width, height: 0 };

  return {
    panes: [...first.panes, ...second.panes],
    dividers: [
      { splitId: node.id, direction: node.direction, rect: seam },
      ...first.dividers,
      ...second.dividers,
    ],
  };
}

/**
 * The ratio a divider drag implies: `position` is the pointer offset within the
 * *tab area* (a fraction, same coordinates as the layout), and the split's own
 * rectangle turns it back into a ratio of that split.
 */
export function ratioFromDrag(rect: Rect, direction: SplitDirection, position: number): number {
  const origin = direction === 'row' ? rect.left : rect.top;
  const span = direction === 'row' ? rect.width : rect.height;
  if (!(span > 0)) return 0.5;
  return clampRatio((position - origin) / span);
}

/** The rectangle a split occupies, or null when the split is not in the tree. */
export function splitRect(node: PaneNode, splitId: string, rect: Rect = FULL): Rect | null {
  if (isLeaf(node)) return null;
  if (node.id === splitId) return rect;
  const row = node.direction === 'row';
  const span = row ? rect.width : rect.height;
  const firstSpan = span * node.ratio;
  const first = splitRect(
    node.first,
    splitId,
    row ? { ...rect, width: firstSpan } : { ...rect, height: firstSpan },
  );
  if (first) return first;
  return splitRect(
    node.second,
    splitId,
    row
      ? { ...rect, left: rect.left + firstSpan, width: span - firstSpan }
      : { ...rect, top: rect.top + firstSpan, height: span - firstSpan },
  );
}

/**
 * A persisted tree (session restore) → a usable one, or null when it is
 * unrecognizable. `rename` supplies the live id for each stored leaf, because
 * restored panes get fresh ids rather than reusing the previous run's.
 */
export function normalizePaneTree(
  raw: unknown,
  rename: (storedId: string) => string,
  nextSplitId: () => string,
): PaneNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const node = raw as Record<string, unknown>;
  if (node.kind === 'leaf') {
    return typeof node.id === 'string' ? leaf(rename(node.id)) : null;
  }
  if (node.kind !== 'split') return null;

  const first = normalizePaneTree(node.first, rename, nextSplitId);
  const second = normalizePaneTree(node.second, rename, nextSplitId);
  // A half-readable split still has one usable side; keeping it loses less than
  // dropping the whole tab.
  if (!first) return second;
  if (!second) return first;
  return {
    kind: 'split',
    id: nextSplitId(),
    direction: node.direction === 'column' ? 'column' : 'row',
    ratio: clampRatio(typeof node.ratio === 'number' ? node.ratio : 0.5),
    first,
    second,
  };
}
