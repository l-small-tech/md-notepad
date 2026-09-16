/**
 * The drawing tools, as pure element constructors.
 *
 * A tool is nothing but "given a gesture, produce a {@link SceneElement}" —
 * keeping that here (rather than in the adapter) means the adapter's pointer
 * handling and, later, the scan tracer agree on what a pen stroke IS, and every
 * constructor is unit-tested without a DOM.
 *
 * The vocabulary itself (tool ids, palette, nib sizes) lives in the dependency-
 * free `tool-settings.ts` so the ribbon can import it without dragging this
 * module's transitive weight into the entry bundle. It is re-exported here so
 * whiteboard code has one import to reach for.
 */

import type { Point } from './geometry';
import { rectFromCorners } from './geometry';
import { buildStrokePath } from './smoothing';
import {
  isBoxShape,
  type ConnectorRoute,
  type ShapeElement,
  type StrokeElement,
  type TextElement,
} from './scene';
import {
  dashArray,
  DEFAULT_CORNER_RADIUS,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH_FACTOR,
  NO_FILL,
  type ArrowHeads,
  type DashStyle,
  type ShapeTool,
} from './tool-settings';

export * from './tool-settings';

export function makeStroke(
  tool: 'pen' | 'highlighter',
  points: readonly Point[],
  color: string,
  width: number,
): StrokeElement | null {
  const d = buildStrokePath(points);
  if (d === '') {
    return null;
  }
  return {
    kind: 'stroke',
    // Drawn strokes stay id-free: ids exist so a scan layer's OCR metadata can
    // point at the ink it read, and every byte counts in a dense file.
    id: null,
    group: null,
    tool,
    d,
    stroke: color,
    strokeWidth: tool === 'highlighter' ? width * HIGHLIGHTER_WIDTH_FACTOR : width,
    opacity: tool === 'highlighter' ? HIGHLIGHTER_OPACITY : null,
    widths: null,
  };
}

/**
 * A text element from what the user typed. `at` is the BASELINE of the first
 * line, which is what `<text y>` means — the adapter's textarea overlay is
 * positioned to match, so the caret sits where the glyphs will land.
 *
 * One line per newline typed, and no other source of lines. SVG `<text>` has
 * no box and no wrapping, so anything that reflowed here would be the editor
 * inventing a feature the file cannot carry — the line breaks are the author's,
 * and they are what every renderer will show, forever.
 *
 * Returns null for empty input (including a box that only ever held spaces):
 * tapping the text tool and tapping away again must leave nothing behind.
 * Trailing blank lines go the same way; interior ones are the user's.
 */
export function makeText(
  at: Point,
  text: string,
  color: string,
  fontSize: number,
  fontFamily: string | null = null,
): TextElement | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }
  while (lines.length > 0 && lines[0]!.trim() === '') {
    lines.shift();
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    kind: 'text',
    id: null,
    group: null,
    labelOf: null,
    x: at.x,
    y: at.y,
    fontSize,
    fontFamily,
    fill: color,
    lines,
  };
}

/** Everything a shape tool needs beyond its two corners. */
export interface ShapeStyle {
  readonly color: string;
  readonly width: number;
  /** `'none'` (the default) or a colour — see `PAPER_FILL` for the board's own. */
  readonly fill?: string;
  readonly dash?: DashStyle;
  /**
   * Line family only. It decides the KIND as well as the heads: `'none'` draws
   * a `line`, anything else an `arrow`, and `'both'` adds `marker-start`. One
   * source of truth, so the shape picker and the heads control cannot
   * disagree about what the next drag will produce.
   */
  readonly heads?: ArrowHeads;
  /** Line family only: straight (the default) or an elbow route. */
  readonly route?: ConnectorRoute;
}

/**
 * A shape from its drag. Returns null for a degenerate gesture (a click that
 * never moved) so a stray tap can't litter the board with zero-size elements.
 *
 * Every non-linear shape is a BOX: the five polygon/path shapes share `rect`'s
 * geometry keys and differ only in what the serializer draws inside them, so
 * transforms, bounds and resize each need one branch rather than six.
 */
export function makeShape(
  tool: ShapeTool,
  start: Point,
  end: Point,
  style: ShapeStyle,
): ShapeElement | null {
  const { color, width } = style;
  const dash = dashArray(style.dash ?? 'solid', width);
  const base = {
    kind: 'shape',
    id: null,
    group: null,
    stroke: color,
    strokeWidth: width,
    dash,
    rx: null,
    markerStart: false,
    opacity: null,
    // Drawn free; the adapter attaches ends that landed on a host afterwards
    // (`connectors.ts` → `attachConnector`).
    from: null,
    to: null,
    route: 'straight',
  } as const;

  if (tool === 'line' || tool === 'arrow') {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 2) {
      return null;
    }
    const heads = style.heads ?? (tool === 'arrow' ? 'end' : 'none');
    return {
      ...base,
      shape: heads === 'none' ? 'line' : 'arrow',
      markerStart: heads === 'both',
      geom: { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
      fill: NO_FILL,
      route: style.route ?? 'straight',
    };
  }

  const rect = rectFromCorners(start, end);
  if (rect.width < 2 && rect.height < 2) {
    return null;
  }
  const fill = style.fill ?? NO_FILL;

  if (tool === 'ellipse') {
    return {
      ...base,
      shape: 'ellipse',
      geom: {
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
        rx: rect.width / 2,
        ry: rect.height / 2,
      },
      fill,
    };
  }
  const geom = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (tool === 'rect' || tool === 'roundrect') {
    return {
      ...base,
      shape: 'rect',
      // The corner radius never exceeds half the shorter side — SVG clamps it
      // anyway, and storing the clamped value keeps a resize honest.
      rx:
        tool === 'roundrect'
          ? Math.min(DEFAULT_CORNER_RADIUS, rect.width / 2, rect.height / 2)
          : null,
      geom,
      fill,
    };
  }
  return isBoxShape(tool) ? { ...base, shape: tool, geom, fill } : null;
}

/**
 * Where a constrained (shift-held) drag actually ends: a box shape becomes a
 * square — an ellipse a circle — and a line snaps to 45° steps. The drag's
 * DIRECTION is preserved in both cases, so a square grows up-and-left as
 * readily as down-and-right.
 */
export function constrainShapeDrag(tool: ShapeTool, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === 'line' || tool === 'arrow') {
    const length = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: start.x + (dx < 0 ? -size : size),
    y: start.y + (dy < 0 ? -size : size),
  };
}
