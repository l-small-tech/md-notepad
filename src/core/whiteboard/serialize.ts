/**
 * {@link SceneDoc} → SVG source. Pure, and DETERMINISTIC: fixed attribute
 * order, coordinates rounded to 2 decimals, 2-space indent, `\n` endings,
 * exactly one trailing newline. Determinism is what makes the round-trip
 * goldens possible and keeps diffs of a saved whiteboard readable.
 *
 * Everything a foreign renderer must honor is STANDARD SVG (layer visibility is
 * `display`, colors and widths are presentation attributes); editor-only state
 * lives in `wb:` attributes and the `<metadata><wb:doc>` JSON. That is why a
 * saved whiteboard renders identically in a browser and inside the app's
 * markdown preview via `![](board.svg)`.
 *
 * Note this is never called for a document the user merely LOOKED at — the
 * adapter's write-back guard serializes only after a genuine edit, so opening a
 * hand-authored or Inkscape SVG cannot rewrite it (the Milkdown contract, I2).
 */

import { escapeAttr, escapeText } from './xml';
import {
  createScene,
  SCENE_SCHEMA,
  SVG_NAMESPACE,
  WB_NAMESPACE,
  type ImageElement,
  type Layer,
  type SceneAttr,
  type SceneDoc,
  type SceneElement,
  type ShapeElement,
  type StrokeElement,
  type TextElement,
} from './scene';

/** Marker id for arrow heads; referenced by `marker-end`. */
export const ARROW_MARKER_ID = 'wb-arrow';

const INDENT = '  ';

/** 2-decimal fixed rounding. `-0` normalizes to `0` so diffs stay stable. */
export function num(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function serializeWhiteboard(doc: SceneDoc): string {
  const [vx, vy, vw, vh] = doc.viewBox;
  const lines: string[] = [];

  const rootAttrs: string[] = [
    `xmlns="${SVG_NAMESPACE}"`,
    `xmlns:wb="${WB_NAMESPACE}"`,
    `viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}"`,
    `width="${num(doc.width)}"`,
    `height="${num(doc.height)}"`,
    ...extras(doc.rootExtras),
  ];
  lines.push(`<svg ${rootAttrs.join(' ')}>`);

  lines.push(`${INDENT}<metadata><wb:doc>${escapeText(metaJson(doc))}</wb:doc></metadata>`);

  if (doc.background !== null) {
    lines.push(
      `${INDENT}<rect wb:role="background" x="${num(vx)}" y="${num(vy)}" ` +
        `width="${num(vw)}" height="${num(vh)}" fill="${escapeAttr(doc.background)}"/>`,
    );
  }

  if (needsArrowMarker(doc)) {
    lines.push(...arrowDefs());
  }

  for (const chunk of doc.prelude) {
    lines.push(INDENT + chunk);
  }

  for (const layer of doc.layers) {
    lines.push(...serializeLayer(layer));
  }

  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

/**
 * The bytes "New whiteboard" writes to disk: an empty board with one layer.
 * Deterministic, so a freshly created `.svg` has a stable, reviewable diff.
 */
export function blankWhiteboardSource(): string {
  return serializeWhiteboard(createScene());
}

/* -------------------------------------------------------------------------- */

function metaJson(doc: SceneDoc): string {
  // Deterministic key order: our two fields first, then everything preserved
  // from the file (or written by a later phase) in sorted order.
  const ordered: Record<string, unknown> = { schema: SCENE_SCHEMA };
  if (doc.background !== null) {
    ordered.background = doc.background;
  }
  for (const key of Object.keys(doc.meta).sort()) {
    ordered[key] = doc.meta[key];
  }
  return JSON.stringify(ordered);
}

function needsArrowMarker(doc: SceneDoc): boolean {
  const hasArrow = doc.layers.some((l) =>
    l.elements.some((e) => e.kind === 'shape' && e.shape === 'arrow'),
  );
  // A file that already carries the marker (round-tripped prelude) must not
  // get a second copy.
  return hasArrow && !doc.prelude.some((chunk) => chunk.includes(`id="${ARROW_MARKER_ID}"`));
}

function arrowDefs(): string[] {
  return [
    `${INDENT}<defs>`,
    `${INDENT}${INDENT}<marker id="${ARROW_MARKER_ID}" viewBox="0 0 10 10" refX="9" refY="5" ` +
      `markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `${INDENT}${INDENT}${INDENT}<path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/>`,
    `${INDENT}${INDENT}</marker>`,
    `${INDENT}</defs>`,
  ];
}

function extras(attrs: readonly SceneAttr[]): string[] {
  return attrs.map((a) => `${a.name}="${escapeAttr(a.value)}"`);
}

function serializeLayer(layer: Layer): string[] {
  const attrs: string[] = [
    `wb:layer="${escapeAttr(layer.id)}"`,
    `wb:name="${escapeAttr(layer.name)}"`,
  ];
  if (layer.kind !== 'draw') {
    attrs.push(`wb:kind="${layer.kind}"`);
  }
  if (layer.locked) {
    attrs.push('wb:locked="true"');
  }
  if (!layer.visible) {
    attrs.push('display="none"');
  }
  attrs.push(...extras(layer.extras));

  const open = `${INDENT}<g ${attrs.join(' ')}`;
  if (layer.elements.length === 0) {
    return [`${open}/>`];
  }
  const body = layer.elements.map((element) => INDENT + INDENT + serializeElement(element));
  return [`${open}>`, ...body, `${INDENT}</g>`];
}

/**
 * One element's markup. Exported because the draw adapter renders the
 * in-progress stroke/shape by serializing the very element it is about to
 * commit — so what you see while dragging is exactly what lands in the file.
 */
export function serializeElement(element: SceneElement): string {
  switch (element.kind) {
    case 'stroke':
      return serializeStroke(element);
    case 'shape':
      return serializeShape(element);
    case 'text':
      return serializeText(element);
    case 'image':
      return serializeImage(element);
    case 'raw':
      // Verbatim, exactly as it was read. This is the "nothing is dropped"
      // guarantee for foreign content and for a scan layer's OCR group.
      return element.xml;
  }
}

function serializeStroke(stroke: StrokeElement): string {
  const attrs: string[] = [];
  if (stroke.id !== null) {
    attrs.push(`wb:id="${escapeAttr(stroke.id)}"`);
  }
  attrs.push(
    `wb:tool="${stroke.tool}"`,
    `d="${escapeAttr(stroke.d)}"`,
    'fill="none"',
    `stroke="${escapeAttr(stroke.stroke)}"`,
    `stroke-width="${num(stroke.strokeWidth)}"`,
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
  );
  if (stroke.opacity !== null) {
    attrs.push(`opacity="${num(stroke.opacity)}"`);
  }
  if (stroke.widths !== null) {
    attrs.push(`wb:widths="${escapeAttr(stroke.widths)}"`);
  }
  return `<path ${attrs.join(' ')}/>`;
}

/** Geometry attribute order per shape — fixed, so output is byte-stable. */
const GEOM_ORDER: Record<ShapeElement['shape'], readonly string[]> = {
  rect: ['x', 'y', 'width', 'height'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  arrow: ['x1', 'y1', 'x2', 'y2'],
};

function serializeShape(shape: ShapeElement): string {
  const tag = shape.shape === 'rect' ? 'rect' : shape.shape === 'ellipse' ? 'ellipse' : 'line';
  const attrs: string[] = [];
  if (shape.id !== null) {
    attrs.push(`wb:id="${escapeAttr(shape.id)}"`);
  }
  for (const key of GEOM_ORDER[shape.shape]) {
    attrs.push(`${key}="${num(shape.geom[key] ?? 0)}"`);
  }
  if (shape.shape === 'rect' || shape.shape === 'ellipse') {
    attrs.push(`fill="${escapeAttr(shape.fill)}"`);
  }
  attrs.push(
    `stroke="${escapeAttr(shape.stroke)}"`,
    `stroke-width="${num(shape.strokeWidth)}"`,
    'stroke-linecap="round"',
  );
  if (shape.shape === 'arrow') {
    attrs.push(`marker-end="url(#${ARROW_MARKER_ID})"`);
  }
  if (shape.opacity !== null) {
    attrs.push(`opacity="${num(shape.opacity)}"`);
  }
  return `<${tag} ${attrs.join(' ')}/>`;
}

function serializeText(text: TextElement): string {
  const attrs: string[] = [];
  if (text.id !== null) {
    attrs.push(`wb:id="${escapeAttr(text.id)}"`);
  }
  attrs.push(
    `x="${num(text.x)}"`,
    `y="${num(text.y)}"`,
    `font-size="${num(text.fontSize)}"`,
    `fill="${escapeAttr(text.fill)}"`,
  );
  const tspans = text.lines
    .map(
      (line, index) =>
        `<tspan x="${num(text.x)}" dy="${index === 0 ? '0' : '1.2em'}">${escapeText(line)}</tspan>`,
    )
    .join('');
  return `<text ${attrs.join(' ')}>${tspans}</text>`;
}

function serializeImage(image: ImageElement): string {
  const attrs: string[] = [];
  if (image.id !== null) {
    attrs.push(`wb:id="${escapeAttr(image.id)}"`);
  }
  attrs.push(
    `x="${num(image.x)}"`,
    `y="${num(image.y)}"`,
    `width="${num(image.width)}"`,
    `height="${num(image.height)}"`,
  );
  if (image.opacity !== null) {
    attrs.push(`opacity="${num(image.opacity)}"`);
  }
  // href last: it is a data: URL and can run to megabytes.
  attrs.push(`href="${escapeAttr(image.href)}"`);
  return `<image ${attrs.join(' ')}/>`;
}
