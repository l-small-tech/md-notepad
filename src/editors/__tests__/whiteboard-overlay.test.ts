/**
 * The drawing overlay must stay transparent under the FILE's own palette
 * stylesheet. The board's `<svg>` is adopted into the page together with its
 * `<style wb:role="palette">` block, whose surface rule
 * (`svg.wb-board:not(.wb-fixed){background:…}`) also matches the overlay — it
 * carries `wb-board` so preview ink themes like committed ink. When that rule
 * wins, the overlay is opaque and every stroke "draws, then vanishes on
 * release" the moment the preview clears. This has regressed twice, once by a
 * palette-selector change that merely raised specificity (0,2,0 → 0,2,1), so
 * the override has to be `!important`, not a specificity contest.
 *
 * Verified in Chrome (2026-09-02): without `!important` the overlay computes
 * to the board surface colour; with it, `rgba(0,0,0,0)`. jsdom does not
 * apply an SVG-embedded stylesheet, so the cascade itself cannot be tested
 * here — this pins the two halves of the contract instead.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { blankWhiteboardSource } from '../../core/whiteboard/serialize';

const APP_CSS = readFileSync('src/styles/whiteboard.css', 'utf8');

describe('whiteboard overlay transparency', () => {
  test('the palette block a board brings along paints the svg.wb-board surface', () => {
    // The hazard: this rule matches the overlay too (it is an `svg.wb-board`).
    expect(blankWhiteboardSource()).toMatch(/svg\.wb-board:not\(\.wb-fixed\)\{background:/);
  });

  test('the app declares the overlay background none with !important', () => {
    const rule = /\.wb-canvas\s*>\s*\.wb-live\s*\{([^}]*)\}/.exec(APP_CSS);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/background:\s*none\s*!important/);
  });
});
