/**
 * The tool vocabulary: which tools exist, the palette, the nib sizes.
 *
 * A LEAF module on purpose — it imports nothing but a type. The ribbon (which
 * is in the eager entry bundle) needs the palette to draw its swatches, and if
 * that import reached `tools.ts` it would pull smoothing, serialization and the
 * XML reader into the startup chunk, quietly undoing invariant I8's promise
 * that a markdown-only session never downloads the whiteboard. The element
 * CONSTRUCTORS live next door in `tools.ts`, which does the lazy-loaded work.
 */

import type { ShapeKind } from './scene';

export type DrawTool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'text' | ShapeKind;

export const SHAPE_TOOLS: readonly ShapeKind[] = ['rect', 'ellipse', 'line', 'arrow'];

export function isShapeTool(tool: DrawTool): tool is ShapeKind {
  return (SHAPE_TOOLS as readonly string[]).includes(tool);
}

/**
 * The marker palette. Deliberately the same eight colours the scan pipeline
 * snaps to (phase 5, S4), so drawn and scanned ink are indistinguishable and a
 * board stays themeable.
 */
export const PALETTE: readonly string[] = [
  '#1a1a1a',
  '#1f9d55',
  '#0f8f8f',
  '#1f6fd0',
  '#8a3fd1',
  '#d02f2f',
  '#e07b00',
  '#c9a400',
];

/**
 * Dark-scheme variants of the eight slots, index-aligned with {@link PALETTE}:
 * near-black flips to near-white, chromatic slots are lifted toward a tone
 * legible on a dark board. These are the DEFAULTS the serializer bakes into a
 * file's palette `<style>` block — the dark-scheme fallback a foreign renderer
 * sees. IN-APP, base.css derives `--wb-c0…c7` from the current theme's palette
 * vars instead, and a theme JSON's `whiteboard` section may pin exact values.
 */
export const PALETTE_DARK: readonly string[] = [
  '#e6e6e6',
  '#43c17c',
  '#3ab5b5',
  '#62a0ef',
  '#b07ce8',
  '#ef6363',
  '#f09b3c',
  '#d9bc3f',
];

/** Dark-scheme board background (`--wb-bg`); light is the canonical #ffffff. */
export const BOARD_BACKGROUND_DARK = '#1e1e1e';

/**
 * The STATIC palette: standard named SVG colours that render identically in
 * every scheme. None of them equals a {@link PALETTE} hex, so the serializer's
 * derived-class rule never tags them — a static stroke is literal by
 * construction, no format machinery involved. Index-aligned with PALETTE so
 * switching palette kinds carries the selection across by slot.
 */
export const STATIC_PALETTE: readonly string[] = [
  'black',
  'green',
  'teal',
  'blue',
  'purple',
  'red',
  'orange',
  'gold',
];

/**
 * Ribbon labels for the themed slots. IN-APP the slots render through the
 * `--wb-*` vars, which base.css derives from the current theme's palette
 * (ink/alert/accent blends) — so a hue name would lie; these describe the
 * slot's ROLE instead. The {@link PALETTE} hexes above remain what a saved
 * file falls back to in a foreign, CSS-less renderer.
 */
export const THEMED_SLOT_NAMES: readonly string[] = [
  'Ink',
  'Accent',
  'Deep accent',
  'Soft accent',
  'Pencil',
  'Alert',
  'Warm',
  'Deep warm',
];

/** Which swatch row the ribbon shows: theme-following slots or fixed colours. */
export type PaletteKind = 'themed' | 'static';

/**
 * The palette slot a colour belongs to, or -1 for a custom hex. Exact string
 * match on purpose: a custom colour — even one letter-case away from a slot —
 * is an explicit opt-out of theming and stays literal in every scheme.
 */
export function paletteSlot(color: string): number {
  return PALETTE.indexOf(color);
}

/**
 * Nib sizes, in scene units, offered by the ribbon. Scaled against the type
 * sizes below: the default nib next to the default 24-unit type should read
 * like a pen next to handwriting, not a marker next to fine print.
 */
export const STROKE_WIDTHS: readonly number[] = [1, 2, 4, 8];
export const DEFAULT_STROKE_WIDTH = 2;
export const DEFAULT_COLOR = PALETTE[0]!;

/** The highlighter is a fat, translucent pen — same element, different attrs. */
export const HIGHLIGHTER_WIDTH_FACTOR = 4;
export const HIGHLIGHTER_OPACITY = 0.35;

/** Eraser reach in SCREEN pixels; the adapter converts to scene units. */
export const ERASER_RADIUS = 6;

/**
 * Type sizes the text tool offers, in scene units — the same thing
 * `font-size` means in the saved file.
 */
export const TEXT_SIZES: readonly number[] = [12, 16, 20, 24, 32, 48, 64, 96];
export const DEFAULT_FONT_SIZE = 24;

/**
 * How far the text tool must be dragged, in SCREEN pixels, before the gesture
 * counts as "I am drawing a box" rather than "I am clicking here". Below it the
 * text auto-sizes to what gets typed, which is what a tap should do.
 */
export const MIN_TEXT_BOX_DRAG = 16;

/** A named font choice. `stack` is what lands in the file's `font-family`. */
export interface FontOption {
  readonly label: string;
  readonly stack: string;
}

/**
 * The font menu. Every entry is a STACK ending in a generic family, never a
 * single face: the whole premise is that the `.svg` renders on someone else's
 * machine — in a browser, in the markdown preview, in an export — where
 * "Segoe Print" may simply not exist. The generic at the end is the guarantee
 * that something reasonable is always drawn.
 */
export const FONT_FAMILIES: readonly FontOption[] = [
  { label: 'Sans', stack: "'Segoe UI', Arial, Helvetica, sans-serif" },
  { label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Mono', stack: "Consolas, 'Courier New', monospace" },
  { label: 'Marker', stack: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive" },
];

export const DEFAULT_FONT_FAMILY = FONT_FAMILIES[0]!.stack;

/** The menu label for a stack, or null when it is one the user brought. */
export function fontLabelFor(stack: string | null): string | null {
  return FONT_FAMILIES.find((f) => f.stack === stack)?.label ?? null;
}

/**
 * Handle geometry for the selection box, in SCREEN pixels (the adapter divides
 * by the zoom, so handles stay the same size however far you zoom in). The hit
 * radius is deliberately larger than the drawn square: a 7px target is
 * unusable with a finger, and the plan's touch budget is 44px.
 */
export const HANDLE_SIZE = 8;
export const HANDLE_HIT_RADIUS = 14;

/** Smallest a selection box may be resized to, in scene units. */
export const MIN_SELECTION_SIZE = 4;

export interface ToolSettings {
  readonly tool: DrawTool;
  readonly color: string;
  readonly width: number;
  /** Text tool only — the nib size says nothing useful about type. */
  readonly fontSize: number;
  readonly fontFamily: string;
}
