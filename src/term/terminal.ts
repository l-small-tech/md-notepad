/**
 * The engine's public face — the API the rest of the app programs against:
 *
 *   const term = new Terminal({ cols, rows });
 *   term.onData((bytes) => pty.write(bytes));   // query responses
 *   term.write(chunkFromPty);
 *   term.resize(cols, rows);
 *
 * Everything else (grid access, modes, scrollback view) is read-only state
 * for the renderer.
 */

import { Parser } from './parser';
import {
  Screen,
  type CursorStyle,
  type Hyperlink,
  type ModeState,
  type ScreenEvents,
  type ShellMark,
} from './screen';
import type { Row } from './row';

export interface TerminalOptions {
  cols: number;
  rows: number;
  /** Retained history lines (default 10 000). */
  scrollback?: number;
}

export interface TerminalEventHandlers {
  title?: (title: string) => void;
  bell?: () => void;
  /** OSC 52 clipboard write (base64 payload). Gate on a setting before using. */
  clipboard?: (base64: string) => void;
  /** OSC 7 — cwd as a file:// URL. */
  cwd?: (url: string) => void;
  cursorStyle?: (style: CursorStyle, blink: boolean) => void;
  /** OSC 133 shell-integration mark. */
  mark?: (mark: ShellMark) => void;
}

const encoder = new TextEncoder();

export class Terminal {
  private screen: Screen;
  private parser: Parser;
  private dataListeners: ((bytes: Uint8Array) => void)[] = [];
  private handlers: TerminalEventHandlers = {};

  constructor(options: TerminalOptions) {
    const events: ScreenEvents = {
      onResponse: (data) => {
        const bytes = encoder.encode(data);
        for (const listener of this.dataListeners) listener(bytes);
      },
      onTitle: (title) => this.handlers.title?.(title),
      onBell: () => this.handlers.bell?.(),
      onClipboard: (payload) => this.handlers.clipboard?.(payload),
      onCwd: (url) => this.handlers.cwd?.(url),
      onCursorStyle: (style, blink) => this.handlers.cursorStyle?.(style, blink),
      onMark: (mark) => this.handlers.mark?.(mark),
    };
    this.screen = new Screen(options.cols, options.rows, events, options.scrollback);
    this.parser = new Parser(this.screen);
  }

  // ---------------------------------------------------------------- writing

  /** Feed application output. Chunks may split anywhere, mid-sequence included. */
  write(data: Uint8Array | string): void {
    this.parser.parse(typeof data === 'string' ? encoder.encode(data) : data);
  }

  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
  }

  /** Full reset (RIS), as if freshly opened. */
  reset(): void {
    this.parser.reset();
    this.screen.reset();
  }

  // ----------------------------------------------------------------- events

  /** Bytes the terminal produces for the application (query responses). */
  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.push(listener);
    return () => {
      this.dataListeners = this.dataListeners.filter((l) => l !== listener);
    };
  }

  /** Replace the terminal event handlers (title, bell, clipboard, …). */
  setHandlers(handlers: TerminalEventHandlers): void {
    this.handlers = handlers;
  }

  // ------------------------------------------------------------- read state

  get cols(): number {
    return this.screen.cols;
  }

  get rows(): number {
    return this.screen.rows;
  }

  get cursor(): { x: number; y: number; visible: boolean } {
    return {
      x: this.screen.cursorX,
      y: this.screen.cursorY,
      visible: this.screen.cursorVisible,
    };
  }

  get title(): string {
    return this.screen.title;
  }

  modes(): ModeState {
    return this.screen.modes();
  }

  /**
   * True while the application holds the alternate screen (DEC 47/1047/1049) —
   * a full-screen program such as an editor or an agent TUI is running, and
   * whatever is typed goes to it rather than to a shell prompt.
   */
  get altScreen(): boolean {
    return this.screen.modes().altScreen;
  }

  /** Grid row `y` (0 = top of the live screen). */
  row(y: number): Row {
    return this.screen.row(y);
  }

  /** Row shown on viewport line `y`, honoring the scrollback offset. */
  viewportRow(y: number): Row {
    return this.screen.viewportRow(y);
  }

  get scrollbackLength(): number {
    return this.screen.scrollback.length;
  }

  get viewportOffset(): number {
    return this.screen.viewportOffset;
  }

  scrollViewport(delta: number): void {
    this.screen.scrollViewport(delta);
  }

  /** Absolute viewport offset in lines back from the live screen (clamped). */
  setViewportOffset(offset: number): void {
    this.screen.setViewportOffset(offset);
  }

  scrollToBottom(): void {
    this.screen.scrollToBottom();
  }

  /** Drop retained history (the "clear scrollback" action). */
  clearScrollback(): void {
    this.screen.clearScrollback();
  }

  /** Retained history size (the scrollback setting), applied live. */
  setScrollbackLimit(lines: number): void {
    this.screen.setScrollbackLimit(lines);
  }

  /**
   * Absolute line number of viewport row 0. Absolute numbering starts at the
   * first line ever written and never restarts, so a selection or a mark keeps
   * pointing at its text while output scrolls past (a line evicted from
   * scrollback simply stops resolving).
   */
  get topLine(): number {
    return this.screen.historyBase - this.screen.viewportOffset;
  }

  /** Row at an absolute line number, or null when it is no longer retained. */
  bufferRow(line: number): Row | null {
    const fromGrid = line - this.screen.historyBase;
    if (fromGrid >= 0) return fromGrid < this.screen.rows ? this.screen.row(fromGrid) : null;
    return this.screen.scrollback.get(this.screen.scrollback.length + fromGrid) ?? null;
  }

  /** OSC 8 hyperlink lookup for a cell's extended `linkId`. */
  hyperlink(id: number): Hyperlink | null {
    return this.screen.hyperlink(id);
  }

  /** Effective RGB (0xRRGGBB) for a 256-palette index, honoring OSC 4. */
  paletteColor(index: number): number {
    return this.screen.paletteColorRgb(index);
  }

  /** The OSC 4 override for a palette index, or null when the theme's stands. */
  paletteOverride(index: number): number | null {
    return this.screen.paletteOverride(index);
  }

  /** Live default colors — the theme's, unless the application moved them. */
  defaultColors(): { foreground: number; background: number; cursor: number } {
    return {
      foreground: this.screen.foregroundColor,
      background: this.screen.backgroundColor,
      cursor: this.screen.cursorColor,
    };
  }

  /** Seed OSC 10/11/12 defaults from the theme (also what queries report). */
  setDefaultColors(colors: { foreground?: number; background?: number; cursor?: number }): void {
    if (colors.foreground !== undefined) this.screen.foregroundColor = colors.foreground;
    if (colors.background !== undefined) this.screen.backgroundColor = colors.background;
    if (colors.cursor !== undefined) this.screen.cursorColor = colors.cursor;
    this.screen.markAllDirty();
  }

  get marks(): readonly ShellMark[] {
    return this.screen.marks;
  }

  // ------------------------------------------------------------ dirty/serialize

  /** Dirty viewport rows since the last call; `all` forces a full repaint. */
  takeDirty(): { all: boolean; rows: number[] } {
    return this.screen.takeDirty();
  }

  /** True while the application holds a synchronized-output batch (DEC 2026). */
  get synchronized(): boolean {
    return this.screen.synchronizedOutput;
  }

  /**
   * Drop a synchronized-output batch the application never closed.
   *
   * `CSI ? 2026 h` with no matching `l` — a crashed program, a killed pty, a
   * frame that was still being written when the shell died — would otherwise
   * hold the surface at its last painted state for good. The renderer's
   * watchdog calls this after `SYNC_TIMEOUT_MS` and paints whatever the
   * engine has; a later `l` is simply a no-op.
   */
  abortSynchronizedOutput(): void {
    this.screen.synchronizedOutput = false;
  }

  /** Screen text, one string per row, trailing blanks trimmed. */
  serialize(): string[] {
    return this.screen.screenText();
  }

  /** Text of one history line (0 = oldest retained). */
  scrollbackLine(index: number): string | null {
    return this.screen.scrollback.get(index)?.text() ?? null;
  }
}
