/**
 * Groups — flat, by tag — and the selection expansion that makes them (and
 * labels) behave as one thing.
 *
 * A group is nothing but a shared `wb:group="id"` on its members. There is no
 * `<g>` wrapper and there is no nesting, and both are decisions rather than
 * omissions:
 *
 * - A nested model would ripple through everything that names an element. An
 *   {@link ElementRef} is `layer + index`; hit-testing walks a flat list;
 *   transforms bake into flat elements; the serializer writes one element per
 *   line; the scan pipeline inserts flat strokes. Every one of those would
 *   grow a path-through-groups notion for a feature diagrams rarely need
 *   beyond one level — and the one level is exactly what a tag gives.
 * - A tag survives everything a `<g>` would break. Z-order ops, layer moves,
 *   copy/paste and a Raw-mode edit all leave members as ordinary elements; a
 *   member deleted by hand simply leaves the group. Grouping a selection that
 *   already contains a group MERGES it (every member gets the new tag), which
 *   is what "no nesting" means in practice.
 *
 * Expansion is the one mechanism behind both groups and labels: any selection
 * the user makes — click, shift-click, marquee — is closed over "same group"
 * and "label ⇄ host" before it is used. Moving a shape therefore moves its
 * label because the label was selected too, not because move knows about
 * labels. The closure runs in both directions for labels on purpose: a label
 * dragged on its own would be re-centred by the next commit, so it is never
 * selectable on its own.
 */

import { isEditable, type ElementRef } from './layers';
import { hostOf, labelsOf } from './labels';
import { freshElementId, type SceneDoc } from './scene';
import { mapElements, resolveElement, sameRef } from './select';

const key = (ref: ElementRef): string => `${ref.layerId}:${ref.index}`;

/** Refs in DOCUMENT order (layer order, then index) — z-order, bottom first. */
export function docOrder(doc: SceneDoc, refs: readonly ElementRef[]): ElementRef[] {
  const wanted = new Set(refs.map(key));
  const out: ElementRef[] = [];
  for (const layer of doc.layers) {
    for (let index = 0; index < layer.elements.length; index++) {
      const ref = { layerId: layer.id, index };
      if (wanted.has(key(ref))) {
        out.push(ref);
      }
    }
  }
  return out;
}

/** The group tag of the element at `ref`, or null. */
export function groupOf(doc: SceneDoc, ref: ElementRef): string | null {
  const element = resolveElement(doc, ref);
  return element && element.kind !== 'raw' ? element.group : null;
}

/** Every editable member of `group`, in document order. */
export function membersOf(doc: SceneDoc, group: string): ElementRef[] {
  const refs: ElementRef[] = [];
  for (const layer of doc.layers) {
    if (!isEditable(layer)) {
      continue;
    }
    layer.elements.forEach((element, index) => {
      if (element.kind !== 'raw' && element.group === group) {
        refs.push({ layerId: layer.id, index });
      }
    });
  }
  return refs;
}

/**
 * The closure of `refs` over group membership and label ⇄ host links, on
 * editable layers, in document order. Idempotent, so it is safe to apply to a
 * selection that was already expanded.
 */
export function expandSelection(doc: SceneDoc, refs: readonly ElementRef[]): ElementRef[] {
  const seen = new Map<string, ElementRef>();
  const queue: ElementRef[] = [...refs];
  while (queue.length > 0) {
    const ref = queue.pop()!;
    const k = key(ref);
    if (seen.has(k)) {
      continue;
    }
    const layer = doc.layers.find((l) => l.id === ref.layerId);
    const element = layer?.elements[ref.index];
    if (!layer || !isEditable(layer) || !element || element.kind === 'raw') {
      continue;
    }
    seen.set(k, ref);
    if (element.group !== null) {
      queue.push(...membersOf(doc, element.group));
    }
    if (element.id !== null) {
      queue.push(...labelsOf(doc, element.id));
    }
    if (element.kind === 'text') {
      const host = hostOf(doc, element);
      if (host !== null) {
        queue.push(host);
      }
    }
  }
  return docOrder(doc, [...seen.values()]);
}

/**
 * Partition `refs` into UNITS: the connected components under the same links
 * expansion follows. Align and distribute move units, not members — a grouped
 * pair of boxes lines up as one thing, and a label rides with its host. Each
 * unit and the list itself are in document order.
 */
export function selectionUnits(doc: SceneDoc, refs: readonly ElementRef[]): ElementRef[][] {
  const remaining = new Map(docOrder(doc, refs).map((ref) => [key(ref), ref] as const));
  const units: ElementRef[][] = [];
  while (remaining.size > 0) {
    const [first] = remaining.values();
    const unit = expandSelection(doc, [first!]).filter((ref) => remaining.has(key(ref)));
    // A ref expansion could not reach (an orphan, or a member on a layer that
    // has since locked) is still its own unit.
    const members = unit.length > 0 ? unit : [first!];
    for (const ref of members) {
      remaining.delete(key(ref));
    }
    units.push(members);
  }
  return units;
}

/** Whether Group makes sense: two or more elements. */
export function canGroup(refs: readonly ElementRef[]): boolean {
  return refs.length >= 2;
}

/** Whether Ungroup makes sense: anything in the selection carries a tag. */
export function canUngroup(doc: SceneDoc, refs: readonly ElementRef[]): boolean {
  return refs.some((ref) => groupOf(doc, ref) !== null);
}

/**
 * Tag every referenced element with one fresh group id. Members of an
 * existing group among them are re-tagged — groups merge rather than nest.
 * Fewer than two refs is a no-op: a group of one is no group.
 */
export function groupElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  random?: () => number,
): SceneDoc {
  if (!canGroup(refs)) {
    return doc;
  }
  const group = freshElementId(doc, random);
  return mapElements(doc, refs, (element) =>
    element.kind === 'raw' ? element : { ...element, group },
  );
}

/** Clear the tag on every referenced element. */
export function ungroupElements(doc: SceneDoc, refs: readonly ElementRef[]): SceneDoc {
  if (!canUngroup(doc, refs)) {
    return doc;
  }
  return mapElements(doc, refs, (element) =>
    element.kind === 'raw' || element.group === null ? element : { ...element, group: null },
  );
}

/** `refs` minus every ref in `remove` — shift-click taking a whole unit out. */
export function withoutRefs(
  refs: readonly ElementRef[],
  remove: readonly ElementRef[],
): ElementRef[] {
  return refs.filter((ref) => !remove.some((r) => sameRef(r, ref)));
}
