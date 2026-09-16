/**
 * Copy and paste, as a document fragment.
 *
 * The clipboard format IS the file format: a copied selection serializes as a
 * complete, valid whiteboard `<svg>` holding one layer, and a paste is
 * anything `parseWhiteboard` can read modeled elements out of. That buys three
 * things for the price of none: the fragment renders as a picture when pasted
 * into any tool that accepts SVG text; a whole board's source pasted onto
 * another board lands as elements; and there is no second grammar to keep in
 * step with the serializer. The app also keeps the parsed elements in memory
 * (`ui/stores/whiteboard.ts`) so a paste works even where the web view cannot
 * read the system clipboard back.
 *
 * Ids are REMAPPED on paste (`remapIds`): every `wb:id` and `wb:group` in the
 * fragment gets a fresh value in the target document, so a label pasted with
 * its host still labels the copy — and one pasted without it becomes plain
 * text rather than a second label on the original. A connector's `from`/`to`
 * get the same treatment through the same function: a pasted arrow stays
 * attached only to a host that was pasted with it.
 */

import { ensureDrawLayer, insertElements, type ElementRef } from './layers';
import { parseWhiteboard } from './parse';
import {
  createLayer,
  createScene,
  freshIdFrom,
  remapIds,
  usedIds,
  type SceneDoc,
  type SceneElement,
} from './scene';
import { resolveElement, transformElement } from './select';
import { serializeWhiteboard } from './serialize';
import { docOrder } from './groups';

/** How far each successive paste of the same clipboard lands, in scene units. */
export const PASTE_OFFSET = 16;

/** The referenced elements, in document order, raw content excluded. */
export function copyElements(doc: SceneDoc, refs: readonly ElementRef[]): SceneElement[] {
  const out: SceneElement[] = [];
  for (const ref of docOrder(doc, refs)) {
    const element = resolveElement(doc, ref);
    if (element && element.kind !== 'raw') {
      out.push(element);
    }
  }
  return out;
}

/** A self-contained `<svg>` holding `elements` on one layer. */
export function serializeFragment(elements: readonly SceneElement[]): string {
  // A themed board like any other, palette block included: the slot classes
  // are how a scan stroke's STORED slot survives the trip (parse reads it back
  // off `class`), and the block is what makes the fragment render with theme
  // colours when it is pasted into something that shows SVG.
  return serializeWhiteboard(
    createScene({ layers: [createLayer({ id: 'clip', name: 'Clipboard', elements })] }),
  );
}

/**
 * The modeled elements in `text` if it is a whiteboard (or a fragment of
 * one), else null — plain prose, a URL, an SVG we did not write all come back
 * null and the paste falls through to whatever else wants it.
 */
export function parseFragment(text: string): SceneElement[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<')) {
    return null;
  }
  let doc: SceneDoc;
  try {
    doc = parseWhiteboard(trimmed);
  } catch {
    return null;
  }
  const elements: SceneElement[] = [];
  for (const layer of doc.layers) {
    for (const element of layer.elements) {
      if (element.kind !== 'raw') {
        elements.push(element);
      }
    }
  }
  return elements.length === 0 ? null : elements;
}

/**
 * Add `elements` to the top of the target layer (the preferred one if it is
 * editable, else `ensureDrawLayer`'s answer), shifted by `offset` on both
 * axes, with every id and group tag remapped fresh. Returns the new refs so
 * the paste can become the selection. Empty input is a no-op.
 */
export function pasteElements(
  doc: SceneDoc,
  elements: readonly SceneElement[],
  preferredLayerId: string | null,
  offset: number,
  random?: () => number,
): { doc: SceneDoc; refs: ElementRef[]; layerId: string | null } {
  if (elements.length === 0) {
    return { doc, refs: [], layerId: preferredLayerId };
  }
  const target = ensureDrawLayer(doc, preferredLayerId, random);
  const used = usedIds(target.doc);
  const mapping = new Map<string, string>();
  const groupCounts = new Map<string, number>();
  for (const element of elements) {
    if (element.kind === 'raw') {
      continue;
    }
    if (element.id !== null && !mapping.has(element.id)) {
      mapping.set(element.id, freshIdFrom(used, random));
    }
    if (element.group !== null) {
      groupCounts.set(element.group, (groupCounts.get(element.group) ?? 0) + 1);
    }
  }
  for (const [group, count] of groupCounts) {
    // A group of one is no group: a single member copied out of a group
    // arrives as a plain element rather than a one-element group.
    if (count >= 2 && !mapping.has(group)) {
      mapping.set(group, freshIdFrom(used, random));
    }
  }
  const placed = remapIds(elements, mapping).map((element) =>
    offset === 0 ? element : transformElement(element, 1, 1, offset, offset),
  );
  const inserted = insertElements(target.doc, target.layerId, Infinity, placed);
  return { doc: inserted.doc, refs: inserted.refs, layerId: target.layerId };
}
