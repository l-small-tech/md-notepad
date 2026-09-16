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
import { boxShapePoints, cylinderRimRy, shapeGeomRect } from './geometry';
import { BOARD_BACKGROUND_DARK, PALETTE, PALETTE_DARK, paletteSlot } from './tool-settings';
import {
  createScene,
  DEFAULT_BACKGROUND,
  isBoxShape,
  SCENE_SCHEMA,
  SVG_NAMESPACE,
  WB_NAMESPACE,
  type BoardColorMode,
  type BoxShapeKind,
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

/**
 * Marker id for a head at the START of a line (`marker-start`).
 *
 * This is a SECOND def whose triangle is drawn pointing the other way, not a
 * reuse of `wb-arrow` under `orient="auto-start-reverse"`. Reversing one def is
 * tidier and it is what the `wb-arrow` def already declares, but the attribute
 * value is SVG 2: Chromium, Firefox and WebView2 honour it, while librsvg,
 * resvg, older Inkscape and several SVG→PDF converters do not, and there it
 * silently degrades to `auto` — a start head pointing backwards INTO the line.
 * The one big idea is that the file renders identically anywhere, so the
 * broadest-support option wins over the tidier one; a duplicated `<path>` in a
 * def costs eighty bytes, once per file.
 */
export const ARROW_START_MARKER_ID = 'wb-arrow-start';

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
  // class rides along after ours. `wb-fixed` (colorMode 'fixed') is the mode
  // SWITCH: every colour-application rule carries a `:not(.wb-fixed)` guard,
  // so the token turns theming off while the palette map stays in the file.
  const ownClass = themed
    ? colorModeOf(doc) === 'fixed'
      ? 'wb-board wb-fixed'
      : 'wb-board'
    : null;
  const foreignClass = doc.rootExtras.find((a) => a.name === 'class')?.value;
  const rootAttrs: string[] = [
    `xmlns="${SVG_NAMESPACE}"`,
    `xmlns:wb="${WB_NAMESPACE}"`,
    `viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}"`,
    `width="${num(width)}"`,
    `height="${num(height)}"`,
    ...(ownClass !== null
      ? [`class="${escapeAttr(foreignClass ? `${ownClass} ${foreignClass}` : ownClass)}"`]
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

  lines.push(...arrowDefs(doc));

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
 * `colorMode` in the `wb:doc` metadata: `'fixed'` renders every element's
 * literal presentation-attribute colour (the root gains `wb-fixed`, which the
 * palette rules' `:not(.wb-fixed)` guard honours); anything else — including
 * absence, which is what every pre-existing file has — is `'themed'`. Only
 * meaningful while {@link isThemed}; a `themed: false` document has no palette
 * machinery to switch.
 */
export function colorModeOf(doc: SceneDoc): BoardColorMode {
  return doc.meta.colorMode === 'fixed' ? 'fixed' : 'themed';
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
 *
 * Every colour-APPLICATION rule is guarded with `:not(.wb-fixed)`: a document
 * whose `colorMode` is `'fixed'` carries `wb-fixed` on the root, which turns
 * the whole mechanism off without removing the map — the literal presentation
 * attributes render instead, in the app and in any foreign renderer alike.
 * The var DEFINITIONS stay unguarded (defining is harmless; applying is not).
 */
function paletteStyleBlock(): string[] {
  const inner = INDENT + INDENT;
  const themedScope = 'svg.wb-board:not(.wb-fixed)';
  const lines = [`${INDENT}<style wb:role="palette">`];
  lines.push(`${inner}svg.wb-board{${paletteVars(DEFAULT_BACKGROUND, PALETTE)}}`);
  lines.push(
    `${inner}@media (prefers-color-scheme: dark){` +
      `svg.wb-board{${paletteVars(BOARD_BACKGROUND_DARK, PALETTE_DARK)}}}`,
  );
  // The surface of an infinite board (no page rect): CSS background on the
  // svg viewport itself. Harmless on a page board — the rect covers it. A
  // fixed-mode board pins the canonical white: its literal colours were
  // measured (or chosen) against white and must not sit on a scheme colour.
  lines.push(`${inner}${themedScope}{background:var(--wb-bg,${DEFAULT_BACKGROUND})}`);
  lines.push(`${inner}svg.wb-board.wb-fixed{background:${DEFAULT_BACKGROUND}}`);
  lines.push(`${inner}${themedScope} .wb-bg{fill:var(--wb-bg,${DEFAULT_BACKGROUND})}`);
  PALETTE.forEach((hex, slot) => {
    lines.push(`${inner}${themedScope} .wb-c${slot}:not(text){stroke:var(--wb-c${slot},${hex})}`);
    lines.push(`${inner}${themedScope} text.wb-c${slot}{fill:var(--wb-c${slot},${hex})}`);
    // Fill-painted ink (a scan's blob fallback) themes through its own class —
    // the stroke rule above would outline it instead of recolouring it.
    lines.push(`${inner}${themedScope} .wb-f${slot}{fill:var(--wb-c${slot},${hex})}`);
  });
  lines.push(`${INDENT}</style>`);
  return lines;
}

function paletteVars(bg: string, colors: readonly string[]): string {
  return [`--wb-bg:${bg}`, ...colors.map((c, slot) => `--wb-c${slot}:${c}`)].join(';');
}

/**
 * `class="wb-cN"` for the element's theme identity, or nothing. The slot is
 * the STORED one when the element carries it (a true-colour scan stroke whose
 * literal hex is the measured colour), otherwise DERIVED from the colour — a
 * palette hex is its own slot, a custom hex is a deliberate opt-out.
 */
function slotClassAttr(color: string, themed: boolean, stored?: number): string[] {
  const slot = themed ? resolveSlot(color, stored) : -1;
  return slot < 0 ? [] : [`class="wb-c${slot}"`];
}

/** Stored slot (validated) if present, else derived from the colour. */
function resolveSlot(color: string, stored: number | undefined): number {
  if (stored !== undefined && Number.isInteger(stored) && stored >= 0 && stored < PALETTE.length) {
    return stored;
  }
  return paletteSlot(color);
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

/**
 * The marker defs this document needs and does not already carry. A file that
 * already holds one (round-tripped into the prelude) must not get a second
 * copy; a file that grows its FIRST reversed head later gets a second `<defs>`
 * holding only that one, which is legal SVG and keeps every earlier byte where
 * it was.
 */
function arrowDefs(doc: SceneDoc): string[] {
  let end = false;
  let start = false;
  for (const layer of doc.layers) {
    for (const element of layer.elements) {
      if (element.kind === 'shape') {
        end ||= element.shape === 'arrow';
        start ||= element.markerStart;
      }
    }
  }
  const carried = (id: string): boolean =>
    doc.prelude.some((chunk) => chunk.includes(`id="${id}"`));
  const markers: string[] = [];
  if (end && !carried(ARROW_MARKER_ID)) {
    markers.push(...markerDef(ARROW_MARKER_ID, 'M0,0 L10,5 L0,10 z', 9, 'auto-start-reverse'));
  }
  if (start && !carried(ARROW_START_MARKER_ID)) {
    // Mirrored geometry with plain `orient="auto"` — reversing it AGAIN with
    // `auto-start-reverse` would point it back down the line. See
    // ARROW_START_MARKER_ID for why the mirror, not the attribute, is the head.
    markers.push(...markerDef(ARROW_START_MARKER_ID, 'M10,0 L0,5 L10,10 z', 1, 'auto'));
  }
  return markers.length === 0 ? [] : [`${INDENT}<defs>`, ...markers, `${INDENT}</defs>`];
}

function markerDef(id: string, d: string, refX: number, orient: string): string[] {
  return [
    `${INDENT}${INDENT}<marker id="${id}" viewBox="0 0 10 10" refX="${refX}" refY="5" ` +
      `markerWidth="6" markerHeight="6" orient="${orient}">`,
    `${INDENT}${INDENT}${INDENT}<path d="${d}" fill="context-stroke"/>`,
    `${INDENT}${INDENT}</marker>`,
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
 * `<style>` block themes. The class is DERIVED from the colour except for an
 * element that carries a STORED `slot` — a true-colour scan stroke, whose
 * literal hex is the measured colour and cannot name its own theme slot.
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
  if (stroke.tool === 'scanfill') {
    // A blob traced by contour: painted with FILL, not stroke, so it themes
    // through its own `wb-fN` class — the palette block's stroke rule would
    // outline it instead of recolouring it.
    const slot = themed ? resolveSlot(stroke.stroke, stroke.slot) : -1;
    attrs.push(
      'wb:tool="scanfill"',
      ...(slot < 0 ? [] : [`class="wb-f${slot}"`]),
      `d="${escapeAttr(stroke.d)}"`,
      `fill="${escapeAttr(stroke.stroke)}"`,
      'fill-rule="evenodd"',
      'stroke="none"',
    );
    if (stroke.opacity !== null) {
      attrs.push(`opacity="${num(stroke.opacity)}"`);
    }
    return `<path ${attrs.join(' ')}/>`;
  }
  attrs.push(
    `wb:tool="${stroke.tool}"`,
    ...slotClassAttr(stroke.stroke, themed, stroke.slot),
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
const GEOM_ORDER: Partial<Record<ShapeElement['shape'], readonly string[]>> = {
  rect: ['x', 'y', 'width', 'height'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  arrow: ['x1', 'y1', 'x2', 'y2'],
};

/**
 * A box shape's `<polygon points>` / `<path d>`.
 *
 * The four polygons need no help on the way back in: their vertices touch the
 * box's edges by construction, so parse recovers `x/y/width/height` as the
 * bounding box of the points. The CYLINDER cannot — its arcs bulge past the
 * ends of the numbers in the `d` string, and reading a box back out of two
 * elliptical arcs means trusting a template the user may have hand-edited. It
 * carries `wb:box="x y w h"` instead: one editor-only attribute, ignored by
 * every other renderer, and unambiguous.
 */
function boxShapeBody(shape: ShapeElement): string[] {
  const rect = shapeGeomRect(shape.shape, shape.geom);
  if (shape.shape !== 'cylinder') {
    const points = boxShapePoints(shape.shape as BoxShapeKind, rect)
      .map((p) => `${num(p.x)},${num(p.y)}`)
      .join(' ');
    return [`points="${points}"`];
  }
  const { x, y, width: w, height: h } = rect;
  const ry = cylinderRimRy(rect);
  const rx = w / 2;
  const arc = (toX: number, toY: number, sweep: number): string =>
    `A${num(rx)},${num(ry)} 0 0 ${sweep} ${num(toX)},${num(toY)}`;
  const d =
    `M${num(x)},${num(y + ry)}${arc(x + w, y + ry, 1)}` +
    `L${num(x + w)},${num(y + h - ry)}${arc(x, y + h - ry, 1)}Z` +
    // The visible front of the rim, as its own subpath.
    `M${num(x)},${num(y + ry)}${arc(x + w, y + ry, 0)}`;
  return [`wb:box="${num(x)} ${num(y)} ${num(w)} ${num(h)}"`, `d="${escapeAttr(d)}"`];
}

/**
 * The class attribute a shape carries: its stroke's theme slot AND its fill's.
 *
 * An outline and a fill are two independent colours, so a shape can need two
 * classes — `wb-cN` drives the palette block's stroke rule, `wb-fN` its fill
 * rule (which already existed for scan blobs and needed no new scoping). A
 * shape filled with the board's own surface colour gets `wb-bg` instead, the
 * very rule the page rect themes through: that is what makes a "Paper"-filled
 * box hide the lines behind it on a dark board as well as a light one.
 */
function shapeClassAttr(shape: ShapeElement, themed: boolean): string[] {
  const tokens: string[] = [];
  const strokeSlot = themed ? resolveSlot(shape.stroke, shape.slot) : -1;
  if (strokeSlot >= 0) {
    tokens.push(`wb-c${strokeSlot}`);
  }
  if (themed && shape.fill !== 'none') {
    const fillSlot = paletteSlot(shape.fill);
    if (fillSlot >= 0) {
      tokens.push(`wb-f${fillSlot}`);
    } else if (shape.fill === DEFAULT_BACKGROUND) {
      tokens.push('wb-bg');
    }
  }
  return tokens.length === 0 ? [] : [`class="${tokens.join(' ')}"`];
}

function serializeShape(shape: ShapeElement, themed: boolean): string {
  const box = isBoxShape(shape.shape);
  const tag = box
    ? shape.shape === 'cylinder'
      ? 'path'
      : 'polygon'
    : shape.shape === 'rect'
      ? 'rect'
      : shape.shape === 'ellipse'
        ? 'ellipse'
        : 'line';
  const attrs: string[] = [];
  if (shape.id !== null) {
    attrs.push(`wb:id="${escapeAttr(shape.id)}"`);
  }
  if (box) {
    // Without this a re-opened polygon is anonymous geometry and would come
    // back as a RawElement — which is exactly what a foreign `<polygon>` does.
    attrs.push(`wb:shape="${shape.shape}"`);
  }
  attrs.push(...shapeClassAttr(shape, themed));
  if (box) {
    attrs.push(...boxShapeBody(shape));
  } else {
    for (const key of GEOM_ORDER[shape.shape] ?? []) {
      attrs.push(`${key}="${num(shape.geom[key] ?? 0)}"`);
    }
    if (shape.shape === 'rect' && shape.rx !== null) {
      attrs.push(`rx="${num(shape.rx)}"`);
    }
  }
  if (box || shape.shape === 'rect' || shape.shape === 'ellipse') {
    attrs.push(`fill="${escapeAttr(shape.fill)}"`);
  }
  attrs.push(
    `stroke="${escapeAttr(shape.stroke)}"`,
    `stroke-width="${num(shape.strokeWidth)}"`,
    'stroke-linecap="round"',
  );
  // Null dash emits nothing, which is what keeps every pre-dash file identical.
  if (shape.dash !== null) {
    attrs.push(`stroke-dasharray="${escapeAttr(shape.dash)}"`);
  }
  if (shape.markerStart) {
    attrs.push(`marker-start="url(#${ARROW_START_MARKER_ID})"`);
  }
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
  attrs.push(...slotClassAttr(text.fill, themed, text.slot));
  attrs.push(`x="${num(text.x)}"`, `y="${num(text.y)}"`, `font-size="${num(text.fontSize)}"`);
  // Omitted when null so text that never asked for a face keeps inheriting the
  // renderer's default — and so files written before this existed round-trip
  // byte-for-byte.
  if (text.fontFamily !== null) {
    attrs.push(`font-family="${escapeAttr(text.fontFamily)}"`);
  }
  attrs.push(`fill="${escapeAttr(text.fill)}"`);
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
