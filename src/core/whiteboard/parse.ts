/**
 * SVG source → {@link SceneDoc}. Pure; the inverse of `serialize.ts`.
 *
 * The contract this file owes the rest of the app:
 *
 * 1. **Never lose content.** Anything not modeled is preserved verbatim from
 *    the original source — top-level oddities in `prelude`, in-layer oddities
 *    as {@link RawElement}, unknown attributes in `extras`, unknown metadata
 *    keys in `meta`.
 * 2. **Never throw on valid XML.** A foreign SVG (Inkscape, Excalidraw export,
 *    hand-authored) parses fine: its renderable content becomes one locked
 *    "Imported" layer. Only malformed XML throws — {@link WhiteboardParseError},
 *    which the adapter surfaces as the "open as text" error card.
 */

import {
  attr,
  childElements,
  isBlankText,
  localName,
  numAttr,
  parseXml,
  rawSource,
  textContent,
  XmlError,
  type XmlElement,
  type XmlNode,
} from './xml';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_BOARD_HEIGHT,
  DEFAULT_BOARD_WIDTH,
  SCENE_SCHEMA,
  type ImageElement,
  type Layer,
  type LayerKind,
  type SceneAttr,
  type SceneDoc,
  type SceneElement,
  type ShapeElement,
  type ShapeKind,
  type StrokeElement,
  type TextElement,
} from './scene';

export class WhiteboardParseError extends Error {
  constructor(
    message: string,
    /** Byte offset into the source, or null when not position-specific. */
    readonly offset: number | null = null,
  ) {
    super(message);
    this.name = 'WhiteboardParseError';
  }
}

/** Root attributes the serializer regenerates; everything else is preserved. */
const OWNED_ROOT_ATTRS = new Set(['xmlns', 'xmlns:wb', 'viewBox', 'width', 'height']);
/** Layer `<g>` attributes the serializer regenerates. */
const OWNED_LAYER_ATTRS = new Set(['wb:layer', 'wb:name', 'wb:kind', 'wb:locked', 'display']);
/** Top-level elements that carry no pixels of their own — kept as prelude. */
const PRELUDE_ELEMENTS = new Set(['defs', 'style', 'title', 'desc', 'metadata']);

export function parseWhiteboard(source: string): SceneDoc {
  let doc;
  try {
    doc = parseXml(source);
  } catch (error) {
    if (error instanceof XmlError) {
      throw new WhiteboardParseError(error.message, error.offset);
    }
    throw error;
  }

  const root = doc.root;
  if (localName(root.name) !== 'svg') {
    throw new WhiteboardParseError(`root element is <${root.name}>, expected <svg>`, root.start);
  }

  const viewBox = readViewBox(root);
  const width = numAttr(root, 'width', viewBox[2]);
  const height = numAttr(root, 'height', viewBox[3]);

  const prelude: string[] = [];
  const layers: Layer[] = [];
  const foreign: string[] = [];
  let foreignIndex = -1;
  let meta: Record<string, unknown> = {};
  let background: string | null = null;
  let sawMeta = false;

  for (const node of root.children) {
    if (isBlankText(source, node)) {
      continue;
    }
    if (node.type !== 'element') {
      // Comments, PIs, CDATA and stray text ride along untouched.
      prelude.push(rawSource(source, node));
      continue;
    }
    const name = localName(node.name);

    if (name === 'metadata') {
      const wbDoc = childElements(node).find((c) => localName(c.name) === 'doc');
      if (wbDoc && !sawMeta) {
        // Ours: the whole <metadata> is regenerated on save.
        sawMeta = true;
        const parsed = readMeta(source, wbDoc);
        background = parsed.background;
        meta = parsed.rest;
        continue;
      }
      prelude.push(rawSource(source, node));
      continue;
    }

    if (name === 'rect' && attr(node, 'wb:role') === 'background') {
      // The rendered backdrop; regenerated from `background` on save.
      background = attr(node, 'fill') ?? background;
      continue;
    }

    if (name === 'g' && attr(node, 'wb:layer') !== null) {
      layers.push(readLayer(source, node));
      continue;
    }

    if (PRELUDE_ELEMENTS.has(name)) {
      prelude.push(rawSource(source, node));
      continue;
    }

    // Renderable content that isn't one of our layers: a foreign SVG's body.
    if (foreignIndex < 0) {
      foreignIndex = layers.length;
    }
    foreign.push(rawSource(source, node));
  }

  if (foreign.length > 0) {
    // One locked layer, placed where its first element appeared, so foreign
    // content keeps its z-order relative to any wb: layers around it.
    layers.splice(foreignIndex, 0, {
      id: 'imported',
      name: 'Imported',
      visible: true,
      locked: true,
      kind: 'foreign' satisfies LayerKind,
      elements: foreign.map((xml) => ({ kind: 'raw', xml }) satisfies SceneElement),
      extras: [],
    });
  }

  return {
    schema: SCENE_SCHEMA,
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_BOARD_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_BOARD_HEIGHT,
    viewBox,
    background: background ?? DEFAULT_BACKGROUND,
    rootExtras: extrasOf(root, OWNED_ROOT_ATTRS),
    prelude,
    layers,
    meta,
  };
}

/* -------------------------------------------------------------------------- */

function readViewBox(root: XmlElement): [number, number, number, number] {
  const raw = attr(root, 'viewBox');
  const parts = raw
    ? raw
        .trim()
        .split(/[\s,]+/)
        .map((n) => Number.parseFloat(n))
    : [];
  if (
    parts.length === 4 &&
    parts.every((n) => Number.isFinite(n)) &&
    parts[2]! > 0 &&
    parts[3]! > 0
  ) {
    return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  }
  const width = numAttr(root, 'width', DEFAULT_BOARD_WIDTH);
  const height = numAttr(root, 'height', DEFAULT_BOARD_HEIGHT);
  return [
    0,
    0,
    width > 0 ? width : DEFAULT_BOARD_WIDTH,
    height > 0 ? height : DEFAULT_BOARD_HEIGHT,
  ];
}

function readMeta(
  source: string,
  wbDoc: XmlElement,
): { background: string | null; rest: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textContent(source, wbDoc).trim() || '{}');
  } catch {
    // Corrupt editor metadata is not corrupt DRAWING data — the strokes are in
    // the SVG body. Drop the metadata and carry on rather than failing the open.
    return { background: null, rest: {} };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { background: null, rest: {} };
  }
  const record = { ...(parsed as Record<string, unknown>) };
  const background = typeof record.background === 'string' ? record.background : null;
  delete record.background;
  delete record.schema; // regenerated
  return { background, rest: record };
}

function extrasOf(element: XmlElement, owned: ReadonlySet<string>): SceneAttr[] {
  return element.attrs
    .filter((a) => !owned.has(a.name))
    .map((a) => ({ name: a.name, value: a.value }));
}

function readLayer(source: string, group: XmlElement): Layer {
  const kindAttr = attr(group, 'wb:kind');
  const elements: SceneElement[] = [];
  for (const node of group.children) {
    if (isBlankText(source, node)) {
      continue;
    }
    elements.push(readElement(source, node));
  }
  return {
    id: attr(group, 'wb:layer') ?? 'layer',
    name: attr(group, 'wb:name') ?? 'Layer',
    visible: attr(group, 'display') !== 'none',
    locked: attr(group, 'wb:locked') === 'true',
    // 'foreign' matters on re-read: once we have wrapped an imported SVG's body
    // in an Imported layer, re-opening the saved file must recognize it as
    // still-foreign (locked, not tool-owned), not demote it to a draw layer.
    kind: kindAttr === 'scan' ? 'scan' : kindAttr === 'foreign' ? 'foreign' : 'draw',
    elements,
    extras: extrasOf(group, OWNED_LAYER_ATTRS),
  };
}

function readElement(source: string, node: XmlNode): SceneElement {
  if (node.type !== 'element') {
    return { kind: 'raw', xml: rawSource(source, node) };
  }
  const parsed = readModeled(source, node);
  return parsed ?? { kind: 'raw', xml: rawSource(source, node) };
}

/** Recognized element, or null → the caller preserves it verbatim. */
function readModeled(source: string, element: XmlElement): SceneElement | null {
  const name = localName(element.name);
  const id = attr(element, 'wb:id');
  const opacity = optionalNum(element, 'opacity');

  if (name === 'path') {
    const tool = attr(element, 'wb:tool');
    if (tool !== 'pen' && tool !== 'highlighter') {
      return null; // a scan's fill path, or foreign geometry — keep as-is
    }
    return {
      kind: 'stroke',
      id,
      tool,
      d: attr(element, 'd') ?? '',
      stroke: attr(element, 'stroke') ?? '#000000',
      strokeWidth: numAttr(element, 'stroke-width', 1),
      opacity,
      widths: attr(element, 'wb:widths'),
    } satisfies StrokeElement;
  }

  if (name === 'rect') {
    return shape(element, 'rect', {
      x: numAttr(element, 'x', 0),
      y: numAttr(element, 'y', 0),
      width: numAttr(element, 'width', 0),
      height: numAttr(element, 'height', 0),
    });
  }

  if (name === 'ellipse') {
    return shape(element, 'ellipse', {
      cx: numAttr(element, 'cx', 0),
      cy: numAttr(element, 'cy', 0),
      rx: numAttr(element, 'rx', 0),
      ry: numAttr(element, 'ry', 0),
    });
  }

  if (name === 'circle') {
    // Normalized to an ellipse — the editor has one radial shape, and the
    // rewrite only reaches the file after a genuine edit (write-back guard).
    const r = numAttr(element, 'r', 0);
    return shape(element, 'ellipse', {
      cx: numAttr(element, 'cx', 0),
      cy: numAttr(element, 'cy', 0),
      rx: r,
      ry: r,
    });
  }

  if (name === 'line') {
    const kind: ShapeKind = attr(element, 'marker-end') ? 'arrow' : 'line';
    return shape(element, kind, {
      x1: numAttr(element, 'x1', 0),
      y1: numAttr(element, 'y1', 0),
      x2: numAttr(element, 'x2', 0),
      y2: numAttr(element, 'y2', 0),
    });
  }

  if (name === 'text') {
    const tspans = childElements(element).filter((c) => localName(c.name) === 'tspan');
    const lines =
      tspans.length > 0
        ? tspans.map((t) => textContent(source, t))
        : [textContent(source, element)];
    return {
      kind: 'text',
      id,
      x: numAttr(element, 'x', 0),
      y: numAttr(element, 'y', 0),
      fontSize: numAttr(element, 'font-size', 16),
      fill: attr(element, 'fill') ?? '#000000',
      lines,
    } satisfies TextElement;
  }

  if (name === 'image') {
    const href = attr(element, 'href') ?? attr(element, 'xlink:href');
    if (href === null) {
      return null;
    }
    return {
      kind: 'image',
      id,
      x: numAttr(element, 'x', 0),
      y: numAttr(element, 'y', 0),
      width: numAttr(element, 'width', 0),
      height: numAttr(element, 'height', 0),
      href,
      opacity,
    } satisfies ImageElement;
  }

  return null;
}

function shape(element: XmlElement, kind: ShapeKind, geom: Record<string, number>): ShapeElement {
  return {
    kind: 'shape',
    id: attr(element, 'wb:id'),
    shape: kind,
    geom,
    stroke: attr(element, 'stroke') ?? '#000000',
    strokeWidth: numAttr(element, 'stroke-width', 1),
    fill: attr(element, 'fill') ?? 'none',
    opacity: optionalNum(element, 'opacity'),
  };
}

function optionalNum(element: XmlElement, name: string): number | null {
  const raw = attr(element, name);
  if (raw === null) {
    return null;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
