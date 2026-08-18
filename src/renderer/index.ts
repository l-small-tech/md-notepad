/**
 * src/renderer — the terminal surface. Screen model in, pixels out.
 *
 * The public API is `TermView` (mount into an element) plus the pieces a host
 * needs to configure it: a `TerminalTheme`, a `FontSpec`, and the `Selection`
 * type. Everything else — run batching, color resolution, cell metrics — is
 * exported for testing and for the app's own geometry math.
 *
 * No React, no Tauri: the same view mounts into any plain element — a pane, a
 * split, a whole tab.
 */

export { TermView } from './view';
export type { TermViewOptions, HoveredLink } from './view';
export { CanvasRenderer } from './renderer';
export type { RendererOptions, CursorStyle, HoverTarget } from './renderer';
export {
  DEFAULT_THEME,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  resolveTheme,
  cssColor,
  cssColorAlpha,
  blend,
} from './theme';
export type { TerminalTheme, PartialTheme } from './theme';
export { DEFAULT_FONT, computeCellMetrics, fontString, measureFont, sameMetrics } from './metrics';
export type { CellMetrics, FontMeasurement, FontSpec, TextMeasurer } from './metrics';
export { ColorResolver } from './colors';
export type { CellColors, ColorOptions, DefaultColors } from './colors';
export { buildRowRuns } from './runs';
export type { BackgroundRun, RowRuns, RunOptions, TextRun } from './runs';
export {
  expandToWord,
  isEmpty as isSelectionEmpty,
  normalize as normalizeSelection,
  rangeForLine,
  selectionText,
} from './selection';
export type { LineSource, Point, Range, Selection } from './selection';
export { detectUrls, urlAt, urlAtColumn } from './links';
export type { DetectedLink } from './links';
export { TermInput, domClipboard } from './input';
export type { ClipboardAdapter, InputView, TermInputOptions } from './input';
export { encodeKey, keyStateFromModes, modifierParam } from './keys';
export type { KeyEncodeState, KeyInput } from './keys';
export {
  WHEEL_DOWN,
  WHEEL_LEFT,
  WHEEL_RIGHT,
  WHEEL_UP,
  encodeFocus,
  encodeMouse,
  wantsMouse,
} from './mouse';
export type { MouseInput, MouseKind, MouseState } from './mouse';
export {
  PASTE_CHUNK,
  bracketPaste,
  isMultiline,
  pasteChunks,
  preparePaste,
  sanitizePaste,
} from './paste';
