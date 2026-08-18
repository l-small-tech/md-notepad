/**
 * Font measurement and cell geometry.
 *
 * Cell size is measured from the *actual* font once per font/size change —
 * never guessed — because every glyph position downstream is `col * width`.
 * The math is split from the canvas call so it can be unit-tested with
 * explicit numbers instead of a real text engine (which jsdom does not have).
 */

export interface FontSpec {
  /** CSS font-family list, e.g. `'JetBrains Mono', monospace`. */
  family: string;
  /** Cell font size in CSS pixels. */
  size: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
}

export const DEFAULT_FONT: FontSpec = {
  family: "'JetBrains Mono', ui-monospace, monospace",
  size: 14,
  lineHeight: 1.2,
};

/** What a text engine tells us about the font. */
export interface FontMeasurement {
  /** Advance width of one glyph in CSS pixels. */
  advance: number;
  /** Distance from the baseline to the top of the tallest glyph. */
  ascent: number;
  /** Distance from the baseline to the bottom of the deepest glyph. */
  descent: number;
}

export interface CellMetrics {
  /** Cell advance width in CSS pixels (fractional — do not round). */
  width: number;
  /** Cell height in CSS pixels (integral: rows must land on pixel boundaries). */
  height: number;
  /** Baseline offset from the top of the cell. */
  baseline: number;
  /** Thickness of underlines and strikethroughs. */
  lineThickness: number;
  /** Underline offset below the baseline. */
  underlineOffset: number;
  /** Strikethrough offset above the baseline. */
  strikeoutOffset: number;
}

/**
 * Turn a font measurement into cell geometry.
 *
 * The height is rounded so that `row * height` stays on whole pixels (blurry
 * half-pixel rows are the classic canvas-terminal artifact), and the glyph box
 * is centered inside it when the line height leaves slack.
 */
export function computeCellMetrics(measurement: FontMeasurement, spec: FontSpec): CellMetrics {
  const advance = measurement.advance > 0 ? measurement.advance : spec.size * 0.6;
  const ascent = measurement.ascent > 0 ? measurement.ascent : spec.size * 0.8;
  const descent = measurement.descent > 0 ? measurement.descent : spec.size * 0.2;

  const height = Math.max(1, Math.round(spec.size * spec.lineHeight));
  const glyphHeight = ascent + descent;
  const leading = Math.max(0, (height - glyphHeight) / 2);
  const baseline = Math.min(height, Math.round(leading + ascent));
  const lineThickness = Math.max(1, Math.round(spec.size / 14));

  return {
    width: advance,
    height,
    baseline,
    lineThickness,
    underlineOffset: Math.max(1, Math.round(descent / 2)),
    strikeoutOffset: Math.round(ascent / 3),
  };
}

/** The subset of a 2D context measuring needs — keeps this testable with a stub. */
export interface TextMeasurer {
  font: string;
  measureText(text: string): {
    width: number;
    actualBoundingBoxAscent?: number;
    actualBoundingBoxDescent?: number;
    fontBoundingBoxAscent?: number;
    fontBoundingBoxDescent?: number;
  };
}

/** The CSS `font` shorthand for a spec, optionally bold and/or italic. */
export function fontString(spec: FontSpec, bold = false, italic = false): string {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${spec.size}px ${spec.family}`;
}

/**
 * Measure `spec` with a real text engine. A monospace font gives the same
 * advance for every glyph, but averaging over a sample keeps a fallback font
 * with slight variation from accumulating drift across a row.
 */
export function measureFont(measurer: TextMeasurer, spec: FontSpec): CellMetrics {
  const previous = measurer.font;
  measurer.font = fontString(spec);
  const sample = 'MMMMMMMMMM';
  const metrics = measurer.measureText(sample);
  const box = measurer.measureText('Mgjpq|');
  measurer.font = previous;
  return computeCellMetrics(
    {
      advance: metrics.width / sample.length,
      ascent: box.actualBoundingBoxAscent ?? box.fontBoundingBoxAscent ?? 0,
      descent: box.actualBoundingBoxDescent ?? box.fontBoundingBoxDescent ?? 0,
    },
    spec,
  );
}

/** True when two metrics would paint identically — the "skip the reflow" test. */
export function sameMetrics(a: CellMetrics, b: CellMetrics): boolean {
  return a.width === b.width && a.height === b.height && a.baseline === b.baseline;
}
