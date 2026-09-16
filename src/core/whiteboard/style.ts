/**
 * Restyling a selection, and reading back what a selection currently IS.
 *
 * The ribbon is the whiteboard's only styling surface (no floating toolbar, no
 * properties panel): with a selection active a swatch, nib, fill, dash or
 * arrow-head click restyles what is selected AND sets the tool default. Both
 * halves need a pure answer to a per-kind question — "what does this patch mean
 * for a text element?" — so both live here rather than in the adapter.
 *
 * A patch is PARTIAL and per-kind: a pen stroke has no fill, a text element is
 * painted by `fill` rather than `stroke`, an image has no style at all. Every
 * kind ignores what it cannot express instead of growing a field it never
 * renders, which is what keeps one click one undo step over a mixed selection.
 */

import type { ElementRef } from './layers';
import { mapElements, resolveElement } from './select';
import type { ConnectorRoute, SceneDoc, SceneElement, ShapeElement } from './scene';
import {
  dashArray,
  dashStyleOf,
  HIGHLIGHTER_WIDTH_FACTOR,
  type ArrowHeads,
  type DashStyle,
} from './tool-settings';

/**
 * What a restyle can change. Every field is optional; an absent one is left
 * alone, which is what lets the ribbon send exactly the control the user
 * touched. `markerEnd` flips a line's KIND (`line` ⇄ `arrow`) because that is
 * where the format keeps the end head — see {@link ShapeElement.markerStart}.
 */
export interface StylePatch {
  /** The element's colour: a shape/stroke's `stroke`, a text's `fill`. */
  readonly stroke?: string;
  /** Shapes only. `'none'` or a colour (including `PAPER_FILL`). */
  readonly fill?: string;
  readonly strokeWidth?: number;
  readonly dash?: DashStyle;
  readonly markerStart?: boolean;
  readonly markerEnd?: boolean;
  /** Lines only: straight or elbow. The attachments are untouched either way. */
  readonly route?: ConnectorRoute;
  readonly rx?: number | null;
  readonly fontSize?: number;
  readonly fontFamily?: string | null;
}

/** The three-way arrow-head control, as one value. */
export function headsOf(shape: ShapeElement): ArrowHeads {
  if (shape.shape !== 'arrow') {
    return 'none';
  }
  return shape.markerStart ? 'both' : 'end';
}

/** The patch a click on the heads control means. */
export function headsPatch(heads: ArrowHeads): StylePatch {
  return { markerEnd: heads !== 'none', markerStart: heads === 'both' };
}

/**
 * Apply `patch` to every referenced element, per kind. Indices are preserved,
 * so the caller's selection survives — one click, one undo step, and the
 * selection is still there to take the next one.
 */
export function restyleElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  patch: StylePatch,
): SceneDoc {
  return mapElements(doc, refs, (element) => restyleElement(element, patch));
}

export function restyleElement(element: SceneElement, patch: StylePatch): SceneElement {
  switch (element.kind) {
    case 'stroke': {
      const next = { ...element };
      if (patch.stroke !== undefined) {
        next.stroke = patch.stroke;
        // A STORED slot is a scan's "this hex means that theme colour" note.
        // Recolouring makes it a lie, and leaving it would render the new
        // colour as the old slot, so a recolour always drops it.
        delete next.slot;
      }
      if (patch.strokeWidth !== undefined && element.tool !== 'scanfill') {
        // The highlighter is a fat pen: giving it the nib size verbatim would
        // turn it into one. It keeps its multiple of whatever nib you pick.
        next.strokeWidth =
          element.tool === 'highlighter'
            ? patch.strokeWidth * HIGHLIGHTER_WIDTH_FACTOR
            : patch.strokeWidth;
      }
      return next;
    }
    case 'shape': {
      const next = { ...element };
      if (patch.stroke !== undefined) {
        next.stroke = patch.stroke;
        delete next.slot;
      }
      if (patch.fill !== undefined && element.shape !== 'line' && element.shape !== 'arrow') {
        next.fill = patch.fill;
      }
      if (patch.strokeWidth !== undefined) {
        next.strokeWidth = patch.strokeWidth;
        // The dash pattern is expressed against the stroke width, so a nib
        // change has to redraw it or a dashed hairline goes solid-looking.
        const style = dashStyleOf(element.dash, element.strokeWidth);
        if (style !== null) {
          next.dash = dashArray(style, patch.strokeWidth);
        }
      }
      if (patch.dash !== undefined) {
        next.dash = dashArray(patch.dash, next.strokeWidth);
      }
      if (patch.rx !== undefined && element.shape === 'rect') {
        next.rx = patch.rx;
      }
      if (element.shape === 'line' || element.shape === 'arrow') {
        if (patch.markerEnd !== undefined) {
          next.shape = patch.markerEnd ? 'arrow' : 'line';
        }
        if (patch.markerStart !== undefined) {
          next.markerStart = patch.markerStart;
        }
        if (patch.route !== undefined) {
          next.route = patch.route;
        }
      }
      return next;
    }
    case 'text': {
      const next = { ...element };
      if (patch.stroke !== undefined) {
        // Text is painted by `fill`; the colour control means the same thing
        // to the user either way, so it maps rather than being ignored.
        next.fill = patch.stroke;
        delete next.slot;
      }
      if (patch.fontSize !== undefined) {
        next.fontSize = patch.fontSize;
      }
      if (patch.fontFamily !== undefined) {
        next.fontFamily = patch.fontFamily;
      }
      return next;
    }
    case 'image':
    case 'raw':
      return element;
  }
}

/* ----------------------------- reading it back ---------------------------- */

/**
 * What the ribbon lights up. Every field is the value the whole selection
 * AGREES on, or null when it is mixed or when nothing in the selection can
 * express it — and the ribbon highlights nothing for null, which is the honest
 * answer to "what colour is this?" for two differently-coloured shapes.
 */
export interface SelectionStyle {
  readonly stroke: string | null;
  readonly fill: string | null;
  readonly strokeWidth: number | null;
  readonly dash: DashStyle | null;
  readonly heads: ArrowHeads | null;
  /** The route every line in the selection takes, or null when mixed / no lines. */
  readonly route: ConnectorRoute | null;
  /** True when the selection holds a line or arrow — the heads and route controls' gate. */
  readonly hasLine: boolean;
  /** True when the selection holds something with a fill (a closed shape). */
  readonly hasFill: boolean;
  /** True when the selection holds text — the ribbon's type controls. */
  readonly hasText: boolean;
  /**
   * True when the selection holds something drawn with a NIB (ink or a shape
   * outline) — the ribbon's stroke-width row. A selection can be both, and
   * then the ribbon shows both rather than guessing which one you meant.
   */
  readonly hasInk: boolean;
}

/** One value if every contributor agrees, else null. */
function agreed<T>(values: readonly T[]): T | null {
  if (values.length === 0) {
    return null;
  }
  const first = values[0]!;
  return values.every((v) => v === first) ? first : null;
}

/**
 * The common style of a selection, or null when nothing is selected — which is
 * how the ribbon knows to show the TOOL's settings instead.
 */
export function selectionStyle(doc: SceneDoc, refs: readonly ElementRef[]): SelectionStyle | null {
  const elements = refs
    .map((ref) => resolveElement(doc, ref))
    .filter((e): e is SceneElement => e !== null && e.kind !== 'raw');
  if (elements.length === 0) {
    return null;
  }
  const strokes: string[] = [];
  const fills: string[] = [];
  const widths: number[] = [];
  const dashes: (DashStyle | null)[] = [];
  const heads: ArrowHeads[] = [];
  const routes: ConnectorRoute[] = [];
  for (const element of elements) {
    if (element.kind === 'stroke') {
      strokes.push(element.stroke);
      widths.push(
        element.tool === 'highlighter'
          ? element.strokeWidth / HIGHLIGHTER_WIDTH_FACTOR
          : element.strokeWidth,
      );
    } else if (element.kind === 'shape') {
      strokes.push(element.stroke);
      widths.push(element.strokeWidth);
      dashes.push(dashStyleOf(element.dash, element.strokeWidth));
      if (element.shape === 'line' || element.shape === 'arrow') {
        heads.push(headsOf(element));
        routes.push(element.route);
      } else {
        fills.push(element.fill);
      }
    } else if (element.kind === 'text') {
      strokes.push(element.fill);
    }
  }
  return {
    stroke: agreed(strokes),
    fill: agreed(fills),
    strokeWidth: agreed(widths),
    dash: agreed(dashes),
    heads: agreed(heads),
    route: agreed(routes),
    hasLine: heads.length > 0,
    hasFill: fills.length > 0,
    hasText: elements.some((e) => e.kind === 'text'),
    hasInk: widths.length > 0,
  };
}
