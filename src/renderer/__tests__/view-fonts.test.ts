/**
 * A pane that mounts while its web font is still loading measures the FALLBACK
 * face — and every cell position, the cursor included, is computed from a cell
 * width the canvas will not paint with once the real face arrives. The window
 * that has just opened is where this bites: its panes are the ones that mount
 * too early (a tab torn off into a new window, a session restored at launch).
 *
 * The whole DOM `TermView` touches is faked here, in the same spirit as
 * `renderer.test.ts`'s recording context: enough surface to mount, and full
 * control over what the font measures and when it finishes loading.
 */
import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '../../term';
import { TermView } from '../view';

/** Advance per character, in CSS px, that `measureText` reports right now. */
let advance = 7;

function fakeContext() {
  return {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({
      width: text.length * advance,
      actualBoundingBoxAscent: 11,
      actualBoundingBoxDescent: 3,
    }),
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    fillText: () => {},
    setTransform: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    setLineDash: () => {},
    rect: () => {},
    clip: () => {},
    translate: () => {},
    stroke: () => {},
    fill: () => {},
    closePath: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
}

function fakeCanvas() {
  return {
    className: '',
    width: 0,
    height: 0,
    style: {},
    setAttribute: () => {},
    remove: () => {},
    getContext: () => fakeContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
}

/** A container whose document hands out fake canvases and a controllable
 *  `fonts.ready`, plus the window bits the view reaches for. */
function mount(size = { width: 808, height: 608 }) {
  let resolveFonts: () => void = () => {};
  const fontsReady = new Promise<void>((resolve) => {
    resolveFonts = resolve;
  });
  const container = {
    clientWidth: size.width,
    clientHeight: size.height,
    className: '',
    appendChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    ownerDocument: {
      createElement: () => fakeCanvas(),
      fonts: { ready: fontsReady },
      defaultView: {
        devicePixelRatio: 1,
        // No ResizeObserver: the view skips observing, which suits a test
        // that changes exactly one thing.
        matchMedia: () => ({ addEventListener: () => {}, removeEventListener: () => {} }),
      },
    },
  };
  return { container, letFontsLoad: resolveFonts };
}

describe('TermView cell metrics', () => {
  it('re-measures when the web font finishes loading, and repaints', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      advance = 7; // the fallback face, still all the browser can measure
      const terminal = new Terminal({ cols: 80, rows: 24 });
      const { container, letFontsLoad } = mount();
      const view = new TermView(container as unknown as HTMLElement, { terminal, padding: 8 });

      const mounted = view.gridSize;
      expect(mounted.cols).toBe(Math.floor((808 - 16) / 7));
      expect(view.cellMetrics.width).toBe(7);

      // The real face arrives: wider cells, so fewer of them fit.
      advance = 8.4;
      const resized = vi.fn();
      view.onResize(resized);
      letFontsLoad();
      await new Promise((r) => setTimeout(r, 0));

      expect(view.cellMetrics.width).toBe(8.4);
      expect(view.gridSize.cols).toBe(Math.floor((808 - 16) / 8.4));
      // The engine follows, so a shell is told the truth about its width…
      expect(terminal.cols).toBe(view.gridSize.cols);
      expect(resized).toHaveBeenCalledWith(view.gridSize);
      view.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves a pane alone when the font it measured is the one that loaded', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      advance = 8.4;
      const terminal = new Terminal({ cols: 80, rows: 24 });
      const { container, letFontsLoad } = mount();
      const view = new TermView(container as unknown as HTMLElement, { terminal, padding: 8 });
      const before = view.gridSize;

      const resized = vi.fn();
      view.onResize(resized);
      letFontsLoad();
      await new Promise((r) => setTimeout(r, 0));

      expect(view.gridSize).toEqual(before);
      expect(resized).not.toHaveBeenCalled();
      view.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
