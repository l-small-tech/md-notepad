/**
 * VT/xterm escape-sequence parser.
 *
 * A state machine following the Paul Williams VT500-series parser diagram
 * (the same model xterm and WezTerm use), with a streaming UTF-8 decoder in
 * front. Bytes go in; typed actions (`print`, `execute`, `csiDispatch`, …)
 * come out and are consumed by the screen model. The parser holds no screen
 * state, which is the seam that makes both halves independently testable.
 *
 * Robustness contract (fuzz-tested): any byte sequence, chunked at any
 * boundary, must never throw and must always return to a sane state.
 */

/**
 * CSI/DCS parameters. Each entry is one semicolon-separated parameter; an
 * entry with more than one element carries colon-separated subparameters
 * (e.g. `38:2:255:0:0` → `[38, 2, 255, 0, 0]`). Missing parameters are 0 —
 * every control we implement treats 0 as "default".
 */
export type Params = number[][];

export interface ParserActions {
  print(cp: number): void;
  /** C0 or C1 control (0x00–0x1f, 0x80–0x9f). */
  execute(code: number): void;
  escDispatch(intermediates: string, final: number): void;
  csiDispatch(prefix: string, params: Params, intermediates: string, final: number): void;
  /**
   * Full OSC payload, e.g. `0;my title`. `stTerminated` is true when the
   * string ended with ST (`ESC \`) rather than BEL, because a query's answer
   * must use the SAME terminator the query did: a client that scans for
   * `ESC \` hangs on a BEL-terminated reply (and then falls back to guessing
   * the background color, which is exactly what OSC 11 exists to avoid).
   */
  oscDispatch(data: string, stTerminated: boolean): void;
  dcsDispatch(
    prefix: string,
    params: Params,
    intermediates: string,
    final: number,
    data: string,
  ): void;
}

enum State {
  Ground,
  Escape,
  EscapeIntermediate,
  CsiEntry,
  CsiParam,
  CsiIntermediate,
  CsiIgnore,
  OscString,
  DcsEntry,
  DcsParam,
  DcsIntermediate,
  DcsPassthrough,
  DcsIgnore,
  SosPmApcString,
}

const REPLACEMENT = 0xfffd;
/** Runaway-string guard: OSC/DCS payloads are capped, extra bytes dropped. */
const MAX_STRING = 1 << 20;
const MAX_PARAMS = 32;
const MAX_PARAM_VALUE = 65535;

export class Parser {
  private state = State.Ground;

  // UTF-8 decoder state (partial sequences may span write() chunks).
  private utfPending = 0;
  private utfCodepoint = 0;
  private utfMin = 0;

  // Sequence-in-progress state.
  private prefix = '';
  private intermediates = '';
  private params: Params = [];
  private current: number[] = [];
  private hasCurrent = false;
  private stringData = '';
  private dcsPrefix = '';
  private dcsIntermediates = '';
  private dcsParams: Params = [];
  private dcsFinal = 0;

  constructor(private actions: ParserActions) {}

  reset(): void {
    this.state = State.Ground;
    this.utfPending = 0;
  }

  parse(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;

      // UTF-8 continuation handling comes first: mid-sequence, only
      // continuation bytes are legal; anything else aborts to a replacement
      // char and reprocesses the byte.
      if (this.utfPending > 0) {
        if ((byte & 0xc0) === 0x80) {
          this.utfCodepoint = (this.utfCodepoint << 6) | (byte & 0x3f);
          if (--this.utfPending === 0) {
            const cp = this.utfCodepoint;
            // Overlong encodings, surrogates and out-of-range are invalid.
            if (cp < this.utfMin || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) {
              this.consume(REPLACEMENT);
            } else {
              this.consume(cp);
            }
          }
          continue;
        }
        this.utfPending = 0;
        this.consume(REPLACEMENT);
        // fall through to process `byte` normally
      }

      if (byte < 0x80) {
        this.consume(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        this.utfPending = 1;
        this.utfCodepoint = byte & 0x1f;
        this.utfMin = 0x80;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        this.utfPending = 2;
        this.utfCodepoint = byte & 0x0f;
        this.utfMin = 0x800;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        this.utfPending = 3;
        this.utfCodepoint = byte & 0x07;
        this.utfMin = 0x10000;
      } else {
        // 0x80–0xc1, 0xf5–0xff: not valid UTF-8 lead bytes.
        this.consume(REPLACEMENT);
      }
    }
  }

  /** Process one decoded codepoint through the state machine. */
  private consume(cp: number): void {
    // "Anywhere" transitions (Williams diagram): CAN/SUB abort, ESC restarts.
    if (cp === 0x18 || cp === 0x1a) {
      this.abortString();
      this.state = State.Ground;
      if (cp === 0x1a) this.actions.print(REPLACEMENT);
      return;
    }
    if (cp === 0x1b) {
      // Leaving OSC via ESC: xterm treats ESC (usually ESC \ = ST) as a
      // terminator, so the collected string dispatches.
      if (this.state === State.OscString) this.dispatchOsc(true);
      else if (this.state === State.DcsPassthrough) this.dispatchDcs();
      this.enterEscape();
      return;
    }

    switch (this.state) {
      case State.Ground:
        if (cp >= 0x20 && cp !== 0x7f && (cp < 0x80 || cp > 0x9f)) this.actions.print(cp);
        else if (cp < 0x20) this.actions.execute(cp);
        else if (cp >= 0x80 && cp <= 0x9f) this.executeC1(cp);
        return;

      case State.Escape:
        if (cp >= 0x20 && cp <= 0x2f) {
          this.intermediates += String.fromCharCode(cp);
          this.state = State.EscapeIntermediate;
        } else if (cp === 0x5b /* [ */) {
          this.enterCsi();
        } else if (cp === 0x5d /* ] */) {
          this.enterOsc();
        } else if (cp === 0x50 /* P */) {
          this.enterDcs();
        } else if (cp === 0x58 || cp === 0x5e || cp === 0x5f /* X ^ _ */) {
          this.state = State.SosPmApcString;
        } else if (cp >= 0x30 && cp <= 0x7e) {
          this.state = State.Ground;
          this.actions.escDispatch('', cp);
        } else if (cp < 0x20) {
          this.actions.execute(cp);
        }
        return;

      case State.EscapeIntermediate:
        if (cp >= 0x20 && cp <= 0x2f) this.intermediates += String.fromCharCode(cp);
        else if (cp >= 0x30 && cp <= 0x7e) {
          this.state = State.Ground;
          this.actions.escDispatch(this.intermediates, cp);
        } else if (cp < 0x20) this.actions.execute(cp);
        return;

      case State.CsiEntry:
      case State.CsiParam:
        if (cp >= 0x30 && cp <= 0x39) {
          const value = this.current.length ? this.current.pop()! : 0;
          this.current.push(Math.min(MAX_PARAM_VALUE, value * 10 + (cp - 0x30)));
          this.hasCurrent = true;
          this.state = State.CsiParam;
        } else if (cp === 0x3b /* ; */) {
          this.pushParam();
          this.state = State.CsiParam;
        } else if (cp === 0x3a /* : */) {
          if (!this.current.length) this.current.push(0);
          this.current.push(0);
          this.hasCurrent = true;
          this.state = State.CsiParam;
        } else if (cp >= 0x3c && cp <= 0x3f) {
          if (this.state === State.CsiEntry) {
            this.prefix += String.fromCharCode(cp);
            this.state = State.CsiParam;
          } else {
            this.state = State.CsiIgnore;
          }
        } else if (cp >= 0x20 && cp <= 0x2f) {
          this.intermediates += String.fromCharCode(cp);
          this.state = State.CsiIntermediate;
        } else if (cp >= 0x40 && cp <= 0x7e) {
          this.dispatchCsi(cp);
        } else if (cp < 0x20) {
          this.actions.execute(cp);
        }
        return;

      case State.CsiIntermediate:
        if (cp >= 0x20 && cp <= 0x2f) this.intermediates += String.fromCharCode(cp);
        else if (cp >= 0x40 && cp <= 0x7e) this.dispatchCsi(cp);
        else if (cp >= 0x30 && cp <= 0x3f) this.state = State.CsiIgnore;
        else if (cp < 0x20) this.actions.execute(cp);
        return;

      case State.CsiIgnore:
        if (cp >= 0x40 && cp <= 0x7e) this.state = State.Ground;
        else if (cp < 0x20) this.actions.execute(cp);
        return;

      case State.OscString:
        if (cp === 0x07) {
          this.dispatchOsc(false);
          this.state = State.Ground;
        } else if (cp >= 0x20 && this.stringData.length < MAX_STRING) {
          this.stringData += String.fromCodePoint(cp);
        }
        return;

      case State.DcsEntry:
      case State.DcsParam:
        if (cp >= 0x30 && cp <= 0x39) {
          const value = this.current.length ? this.current.pop()! : 0;
          this.current.push(Math.min(MAX_PARAM_VALUE, value * 10 + (cp - 0x30)));
          this.hasCurrent = true;
          this.state = State.DcsParam;
        } else if (cp === 0x3b) {
          this.pushParam();
          this.state = State.DcsParam;
        } else if (cp === 0x3a) {
          if (!this.current.length) this.current.push(0);
          this.current.push(0);
          this.hasCurrent = true;
          this.state = State.DcsParam;
        } else if (cp >= 0x3c && cp <= 0x3f) {
          if (this.state === State.DcsEntry) {
            this.prefix += String.fromCharCode(cp);
            this.state = State.DcsParam;
          } else {
            this.state = State.DcsIgnore;
          }
        } else if (cp >= 0x20 && cp <= 0x2f) {
          this.intermediates += String.fromCharCode(cp);
          this.state = State.DcsIntermediate;
        } else if (cp >= 0x40 && cp <= 0x7e) {
          this.hookDcs(cp);
        }
        return;

      case State.DcsIntermediate:
        if (cp >= 0x20 && cp <= 0x2f) this.intermediates += String.fromCharCode(cp);
        else if (cp >= 0x40 && cp <= 0x7e) this.hookDcs(cp);
        else if (cp >= 0x30 && cp <= 0x3f) this.state = State.DcsIgnore;
        return;

      case State.DcsPassthrough:
        if (this.stringData.length < MAX_STRING) this.stringData += String.fromCodePoint(cp);
        return;

      case State.DcsIgnore:
      case State.SosPmApcString:
        // Consumed until ST/CAN/SUB (handled by the anywhere rules above).
        return;
    }
  }

  private executeC1(cp: number): void {
    if (cp === 0x90) this.enterDcs();
    else if (cp === 0x9b) this.enterCsi();
    else if (cp === 0x9d) this.enterOsc();
    else if (cp === 0x98 || cp === 0x9e || cp === 0x9f) this.state = State.SosPmApcString;
    else this.actions.execute(cp);
  }

  private enterEscape(): void {
    this.state = State.Escape;
    this.intermediates = '';
  }

  private enterCsi(): void {
    this.state = State.CsiEntry;
    this.prefix = '';
    this.intermediates = '';
    this.params = [];
    this.current = [];
    this.hasCurrent = false;
  }

  private enterOsc(): void {
    this.state = State.OscString;
    this.stringData = '';
  }

  private enterDcs(): void {
    this.state = State.DcsEntry;
    this.prefix = '';
    this.intermediates = '';
    this.params = [];
    this.current = [];
    this.hasCurrent = false;
    this.stringData = '';
  }

  private pushParam(): void {
    if (this.params.length < MAX_PARAMS) {
      this.params.push(this.current.length ? this.current : [0]);
    }
    this.current = [];
    this.hasCurrent = false;
  }

  private dispatchCsi(final: number): void {
    if (this.hasCurrent || this.params.length) this.pushParam();
    this.state = State.Ground;
    this.actions.csiDispatch(this.prefix, this.params, this.intermediates, final);
  }

  private hookDcs(final: number): void {
    if (this.hasCurrent || this.params.length) this.pushParam();
    this.dcsPrefix = this.prefix;
    this.dcsIntermediates = this.intermediates;
    this.dcsParams = this.params;
    this.dcsFinal = final;
    this.stringData = '';
    this.state = State.DcsPassthrough;
  }

  private dispatchOsc(stTerminated: boolean): void {
    this.actions.oscDispatch(this.stringData, stTerminated);
    this.stringData = '';
  }

  private dispatchDcs(): void {
    this.actions.dcsDispatch(
      this.dcsPrefix,
      this.dcsParams,
      this.dcsIntermediates,
      this.dcsFinal,
      this.stringData,
    );
    this.stringData = '';
  }

  private abortString(): void {
    this.stringData = '';
  }
}
