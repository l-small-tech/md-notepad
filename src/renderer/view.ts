/**
 * `TermView` — the mountable terminal surface.
 *
 * Owns the canvas, the frame loop and everything that has to react to the
 * environment (element size, devicePixelRatio, font changes, focus, link
 * hover). The host gives it an element and a `Terminal`; it gives the host a
 * grid size whenever the pty needs resizing.
 *
 *   const view = new TermView(element, { terminal });
 *   view.onResize(({ cols, rows }) => pty.resize(cols, rows));
 *   view.requestRender();          // after writing pty bytes into the engine
 *
 * Deliberately framework-free (no React, no Tauri) so the same class mounts
 * into a pane in this app and into a tab in a future merged app.
 */

import { fitGrid, sameGrid, type GridSize } from '../core/geometry';
import type { Terminal } from '../term';
import { urlAt, type DetectedLink } from './links';
import {
  DEFAULT_FONT,
  computeCellMetrics,
  measureFont,
  sameMetrics,
  type CellMetrics,
  type FontSpec,
} from './metrics';
import { CanvasRenderer, type CursorStyle, type HoverTarget } from './renderer';
import type { Selection } from './selection';
import { DEFAULT_THEME, type TerminalTheme } from './theme';

export interface TermViewOptions {
  terminal: Terminal;
  theme?: TerminalTheme;
  font?: FontSpec;
  /** Inset between the element's edge and the grid, in CSS pixels. */
  padding?: number;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean;
}

/** A link under the pointer: OSC 8 (with a uri from the engine) or a bare URL. */
export interface HoveredLink {
  uri: string;
  line: number;
  start: number;
  end: number;
  linkId: number;
}

const BLINK_INTERVAL_MS = 530;
/**
 * How long a synchronized-output batch (DEC 2026) may hold the frame before we
 * paint anyway. A well-behaved app closes it within a frame; a crashed one
 * must not freeze the terminal.
 */
const SYNC_TIMEOUT_MS = 150;

export class TermView {
  readonly canvas: HTMLCanvasElement;
  private renderer: CanvasRenderer;
  private terminal: Terminal;
  private font: FontSpec;
  private metrics: CellMetrics;
  private padding: number;
  private grid: GridSize;

  private frame = 0;
  private blockedSince = 0;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private blinkEnabled: boolean;
  private observer: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;
  private resizeListeners: ((grid: GridSize) => void)[] = [];
  private linkListeners: ((link: HoveredLink | null) => void)[] = [];
  private hovered: HoveredLink | null = null;
  private disposed = false;

  constructor(
    private container: HTMLElement,
    options: TermViewOptions,
  ) {
    this.terminal = options.terminal;
    this.font = options.font ?? DEFAULT_FONT;
    this.padding = options.padding ?? 0;
    this.blinkEnabled = options.cursorBlink ?? true;

    this.canvas = container.ownerDocument.createElement('canvas');
    this.canvas.className = 'term-canvas';
    // The canvas is decoration; the focusable element is the host's.
    this.canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(this.canvas);

    this.metrics = this.measure();
    this.grid = this.fit();
    this.terminal.resize(this.grid.cols, this.grid.rows);

    this.renderer = new CanvasRenderer(this.canvas, {
      terminal: this.terminal,
      metrics: this.metrics,
      theme: options.theme ?? DEFAULT_THEME,
      font: this.font,
      padding: this.padding,
      ...(options.cursorStyle ? { cursorStyle: options.cursorStyle } : {}),
    });
    this.renderer.resize(container.clientWidth, container.clientHeight, this.dpr());

    this.observe();
    this.watchPixelRatio();
    this.restartBlink();
    this.container.addEventListener('mousemove', this.onMouseMove);
    this.container.addEventListener('mouseleave', this.onMouseLeave);
    this.requestRender();
  }

  // ------------------------------------------------------------------ frames

  /** Ask for a repaint on the next frame; repeated calls coalesce into one. */
  requestRender(): void {
    if (this.disposed || this.frame !== 0) return;
    this.frame = requestAnimationFrame(this.onFrame);
  }

  private onFrame = (): void => {
    this.frame = 0;
    const painted = this.renderer.render();
    if (painted) {
      this.blockedSince = 0;
      return;
    }
    // Synchronized output: try again next frame, but never wait forever.
    const now = performance.now();
    if (this.blockedSince === 0) this.blockedSince = now;
    if (now - this.blockedSince > SYNC_TIMEOUT_MS) {
      this.blockedSince = 0;
      this.renderer.invalidate();
    }
    this.requestRender();
  };

  /** Repaint every cell (theme change, font change, first paint). */
  refresh(): void {
    this.renderer.invalidate();
    this.requestRender();
  }

  // ------------------------------------------------------------------ layout

  private dpr(): number {
    return this.container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  }

  private measure(): CellMetrics {
    const context = this.container.ownerDocument.createElement('canvas').getContext('2d');
    // No text engine (a headless test environment): fall back to metrics
    // derived from the font size rather than failing to mount.
    if (!context) return computeCellMetrics({ advance: 0, ascent: 0, descent: 0 }, this.font);
    return measureFont(context, this.font);
  }

  private fit(): GridSize {
    return fitGrid(
      this.container.clientWidth,
      this.container.clientHeight,
      { width: this.metrics.width, height: this.metrics.height },
      this.padding,
    );
  }

  private observe(): void {
    const view = this.container.ownerDocument.defaultView;
    if (!view || typeof view.ResizeObserver !== 'function') return;
    this.observer = new view.ResizeObserver(() => this.relayout());
    this.observer.observe(this.container);
  }

  /**
   * Chrome fires no event for a DPI change; the standard trick is a media
   * query on the current ratio, which stops matching the moment it changes.
   */
  private watchPixelRatio(): void {
    const view = this.container.ownerDocument.defaultView;
    if (!view?.matchMedia) return;
    this.dprQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.dprQuery = view.matchMedia(`(resolution: ${this.dpr()}dppx)`);
    this.dprQuery.addEventListener('change', this.onPixelRatioChange);
  }

  private onPixelRatioChange = (): void => {
    this.watchPixelRatio();
    this.relayout(true);
  };

  /** Re-measure and, if the grid changed, resize the engine and tell the host. */
  private relayout(force = false): void {
    if (this.disposed) return;
    this.renderer.resize(this.container.clientWidth, this.container.clientHeight, this.dpr());
    const next = this.fit();
    if (!force && sameGrid(this.grid, next)) {
      this.requestRender();
      return;
    }
    this.grid = next;
    this.terminal.resize(next.cols, next.rows);
    for (const listener of this.resizeListeners) listener(next);
    this.requestRender();
  }

  /** Called when the grid size changes — the host resizes the pty from here. */
  onResize(listener: (grid: GridSize) => void): () => void {
    this.resizeListeners.push(listener);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
    };
  }

  get gridSize(): GridSize {
    return this.grid;
  }

  get cellMetrics(): CellMetrics {
    return this.metrics;
  }

  // ------------------------------------------------------------------ config

  setFont(font: FontSpec): void {
    this.font = font;
    const metrics = this.measure();
    if (sameMetrics(this.metrics, metrics)) {
      this.metrics = metrics;
      this.renderer.setFont(font, metrics);
      this.requestRender();
      return;
    }
    this.metrics = metrics;
    this.renderer.setFont(font, metrics);
    this.relayout(true);
  }

  setTheme(theme: TerminalTheme): void {
    // The renderer seeds the engine's OSC 10/11/12 defaults from the theme.
    this.renderer.setTheme(theme);
    this.requestRender();
  }

  setCursorStyle(style: CursorStyle, blink?: boolean): void {
    this.renderer.setCursorStyle(style);
    if (blink !== undefined && blink !== this.blinkEnabled) {
      this.blinkEnabled = blink;
      this.restartBlink();
    }
    this.requestRender();
  }

  setFocused(focused: boolean): void {
    this.renderer.setFocused(focused);
    this.restartBlink();
    this.requestRender();
  }

  setSelection(selection: Selection | null): void {
    this.renderer.setSelection(selection);
    this.requestRender();
  }

  /** The application changed colors (OSC 4/10/11/12). */
  refreshColors(): void {
    this.renderer.refreshColors();
    this.requestRender();
  }

  private restartBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.renderer.setCursorBlinkOn(true);
    if (!this.blinkEnabled || this.disposed) return;
    let on = true;
    this.blinkTimer = setInterval(() => {
      on = !on;
      this.renderer.setCursorBlinkOn(on);
      this.requestRender();
    }, BLINK_INTERVAL_MS);
  }

  // ------------------------------------------------------------- coordinates

  /** Mouse event → absolute buffer position (the coordinates selection uses). */
  positionAt(event: { clientX: number; clientY: number }): { line: number; col: number } {
    const rect = this.canvas.getBoundingClientRect();
    const { col, row } = this.renderer.cellAt(event.clientX - rect.left, event.clientY - rect.top);
    return { line: this.terminal.topLine + row, col };
  }

  // -------------------------------------------------------------------- links

  private onMouseMove = (event: MouseEvent): void => {
    const { line, col } = this.positionAt(event);
    this.setHovered(this.linkAt(line, col));
  };

  private onMouseLeave = (): void => this.setHovered(null);

  /** The OSC 8 hyperlink or bare URL at an absolute position, if any. */
  linkAt(line: number, col: number): HoveredLink | null {
    const row = this.terminal.bufferRow(line);
    if (!row) return null;

    const linkId = row.getCell(Math.min(col, row.cols - 1)).extended?.linkId ?? 0;
    if (linkId !== 0) {
      const uri = this.terminal.hyperlink(linkId)?.uri;
      if (uri) {
        // Explicit links can span the row; underline all of their cells.
        let start = col;
        let end = col + 1;
        while (start > 0 && (row.getCell(start - 1).extended?.linkId ?? 0) === linkId) start--;
        while (end < row.cols && (row.getCell(end).extended?.linkId ?? 0) === linkId) end++;
        return { uri, line, start, end, linkId };
      }
    }

    const detected: DetectedLink | null = urlAt(row.text(), col);
    return detected ? { ...detected, line, linkId: 0 } : null;
  }

  private setHovered(link: HoveredLink | null): void {
    const same =
      link === this.hovered ||
      (link !== null &&
        this.hovered !== null &&
        link.line === this.hovered.line &&
        link.start === this.hovered.start &&
        link.uri === this.hovered.uri);
    if (same) return;
    this.hovered = link;
    const target: HoverTarget | null = link
      ? link.linkId !== 0
        ? { linkId: link.linkId }
        : { line: link.line, start: link.start, end: link.end }
      : null;
    this.renderer.setHover(target);
    this.container.style.cursor = link ? 'pointer' : '';
    for (const listener of this.linkListeners) listener(link);
    this.requestRender();
  }

  /** Notified when the link under the pointer changes (null when it leaves one). */
  onLinkHover(listener: (link: HoveredLink | null) => void): () => void {
    this.linkListeners.push(listener);
    return () => {
      this.linkListeners = this.linkListeners.filter((l) => l !== listener);
    };
  }

  get hoveredLink(): HoveredLink | null {
    return this.hovered;
  }

  // ----------------------------------------------------------------- teardown

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.blinkTimer !== null) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    this.observer?.disconnect();
    this.observer = null;
    this.dprQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.dprQuery = null;
    this.container.removeEventListener('mousemove', this.onMouseMove);
    this.container.removeEventListener('mouseleave', this.onMouseLeave);
    this.canvas.remove();
  }
}
