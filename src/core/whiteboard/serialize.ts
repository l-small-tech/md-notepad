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
import { contentViewBox } from './bounds';
import { BOARD_BACKGROUND_DARK, PALETTE, PALETTE_DARK, paletteSlot } from './tool-settings';
import {
  createScene,
  DEFAULT_BACKGROUND,
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
  // An infinite board has no page, so its saved viewBox is refitted to the
  // content every time (idempotent — see bounds.ts); a page board's viewBox
  // is the page and stays exactly where the user put it.
  const infinite = doc.background === null;
  const [vx, vy, vw, vh] = infinite ? contentViewBox(doc) : doc.viewBox;
  const width = infinite ? vw : doc.width;
  const height = infinite ? vh : doc.height;
  const lines: string[] = [];
  const themed = isThemed(doc);

  // Theming scopes every palette rule to `svg.wb-board` — the class, not
  // `:root`, because the file gets inlined into HTML contexts (export,
  // mermaid-style DOM inlining) where `:root` is the page. A foreign root
  // class rides along after ours.
  const foreignClass = doc.rootExtras.find((a) => a.name === 'class')?.value;
  const rootAttrs: string[] = [
    `xmlns="${SVG_NAMESPACE}"`,
    `xmlns:wb="${WB_NAMESPACE}"`,
    `viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}"`,
    `width="${num(width)}"`,
    `height="${num(height)}"`,
    ...(themed
      ? [`class="${escapeAttr(foreignClass ? `wb-board ${foreignClass}` : 'wb-board')}"`]
      : []),
    ...extras(themed ? doc.rootExtras.filter((a) => a.name !== 'class') : doc.rootExtras),
  ];
  lines.push(`<svg ${rootAttrs.join(' ')}>`);

  lines.push(`${INDENT}<metadata><wb:doc>${escapeText(metaJson(doc))}</wb:doc></metadata>`);

  if (themed) {
    lines.push(...paletteStyleBlock());
  }

  if (doc.background !== null) {
    // The backdrop is themable only while it is the canonical white — a custom
    // background is an explicit opt-out, exactly like a custom ink colour.
    const bgClass = themed && doc.background === DEFAULT_BACKGROUND ? ' class="wb-bg"' : '';
    lines.push(
      `${INDENT}<rect wb:role="background"${bgClass} x="${num(vx)}" y="${num(vy)}" ` +
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
    lines.push(...serializeLayer(layer, themed));
  }

  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

/** `"themed": false` in the wb:doc metadata turns the palette machinery off. */
export function isThemed(doc: SceneDoc): boolean {
  return doc.meta.themed !== false;
}

/**
 * The serializer-owned palette block: slot variables with light defaults, a
 * `prefers-color-scheme: dark` override, and class → `var()` rules. CSS
 * overrides presentation attributes, so a CSS-capable renderer themes the ink
 * while anything dumber falls back to the literal hex each element carries.
 * Regenerated wholesale on every save (parse drops the old copy), which is how
 * the palette stays current when these constants change.
 *
 * The stroke rule excludes `<text>` — text is painted by `fill`, and handing it
 * a stroke would outline every glyph at the default 1px width.
 */
function paletteStyleBlock(): string[] {
  const inner = INDENT + INDENT;
  const lines = [`${INDENT}<style wb:role="palette">`];
  lines.push(`${inner}svg.wb-board{${paletteVars(DEFAULT_BACKGROUND, PALETTE)}}`);
  lines.push(
    `${inner}@media (prefers-color-scheme: dark){` +
      `svg.wb-board{${paletteVars(BOARD_BACKGROUND_DARK, PALETTE_DARK)}}}`,
  );
  // The surface of an infinite board (no page rect): CSS background on the
  // svg viewport itself. Harmless on a page board — the rect covers it.
  lines.push(`${inner}svg.wb-board{background:var(--wb-bg,${DEFAULT_BACKGROUND})}`);
  lines.push(`${inner}svg.wb-board .wb-bg{fill:var(--wb-bg,${DEFAULT_BACKGROUND})}`);
  PALETTE.forEach((hex, slot) => {
    lines.push(`${inner}svg.wb-board .wb-c${slot}:not(text){stroke:var(--wb-c${slot},${hex})}`);
    lines.push(`${inner}svg.wb-board text.wb-c${slot}{fill:var(--wb-c${slot},${hex})}`);
  });
  lines.push(`${INDENT}</style>`);
  return lines;
}

function paletteVars(bg: string, colors: readonly string[]): string {
  return [`--wb-bg:${bg}`, ...colors.map((c, slot) => `--wb-c${slot}:${c}`)].join(';');
}

/** `class="wb-cN"` for a palette colour, or nothing for a custom hex. */
function slotClassAttr(color: string, themed: boolean): string[] {
  const slot = themed ? paletteSlot(color) : -1;
  return slot < 0 ? [] : [`class="wb-c${slot}"`];
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

function serializeLayer(layer: Layer, themed: boolean): string[] {
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
  const body = layer.elements.map((element) => INDENT + INDENT + serializeElement(element, themed));
  return [`${open}>`, ...body, `${INDENT}</g>`];
}

/**
 * One element's markup. Exported because the draw adapter renders the
 * in-progress stroke/shape by serializing the very element it is about to
 * commit — so what you see while dragging is exactly what lands in the file.
 * `themed` adds the palette-slot class (`wb-cN`) that the file's palette
 * `<style>` block themes; classes are DERIVED from the colour, never stored.
 */
export function serializeElement(element: SceneElement, themed = true): string {
  switch (element.kind) {
    case 'stroke':
      return serializeStroke(element, themed);
    case 'shape':
      return serializeShape(element, themed);
    case 'text':
      return serializeText(element, themed);
    case 'image':
      return serializeImage(element);
    case 'raw':
      // Verbatim, exactly as it was read. This is the "nothing is dropped"
      // guarantee for foreign content and for a scan layer's OCR group.
      return element.xml;
  }
}

function serializeStroke(stroke: StrokeElement, themed: boolean): string {
  const attrs: string[] = [];
  if (stroke.id !== null) {
    attrs.push(`wb:id="${escapeAttr(stroke.id)}"`);
  }
  attrs.push(
    `wb:tool="${stroke.tool}"`,
    ...slotClassAttr(stroke.stroke, themed),
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

function serializeShape(shape: ShapeElement, themed: boolean): string {
  const tag = shape.shape === 'rect' ? 'rect' : shape.shape === 'ellipse' ? 'ellipse' : 'line';
  const attrs: string[] = [];
  if (shape.id !== null) {
    attrs.push(`wb:id="${escapeAttr(shape.id)}"`);
  }
  // Only the OUTLINE is themable — the palette block's class rule sets stroke.
  // A shape fill stays literal (v1 shapes are fill="none" anyway).
  attrs.push(...slotClassAttr(shape.stroke, themed));
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

function serializeText(text: TextElement, themed: boolean): string {
  const attrs: string[] = [];
  if (text.id !== null) {
    attrs.push(`wb:id="${escapeAttr(text.id)}"`);
  }
  // Text paints with fill; the palette block themes it via `text.wb-cN`.
  attrs.push(...slotClassAttr(text.fill, themed));
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
