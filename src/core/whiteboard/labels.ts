/**
 * Labels — text centred in (or on) another element, following it around.
 *
 * A label is an ordinary {@link TextElement} with `labelOf` set to its host's
 * `wb:id`. That is the whole model: no container, no anchor object, nothing a
 * foreign renderer has to understand. The serializer adds `text-anchor="middle"`
 * so the lines centre themselves in any SVG renderer, and the geometry here
 * puts the block's centre on the host's centre — which for a `line`/`arrow` is
 * its midpoint, because a line's box is the box of its two endpoints.
 *
 * Two rules keep labels honest without a layout engine:
 *
 * - **A label is welded to its host for selection** (`groups.ts` expands a
 *   selection across the link in both directions), so a label can never be
 *   dragged away from the thing it labels and then snap back on the next
 *   commit. Moving the host moves the label; deleting the host deletes it.
 * - **A resize RE-CENTRES the label, it never scales it.** Type size is a
 *   choice the author made; stretching a box should not stretch the words in
 *   it. The adapter leaves labels out of the scale and runs
 *   {@link relayoutLabels} afterwards — the same pass every commit runs, so
 *   whatever moved a host (align, distribute, nudge, a raw edit followed by
 *   any Draw-mode edit) leaves the labels centred.
 *
 * A label whose host is gone (deleted in Raw mode, a hand-authored file) is
 * just text: every function here treats a dangling `labelOf` as "no host".
 */

import { elementBounds } from './hit-test';
import { insertElements, type ElementRef } from './layers';
import {
  freshElementId,
  isLineShape,
  type SceneDoc,
  type SceneElement,
  type TextElement,
} from './scene';
import { mapElements, resolveElement } from './select';
import { connectorPoints, polylineMidpoint, type Point } from './geometry';

/** Line pitch as a multiple of font size — the `dy="1.2em"` the tspans use. */
export const LABEL_LINE_HEIGHT = 1.2;

/**
 * How far above the baseline a line's visual centre sits, as a fraction of
 * font size (half a typical cap height). Centring on this rather than on the
 * line box is what makes a one-word label look centred in its box instead of
 * riding slightly high.
 */
export const LABEL_CAP_CENTRE = 0.35;

/**
 * The first baseline for `lineCount` lines of `fontSize` whose block is
 * visually centred on `cy`. Lines are `LABEL_LINE_HEIGHT` apart, so the block
 * of baselines spans (n−1)·1.2·f and the middle of it goes on `cy`, shifted
 * down by the cap-centre offset so glyphs — not line boxes — are centred.
 */
export function labelBaseline(cy: number, fontSize: number, lineCount: number): number {
  const lines = Math.max(1, lineCount);
  return cy - ((lines - 1) * LABEL_LINE_HEIGHT * fontSize) / 2 + LABEL_CAP_CENTRE * fontSize;
}

/** The inverse of {@link labelBaseline}: where an existing label's centre is. */
export function labelCentreY(baseline: number, fontSize: number, lineCount: number): number {
  const lines = Math.max(1, lineCount);
  return baseline + ((lines - 1) * LABEL_LINE_HEIGHT * fontSize) / 2 - LABEL_CAP_CENTRE * fontSize;
}

/** Elements that can carry a label: anything with a box of its own. */
export function canHostLabel(element: SceneElement): boolean {
  return element.kind === 'shape' || element.kind === 'image';
}

/**
 * The point a host's labels centre on, or null for an element with no box.
 * A line's is the midpoint of its ROUTE — for a straight line that is the
 * midpoint of its ends, for an elbow it is halfway along the bends, so the
 * label sits on the drawn line rather than floating in the corner between
 * them.
 */
export function hostCentre(host: SceneElement): Point | null {
  if (isLineShape(host)) {
    return polylineMidpoint(connectorPoints(host));
  }
  const box = elementBounds(host);
  return box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The `<text x y>` for a label of `lineCount` lines centred on `host`. */
export function labelPosition(
  host: SceneElement,
  fontSize: number,
  lineCount: number,
): Point | null {
  const centre = hostCentre(host);
  return centre === null ? null : { x: centre.x, y: labelBaseline(centre.y, fontSize, lineCount) };
}

/** The element carrying `wb:id="id"`, on any layer, or null. */
export function findElementById(doc: SceneDoc, id: string): ElementRef | null {
  for (const layer of doc.layers) {
    const index = layer.elements.findIndex((e) => e.kind !== 'raw' && e.id === id);
    if (index >= 0) {
      return { layerId: layer.id, index };
    }
  }
  return null;
}

/** Every label of the element with `wb:id="hostId"`, in document order. */
export function labelsOf(doc: SceneDoc, hostId: string): ElementRef[] {
  const refs: ElementRef[] = [];
  for (const layer of doc.layers) {
    layer.elements.forEach((element, index) => {
      if (element.kind === 'text' && element.labelOf === hostId) {
        refs.push({ layerId: layer.id, index });
      }
    });
  }
  return refs;
}

/** The live host of a label, or null when it is free text or an orphan. */
export function hostOf(doc: SceneDoc, text: TextElement): ElementRef | null {
  return text.labelOf === null ? null : findElementById(doc, text.labelOf);
}

/**
 * `refs` plus the labels of every host among them, deduplicated. What "delete
 * the host" and "erase the host" both remove — a label with nothing to label
 * is litter, not content.
 */
export function withLabels(doc: SceneDoc, refs: readonly ElementRef[]): ElementRef[] {
  const out: ElementRef[] = [...refs];
  const seen = new Set(refs.map((r) => `${r.layerId}:${r.index}`));
  for (const ref of refs) {
    const element = resolveElement(doc, ref);
    if (!element || element.kind === 'raw' || element.id === null) {
      continue;
    }
    for (const label of labelsOf(doc, element.id)) {
      const key = `${label.layerId}:${label.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(label);
      }
    }
  }
  return out;
}

/**
 * Re-centre every label on its host. Returns the SAME document when nothing
 * moved, so a commit that touched no host costs no new snapshot. The adapter
 * runs this after every commit, after `reconnect` (connectors.ts) — a
 * connector's label sits on its routed path, so the path settles first.
 */
export function relayoutLabels(doc: SceneDoc): SceneDoc {
  const hosts = new Map<string, SceneElement | null>();
  const hostFor = (id: string): SceneElement | null => {
    let host = hosts.get(id);
    if (host === undefined) {
      const ref = findElementById(doc, id);
      host = ref === null ? null : resolveElement(doc, ref);
      hosts.set(id, host);
    }
    return host;
  };
  let changed = false;
  const layers = doc.layers.map((layer) => {
    let touched = false;
    const elements = layer.elements.map((element) => {
      if (element.kind !== 'text' || element.labelOf === null) {
        return element;
      }
      const host = hostFor(element.labelOf);
      if (host === null) {
        return element; // an orphan is just text
      }
      const at = labelPosition(host, element.fontSize, element.lines.length);
      if (at === null || (at.x === element.x && at.y === element.y)) {
        return element;
      }
      touched = true;
      return { ...element, x: at.x, y: at.y };
    });
    if (!touched) {
      return layer;
    }
    changed = true;
    return { ...layer, elements };
  });
  return changed ? { ...doc, layers } : doc;
}

/**
 * Make `text` the label of the element at `hostRef`: give the host a `wb:id`
 * if it has none, centre the text on it, and insert it just above the host in
 * the same layer so it paints over a filled shape. Returns the label's ref.
 * Null when the host cannot carry a label (see {@link canHostLabel}).
 */
export function attachLabel(
  doc: SceneDoc,
  hostRef: ElementRef,
  text: TextElement,
  random?: () => number,
): { doc: SceneDoc; ref: ElementRef } | null {
  const host = resolveElement(doc, hostRef);
  if (!host || host.kind === 'raw' || !canHostLabel(host)) {
    return null;
  }
  let next = doc;
  let hostId = host.id;
  if (hostId === null) {
    hostId = freshElementId(doc, random);
    const id = hostId;
    next = mapElements(next, [hostRef], (e) => (e.kind === 'raw' ? e : { ...e, id }));
  }
  const at = labelPosition(host, text.fontSize, text.lines.length);
  const label: TextElement = {
    ...text,
    labelOf: hostId,
    x: at?.x ?? text.x,
    y: at?.y ?? text.y,
  };
  const inserted = insertElements(next, hostRef.layerId, hostRef.index + 1, [label]);
  return { doc: inserted.doc, ref: inserted.refs[0]! };
}
