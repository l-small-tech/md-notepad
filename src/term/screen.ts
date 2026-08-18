/**
 * The screen model: consumes parser actions, owns all terminal state.
 *
 * Pure TypeScript — no DOM, no Tauri. Everything observable (grid contents,
 * cursor, modes, scrollback) is exposed as plain state so the renderer reads
 * and the test suite asserts without any environment.
 */

import { AttributeState, MODE_SHIFT, paletteColor, rgbColor } from './attributes';
import { ZWJ, charWidth } from './charwidth';
import type { Params, ParserActions } from './parser';
import { Row } from './row';
import { Scrollback } from './scrollback';

export interface ScreenEvents {
  /** Bytes the terminal sends back to the application (query responses). */
  onResponse?: (data: string) => void;
  onTitle?: (title: string) => void;
  onBell?: () => void;
  /** OSC 52 clipboard write; payload is base64. Gating is the host's job. */
  onClipboard?: (base64: string) => void;
  /** OSC 7 — file:// URL of the shell's cwd. */
  onCwd?: (url: string) => void;
  /** DECSCUSR. */
  onCursorStyle?: (style: CursorStyle, blink: boolean) => void;
  /** OSC 133 shell-integration mark. */
  onMark?: (mark: ShellMark) => void;
}

export type CursorStyle = 'block' | 'underline' | 'bar';

export interface ShellMark {
  /** A=prompt start, B=prompt end, C=command output start, D=command done. */
  kind: string;
  /** Line index counted from the start of retained+evicted history. */
  absoluteLine: number;
  /** Exit code, present on `D;<code>` marks. */
  exitCode?: number;
}

export type MouseTracking = 'none' | 'click' | 'drag' | 'any';
export type MouseEncoding = 'default' | 'utf8' | 'sgr';

/** Modes the input encoder (Phase 4) and renderer need to observe. */
export interface ModeState {
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
  bracketedPaste: boolean;
  synchronizedOutput: boolean;
  mouseTracking: MouseTracking;
  mouseEncoding: MouseEncoding;
  focusReporting: boolean;
  /** xterm modifyOtherKeys level (0 off, 1 without shift-only, 2 with). */
  modifyOtherKeys: number;
  cursorVisible: boolean;
  altScreen: boolean;
  reverseVideo: boolean;
}

interface SavedCursor {
  x: number;
  y: number;
  attrs: AttributeState;
  originMode: boolean;
  pendingWrap: boolean;
  charsets: [string, string];
  activeCharset: number;
}

interface Buffer {
  rows: Row[];
  saved: SavedCursor | null;
}

export interface Hyperlink {
  uri: string;
  /** The `id=` param from OSC 8, used to join multi-cell links. */
  id: string;
}

/** DEC Special Graphics (ESC ( 0) — the line-drawing charset vim/less use. */
// prettier-ignore
const DEC_SPECIAL: Record<number, number> = {
  0x60: 0x25c6, 0x61: 0x2592, 0x62: 0x2409, 0x63: 0x240c, 0x64: 0x240d,
  0x65: 0x240a, 0x66: 0x00b0, 0x67: 0x00b1, 0x68: 0x2424, 0x69: 0x240b,
  0x6a: 0x2518, 0x6b: 0x2510, 0x6c: 0x250c, 0x6d: 0x2514, 0x6e: 0x253c,
  0x6f: 0x23ba, 0x70: 0x23bb, 0x71: 0x2500, 0x72: 0x23bc, 0x73: 0x23bd,
  0x74: 0x251c, 0x75: 0x2524, 0x76: 0x2534, 0x77: 0x252c, 0x78: 0x2502,
  0x79: 0x2264, 0x7a: 0x2265, 0x7b: 0x03c0, 0x7c: 0x2260, 0x7d: 0x00a3,
  0x7e: 0x00b7,
};

const DEFAULT_SCROLLBACK = 10000;

export class Screen implements ParserActions {
  cols: number;
  rows: number;

  cursorX = 0;
  cursorY = 0;
  pendingWrap = false;

  attrs = new AttributeState();

  scrollTop = 0;
  scrollBottom: number;

  // Modes.
  insertMode = false;
  originMode = false;
  autowrap = true;
  cursorVisible = true;
  applicationCursorKeys = false;
  applicationKeypad = false;
  bracketedPaste = false;
  synchronizedOutput = false;
  focusReporting = false;
  reverseVideo = false;
  mouseTracking: MouseTracking = 'none';
  mouseEncoding: MouseEncoding = 'default';
  /**
   * `CSI > 4 ; Ps m` (XTMODKEYS). Applications raise this to disambiguate keys
   * the legacy encoding cannot express (Shift+Enter, Ctrl+;). The keyboard
   * encoder reads it; the engine only remembers it.
   */
  modifyOtherKeys = 0;

  title = '';
  private titleStack: string[] = [];

  /** OSC 10/11/12 colors as 0xRRGGBB; the host seeds these from the theme. */
  foregroundColor = 0xe6e6e6;
  backgroundColor = 0x0b0f14;
  cursorColor = 0xe6e6e6;
  private paletteOverrides = new Map<number, number>();

  readonly scrollback: Scrollback;
  /** Lines ever pushed into history (including evicted) — anchors marks and
   * the renderer's absolute line numbering. */
  historyBase = 0;
  /** How many lines the viewport is scrolled up from the live grid (main screen only). */
  viewportOffset = 0;

  marks: ShellMark[] = [];

  private main: Buffer;
  private alt: Buffer;
  private active: Buffer;
  altScreenActive = false;

  private charsets: [string, string] = ['B', 'B'];
  private activeCharset = 0;

  private tabStops = new Set<number>();

  private lastPrinted = 0;
  private pendingJoin = false;

  private links: Hyperlink[] = [];
  private linkIds = new Map<string, number>();

  private dirtyRows = new Set<number>();
  private allDirty = true;

  constructor(
    cols: number,
    rows: number,
    private events: ScreenEvents = {},
    scrollbackLines: number = DEFAULT_SCROLLBACK,
  ) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.scrollBottom = this.rows - 1;
    this.scrollback = new Scrollback(scrollbackLines);
    this.main = { rows: this.blankRows(this.rows), saved: null };
    this.alt = { rows: this.blankRows(this.rows), saved: null };
    this.active = this.main;
    this.resetTabStops();
  }

  // ------------------------------------------------------------------ views

  /** The live grid of the active buffer (row 0 is the top of the screen). */
  get grid(): Row[] {
    return this.active.rows;
  }

  row(y: number): Row {
    return this.active.rows[y]!;
  }

  /**
   * The row shown on viewport line `y` given the current scroll offset —
   * from scrollback when scrolled up, the live grid otherwise.
   */
  viewportRow(y: number): Row {
    if (this.viewportOffset === 0) return this.row(y);
    const fromScrollback = this.viewportOffset - y;
    if (fromScrollback > 0) {
      return this.scrollback.get(this.scrollback.length - fromScrollback) ?? this.row(0);
    }
    return this.row(y - this.viewportOffset);
  }

  modes(): ModeState {
    return {
      applicationCursorKeys: this.applicationCursorKeys,
      applicationKeypad: this.applicationKeypad,
      bracketedPaste: this.bracketedPaste,
      synchronizedOutput: this.synchronizedOutput,
      mouseTracking: this.mouseTracking,
      mouseEncoding: this.mouseEncoding,
      focusReporting: this.focusReporting,
      modifyOtherKeys: this.modifyOtherKeys,
      cursorVisible: this.cursorVisible,
      altScreen: this.altScreenActive,
      reverseVideo: this.reverseVideo,
    };
  }

  hyperlink(id: number): Hyperlink | null {
    return this.links[id - 1] ?? null;
  }

  /** Screen text, one string per grid row, trailing blanks trimmed. */
  screenText(): string[] {
    return this.active.rows.map((row) => row.text());
  }

  // -------------------------------------------------------------- scrolling

  /**
   * Drop retained history. `historyBase` deliberately keeps counting, so
   * absolute line numbers held by selections and marks never point at
   * different text than they did before.
   */
  clearScrollback(): void {
    this.scrollback.clear();
    this.viewportOffset = 0;
    this.markAllDirty();
  }

  /**
   * Change how much history is retained (the scrollback setting). Shrinking
   * drops the oldest lines, so the viewport is pulled back inside what is left
   * rather than pointing at evicted text.
   */
  setScrollbackLimit(lines: number): void {
    const capacity = Math.max(0, Math.floor(lines));
    if (capacity === this.scrollback.capacity) return;
    this.scrollback.setCapacity(capacity);
    this.viewportOffset = Math.min(this.viewportOffset, this.scrollback.length);
    this.markAllDirty();
  }

  scrollViewport(delta: number): void {
    this.setViewportOffset(this.viewportOffset + delta);
  }

  setViewportOffset(offset: number): void {
    const max = this.altScreenActive ? 0 : this.scrollback.length;
    const next = Math.max(0, Math.min(max, offset));
    if (next !== this.viewportOffset) {
      this.viewportOffset = next;
      this.markAllDirty();
    }
  }

  scrollToBottom(): void {
    this.setViewportOffset(0);
  }

  // ------------------------------------------------------------------ dirty

  markDirty(y: number): void {
    if (!this.allDirty) this.dirtyRows.add(y);
  }

  markAllDirty(): void {
    this.allDirty = true;
    this.dirtyRows.clear();
  }

  /** Return and clear the dirty set. `all` means repaint everything. */
  takeDirty(): { all: boolean; rows: number[] } {
    const result = { all: this.allDirty, rows: this.allDirty ? [] : [...this.dirtyRows] };
    this.allDirty = false;
    this.dirtyRows.clear();
    return result;
  }

  // ----------------------------------------------------------- ParserActions

  print(cp: number): void {
    // Charset translation (DEC Special Graphics for box drawing).
    if (this.charsets[this.activeCharset] === '0' && cp >= 0x60 && cp <= 0x7e) {
      cp = DEC_SPECIAL[cp] ?? cp;
    }

    const width = charWidth(cp);

    if (width === 0 || this.pendingJoin) {
      this.attachToPrevious(cp);
      this.pendingJoin = cp === ZWJ;
      return;
    }
    this.pendingJoin = false;

    if (this.pendingWrap && this.autowrap) {
      this.pendingWrap = false;
      this.cursorX = 0;
      this.linefeed();
      this.row(this.cursorY).wrapped = true;
    }
    this.pendingWrap = false;

    const row = this.row(this.cursorY);

    if (width === 2 && this.cursorX >= this.cols - 1) {
      if (!this.autowrap || this.cols < 2) {
        // No room and no wrapping: the char can't be displayed whole.
        row.eraseCell(this.cols - 1, this.attrs);
        this.markDirty(this.cursorY);
        return;
      }
      row.eraseCell(this.cursorX, this.attrs);
      this.markDirty(this.cursorY);
      this.cursorX = 0;
      this.linefeed();
      this.row(this.cursorY).wrapped = true;
      this.printAt(this.row(this.cursorY), cp, 2);
      return;
    }

    this.printAt(row, cp, width);
  }

  private printAt(row: Row, cp: number, width: 1 | 2): void {
    if (this.insertMode) row.insertCells(this.cursorX, width, this.attrs);

    // Overwriting half of an existing wide char blanks the other half.
    this.clearWideOverlap(row, this.cursorX);
    if (width === 2) this.clearWideOverlap(row, this.cursorX + 1);

    row.setCell(this.cursorX, cp, width, this.attrs);
    if (width === 2) row.setWideSpacer(this.cursorX + 1, this.attrs);
    this.markDirty(this.cursorY);
    this.lastPrinted = cp;

    this.cursorX += width;
    if (this.cursorX >= this.cols) {
      this.cursorX = this.cols - 1;
      if (this.autowrap) this.pendingWrap = true;
    }
  }

  private clearWideOverlap(row: Row, col: number): void {
    if (col < this.cols && row.isWideSpacer(col) && col > 0) {
      row.eraseCell(col - 1, this.attrs);
      row.eraseCell(col, this.attrs);
    } else if (col < this.cols && row.isWideStart(col) && col + 1 < this.cols) {
      row.eraseCell(col + 1, this.attrs);
    }
  }

  /** Combining marks / ZWJ continuations attach to the last printed cell. */
  private attachToPrevious(cp: number): void {
    let y = this.cursorY;
    let x = this.cursorX;
    if (!this.pendingWrap) {
      if (x === 0) {
        if (y === 0 || !this.row(y).wrapped) return; // nothing to attach to
        y -= 1;
        x = this.cols - 1;
      } else {
        x -= 1;
      }
    }
    const row = this.row(y);
    if (row.isWideSpacer(x) && x > 0) x -= 1;
    if (row.codepointAt(x) === 0) return;
    row.appendCombining(x, String.fromCodePoint(cp));
    this.markDirty(y);
  }

  execute(code: number): void {
    switch (code) {
      case 0x07:
        this.events.onBell?.();
        return;
      case 0x08: // BS
        if (this.cursorX > 0) this.cursorX--;
        else if (this.pendingWrap) this.cursorX = this.cols - 1;
        this.pendingWrap = false;
        return;
      case 0x09: // HT
        this.cursorX = this.nextTabStop();
        this.pendingWrap = false;
        return;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this.pendingWrap = false;
        this.linefeed();
        return;
      case 0x0d: // CR
        this.cursorX = 0;
        this.pendingWrap = false;
        return;
      case 0x0e: // SO — invoke G1
        this.activeCharset = 1;
        return;
      case 0x0f: // SI — invoke G0
        this.activeCharset = 0;
        return;
      case 0x84: // IND
        this.index();
        return;
      case 0x85: // NEL
        this.cursorX = 0;
        this.index();
        return;
      case 0x88: // HTS
        this.tabStops.add(this.cursorX);
        return;
      case 0x8d: // RI
        this.reverseIndex();
        return;
      default:
        return; // NUL and friends: ignored
    }
  }

  escDispatch(intermediates: string, final: number): void {
    if (intermediates === '') {
      switch (final) {
        case 0x37: // 7 DECSC
          this.saveCursor();
          return;
        case 0x38: // 8 DECRC
          this.restoreCursor();
          return;
        case 0x44: // D IND
          this.index();
          return;
        case 0x45: // E NEL
          this.cursorX = 0;
          this.index();
          return;
        case 0x48: // H HTS
          this.tabStops.add(this.cursorX);
          return;
        case 0x4d: // M RI
          this.reverseIndex();
          return;
        case 0x3d: // = DECKPAM
          this.applicationKeypad = true;
          return;
        case 0x3e: // > DECKPNM
          this.applicationKeypad = false;
          return;
        case 0x63: // c RIS
          this.reset();
          return;
        default:
          return;
      }
    }
    if (intermediates === '#' && final === 0x38) {
      this.screenAlignment();
      return;
    }
    // Charset designation: ESC ( X → G0, ESC ) X → G1. Others ignored.
    if (intermediates === '(') this.charsets[0] = String.fromCharCode(final);
    else if (intermediates === ')') this.charsets[1] = String.fromCharCode(final);
  }

  csiDispatch(prefix: string, params: Params, intermediates: string, final: number): void {
    const p = (i: number, fallback = 0): number => params[i]?.[0] ?? fallback;
    const p1 = (i: number): number => Math.max(1, p(i));

    if (intermediates === '' && prefix === '') {
      switch (final) {
        case 0x40: // @ ICH
          this.row(this.cursorY).insertCells(this.cursorX, p1(0), this.attrs);
          this.markDirty(this.cursorY);
          this.pendingWrap = false;
          return;
        case 0x41: // A CUU
          this.moveCursor(0, -p1(0));
          return;
        case 0x42: // B CUD
          this.moveCursor(0, p1(0));
          return;
        case 0x43: // C CUF
          this.moveCursor(p1(0), 0);
          return;
        case 0x44: // D CUB
          this.moveCursor(-p1(0), 0);
          return;
        case 0x45: // E CNL
          this.moveCursor(0, p1(0));
          this.cursorX = 0;
          return;
        case 0x46: // F CPL
          this.moveCursor(0, -p1(0));
          this.cursorX = 0;
          return;
        case 0x47: // G CHA
        case 0x60: // ` HPA
          this.cursorX = Math.min(this.cols - 1, p1(0) - 1);
          this.pendingWrap = false;
          return;
        case 0x48: // H CUP
        case 0x66: // f HVP
          this.setCursor(p1(1) - 1, p1(0) - 1);
          return;
        case 0x49: // I CHT
          for (let i = p1(0); i > 0; i--) this.cursorX = this.nextTabStop();
          this.pendingWrap = false;
          return;
        case 0x4a: // J ED
          this.eraseDisplay(p(0));
          return;
        case 0x4b: // K EL
          this.eraseLine(p(0));
          return;
        case 0x4c: // L IL
          this.insertLines(p1(0));
          return;
        case 0x4d: // M DL
          this.deleteLines(p1(0));
          return;
        case 0x50: // P DCH
          this.row(this.cursorY).deleteCells(this.cursorX, p1(0), this.attrs);
          this.markDirty(this.cursorY);
          this.pendingWrap = false;
          return;
        case 0x53: // S SU
          this.scrollUp(p1(0));
          return;
        case 0x54: // T SD
          this.scrollDown(p1(0));
          return;
        case 0x58: // X ECH
          this.row(this.cursorY).eraseRange(
            this.cursorX,
            Math.min(this.cols, this.cursorX + p1(0)),
            this.attrs,
          );
          this.markDirty(this.cursorY);
          this.pendingWrap = false;
          return;
        case 0x5a: // Z CBT
          for (let i = p1(0); i > 0; i--) this.cursorX = this.prevTabStop();
          this.pendingWrap = false;
          return;
        case 0x61: // a HPR
          this.moveCursor(p1(0), 0);
          return;
        case 0x62: // b REP
          if (this.lastPrinted !== 0) {
            for (let i = p1(0); i > 0; i--) this.print(this.lastPrinted);
          }
          return;
        case 0x63: // c DA1
          this.respond('\x1b[?62;22c');
          return;
        case 0x64: // d VPA
          this.setCursor(this.cursorX, p1(0) - 1, true);
          return;
        case 0x65: // e VPR
          this.moveCursor(0, p1(0));
          return;
        case 0x67: // g TBC
          if (p(0) === 3) this.tabStops.clear();
          else this.tabStops.delete(this.cursorX);
          return;
        case 0x68: // h SM
          for (const param of params) this.setAnsiMode(param[0]!, true);
          return;
        case 0x6c: // l RM
          for (const param of params) this.setAnsiMode(param[0]!, false);
          return;
        case 0x6d: // m SGR
          this.sgr(params.length ? params : [[0]]);
          return;
        case 0x6e: // n DSR
          if (p(0) === 5) this.respond('\x1b[0n');
          else if (p(0) === 6) this.reportCursorPosition('');
          return;
        case 0x72: // r DECSTBM
          this.setMargins(p(0), p(1));
          return;
        case 0x73: // s save cursor
          this.saveCursor();
          return;
        case 0x74: // t XTWINOPS — only the title stack is supported
          if (p(0) === 22) {
            if (this.titleStack.length < 10) this.titleStack.push(this.title);
          } else if (p(0) === 23) {
            this.setTitle(this.titleStack.pop() ?? this.title);
          }
          return;
        case 0x75: // u restore cursor
          this.restoreCursor();
          return;
        default:
          return;
      }
    }

    if (prefix === '?') {
      if (intermediates === '' && final === 0x68) {
        for (const param of params) this.setDecMode(param[0]!, true);
        return;
      }
      if (intermediates === '' && final === 0x6c) {
        for (const param of params) this.setDecMode(param[0]!, false);
        return;
      }
      if (intermediates === '' && final === 0x6e && p(0) === 6) {
        this.reportCursorPosition('?');
        return;
      }
      if (intermediates === '$' && final === 0x70) {
        this.reportDecMode(p(0));
        return;
      }
      // ?J / ?K (selective erase) — treated as plain ED/EL.
      if (intermediates === '' && final === 0x4a) return this.eraseDisplay(p(0));
      if (intermediates === '' && final === 0x4b) return this.eraseLine(p(0));
      return;
    }

    if (prefix === '>') {
      if (final === 0x63) {
        // DA2: claim a VT220-class terminal, version 10.
        this.respond('\x1b[>1;10;0c');
      } else if (final === 0x71 && intermediates === '') {
        // XTVERSION
        this.respond('\x1bP>|smooth-terminal 0.1.0\x1b\\');
      } else if (final === 0x6d) {
        // XTMODKEYS: `CSI > 4 ; Ps m`. Only resource 4 (modifyOtherKeys) is
        // tracked; `CSI > 4 m` with no value turns it off, as in xterm.
        if (params.length === 0 || p(0) === 4) {
          this.modifyOtherKeys = params.length > 1 ? Math.max(0, Math.min(2, p(1))) : 0;
        }
      } else if (final === 0x6e) {
        // XTRMMODKEYS — reset the resource to its default (off).
        if (params.length === 0 || p(0) === 4) this.modifyOtherKeys = 0;
      }
      return;
    }

    if (prefix === '' && intermediates === ' ' && final === 0x71) {
      this.cursorStyleReport(p(0));
      return;
    }
    if (prefix === '' && intermediates === '!' && final === 0x70) {
      this.softReset();
      return;
    }
    if (prefix === '' && intermediates === '$' && final === 0x70) {
      // DECRQM for ANSI modes: only IRM (4) is tracked.
      const mode = p(0);
      const value = mode === 4 ? (this.insertMode ? 1 : 2) : 0;
      this.respond(`\x1b[${mode};${value}$y`);
      return;
    }
  }

  oscDispatch(data: string): void {
    const sep = data.indexOf(';');
    const id = Number.parseInt(sep === -1 ? data : data.slice(0, sep), 10);
    const rest = sep === -1 ? '' : data.slice(sep + 1);
    if (Number.isNaN(id)) return;

    switch (id) {
      case 0:
      case 2:
        this.setTitle(rest);
        return;
      case 1:
        return; // icon name — no icon to set
      case 4:
        this.oscPalette(rest);
        return;
      case 104:
        if (rest === '') this.paletteOverrides.clear();
        else for (const part of rest.split(';')) this.paletteOverrides.delete(Number(part));
        this.markAllDirty();
        return;
      case 7:
        this.events.onCwd?.(rest);
        return;
      case 8:
        this.oscHyperlink(rest);
        return;
      case 10:
      case 11:
      case 12:
        this.oscDynamicColor(id, rest);
        return;
      case 110:
      case 111:
      case 112:
        // Resets restore the host-seeded defaults; the host re-seeds on theme
        // change anyway, so nothing to do beyond a repaint.
        this.markAllDirty();
        return;
      case 52:
        this.oscClipboard(rest);
        return;
      case 133:
        this.oscShellMark(rest);
        return;
      default:
        return;
    }
  }

  dcsDispatch(
    _prefix: string,
    _params: Params,
    _intermediates: string,
    _final: number,
    _data: string,
  ): void {
    // No DCS controls implemented (DECRQSS et al. deliberately unanswered).
  }

  // -------------------------------------------------------------- movement

  private moveCursor(dx: number, dy: number): void {
    this.pendingWrap = false;
    this.cursorX = Math.max(0, Math.min(this.cols - 1, this.cursorX + dx));
    if (dy !== 0) {
      // Vertical movement stops at the scroll margins when the cursor starts
      // inside them (xterm behavior).
      const top = this.cursorY >= this.scrollTop ? this.scrollTop : 0;
      const bottom = this.cursorY <= this.scrollBottom ? this.scrollBottom : this.rows - 1;
      this.cursorY = Math.max(top, Math.min(bottom, this.cursorY + dy));
    }
  }

  /** CUP/VPA. In origin mode coordinates are relative to the scroll region. */
  private setCursor(x: number, y: number, keepX = false): void {
    this.pendingWrap = false;
    if (this.originMode) {
      y += this.scrollTop;
      this.cursorY = Math.max(this.scrollTop, Math.min(this.scrollBottom, y));
    } else {
      this.cursorY = Math.max(0, Math.min(this.rows - 1, y));
    }
    if (!keepX) this.cursorX = Math.max(0, Math.min(this.cols - 1, x));
  }

  private linefeed(): void {
    if (this.cursorY === this.scrollBottom) this.scrollUp(1);
    else if (this.cursorY < this.rows - 1) this.cursorY++;
  }

  private index(): void {
    this.pendingWrap = false;
    this.linefeed();
  }

  private reverseIndex(): void {
    this.pendingWrap = false;
    if (this.cursorY === this.scrollTop) this.scrollDown(1);
    else if (this.cursorY > 0) this.cursorY--;
  }

  private nextTabStop(): number {
    for (let x = this.cursorX + 1; x < this.cols; x++) {
      if (this.tabStops.has(x)) return x;
    }
    return this.cols - 1;
  }

  private prevTabStop(): number {
    for (let x = this.cursorX - 1; x > 0; x--) {
      if (this.tabStops.has(x)) return x;
    }
    return 0;
  }

  private resetTabStops(): void {
    this.tabStops.clear();
    for (let x = 8; x < this.cols; x += 8) this.tabStops.add(x);
  }

  // ------------------------------------------------------------- scrolling

  /** Scroll the region up `n` lines; top lines go to scrollback when eligible. */
  scrollUp(n: number, allowHistory = true): void {
    const region = this.active.rows;
    const keepHistory =
      allowHistory &&
      !this.altScreenActive &&
      this.scrollTop === 0 &&
      this.scrollBottom === this.rows - 1;
    n = Math.min(n, this.scrollBottom - this.scrollTop + 1);
    for (let i = 0; i < n; i++) {
      const removed = region.splice(this.scrollTop, 1)[0]!;
      if (keepHistory) {
        this.scrollback.push(removed);
        this.historyBase++;
      }
      const blank = new Row(this.cols);
      if (this.attrs.bg !== 0) blank.eraseRange(0, this.cols, this.attrs);
      region.splice(this.scrollBottom, 0, blank);
    }
    // Keep the viewport anchored on the same content while scrolled up.
    if (keepHistory && this.viewportOffset > 0) {
      this.viewportOffset = Math.min(this.viewportOffset + n, this.scrollback.length);
    }
    this.markAllDirty();
  }

  scrollDown(n: number): void {
    const region = this.active.rows;
    n = Math.min(n, this.scrollBottom - this.scrollTop + 1);
    for (let i = 0; i < n; i++) {
      region.splice(this.scrollBottom, 1);
      const blank = new Row(this.cols);
      if (this.attrs.bg !== 0) blank.eraseRange(0, this.cols, this.attrs);
      region.splice(this.scrollTop, 0, blank);
    }
    this.markAllDirty();
  }

  private insertLines(n: number): void {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;
    const savedTop = this.scrollTop;
    this.scrollTop = this.cursorY;
    this.scrollDown(n);
    this.scrollTop = savedTop;
    this.cursorX = 0;
    this.pendingWrap = false;
  }

  private deleteLines(n: number): void {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;
    const savedTop = this.scrollTop;
    this.scrollTop = this.cursorY;
    // Deleted lines are destroyed, never archived: with the cursor at row 0
    // and default margins the temporary scrollTop would otherwise make
    // scrollUp's keepHistory test pass and leak the line into scrollback.
    this.scrollUp(n, false);
    this.scrollTop = savedTop;
    this.cursorX = 0;
    this.pendingWrap = false;
  }

  private setMargins(top: number, bottom: number): void {
    top = Math.max(1, top || 1) - 1;
    bottom = (bottom || this.rows) - 1;
    bottom = Math.min(this.rows - 1, bottom);
    if (top >= bottom) return;
    this.scrollTop = top;
    this.scrollBottom = bottom;
    this.setCursor(0, 0);
  }

  // --------------------------------------------------------------- erasing

  private eraseDisplay(mode: number): void {
    this.pendingWrap = false;
    switch (mode) {
      case 0:
        this.row(this.cursorY).eraseRange(this.cursorX, this.cols, this.attrs);
        for (let y = this.cursorY + 1; y < this.rows; y++) {
          this.row(y).eraseRange(0, this.cols, this.attrs);
          this.row(y).wrapped = false;
        }
        break;
      case 1:
        for (let y = 0; y < this.cursorY; y++) {
          this.row(y).eraseRange(0, this.cols, this.attrs);
          this.row(y).wrapped = false;
        }
        this.row(this.cursorY).eraseRange(0, this.cursorX + 1, this.attrs);
        break;
      case 2:
        for (let y = 0; y < this.rows; y++) {
          this.row(y).eraseRange(0, this.cols, this.attrs);
          this.row(y).wrapped = false;
        }
        break;
      case 3:
        this.scrollback.clear();
        this.viewportOffset = 0;
        break;
      default:
        return;
    }
    this.markAllDirty();
  }

  private eraseLine(mode: number): void {
    this.pendingWrap = false;
    const row = this.row(this.cursorY);
    if (mode === 0) row.eraseRange(this.cursorX, this.cols, this.attrs);
    else if (mode === 1) row.eraseRange(0, this.cursorX + 1, this.attrs);
    else if (mode === 2) row.eraseRange(0, this.cols, this.attrs);
    this.markDirty(this.cursorY);
  }

  private screenAlignment(): void {
    // DECALN: E-fill, reset margins, home.
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    const plain = new AttributeState();
    for (let y = 0; y < this.rows; y++) {
      const row = this.row(y);
      for (let x = 0; x < this.cols; x++) row.setCell(x, 0x45, 1, plain);
    }
    this.cursorX = 0;
    this.cursorY = 0;
    this.pendingWrap = false;
    this.markAllDirty();
  }

  // ----------------------------------------------------------------- modes

  private setAnsiMode(mode: number, set: boolean): void {
    if (mode === 4) this.insertMode = set;
  }

  private setDecMode(mode: number, set: boolean): void {
    switch (mode) {
      case 1:
        this.applicationCursorKeys = set;
        return;
      case 5:
        if (this.reverseVideo !== set) {
          this.reverseVideo = set;
          this.markAllDirty();
        }
        return;
      case 6:
        this.originMode = set;
        this.setCursor(0, 0);
        return;
      case 7:
        this.autowrap = set;
        if (!set) this.pendingWrap = false;
        return;
      case 25:
        this.cursorVisible = set;
        this.markDirty(this.cursorY);
        return;
      case 1000:
        this.mouseTracking = set ? 'click' : 'none';
        return;
      case 1002:
        this.mouseTracking = set ? 'drag' : 'none';
        return;
      case 1003:
        this.mouseTracking = set ? 'any' : 'none';
        return;
      case 1004:
        this.focusReporting = set;
        return;
      case 1005:
        this.mouseEncoding = set ? 'utf8' : 'default';
        return;
      case 1006:
        this.mouseEncoding = set ? 'sgr' : 'default';
        return;
      case 47:
        if (set) this.enterAltScreen(false);
        else this.leaveAltScreen(false);
        return;
      case 1047:
        if (set) this.enterAltScreen(true);
        else this.leaveAltScreen(false);
        return;
      case 1048:
        if (set) this.saveCursor();
        else this.restoreCursor();
        return;
      case 1049:
        if (set) {
          this.saveCursor();
          this.enterAltScreen(true);
        } else {
          this.leaveAltScreen(true);
        }
        return;
      case 2004:
        this.bracketedPaste = set;
        return;
      case 2026:
        this.synchronizedOutput = set;
        if (!set) this.markAllDirty();
        return;
      default:
        return;
    }
  }

  private reportDecMode(mode: number): void {
    const known: Record<number, boolean> = {
      1: this.applicationCursorKeys,
      5: this.reverseVideo,
      6: this.originMode,
      7: this.autowrap,
      25: this.cursorVisible,
      47: this.altScreenActive,
      1000: this.mouseTracking === 'click',
      1002: this.mouseTracking === 'drag',
      1003: this.mouseTracking === 'any',
      1004: this.focusReporting,
      1005: this.mouseEncoding === 'utf8',
      1006: this.mouseEncoding === 'sgr',
      1047: this.altScreenActive,
      1048: true,
      1049: this.altScreenActive,
      2004: this.bracketedPaste,
      2026: this.synchronizedOutput,
    };
    const value = mode in known ? (known[mode] ? 1 : 2) : 0;
    this.respond(`\x1b[?${mode};${value}$y`);
  }

  private enterAltScreen(clear: boolean): void {
    if (this.altScreenActive) return;
    this.altScreenActive = true;
    this.active = this.alt;
    this.viewportOffset = 0;
    if (clear) {
      const plain = new AttributeState();
      for (const row of this.alt.rows) {
        row.eraseRange(0, this.cols, plain);
        row.wrapped = false;
      }
    }
    this.markAllDirty();
  }

  private leaveAltScreen(restoreCursor: boolean): void {
    if (!this.altScreenActive) return;
    this.altScreenActive = false;
    this.active = this.main;
    if (restoreCursor) this.restoreCursor();
    this.markAllDirty();
  }

  private saveCursor(): void {
    this.active.saved = {
      x: this.cursorX,
      y: this.cursorY,
      attrs: this.attrs.clone(),
      originMode: this.originMode,
      pendingWrap: this.pendingWrap,
      charsets: [...this.charsets],
      activeCharset: this.activeCharset,
    };
  }

  private restoreCursor(): void {
    const saved = this.active.saved;
    if (!saved) {
      this.setCursor(0, 0);
      this.attrs.reset();
      return;
    }
    this.cursorX = Math.min(saved.x, this.cols - 1);
    this.cursorY = Math.min(saved.y, this.rows - 1);
    this.attrs.copyFrom(saved.attrs);
    this.originMode = saved.originMode;
    this.pendingWrap = saved.pendingWrap;
    this.charsets = [...saved.charsets];
    this.activeCharset = saved.activeCharset;
  }

  private softReset(): void {
    this.insertMode = false;
    this.originMode = false;
    this.autowrap = true;
    this.cursorVisible = true;
    this.applicationCursorKeys = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.attrs.reset();
    this.attrs.linkId = 0;
    this.charsets = ['B', 'B'];
    this.activeCharset = 0;
    this.pendingWrap = false;
  }

  reset(): void {
    this.softReset();
    this.applicationKeypad = false;
    this.bracketedPaste = false;
    this.synchronizedOutput = false;
    this.focusReporting = false;
    this.reverseVideo = false;
    this.mouseTracking = 'none';
    this.mouseEncoding = 'default';
    this.modifyOtherKeys = 0;
    this.insertMode = false;
    this.altScreenActive = false;
    this.active = this.main;
    this.main.rows = this.blankRows(this.rows);
    this.alt.rows = this.blankRows(this.rows);
    this.main.saved = null;
    this.alt.saved = null;
    this.cursorX = 0;
    this.cursorY = 0;
    this.viewportOffset = 0;
    this.paletteOverrides.clear();
    this.resetTabStops();
    this.markAllDirty();
  }

  // ------------------------------------------------------------------- SGR

  private sgr(params: Params): void {
    const attrs = this.attrs;
    for (let i = 0; i < params.length; i++) {
      const entry = params[i]!;
      const code = entry[0]!;
      switch (code) {
        case 0:
          attrs.reset();
          break;
        case 1:
          attrs.fg |= 1 << 26; // bold
          break;
        case 2:
          attrs.fg |= 1 << 27; // dim
          break;
        case 3:
          attrs.fg |= 1 << 28; // italic
          break;
        case 4:
          this.setUnderline(entry.length > 1 ? entry[1]! : 1);
          break;
        case 5:
        case 6:
          attrs.fg |= 1 << 29; // blink
          break;
        case 7:
          attrs.fg |= 1 << 30; // inverse
          break;
        case 8:
          attrs.fg |= -2147483648; // invisible
          break;
        case 9:
          attrs.bg |= 1 << 26; // strikethrough
          break;
        case 21:
          this.setUnderline(2);
          break;
        case 22:
          attrs.fg &= ~((1 << 26) | (1 << 27));
          break;
        case 23:
          attrs.fg &= ~(1 << 28);
          break;
        case 24:
          this.setUnderline(0);
          break;
        case 25:
          attrs.fg &= ~(1 << 29);
          break;
        case 27:
          attrs.fg &= ~(1 << 30);
          break;
        case 28:
          attrs.fg &= 0x7fffffff; // clear invisible
          break;
        case 29:
          attrs.bg &= ~(1 << 26);
          break;
        case 39:
          attrs.fg &= ~(0x00ffffff | (0b11 << MODE_SHIFT));
          break;
        case 49:
          attrs.bg &= ~(0x00ffffff | (0b11 << MODE_SHIFT));
          break;
        case 38:
        case 48:
        case 58: {
          const { color, consumed } = this.parseExtendedColor(params, i);
          i += consumed;
          if (color === null) break;
          if (code === 38) attrs.fg = (attrs.fg & ~0x03ffffff) | color;
          else if (code === 48) attrs.bg = (attrs.bg & ~0x03ffffff) | color;
          else attrs.underlineColor = color;
          break;
        }
        case 59:
          attrs.underlineColor = 0;
          break;
        default:
          if (code >= 30 && code <= 37) {
            attrs.fg = (attrs.fg & ~0x03ffffff) | paletteColor(code - 30);
          } else if (code >= 40 && code <= 47) {
            attrs.bg = (attrs.bg & ~0x03ffffff) | paletteColor(code - 40);
          } else if (code >= 90 && code <= 97) {
            attrs.fg = (attrs.fg & ~0x03ffffff) | paletteColor(code - 90 + 8);
          } else if (code >= 100 && code <= 107) {
            attrs.bg = (attrs.bg & ~0x03ffffff) | paletteColor(code - 100 + 8);
          }
          break;
      }
    }
  }

  private setUnderline(style: number): void {
    if (style > 5) style = 1;
    this.attrs.bg = (this.attrs.bg & ~(0b111 << 27)) | (style << 27);
  }

  /**
   * Parse `38/48/58` extended color in either form:
   *   semicolon: `38;5;idx` / `38;2;r;g;b` (consumes following params)
   *   colon:     `38:5:idx` / `38:2:r:g:b` / `38:2::r:g:b` (self-contained)
   * Returns the packed color word and how many extra params were consumed.
   */
  private parseExtendedColor(
    params: Params,
    i: number,
  ): { color: number | null; consumed: number } {
    const entry = params[i]!;
    if (entry.length > 1) {
      // Colon form.
      const kind = entry[1]!;
      if (kind === 5 && entry.length >= 3) return { color: paletteColor(entry[2]!), consumed: 0 };
      if (kind === 2) {
        if (entry.length >= 6) {
          // 38:2:<colorspace>:r:g:b
          return { color: rgbColor(entry[3]!, entry[4]!, entry[5]!), consumed: 0 };
        }
        if (entry.length === 5) {
          return { color: rgbColor(entry[2]!, entry[3]!, entry[4]!), consumed: 0 };
        }
      }
      return { color: null, consumed: 0 };
    }
    // Semicolon form.
    const kind = params[i + 1]?.[0];
    if (kind === 5) {
      return { color: paletteColor(params[i + 2]?.[0] ?? 0), consumed: 2 };
    }
    if (kind === 2) {
      return {
        color: rgbColor(params[i + 2]?.[0] ?? 0, params[i + 3]?.[0] ?? 0, params[i + 4]?.[0] ?? 0),
        consumed: 4,
      };
    }
    return { color: null, consumed: kind === undefined ? 0 : 1 };
  }

  // ------------------------------------------------------------------- OSC

  private setTitle(title: string): void {
    this.title = title;
    this.events.onTitle?.(title);
  }

  private oscPalette(rest: string): void {
    // `4;idx;spec[;idx;spec...]`; spec `?` queries.
    const parts = rest.split(';');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const index = Number.parseInt(parts[i]!, 10);
      const spec = parts[i + 1]!;
      if (Number.isNaN(index) || index < 0 || index > 255) continue;
      if (spec === '?') {
        const rgb = this.paletteColorRgb(index);
        this.respond(`\x1b]4;${index};${formatColor(rgb)}\x07`);
      } else {
        const rgb = parseColorSpec(spec);
        if (rgb !== null) {
          this.paletteOverrides.set(index, rgb);
          this.markAllDirty();
        }
      }
    }
  }

  private oscDynamicColor(id: number, spec: string): void {
    if (spec === '?') {
      const rgb =
        id === 10 ? this.foregroundColor : id === 11 ? this.backgroundColor : this.cursorColor;
      this.respond(`\x1b]${id};${formatColor(rgb)}\x07`);
      return;
    }
    const rgb = parseColorSpec(spec);
    if (rgb === null) return;
    if (id === 10) this.foregroundColor = rgb;
    else if (id === 11) this.backgroundColor = rgb;
    else this.cursorColor = rgb;
    this.markAllDirty();
  }

  private oscHyperlink(rest: string): void {
    // `8;params;uri` — empty uri ends the link.
    const sep = rest.indexOf(';');
    if (sep === -1) return;
    const params = rest.slice(0, sep);
    const uri = rest.slice(sep + 1);
    if (uri === '') {
      this.attrs.linkId = 0;
      return;
    }
    const idParam = params
      .split(':')
      .find((kv) => kv.startsWith('id='))
      ?.slice(3);
    const key = `${idParam ?? ''}\0${uri}`;
    let linkId = this.linkIds.get(key);
    if (linkId === undefined) {
      this.links.push({ uri, id: idParam ?? '' });
      linkId = this.links.length;
      this.linkIds.set(key, linkId);
    }
    this.attrs.linkId = linkId;
  }

  private oscClipboard(rest: string): void {
    // `52;<selection>;<base64>` — only writes are honored; queries would leak
    // the clipboard to the application, so they are ignored.
    const sep = rest.indexOf(';');
    if (sep === -1) return;
    const payload = rest.slice(sep + 1);
    if (payload !== '?') this.events.onClipboard?.(payload);
  }

  private oscShellMark(rest: string): void {
    const [kind, ...args] = rest.split(';');
    if (!kind) return;
    const mark: ShellMark = {
      kind,
      absoluteLine: this.historyBase + this.cursorY,
    };
    if (kind === 'D' && args[0] !== undefined && args[0] !== '') {
      const code = Number.parseInt(args[0], 10);
      if (!Number.isNaN(code)) mark.exitCode = code;
    }
    this.marks.push(mark);
    if (this.marks.length > 1000) this.marks.shift();
    this.events.onMark?.(mark);
  }

  /** The OSC 4 override for a palette index, or null when none was set. */
  paletteOverride(index: number): number | null {
    return this.paletteOverrides.get(index) ?? null;
  }

  /** Effective RGB for a palette index, honoring OSC 4 overrides. */
  paletteColorRgb(index: number): number {
    const override = this.paletteOverrides.get(index);
    if (override !== undefined) return override;
    return DEFAULT_PALETTE[index] ?? 0;
  }

  // --------------------------------------------------------------- reports

  private respond(data: string): void {
    this.events.onResponse?.(data);
  }

  private reportCursorPosition(prefix: string): void {
    const y = this.originMode ? this.cursorY - this.scrollTop : this.cursorY;
    this.respond(`\x1b[${prefix}${y + 1};${this.cursorX + 1}R`);
  }

  private cursorStyleReport(param: number): void {
    // DECSCUSR: 0/1 blink block, 2 block, 3 blink underline, 4 underline,
    // 5 blink bar, 6 bar.
    const styles: CursorStyle[] = [
      'block',
      'block',
      'block',
      'underline',
      'underline',
      'bar',
      'bar',
    ];
    const style = styles[param] ?? 'block';
    const blink = param === 0 || param === 1 || param === 3 || param === 5;
    this.events.onCursorStyle?.(style, blink);
  }

  // ---------------------------------------------------------------- resize

  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    if (cols === this.cols && rows === this.rows) return;

    for (const buffer of [this.main, this.alt]) {
      const isActive = buffer === this.active;
      const isMain = buffer === this.main;
      for (const row of buffer.rows) row.resize(cols);

      if (rows > buffer.rows.length) {
        // Grow: pull lines back out of scrollback first (main buffer), so
        // making the window taller reveals recent output, not blank space.
        let add = rows - buffer.rows.length;
        while (add > 0 && isMain && this.scrollback.length > 0) {
          const line = this.scrollback.pop()!;
          line.resize(cols);
          buffer.rows.unshift(line);
          if (isActive) this.cursorY++;
          add--;
        }
        while (add-- > 0) buffer.rows.push(new Row(cols));
      } else if (rows < buffer.rows.length) {
        let remove = buffer.rows.length - rows;
        // Trim blank lines below the cursor first; then push from the top
        // into scrollback so content above the cursor survives.
        while (remove > 0 && buffer.rows.length - 1 > (isActive ? this.cursorY : 0)) {
          const last = buffer.rows[buffer.rows.length - 1]!;
          if (last.text() !== '') break;
          buffer.rows.pop();
          remove--;
        }
        while (remove-- > 0) {
          const removed = buffer.rows.shift()!;
          if (isMain) {
            this.scrollback.push(removed);
            this.historyBase++;
          }
          if (isActive && this.cursorY > 0) this.cursorY--;
        }
      }
    }

    this.cols = cols;
    this.rows = rows;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.cursorX = Math.min(this.cursorX, cols - 1);
    this.cursorY = Math.max(0, Math.min(this.cursorY, rows - 1));
    this.pendingWrap = false;
    this.viewportOffset = Math.min(this.viewportOffset, this.scrollback.length);
    this.markAllDirty();
  }

  private blankRows(count: number): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < count; i++) rows.push(new Row(this.cols));
    return rows;
  }
}

/** Parse an X11-style color spec: `rgb:RR/GG/BB` (1–4 hex digits) or `#RRGGBB`. */
export function parseColorSpec(spec: string): number | null {
  if (spec.startsWith('#')) {
    const hex = spec.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    if (hex.length === 6) return Number.parseInt(hex, 16);
    if (hex.length === 3) {
      const [r, g, b] = hex;
      return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
    }
    return null;
  }
  if (spec.startsWith('rgb:')) {
    const parts = spec.slice(4).split('/');
    if (parts.length !== 3) return null;
    const channels = parts.map((part) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      // Scale to 8 bits from however many digits were given.
      const value = Number.parseInt(part, 16);
      const max = 16 ** part.length - 1;
      return Math.round((value / max) * 255);
    });
    if (channels.some((c) => c === null)) return null;
    return (channels[0]! << 16) | (channels[1]! << 8) | channels[2]!;
  }
  return null;
}

/** Format 0xRRGGBB as the `rgb:rrrr/gggg/bbbb` form xterm answers queries with. */
export function formatColor(rgb: number): string {
  const channel = (value: number) => {
    const scaled = (value << 8) | value;
    return scaled.toString(16).padStart(4, '0');
  };
  return `rgb:${channel((rgb >> 16) & 0xff)}/${channel((rgb >> 8) & 0xff)}/${channel(rgb & 0xff)}`;
}

/** The xterm-standard 256-color palette as 0xRRGGBB. */
export const DEFAULT_PALETTE: number[] = buildDefaultPalette();

function buildDefaultPalette(): number[] {
  const palette: number[] = [
    // Standard + bright ANSI (xterm defaults; themes override at render time).
    0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f,
    0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
  ];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette.push((steps[r]! << 16) | (steps[g]! << 8) | steps[b]!);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const gray = 8 + i * 10;
    palette.push((gray << 16) | (gray << 8) | gray);
  }
  return palette;
}
