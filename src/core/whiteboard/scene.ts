/**
 * The whiteboard scene model — the in-memory shape of a `.svg` whiteboard.
 *
 * The FILE is the source of truth (a single self-contained SVG that any browser
 * renders); `SceneDoc` is a lossless projection of it that the editor can reason
 * about. `parse.ts` builds one, `serialize.ts` writes one back, and the pair is
 * golden-tested — those tests define the format.
 *
 * Two properties everything else leans on:
 *
 * - **Immutable, structurally shared.** Every edit is a pure
 *   `(doc, …) → doc`, so undo is a snapshot stack (Phase 2) rather than an
 *   inverse-operation zoo.
 * - **Nothing is dropped.** Content we don't model survives as a
 *   {@link RawElement} (inside a layer) or in {@link SceneDoc.prelude}
 *   (top-level `<defs>`/`<style>`/comments), both re-emitted from the original
 *   source text.
 */

/** Namespace for every editor-only attribute. Foreign renderers ignore it. */
export const WB_NAMESPACE = 'urn:md-notepad:whiteboard';
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const SCENE_SCHEMA = 1;

export const DEFAULT_BOARD_WIDTH = 1600;
export const DEFAULT_BOARD_HEIGHT = 1000;
export const DEFAULT_BACKGROUND = '#ffffff';

/** A `name="value"` pair we don't own, re-emitted after the ones we do. */
export interface SceneAttr {
  readonly name: string;
  readonly value: string;
}

/* ------------------------------- elements -------------------------------- */

/** Freehand ink. The pen tool and the scan tracer both emit exactly this. */
export interface StrokeElement {
  readonly kind: 'stroke';
  /** `wb:id`, present only inside scan layers (drawn strokes stay id-free). */
  readonly id: string | null;
  readonly tool: 'pen' | 'highlighter';
  /** Path data, already in scene coordinates. */
  readonly d: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number | null;
  /**
   * `wb:widths` — per-vertex half-widths from a scan, kept for a future
   * variable-width brush. v1 renders constant width and never reads this.
   */
  readonly widths: string | null;
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';

/**
 * A primitive shape. Geometry is BAKED into the element's own coordinates —
 * there are no stacked transforms anywhere in the format, which is what keeps
 * hit-testing, resizing and foreign-renderer fidelity all trivial.
 *
 * `geom` keys by shape: rect → x/y/width/height, ellipse → cx/cy/rx/ry,
 * line and arrow → x1/y1/x2/y2.
 */
export interface ShapeElement {
  readonly kind: 'shape';
  readonly id: string | null;
  readonly shape: ShapeKind;
  readonly geom: Readonly<Record<string, number>>;
  readonly stroke: string;
  readonly strokeWidth: number;
  /** `'none'` or a color. */
  readonly fill: string;
  readonly opacity: number | null;
}

export interface TextElement {
  readonly kind: 'text';
  readonly id: string | null;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  /**
   * A CSS font stack, or null to inherit the renderer's default. A STACK
   * rather than a single face on purpose: the file has to render in a plain
   * browser on someone else's machine, where the exact font may not exist.
   */
  readonly fontFamily: string | null;
  readonly fill: string;
  /** One entry per rendered line (serialized as `<tspan>`s). */
  readonly lines: readonly string[];
}

/** A raster image: a scan's "insert as photo" fallback, or a pasted picture. */
export interface ImageElement {
  readonly kind: 'image';
  readonly id: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Always a `data:` URL — the file must stay self-contained. */
  readonly href: string;
  readonly opacity: number | null;
}

/**
 * Content we recognize but do not model: foreign SVG, a scan layer's hidden OCR
 * `<text>` group, an element from a future schema. Held as its original source
 * and re-emitted unchanged; invisible to every tool.
 */
export interface RawElement {
  readonly kind: 'raw';
  readonly xml: string;
}

export type SceneElement = StrokeElement | ShapeElement | TextElement | ImageElement | RawElement;

/* -------------------------------- layers --------------------------------- */

/**
 * 'draw'    — an ordinary layer the tools own.
 * 'scan'    — a photo→SVG import; ordinary editable strokes plus OCR metadata.
 * 'foreign' — content from a non-whiteboard SVG. Rendered live, listed as
 *             "Imported", locked, re-emitted byte-for-byte.
 */
export type LayerKind = 'draw' | 'scan' | 'foreign';

export interface Layer {
  /** Short opaque id; the `wb:layer` attribute and the panel's identity. */
  readonly id: string;
  readonly name: string;
  /** Serialized as `display="none"` — standard SVG, so foreign renderers obey. */
  readonly visible: boolean;
  readonly locked: boolean;
  readonly kind: LayerKind;
  readonly elements: readonly SceneElement[];
  /** Attributes on the `<g>` we don't own, preserved in source order. */
  readonly extras: readonly SceneAttr[];
}

/* --------------------------------- doc ----------------------------------- */

export interface SceneDoc {
  readonly schema: typeof SCENE_SCHEMA;
  readonly width: number;
  readonly height: number;
  /**
   * `[minX, minY, width, height]`. For an INFINITE board (`background: null`)
   * the serializer refits this to the content on every save; a page board
   * keeps it fixed (the page IS the board).
   */
  readonly viewBox: readonly [number, number, number, number];
  /** The page colour, or null for an infinite board with no page rect. */
  readonly background: string | null;
  /** Root `<svg>` attributes we don't own (xmlns:inkscape, class, …). */
  readonly rootExtras: readonly SceneAttr[];
  /** Verbatim top-level non-layer nodes (`<defs>`, `<style>`, comments). */
  readonly prelude: readonly string[];
  readonly layers: readonly Layer[];
  /**
   * Everything in the `wb:doc` metadata JSON that isn't a first-class field
   * above (`ocr`, `view`, future keys). Round-tripped untouched.
   */
  readonly meta: Readonly<Record<string, unknown>>;
}

/* ------------------------------- constructors ----------------------------- */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * A short layer id. Pure by injection: callers pass the randomness so tests
 * (and the deterministic serializer goldens) stay reproducible.
 */
export function makeLayerId(random: () => number = Math.random): string {
  let out = '';
  for (let n = 0; n < 4; n++) {
    out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? 'a';
  }
  return out;
}

/** A layer id not already used in `doc`. */
export function freshLayerId(doc: SceneDoc, random: () => number = Math.random): string {
  const used = new Set(doc.layers.map((l) => l.id));
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = makeLayerId(random);
    if (!used.has(id)) {
      return id;
    }
  }
  // Astronomically unlikely; still never return a duplicate.
  return `l${used.size + 1}`;
}

export function createLayer(init: Partial<Layer> & { id: string }): Layer {
  return {
    id: init.id,
    name: init.name ?? 'Layer 1',
    visible: init.visible ?? true,
    locked: init.locked ?? false,
    kind: init.kind ?? 'draw',
    elements: init.elements ?? [],
    extras: init.extras ?? [],
  };
}

/**
 * A blank board — the skeleton "New whiteboard" writes to disk. INFINITE by
 * default (`background: null`, no page rect): the serializer fits the viewBox
 * to the content on every save, and the surface colour comes from the palette
 * block's `svg.wb-board{background:…}` rule instead of a rect. Passing a
 * background colour creates a fixed page (`setBackground` toggles it later).
 */
export function createScene(init: Partial<SceneDoc> = {}): SceneDoc {
  const width = init.width ?? DEFAULT_BOARD_WIDTH;
  const height = init.height ?? DEFAULT_BOARD_HEIGHT;
  return {
    schema: SCENE_SCHEMA,
    width,
    height,
    viewBox: init.viewBox ?? [0, 0, width, height],
    background: init.background !== undefined ? init.background : null,
    rootExtras: init.rootExtras ?? [],
    prelude: init.prelude ?? [],
    layers: init.layers ?? [createLayer({ id: 'a1B2', name: 'Layer 1' })],
    meta: init.meta ?? {},
  };
}

/* --------------------------------- queries -------------------------------- */

/** Elements the tools may touch: modeled elements on unlocked, visible layers. */
export function editableLayers(doc: SceneDoc): Layer[] {
  return doc.layers.filter((l) => l.visible && !l.locked && l.kind !== 'foreign');
}

export function layerById(doc: SceneDoc, id: string): Layer | undefined {
  return doc.layers.find((l) => l.id === id);
}

/** Total modeled (non-raw) element count — the status readout and size guard. */
export function elementCount(doc: SceneDoc): number {
  let count = 0;
  for (const layer of doc.layers) {
    for (const element of layer.elements) {
      if (element.kind !== 'raw') {
        count++;
      }
    }
  }
  return count;
}
