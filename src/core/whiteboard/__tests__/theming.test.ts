/**
 * Themable ink (phase 2.5): the serializer-owned palette `<style>` block, the
 * palette-slot classes, and their round-trip behaviour.
 *
 * The contract under test: a saved board keeps its concrete light-theme hexes
 * in presentation attributes (the truth for any CSS-less renderer) and gains
 * `class="wb-cN"` / `class="wb-bg"` plus one regenerated
 * `<style wb:role="palette">` block that themes those classes via `var()` —
 * scoped to `svg.wb-board`, never `:root`, because the file gets inlined into
 * HTML pages. Custom colours and `"themed": false` documents opt out entirely.
 */

import { describe, expect, it } from 'vitest';
import { parseWhiteboard } from '../parse';
import { createLayer, createScene, type SceneElement, type StrokeElement } from '../scene';
import { isThemed, serializeElement, serializeWhiteboard } from '../serialize';
import { BOARD_BACKGROUND_DARK, PALETTE, PALETTE_DARK } from '../tool-settings';

function stroke(color: string): StrokeElement {
  return {
    kind: 'stroke',
    id: null,
    tool: 'pen',
    d: 'M1,1 C2,2 3,3 4,4',
    stroke: color,
    strokeWidth: 3,
    opacity: null,
    widths: null,
  };
}

function boardWith(elements: SceneElement[], meta: Record<string, unknown> = {}) {
  return createScene({ layers: [createLayer({ id: 'aaaa', elements })], meta });
}

describe('the palette style block', () => {
  const blank = serializeWhiteboard(createScene());

  it('is emitted once, scoped to svg.wb-board, with the root class', () => {
    expect(blank.match(/<style wb:role="palette">/g)).toHaveLength(1);
    expect(blank).toContain('class="wb-board"');
    // A blank board is INFINITE — no page rect; the surface colour comes from
    // the block's background rule on the svg viewport itself.
    expect(blank).not.toContain('wb:role="background"');
    expect(blank).toContain('svg.wb-board{background:var(--wb-bg,#ffffff)}');
    // Never :root — the file gets inlined into HTML contexts.
    expect(blank).not.toContain(':root');
  });

  it('tags the page rect wb-bg on a page board', () => {
    const paged = serializeWhiteboard(createScene({ background: '#ffffff' }));
    expect(paged).toContain('<rect wb:role="background" class="wb-bg"');
  });

  it('defines every slot with its light default and dark override', () => {
    PALETTE.forEach((hex, slot) => {
      expect(blank).toContain(`--wb-c${slot}:${hex}`);
      expect(blank).toContain(`--wb-c${slot}:${PALETTE_DARK[slot]}`);
      // The class rule falls back to the literal hex for var()-less renderers.
      expect(blank).toContain(`stroke:var(--wb-c${slot},${hex})`);
    });
    expect(blank).toContain('@media (prefers-color-scheme: dark)');
    expect(blank).toContain(`--wb-bg:${BOARD_BACKGROUND_DARK}`);
  });

  it('excludes text from the stroke rule and themes text via fill', () => {
    expect(blank).toContain('.wb-c0:not(text){stroke:');
    expect(blank).toContain('text.wb-c0{fill:');
  });

  it('round-trips as a fixed point', () => {
    const again = serializeWhiteboard(parseWhiteboard(blank));
    expect(again).toBe(blank);
  });

  it('replaces a stale block instead of duplicating or freezing it', () => {
    const stale = blank.replace(
      '<style wb:role="palette">',
      '<style wb:role="palette">svg.wb-board{--wb-c0:#0000ff}',
    );
    const out = serializeWhiteboard(parseWhiteboard(stale));
    expect(out).toBe(blank);
  });

  it('leaves a foreign top-level <style> alone (prelude, verbatim)', () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <style>.mine{fill:red}</style>
  <g wb:layer="aaaa" wb:name="L"/>
</svg>`;
    const out = serializeWhiteboard(parseWhiteboard(source));
    expect(out).toContain('<style>.mine{fill:red}</style>');
    // ...and still gets exactly one palette block of its own.
    expect(out.match(/<style wb:role="palette">/g)).toHaveLength(1);
  });
});

describe('palette-slot classes', () => {
  it('tags a palette stroke with its slot class, derived from the colour', () => {
    const out = serializeWhiteboard(boardWith([stroke(PALETTE[6]!)]));
    expect(out).toContain(`wb:tool="pen" class="wb-c6" d=`);
  });

  it('leaves a custom hex classless — an explicit opt-out of theming', () => {
    const out = serializeWhiteboard(boardWith([stroke('#123456')]));
    // The palette block still exists, but the ELEMENT carries no slot class.
    expect(out).toContain('wb:tool="pen" d=');
    expect(out).not.toContain('class="wb-c');
    expect(out).toContain('stroke="#123456"');
  });

  it('tags shapes by stroke and text by fill', () => {
    const shape: SceneElement = {
      kind: 'shape',
      id: null,
      shape: 'rect',
      geom: { x: 0, y: 0, width: 5, height: 5 },
      stroke: PALETTE[1]!,
      strokeWidth: 2,
      fill: 'none',
      opacity: null,
    };
    const text: SceneElement = {
      kind: 'text',
      id: null,
      fontFamily: null,
      x: 1,
      y: 2,
      fontSize: 16,
      fill: PALETTE[4]!,
      lines: ['hi'],
    };
    const out = serializeWhiteboard(boardWith([shape, text]));
    expect(out).toContain('<rect class="wb-c1"');
    expect(out).toContain('<text class="wb-c4"');
  });

  it('classes survive a round trip because they are re-derived, not stored', () => {
    const first = serializeWhiteboard(boardWith([stroke(PALETTE[2]!)]));
    expect(serializeWhiteboard(parseWhiteboard(first))).toBe(first);
  });

  it('serializeElement defaults to themed — the drag preview matches the commit', () => {
    expect(serializeElement(stroke(PALETTE[3]!))).toContain('class="wb-c3"');
    expect(serializeElement(stroke(PALETTE[3]!), false)).not.toContain('class');
  });
});

describe('opting out', () => {
  it('"themed": false suppresses the block, the classes and the root class', () => {
    const out = serializeWhiteboard(boardWith([stroke(PALETTE[0]!)], { themed: false }));
    expect(out).not.toContain('wb:role="palette"');
    expect(out).not.toContain('wb-board');
    expect(out).not.toContain('wb-c0');
    expect(out).not.toContain('wb-bg');
    expect(out).toContain('"themed":false');
    // ...and the flag itself round-trips.
    const back = parseWhiteboard(out);
    expect(isThemed(back)).toBe(false);
    expect(serializeWhiteboard(back)).toBe(out);
  });

  it('a custom background keeps its literal fill and gets no wb-bg class', () => {
    const out = serializeWhiteboard(createScene({ background: '#fff8dc' }));
    expect(out).toContain('<rect wb:role="background" x=');
    expect(out).toContain('fill="#fff8dc"');
    expect(out).not.toContain('wb-bg{fill:var(--wb-bg,#fff8dc)');
  });
});

describe('foreign root classes', () => {
  const foreign = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" class="inkscape-doc">
  <g wb:layer="aaaa" wb:name="L"/>
</svg>`;

  it('merges wb-board in front of a foreign class and round-trips stably', () => {
    const first = serializeWhiteboard(parseWhiteboard(foreign));
    expect(first).toContain('class="wb-board inkscape-doc"');
    // One class attribute on the root, not two.
    expect(first.slice(0, first.indexOf('>')).match(/class=/g)).toHaveLength(1);
    const second = serializeWhiteboard(parseWhiteboard(first));
    expect(second).toBe(first);
    // No token duplication over repeated trips.
    expect(second.match(/wb-board/g)!.length).toBe(first.match(/wb-board/g)!.length);
  });

  it('strips wb-board from parsed root extras so it is never doubled', () => {
    const doc = parseWhiteboard(serializeWhiteboard(parseWhiteboard(foreign)));
    const classes = doc.rootExtras.filter((a) => a.name === 'class');
    expect(classes).toEqual([{ name: 'class', value: 'inkscape-doc' }]);
  });
});
