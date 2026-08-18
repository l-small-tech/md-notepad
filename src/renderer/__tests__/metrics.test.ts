import { describe, expect, it } from 'vitest';
import {
  computeCellMetrics,
  fontString,
  measureFont,
  sameMetrics,
  type FontSpec,
  type TextMeasurer,
} from '../metrics';

const spec: FontSpec = { family: "'JetBrains Mono', monospace", size: 14, lineHeight: 1.2 };

describe('computeCellMetrics', () => {
  it('rounds the cell height so rows land on whole pixels', () => {
    const metrics = computeCellMetrics({ advance: 8.4, ascent: 11, descent: 3 }, spec);
    expect(metrics.height).toBe(17); // 14 * 1.2 = 16.8
    expect(Number.isInteger(metrics.height)).toBe(true);
  });

  it('keeps the advance fractional — rounding it drifts across a row', () => {
    const metrics = computeCellMetrics({ advance: 8.4, ascent: 11, descent: 3 }, spec);
    expect(metrics.width).toBeCloseTo(8.4);
  });

  it('centers the glyph box in the line box', () => {
    const metrics = computeCellMetrics({ advance: 8, ascent: 10, descent: 2 }, spec);
    // height 17, glyph box 12 → 2.5px of leading above the ascent.
    expect(metrics.baseline).toBe(13);
    expect(metrics.baseline).toBeLessThanOrEqual(metrics.height);
  });

  it('falls back to size-derived numbers when the font engine reports nothing', () => {
    const metrics = computeCellMetrics({ advance: 0, ascent: 0, descent: 0 }, spec);
    expect(metrics.width).toBeGreaterThan(0);
    expect(metrics.baseline).toBeGreaterThan(0);
    expect(metrics.height).toBe(17);
  });

  it('never produces a zero-thickness underline', () => {
    const tiny = computeCellMetrics({ advance: 4, ascent: 5, descent: 1 }, { ...spec, size: 6 });
    expect(tiny.lineThickness).toBeGreaterThanOrEqual(1);
    expect(tiny.underlineOffset).toBeGreaterThanOrEqual(1);
  });
});

describe('fontString', () => {
  it('emits the CSS shorthand in the order canvas expects', () => {
    expect(fontString(spec)).toBe("14px 'JetBrains Mono', monospace");
    expect(fontString(spec, true)).toBe("bold 14px 'JetBrains Mono', monospace");
    expect(fontString(spec, true, true)).toBe("italic bold 14px 'JetBrains Mono', monospace");
  });
});

describe('measureFont', () => {
  /** A stub text engine: every glyph is 9px wide, ascent 11, descent 3. */
  function measurer(): TextMeasurer & { fonts: string[] } {
    return {
      font: 'initial',
      fonts: [] as string[],
      measureText(text: string) {
        this.fonts.push(this.font);
        return {
          width: text.length * 9,
          actualBoundingBoxAscent: 11,
          actualBoundingBoxDescent: 3,
        };
      },
    };
  }

  it('averages the advance over a sample and restores the context font', () => {
    const stub = measurer();
    const metrics = measureFont(stub, spec);
    expect(metrics.width).toBeCloseTo(9);
    expect(stub.fonts[0]).toBe(fontString(spec));
    expect(stub.font).toBe('initial');
  });

  it('falls back to the font bounding box when actual bounds are missing', () => {
    const stub: TextMeasurer = {
      font: '',
      measureText: (text: string) => ({
        width: text.length * 7,
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
      }),
    };
    const metrics = measureFont(stub, spec);
    expect(metrics.width).toBeCloseTo(7);
    expect(metrics.baseline).toBeGreaterThan(0);
  });
});

describe('sameMetrics', () => {
  it('compares only what changes the layout', () => {
    const a = computeCellMetrics({ advance: 8, ascent: 10, descent: 2 }, spec);
    const b = computeCellMetrics({ advance: 8, ascent: 10, descent: 2 }, spec);
    expect(sameMetrics(a, b)).toBe(true);
    expect(sameMetrics(a, { ...a, width: 9 })).toBe(false);
  });
});
