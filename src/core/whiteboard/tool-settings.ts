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
