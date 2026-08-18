/**
 * The canvas renderer.
 *
 * Paints the terminal's viewport onto a 2D canvas, one dirty row at a time:
 *
 *   engine dirty rows ─┐
 *   cursor movement  ──┼─► rows to repaint ─► clearRect ─► bg spans ─► text
 *   theme/font/size  ──┘                                   runs ─► decorations
 *
 * Two properties are load-bearing:
 *
 *   - **Transparency.** A row is *cleared*, not filled, before painting. Cells
 *     with the default background therefore stay fully transparent and the
 *     translucent window background shows through; explicitly colored cells
 *     paint opaquely over it (plan §Phase 3).
 *   - **Batching.** Cells are reduced to runs (see runs.ts) before any canvas
 *     call, so a line of text costs a couple of `fillText`s rather than one
 *     per column.
 *
 * No DOM beyond the canvas itself, no Tauri, no React: the host owns layout,
 * this owns pixels.
 */

import { UnderlineStyle, type Terminal } from '../term';
import { ColorResolver, type ColorOptions } from './colors';
import { DEFAULT_FONT, fontString, type CellMetrics, type FontSpec } from './metrics';
import { buildRowRuns, type BackgroundRun, type TextRun } from './runs';
import { rangeForLine, type Selection } from './selection';
import { DEFAULT_THEME, cssColor, cssColorAlpha, type TerminalTheme } from './theme';

export type CursorStyle = 'block' | 'underline' | 'bar';

/** What the pointer is over, so the renderer can underline the whole link. */
export type HoverTarget =
  { linkId: number } | { line: number; start: number; end: number; linkId?: number };

export interface RendererOptions {
  terminal: Terminal;
  metrics: CellMetrics;
  theme?: TerminalTheme;
  font?: FontSpec;
  /** Inset in CSS pixels between the canvas edge and the grid. */
  padding?: number;
  colors?: ColorOptions;
  cursorStyle?: CursorStyle;
}

const CURSOR_UNFOCUSED_ALPHA = 0.55;
/** Bar/underline cursor thickness as a fraction of the cell. */
const CURSOR_BAR_RATIO = 0.12;

export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private terminal: Terminal;
  private resolver: ColorResolver;
  private theme: TerminalTheme;
  private font: FontSpec;
  private metrics: CellMetrics;
  private padding: number;

  private widthPx = 0;
  private heightPx = 0;
  private dpr = 1;

  private cursorStyle: CursorStyle;
  private cursorBlinkOn = true;
  private focused = true;
  private selection: Selection | null = null;
  private hover: HoverTarget | null = null;

  /** Rows the renderer itself invalidated (cursor moves, hover, selection). */
  private dirtyRows = new Set<number>();
  private fullRepaint = true;
  private lastCursor = { x: 0, y: 0 };
  /** DECSCNM, sampled once per frame rather than once per row. */
  private reverseVideo = false;

  constructor(
    private canvas: HTMLCanvasElement,
    options: RendererOptions,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.terminal = options.terminal;
    this.theme = options.theme ?? DEFAULT_THEME;
    this.font = options.font ?? DEFAULT_FONT;
    this.metrics = options.metrics;
    this.padding = options.padding ?? 0;
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.resolver = new ColorResolver(
      this.theme,
      this.terminal.defaultColors(),
      (index) => this.terminal.paletteOverride(index),
      options.colors,
    );
    this.seedDefaultColors();
  }

  /**
   * Push the theme's colors into the engine as the OSC 10/11/12 defaults, so
   * an application that *queries* the background color (the usual light/dark
   * detection) learns the theme's, and an application that *sets* one still
   * wins until the theme changes again.
   */
  private seedDefaultColors(): void {
    this.terminal.setDefaultColors({
      foreground: this.theme.foreground,
      background: this.theme.background,
      cursor: this.theme.cursor,
    });
    this.resolver.setDefaults(this.terminal.defaultColors());
  }

  // ------------------------------------------------------------- configure

  /** Size the backing store for `dpr` and lay the grid out in CSS pixels. */
  resize(widthPx: number, heightPx: number, dpr = 1): void {
    this.widthPx = widthPx;
    this.heightPx = heightPx;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(widthPx * dpr));
    this.canvas.height = Math.max(1, Math.round(heightPx * dpr));
    this.canvas.style.width = `${widthPx}px`;
    this.canvas.style.height = `${heightPx}px`;
    // Everything below draws in CSS pixels; the transform does the HiDPI work.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  setTheme(theme: TerminalTheme): void {
    this.theme = theme;
    this.resolver.setTheme(theme);
    this.seedDefaultColors();
    this.invalidate();
  }

  setFont(font: FontSpec, metrics: CellMetrics): void {
    this.font = font;
    this.metrics = metrics;
    this.invalidate();
  }

  setCursorStyle(style: CursorStyle): void {
    this.cursorStyle = style;
    this.markCursorDirty();
  }

  /** Blink phase — the view owns the timer. */
  setCursorBlinkOn(on: boolean): void {
    if (this.cursorBlinkOn === on) return;
    this.cursorBlinkOn = on;
    this.markCursorDirty();
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.markCursorDirty();
  }

  setSelection(selection: Selection | null): void {
    this.selection = selection;
    // Selection spans are cheap to get wrong incrementally; repaint the grid.
    this.invalidate();
  }

  setHover(hover: HoverTarget | null): void {
    if (hover === null && this.hover === null) return;
    this.hover = hover;
    this.invalidate();
  }

  /** OSC 4/10/11/12 changed a color the resolver memoized. */
  refreshColors(): void {
    this.resolver.setDefaults(this.terminal.defaultColors());
    this.resolver.invalidate();
    this.invalidate();
  }

  /** Force a full repaint on the next `render()`. */
  invalidate(): void {
    this.fullRepaint = true;
    this.dirtyRows.clear();
  }

  get cellMetrics(): CellMetrics {
    return this.metrics;
  }

  // ---------------------------------------------------------------- painting

  /**
   * Paint everything invalidated since the last call.
   *
   * Returns false without touching the canvas — or the engine's dirty set —
   * while the application holds a synchronized-output batch (DEC 2026): that
   * is exactly the flicker Claude Code's spinner uses the mode to avoid.
   *
   * `force` paints anyway, mid-batch and all. It is the escape hatch behind
   * `TermView`'s watchdog: a batch that is never closed must cost one torn
   * frame, not a permanently frozen surface.
   */
  render(force = false): boolean {
    if (this.terminal.synchronized && !force) return false;

    const rows = this.terminal.rows;
    this.reverseVideo = this.terminal.modes().reverseVideo;
    const engineDirty = this.terminal.takeDirty();
    const offset = this.terminal.viewportOffset;

    let targets: number[];
    if (this.fullRepaint || engineDirty.all) {
      targets = [];
      for (let y = 0; y < rows; y++) targets.push(y);
    } else {
      const set = new Set(this.dirtyRows);
      // Engine rows are grid rows; on screen they sit `offset` lower.
      for (const gridY of engineDirty.rows) {
        const y = gridY + offset;
        if (y >= 0 && y < rows) set.add(y);
      }
      targets = [...set].sort((a, b) => a - b);
    }

    this.fullRepaint = false;
    this.dirtyRows.clear();
    for (const y of targets) this.paintRow(y);

    this.paintCursor();
    return true;
  }

  private paintRow(y: number): void {
    const { ctx, metrics } = this;
    const top = this.padding + y * metrics.height;
    ctx.clearRect(0, top, this.widthPx, metrics.height);

    const row = this.terminal.viewportRow(y);
    const cols = this.terminal.cols;
    const line = this.terminal.topLine + y;
    const selection = this.selection ? rangeForLine(this.selection, line, cols) : null;
    const { backgrounds, texts } = buildRowRuns(row, cols, this.resolver, {
      reverseVideo: this.reverseVideo,
      selection,
    });

    for (const background of backgrounds) this.paintBackground(background, top);
    for (const text of texts) this.paintText(text, top, line);
  }

  private paintBackground(run: BackgroundRun, top: number): void {
    const { ctx, metrics } = this;
    ctx.fillStyle = cssColor(run.color);
    ctx.fillRect(
      this.padding + run.col * metrics.width,
      top,
      run.width * metrics.width,
      metrics.height,
    );
  }

  private paintText(run: TextRun, top: number, line: number): void {
    const { ctx, metrics } = this;
    const x = this.padding + run.col * metrics.width;
    const baseline = top + metrics.baseline;

    if (run.text !== '') {
      ctx.font = fontString(this.font, run.bold, run.italic);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = cssColor(run.colors.fg);
      ctx.fillText(run.text, x, baseline);
    }

    const width = run.width * metrics.width;
    if (run.underline !== UnderlineStyle.None) {
      this.paintUnderline(run.underline, x, baseline, width, run.colors.underline);
    }
    if (run.strikethrough) {
      ctx.fillStyle = cssColor(run.colors.underline);
      ctx.fillRect(x, baseline - metrics.strikeoutOffset, width, metrics.lineThickness);
    }
    if (this.isHovered(run, line)) {
      ctx.fillStyle = cssColor(run.colors.fg);
      ctx.fillRect(x, baseline + metrics.underlineOffset, width, metrics.lineThickness);
    }
  }

  private isHovered(run: TextRun, line: number): boolean {
    const hover = this.hover;
    if (!hover) return false;
    if ('linkId' in hover && hover.linkId && run.linkId === hover.linkId) return true;
    if (!('line' in hover)) return false;
    return hover.line === line && run.col < hover.end && run.col + run.width > hover.start;
  }

  private paintUnderline(
    style: UnderlineStyle,
    x: number,
    baseline: number,
    width: number,
    color: number,
  ): void {
    const { ctx, metrics } = this;
    const y = baseline + metrics.underlineOffset;
    const thickness = metrics.lineThickness;

    if (style === UnderlineStyle.Single) {
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(x, y, width, thickness);
      return;
    }
    if (style === UnderlineStyle.Double) {
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(x, y, width, thickness);
      ctx.fillRect(x, y + thickness * 2, width, thickness);
      return;
    }

    ctx.save();
    ctx.strokeStyle = cssColor(color);
    ctx.lineWidth = thickness;
    ctx.beginPath();
    if (style === UnderlineStyle.Curly) {
      // One full wave per cell — the shape editors and linters draw.
      const amplitude = Math.max(1, metrics.underlineOffset);
      const period = Math.max(4, metrics.width);
      ctx.moveTo(x, y);
      for (let dx = 0; dx <= width; dx += period / 2) {
        const up = Math.round(dx / (period / 2)) % 2 === 0;
        ctx.quadraticCurveTo(x + dx - period / 4, y + (up ? amplitude : -amplitude), x + dx, y);
      }
    } else {
      ctx.setLineDash(
        style === UnderlineStyle.Dotted
          ? [thickness, thickness * 2]
          : [thickness * 4, thickness * 3],
      );
      ctx.moveTo(x, y + thickness / 2);
      ctx.lineTo(x + width, y + thickness / 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ cursor

  /** Queue a viewport row for repaint, ignoring rows that are off screen. */
  private markRowDirty(y: number): void {
    if (this.fullRepaint) return;
    if (y >= 0 && y < this.terminal.rows) this.dirtyRows.add(y);
  }

  private markCursorDirty(): void {
    this.markRowDirty(this.terminal.cursor.y + this.terminal.viewportOffset);
    this.markRowDirty(this.lastCursor.y);
  }

  /**
   * The cursor is painted on top of its row, never into the engine's model, so
   * moving it only ever dirties the row it left and the row it entered.
   */
  private paintCursor(): void {
    const cursor = this.terminal.cursor;
    const y = cursor.y + this.terminal.viewportOffset;
    if (this.lastCursor.y !== y || this.lastCursor.x !== cursor.x) {
      // Repaint what the cursor uncovered on the next frame.
      this.markRowDirty(this.lastCursor.y);
      this.lastCursor = { x: cursor.x, y };
    }
    if (!cursor.visible || !this.cursorBlinkOn) return;
    // Scrolled into history: the live cursor is not where the user is looking.
    if (y < 0 || y >= this.terminal.rows) return;

    const { ctx, metrics } = this;
    const row = this.terminal.viewportRow(y);
    const cell = row.getCell(Math.min(cursor.x, this.terminal.cols - 1));
    const span = cell.width === 2 ? 2 : 1;
    const x = this.padding + cursor.x * metrics.width;
    const top = this.padding + y * metrics.height;
    const color = this.terminal.defaultColors().cursor;

    if (!this.focused) {
      // An unfocused pane shows a hollow box — the convention every terminal
      // uses to say "typing goes somewhere else".
      ctx.strokeStyle = cssColorAlpha(color, CURSOR_UNFOCUSED_ALPHA);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, top + 0.5, span * metrics.width - 1, metrics.height - 1);
      return;
    }

    ctx.fillStyle = cssColor(color);
    if (this.cursorStyle === 'bar') {
      ctx.fillRect(x, top, Math.max(1, metrics.width * CURSOR_BAR_RATIO), metrics.height);
      return;
    }
    if (this.cursorStyle === 'underline') {
      const thickness = Math.max(1, Math.round(metrics.height * CURSOR_BAR_RATIO));
      ctx.fillRect(x, top + metrics.height - thickness, span * metrics.width, thickness);
      return;
    }

    ctx.fillRect(x, top, span * metrics.width, metrics.height);
    if (cell.text !== '') {
      const colors = this.resolver.resolve(cell, this.reverseVideo);
      ctx.font = fontString(this.font, false, false);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = cssColor(this.theme.cursorText ?? colors.bg ?? this.theme.background);
      ctx.fillText(cell.text, x, top + metrics.baseline);
    }
  }

  /** Pixel point (relative to the canvas) → grid cell, clamped to the grid. */
  cellAt(xPx: number, yPx: number): { col: number; row: number } {
    const col = Math.floor((xPx - this.padding) / this.metrics.width);
    const row = Math.floor((yPx - this.padding) / this.metrics.height);
    return {
      col: Math.max(0, Math.min(this.terminal.cols - 1, col)),
      row: Math.max(0, Math.min(this.terminal.rows - 1, row)),
    };
  }

  get devicePixelRatioUsed(): number {
    return this.dpr;
  }

  get sizePx(): { width: number; height: number } {
    return { width: this.widthPx, height: this.heightPx };
  }
}
