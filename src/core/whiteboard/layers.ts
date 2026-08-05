/**
 * Layer and element operations — every one a pure `(doc, …) → doc`.
 *
 * {@link SceneDoc} is immutable with structural sharing, so an edit is a new
 * document that shares everything it did not touch. That is what makes undo a
 * snapshot stack (`history.ts`) rather than a zoo of inverse operations, and it
 * is why none of these functions is allowed to mutate its argument.
 *
 * Layer order in `doc.layers` IS z-order: later paints on top. The panel shows
 * the list reversed (topmost first), which is the only place that flip lives.
 */

import { createLayer, freshLayerId, type Layer, type SceneDoc, type SceneElement } from './scene';

/** A layer the tools may draw on: visible, unlocked, and ours. */
export function isEditable(layer: Layer): boolean {
  return layer.visible && !layer.locked && layer.kind !== 'foreign';
}

/**
 * Where new ink goes: `preferred` if it is still editable, else the topmost
 * editable layer. Null when the document has none (every layer locked, hidden,
 * or imported) — {@link ensureDrawLayer} is the fix for that.
 */
export function targetLayerId(doc: SceneDoc, preferred: string | null): string | null {
  if (preferred !== null) {
    const layer = doc.layers.find((l) => l.id === preferred);
    if (layer && isEditable(layer)) {
      return layer.id;
    }
  }
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i]!;
    if (isEditable(layer)) {
      return layer.id;
    }
  }
  return null;
}

/**
 * A document guaranteed to have somewhere to draw. Opening a foreign SVG gives
 * exactly one locked "Imported" layer, so the first pen stroke has to create
 * the layer it lands on — silently, on top, as part of that same undo step.
 */
export function ensureDrawLayer(
  doc: SceneDoc,
  preferred: string | null,
  random?: () => number,
): { doc: SceneDoc; layerId: string } {
  const existing = targetLayerId(doc, preferred);
  if (existing !== null) {
    return { doc, layerId: existing };
  }
  const next = addLayer(doc, undefined, random);
  return { doc: next, layerId: next.layers[next.layers.length - 1]!.id };
}

/** Append a new empty layer on top. `name` defaults to "Layer N". */
export function addLayer(doc: SceneDoc, name?: string, random?: () => number): SceneDoc {
  const id = freshLayerId(doc, random);
  const layer = createLayer({ id, name: name ?? nextLayerName(doc) });
  return { ...doc, layers: [...doc.layers, layer] };
}

/** "Layer N" for the lowest N not already taken, so names never collide. */
function nextLayerName(doc: SceneDoc): string {
  const taken = new Set(doc.layers.map((l) => l.name));
  for (let n = 1; ; n++) {
    const candidate = `Layer ${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function mapLayer(doc: SceneDoc, id: string, update: (layer: Layer) => Layer): SceneDoc {
  let changed = false;
  const layers = doc.layers.map((layer) => {
    if (layer.id !== id) {
      return layer;
    }
    changed = true;
    return update(layer);
  });
  return changed ? { ...doc, layers } : doc;
}

export function renameLayer(doc: SceneDoc, id: string, name: string): SceneDoc {
  const trimmed = name.trim();
  if (trimmed === '') {
    return doc;
  }
  return mapLayer(doc, id, (layer) => ({ ...layer, name: trimmed }));
}

export function setLayerVisible(doc: SceneDoc, id: string, visible: boolean): SceneDoc {
  return mapLayer(doc, id, (layer) => ({ ...layer, visible }));
}

export function setLayerLocked(doc: SceneDoc, id: string, locked: boolean): SceneDoc {
  return mapLayer(doc, id, (layer) => ({ ...layer, locked }));
}

/**
 * Delete a layer and its contents. The last layer is never removed — a board
 * with nowhere to draw is a dead end the UI would then have to explain — so
 * deleting it empties it instead.
 */
export function removeLayer(doc: SceneDoc, id: string): SceneDoc {
  if (doc.layers.length <= 1) {
    return mapLayer(doc, id, (layer) => ({ ...layer, elements: [] }));
  }
  const layers = doc.layers.filter((l) => l.id !== id);
  return layers.length === doc.layers.length ? doc : { ...doc, layers };
}

/** Move a layer `delta` steps through the z-order (+1 = one step up/front). */
export function moveLayer(doc: SceneDoc, id: string, delta: number): SceneDoc {
  const from = doc.layers.findIndex((l) => l.id === id);
  if (from < 0) {
    return doc;
  }
  const to = Math.max(0, Math.min(doc.layers.length - 1, from + delta));
  if (to === from) {
    return doc;
  }
  const layers = [...doc.layers];
  const [moved] = layers.splice(from, 1);
  layers.splice(to, 0, moved!);
  return { ...doc, layers };
}

/* -------------------------------- elements -------------------------------- */

/** Append one element to the top of a layer. */
export function addElement(doc: SceneDoc, layerId: string, element: SceneElement): SceneDoc {
  return mapLayer(doc, layerId, (layer) => ({
    ...layer,
    elements: [...layer.elements, element],
  }));
}

/** Where an element lives: which layer, and its index within that layer. */
export interface ElementRef {
  readonly layerId: string;
  readonly index: number;
}

/**
 * Delete a set of elements in one step (the eraser can cross several strokes in
 * a single drag, and that must be one undo). Indices are resolved against the
 * document as passed in — refs are collected and applied against the same
 * snapshot, never one at a time.
 */
export function removeElements(doc: SceneDoc, refs: readonly ElementRef[]): SceneDoc {
  if (refs.length === 0) {
    return doc;
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
  const layers = doc.layers.map((layer) => {
    const drop = byLayer.get(layer.id);
    if (!drop || drop.size === 0) {
      return layer;
    }
    const elements = layer.elements.filter((_, index) => !drop.has(index));
    if (elements.length === layer.elements.length) {
      return layer;
    }
    changed = true;
    return { ...layer, elements };
  });
  return changed ? { ...doc, layers } : doc;
}
