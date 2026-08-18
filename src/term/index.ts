/**
 * src/term — the terminal engine. Pure TypeScript: bytes in, screen state
 * out. The app embeds it through `Terminal`; the renderer reads rows/cells
 * through the types exported here.
 */

export { Terminal } from './terminal';
export type { TerminalOptions, TerminalEventHandlers } from './terminal';
export type {
  CursorStyle,
  Hyperlink,
  ModeState,
  MouseEncoding,
  MouseTracking,
  ShellMark,
} from './screen';
export { DEFAULT_PALETTE } from './screen';
export type { Cell } from './row';
export { Row } from './row';
export {
  ColorMode,
  UnderlineStyle,
  colorMode,
  colorValue,
  BG_EXTENDED,
  BG_STRIKETHROUGH,
  BG_UNDERLINE_MASK,
  BG_UNDERLINE_SHIFT,
  FG_BLINK,
  FG_BOLD,
  FG_DIM,
  FG_INVERSE,
  FG_INVISIBLE,
  FG_ITALIC,
} from './attributes';
export { charWidth } from './charwidth';
