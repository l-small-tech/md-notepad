import { beforeEach, describe, expect, it } from 'vitest';
import { Terminal } from '../../term';
import { CanvasRenderer } from '../renderer';
import { DEFAULT_DARK_THEME } from '../theme';
import { computeCellMetrics } from '../metrics';

/**
 * A recording 2D context. The renderer's contract is "which canvas calls, with
 * which arguments" — recording them tests the paint logic exactly, and without
 * a real text engine (jsdom has none) or pixel comparisons.
 */
interface Call {
  op: string;
  args: number[];
  text?: string;
  fill?: string;
  stroke?: string;
  font?: string;
}

function fakeCanvas() {
  const calls: Call[] = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    textBaseline: 'alphabetic',
    clearRect: (...args: number[]) => calls.push({ op: 'clearRect', args }),
    fillRect: (...args: number[]) => calls.push({ op: 'fillRect', args, fill: context.fillStyle }),
    strokeRect: (...args: number[]) =>
      calls.push({ op: 'strokeRect', args, stroke: context.strokeStyle }),
    fillText: (text: string, ...args: number[]) =>
      calls.push({ op: 'fillText', args, text, fill: context.fillStyle, font: context.font }),
    setTransform: (...args: number[]) => calls.push({ op: 'setTransform', args }),
    save: () => calls.push({ op: 'save', args: [] }),
    restore: () => calls.push({ op: 'restore', args: [] }),
    beginPath: () => calls.push({ op: 'beginPath', args: [] }),
    moveTo: (...args: number[]) => calls.push({ op: 'moveTo', args }),
    lineTo: (...args: number[]) => calls.push({ op: 'lineTo', args }),
    quadraticCurveTo: (...args: number[]) => calls.push({ op: 'quadraticCurveTo', args }),
    setLineDash: () => calls.push({ op: 'setLineDash', args: [] }),
    stroke: () => calls.push({ op: 'stroke', args: [] }),
  };
  const canvas = {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getContext: () => context,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, calls, context };
}

const METRICS = computeCellMetrics(
  { advance: 8, ascent: 11, descent: 3 },
  {
    family: 'monospace',
    size: 14,
    lineHeight: 1.2,
  },
);

const COLS = 10;
const ROWS = 4;

function setup() {
  const { canvas, calls } = fakeCanvas();
  const terminal = new Terminal({ cols: COLS, rows: ROWS });
  const renderer = new CanvasRenderer(canvas, {
    terminal,
    metrics: METRICS,
    theme: DEFAULT_DARK_THEME,
  });
  renderer.resize(COLS * METRICS.width, ROWS * METRICS.height, 1);
  calls.length = 0;
  return { canvas, calls, terminal, renderer };
}

const ops = (calls: Call[], op: string) => calls.filter((call) => call.op === op);
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`;

describe('CanvasRenderer', () => {
  let harness: ReturnType<typeof setup>;

  beforeEach(() => {
    harness = setup();
  });

  it('scales the backing store for HiDPI and draws in CSS pixels', () => {
    const { canvas, calls, renderer } = harness;
    renderer.resize(200, 100, 2);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    expect(canvas.style.width).toBe('200px');
    expect(ops(calls, 'setTransform').at(-1)!.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('paints every row on the first frame', () => {
    const { calls, renderer } = harness;
    renderer.render();
    expect(ops(calls, 'clearRect')).toHaveLength(ROWS);
  });

  it('repaints only the rows the engine marked dirty', () => {
    const { calls, terminal, renderer } = harness;
    renderer.render();
    calls.length = 0;

    terminal.write('\x1b[3;1Hhi'); // row index 2
    renderer.render();
    const cleared = ops(calls, 'clearRect').map((call) => call.args[1]);
    expect(cleared).toContain(2 * METRICS.height);
    expect(cleared.length).toBeLessThan(ROWS);
  });

  it('leaves default-background cells transparent', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25lplain'); // cursor hidden: only cell backgrounds remain
    renderer.render();
    expect(ops(calls, 'fillRect')).toHaveLength(0);
    expect(ops(calls, 'fillText')[0]!.text).toBe('plain');
  });

  it('paints an explicit background opaquely, merged across the run', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25l\x1b[41mabc');
    renderer.render();
    const rect = ops(calls, 'fillRect')[0]!;
    expect(rect.fill).toBe(hex(DEFAULT_DARK_THEME.ansi[1]!));
    expect(rect.args).toEqual([0, 0, 3 * METRICS.width, METRICS.height]);
  });

  it('positions text on the row baseline, using the bold face for bold cells', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25l\x1b[2;3H\x1b[1mbold');
    renderer.render();
    const text = ops(calls, 'fillText').find((call) => call.text === 'bold')!;
    expect(text.args).toEqual([2 * METRICS.width, METRICS.height + METRICS.baseline]);
    expect(text.font).toContain('bold');
  });

  it('draws a block cursor and the glyph beneath it', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('X\x1b[1;1H');
    renderer.render();
    const cursor = ops(calls, 'fillRect').at(-1)!;
    expect(cursor.args).toEqual([0, 0, METRICS.width, METRICS.height]);
    expect(cursor.fill).toBe(hex(DEFAULT_DARK_THEME.cursor));
    expect(ops(calls, 'fillText').at(-1)!.text).toBe('X');
  });

  it('draws a hollow cursor when the pane is not focused', () => {
    const { calls, renderer } = harness;
    renderer.setFocused(false);
    renderer.render();
    expect(ops(calls, 'strokeRect')).toHaveLength(1);
    expect(ops(calls, 'fillRect')).toHaveLength(0);
  });

  it('draws a bar cursor as a sliver of the cell', () => {
    const { calls, renderer } = harness;
    renderer.setCursorStyle('bar');
    renderer.render();
    const cursor = ops(calls, 'fillRect').at(-1)!;
    expect(cursor.args[2]).toBeLessThan(METRICS.width);
    expect(cursor.args[3]).toBe(METRICS.height);
  });

  it('hides the cursor while the blink phase is off', () => {
    const { calls, renderer } = harness;
    renderer.setCursorBlinkOn(false);
    renderer.render();
    expect(ops(calls, 'fillRect')).toHaveLength(0);
  });

  it('honors DECTCEM', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25l');
    renderer.render();
    expect(ops(calls, 'fillRect')).toHaveLength(0);
  });

  it('paints nothing while a synchronized-output batch is open', () => {
    const { calls, terminal, renderer } = harness;
    renderer.render();
    calls.length = 0;
    terminal.write('\x1b[?2026h');
    terminal.write('flickery');
    expect(renderer.render()).toBe(false);
    expect(calls).toHaveLength(0);

    // The engine's dirty rows survived the skipped frame, so nothing is lost.
    terminal.write('\x1b[?2026l');
    expect(renderer.render()).toBe(true);
    expect(ops(calls, 'fillText').some((call) => call.text === 'flickery')).toBe(true);
  });

  it('forces a frame through an unclosed synchronized-output batch', () => {
    const { calls, terminal, renderer } = harness;
    renderer.render();
    calls.length = 0;
    // A batch the application opens and never closes — a crashed TUI, a pty
    // killed mid-frame. Without the forcing render the surface never paints
    // again, which reads to the user as a frozen terminal.
    terminal.write('\x1b[?2026h');
    terminal.write('stranded');
    expect(renderer.render()).toBe(false);
    expect(calls).toHaveLength(0);

    expect(renderer.render(true)).toBe(true);
    expect(ops(calls, 'fillText').some((call) => call.text === 'stranded')).toBe(true);
  });

  it('paints normally again once an abandoned batch is dropped', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?2026h');
    expect(renderer.render()).toBe(false);

    terminal.abortSynchronizedOutput();
    calls.length = 0;
    terminal.write('recovered');
    expect(renderer.render()).toBe(true);
    expect(ops(calls, 'fillText').some((call) => call.text === 'recovered')).toBe(true);
  });

  it('paints the selection background over the selected columns', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25lhello');
    renderer.setSelection({ anchor: { line: 0, col: 1 }, head: { line: 0, col: 3 } });
    renderer.render();
    const rect = ops(calls, 'fillRect')[0]!;
    expect(rect.fill).toBe(hex(DEFAULT_DARK_THEME.selection));
    expect(rect.args).toEqual([METRICS.width, 0, 2 * METRICS.width, METRICS.height]);
  });

  it('underlines the hovered link', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25lhttp://a.t');
    renderer.setHover({ line: 0, start: 0, end: 10 });
    renderer.render();
    const underline = ops(calls, 'fillRect').find((call) => call.args[3] === METRICS.lineThickness);
    expect(underline).toBeDefined();
    expect(underline!.args[2]).toBe(10 * METRICS.width);
  });

  it('draws SGR 4 underlines under the baseline', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25l\x1b[4mup');
    renderer.render();
    const underline = ops(calls, 'fillRect')[0]!;
    expect(underline.args[1]).toBe(METRICS.baseline + METRICS.underlineOffset);
    expect(underline.args[3]).toBe(METRICS.lineThickness);
  });

  it('strokes curly and dashed underlines instead of filling them', () => {
    const { calls, terminal, renderer } = harness;
    terminal.write('\x1b[?25l\x1b[4:3mcurly');
    renderer.render();
    expect(ops(calls, 'stroke')).toHaveLength(1);
    expect(ops(calls, 'quadraticCurveTo').length).toBeGreaterThan(0);
  });

  it('repaints everything when the theme changes', () => {
    const { calls, renderer } = harness;
    renderer.render();
    calls.length = 0;
    renderer.setTheme({ ...DEFAULT_DARK_THEME, foreground: 0x00ff00 });
    renderer.render();
    expect(ops(calls, 'clearRect')).toHaveLength(ROWS);
  });

  it('maps pixels to cells, clamped to the grid', () => {
    const { renderer } = harness;
    expect(renderer.cellAt(0, 0)).toEqual({ col: 0, row: 0 });
    expect(renderer.cellAt(METRICS.width * 2.5, METRICS.height * 1.5)).toEqual({
      col: 2,
      row: 1,
    });
    expect(renderer.cellAt(-50, 9999)).toEqual({ col: 0, row: ROWS - 1 });
  });

  it('renders scrollback when the viewport is scrolled up', () => {
    const { calls, terminal, renderer } = harness;
    for (let i = 0; i < 8; i++) terminal.write(`line${i}\r\n`);
    renderer.render();
    calls.length = 0;

    terminal.scrollViewport(2);
    renderer.render();
    const drawn = ops(calls, 'fillText').map((call) => call.text);
    expect(drawn).toContain('line3');
    // The live cursor is below the viewport now, so it must not be painted.
    expect(ops(calls, 'fillRect')).toHaveLength(0);
  });
});
