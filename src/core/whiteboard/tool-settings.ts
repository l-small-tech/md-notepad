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

export type DrawTool = 'pen' | 'highlighter' | 'eraser' | ShapeKind;

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
  '#d02f2f',
  '#e07b00',
  '#c9a400',
  '#1f9d55',
  '#0f8f8f',
  '#1f6fd0',
  '#8a3fd1',
];

/**
 * Dark-scheme variants of the eight slots, index-aligned with {@link PALETTE}:
 * near-black flips to near-white, chromatic slots are lifted toward a tone
 * legible on a dark board. These are the DEFAULTS the serializer bakes into a
 * file's palette `<style>` block and base.css declares as `--wb-c0…c7`; a theme
 * JSON's `whiteboard` section may override them per scheme.
 */
export const PALETTE_DARK: readonly string[] = [
  '#e6e6e6',
  '#ef6363',
  '#f09b3c',
  '#d9bc3f',
  '#43c17c',
  '#3ab5b5',
  '#62a0ef',
  '#b07ce8',
];

/** Dark-scheme board background (`--wb-bg`); light is the canonical #ffffff. */
export const BOARD_BACKGROUND_DARK = '#1e1e1e';

/**
 * The palette slot a colour belongs to, or -1 for a custom hex. Exact string
 * match on purpose: a custom colour — even one letter-case away from a slot —
 * is an explicit opt-out of theming and stays literal in every scheme.
 */
export function paletteSlot(color: string): number {
  return PALETTE.indexOf(color);
}

/** Nib sizes, in scene units, offered by the ribbon. */
export const STROKE_WIDTHS: readonly number[] = [1.5, 3, 6, 12];
export const DEFAULT_STROKE_WIDTH = 3;
export const DEFAULT_COLOR = PALETTE[0]!;

/** The highlighter is a fat, translucent pen — same element, different attrs. */
export const HIGHLIGHTER_WIDTH_FACTOR = 4;
export const HIGHLIGHTER_OPACITY = 0.35;

/** Eraser reach in SCREEN pixels; the adapter converts to scene units. */
export const ERASER_RADIUS = 6;

export interface ToolSettings {
  readonly tool: DrawTool;
  readonly color: string;
  readonly width: number;
}
