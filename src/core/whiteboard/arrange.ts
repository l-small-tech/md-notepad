/**
 * Arranging a selection: z-order, align, distribute. Pure `(doc, refs, …) →`
 * functions the context menu and the keyboard chords call.
 *
 * Z-order is the element order inside its layer and nothing else — layers are
 * the coarse stack, elements the fine one — so `reorderElements` works per
 * layer and never moves an element between layers. Refs change when elements
 * move, so it returns the new ones.
 *
 * Align and distribute operate on UNITS (`selectionUnits`): a group is one
 * thing, and a label rides with its host. Everything moves by a plain
 * translation — no element is resized to line up, which is what people mean
 * by "align" and what keeps the operation trivially undoable by eye.
 */

import { unionRect, type Rect } from './geometry';
import { elementBounds } from './hit-test';
import type { ElementRef } from './layers';
import { selectionUnits } from './groups';
import type { SceneDoc } from './scene';
import { mapElements, resolveElement, transformElement } from './select';

export type ZOrderOp = 'front' | 'back' | 'forward' | 'backward';

export const Z_ORDER_LABELS: Record<ZOrderOp, string> = {
  front: 'Bring to front',
  forward: 'Bring forward',
  backward: 'Send backward',
  back: 'Send to back',
};

/**
 * Restack the referenced elements within their own layers. `forward` and
 * `backward` step the selection ONE element past the nearest unselected
 * neighbour, keeping the selected elements' relative order — a block of
 * selected elements moves as a block, which is what every editor does and
 * what makes repeated presses predictable.
 */
export function reorderElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  op: ZOrderOp,
): { doc: SceneDoc; refs: ElementRef[] } {
  if (refs.length === 0) {
    return { doc, refs: [] };
  }
  const byLayer = new Map<string, Set<number>>();
  for (const ref of refs) {
    let set = byLayer.get(ref.layerId);
    if (!set) {
      set = new Set();
      byLayer.set(ref.layerId, set);
    }
    set.add(ref.index);
  }
  let changed = false;
  const outRefs: ElementRef[] = [];
  const layers = doc.layers.map((layer) => {
    const picked = byLayer.get(layer.id);
    if (!picked || picked.size === 0) {
      return layer;
    }
    const n = layer.elements.length;
    // Work on a permutation of indices; `selected` follows the elements.
    const order = layer.elements.map((_, i) => i);
    const selected = layer.elements.map((_, i) => picked.has(i));
    const swap = (i: number, j: number): void => {
      [order[i], order[j]] = [order[j]!, order[i]!];
      [selected[i], selected[j]] = [selected[j]!, selected[i]!];
    };
    if (op === 'front' || op === 'back') {
      const chosen = order.filter((i) => picked.has(i));
      const rest = order.filter((i) => !picked.has(i));
      const next = op === 'front' ? [...rest, ...chosen] : [...chosen, ...rest];
      order.splice(0, n, ...next);
      selected.splice(0, n, ...next.map((i) => picked.has(i)));
    } else if (op === 'forward') {
      for (let i = n - 2; i >= 0; i--) {
        if (selected[i] && !selected[i + 1]) {
          swap(i, i + 1);
        }
      }
    } else {
      for (let i = 1; i < n; i++) {
        if (selected[i] && !selected[i - 1]) {
          swap(i, i - 1);
        }
      }
    }
    selected.forEach((isSelected, index) => {
      if (isSelected) {
        outRefs.push({ layerId: layer.id, index });
      }
    });
    if (order.every((from, to) => from === to)) {
      return layer;
    }
    changed = true;
    return { ...layer, elements: order.map((from) => layer.elements[from]!) };
  });
  return { doc: changed ? { ...doc, layers } : doc, refs: outRefs };
}

/* ------------------------------ align / distribute ------------------------ */

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export const ALIGN_LABELS: Record<AlignEdge, string> = {
  left: 'Align left',
  center: 'Align centres',
  right: 'Align right',
  top: 'Align top',
  middle: 'Align middles',
  bottom: 'Align bottom',
};

export type DistributeAxis = 'horizontal' | 'vertical';

export const DISTRIBUTE_LABELS: Record<DistributeAxis, string> = {
  horizontal: 'Distribute horizontally',
  vertical: 'Distribute vertically',
};

interface Unit {
  readonly refs: readonly ElementRef[];
  readonly box: Rect;
}

/** The selection's units with measurable bounds. */
function units(doc: SceneDoc, refs: readonly ElementRef[]): Unit[] {
  const out: Unit[] = [];
  for (const unit of selectionUnits(doc, refs)) {
    let box: Rect | null = null;
    for (const ref of unit) {
      const element = resolveElement(doc, ref);
      box = unionRect(box, element ? elementBounds(element) : null);
    }
    if (box !== null) {
      out.push({ refs: unit, box });
    }
  }
  return out;
}

function translateUnit(doc: SceneDoc, unit: Unit, dx: number, dy: number): SceneDoc {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return doc;
  }
  return mapElements(doc, unit.refs, (element) => transformElement(element, 1, 1, dx, dy));
}

/** Whether Align makes sense: two or more units. */
export function canAlign(doc: SceneDoc, refs: readonly ElementRef[]): boolean {
  return units(doc, refs).length >= 2;
}

/** Whether Distribute makes sense: three or more units. */
export function canDistribute(doc: SceneDoc, refs: readonly ElementRef[]): boolean {
  return units(doc, refs).length >= 3;
}

/**
 * Line the units up on one edge (or centre line) of the selection's overall
 * box. Two or more units required; fewer is a no-op.
 */
export function alignElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  edge: AlignEdge,
): SceneDoc {
  const list = units(doc, refs);
  if (list.length < 2) {
    return doc;
  }
  let box: Rect | null = null;
  for (const unit of list) {
    box = unionRect(box, unit.box);
  }
  const all = box!;
  let next = doc;
  for (const unit of list) {
    const b = unit.box;
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case 'left':
        dx = all.x - b.x;
        break;
      case 'center':
        dx = all.x + all.width / 2 - (b.x + b.width / 2);
        break;
      case 'right':
        dx = all.x + all.width - (b.x + b.width);
        break;
      case 'top':
        dy = all.y - b.y;
        break;
      case 'middle':
        dy = all.y + all.height / 2 - (b.y + b.height / 2);
        break;
      case 'bottom':
        dy = all.y + all.height - (b.y + b.height);
        break;
    }
    next = translateUnit(next, unit, dx, dy);
  }
  return next;
}

/**
 * Space the units evenly along one axis. The two outermost stay put; the
 * gaps between neighbours become equal. When the units do not fit side by
 * side inside the span (gaps would go negative) their CENTRES are spaced
 * evenly instead — still an even rhythm, which is what the eye reads.
 * Three or more units required.
 */
export function distributeElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  axis: DistributeAxis,
): SceneDoc {
  const list = units(doc, refs);
  if (list.length < 3) {
    return doc;
  }
  const horizontal = axis === 'horizontal';
  const start = (b: Rect): number => (horizontal ? b.x : b.y);
  const size = (b: Rect): number => (horizontal ? b.width : b.height);
  const sorted = [...list].sort(
    (a, b) => start(a.box) + size(a.box) / 2 - (start(b.box) + size(b.box) / 2),
  );
  const first = sorted[0]!.box;
  const last = sorted[sorted.length - 1]!.box;
  const span = start(last) + size(last) - start(first);
  const total = sorted.reduce((sum, unit) => sum + size(unit.box), 0);
  const gap = (span - total) / (sorted.length - 1);
  let next = doc;
  if (gap >= 0) {
    let cursor = start(first);
    for (const unit of sorted) {
      const delta = cursor - start(unit.box);
      next = translateUnit(next, unit, horizontal ? delta : 0, horizontal ? 0 : delta);
      cursor += size(unit.box) + gap;
    }
    return next;
  }
  const firstCentre = start(first) + size(first) / 2;
  const lastCentre = start(last) + size(last) / 2;
  const step = (lastCentre - firstCentre) / (sorted.length - 1);
  sorted.forEach((unit, i) => {
    const centre = start(unit.box) + size(unit.box) / 2;
    const delta = firstCentre + step * i - centre;
    next = translateUnit(next, unit, horizontal ? delta : 0, horizontal ? 0 : delta);
  });
  return next;
}
