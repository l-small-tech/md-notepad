/**
 * color-mode.ts: reading a saved board's colour mode off its root tag and
 * flipping it by re-serializing — the preview / rich-editor right-click
 * toggle's pure half — plus the `.svg` reference scan it uses for "all boards
 * in this document".
 */

import { describe, expect, it } from 'vitest';
import { boardColorModeOf, svgImageSources, withBoardColorMode } from '../color-mode';
import { setColorMode } from '../layers';
import { createScene } from '../scene';
import { serializeWhiteboard } from '../serialize';
import { isThemableBoardSvg } from '../theme-inject';

const themed = serializeWhiteboard(createScene());
const fixed = serializeWhiteboard(setColorMode(createScene(), 'fixed'));
const off = serializeWhiteboard(createScene({ meta: { themed: false } }));
const foreign = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

describe('boardColorModeOf', () => {
  it('reads themed and fixed off the serializer output', () => {
    expect(boardColorModeOf(themed)).toBe('themed');
    expect(boardColorModeOf(fixed)).toBe('fixed');
  });

  it('is null for boards without a dual representation and for foreign text', () => {
    expect(boardColorModeOf(off)).toBeNull();
    expect(boardColorModeOf(foreign)).toBeNull();
    expect(boardColorModeOf('nope')).toBeNull();
  });

  it('finds the tokens among foreign classes and after a prolog', () => {
    const src = `<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="x" class="foo wb-board wb-fixed bar">\n</svg>`;
    expect(boardColorModeOf(src)).toBe('fixed');
  });
});

describe('withBoardColorMode', () => {
  it('flips themed → fixed → themed and lands back on the identical bytes', () => {
    const toFixed = withBoardColorMode(themed, 'fixed');
    expect(toFixed).toBe(fixed);
    expect(boardColorModeOf(toFixed)).toBe('fixed');
    expect(isThemableBoardSvg(toFixed)).toBe(false);
    expect(withBoardColorMode(toFixed, 'themed')).toBe(themed);
  });

  it('returns the very same string when nothing would change', () => {
    expect(withBoardColorMode(themed, 'themed')).toBe(themed);
    expect(withBoardColorMode(fixed, 'fixed')).toBe(fixed);
    expect(withBoardColorMode(off, 'fixed')).toBe(off);
    expect(withBoardColorMode(foreign, 'fixed')).toBe(foreign);
  });
});

describe('svgImageSources', () => {
  it('collects markdown and html svg refs in order, once each', () => {
    const md = [
      '# Notes',
      '![a](./boards/a.svg "title")',
      '![png](shot.png)',
      '![b](<sub dir/b.SVG>)',
      '<img src="c.svg" alt="c">',
      "<p><img alt='d' src='d.svg'></p>",
      '![again](./boards/a.svg)',
      'https://x.test/e.svg',
    ].join('\n');
    expect(svgImageSources(md)).toEqual(['./boards/a.svg', 'sub dir/b.SVG', 'c.svg', 'd.svg']);
  });

  it('is empty for a document with no svg images', () => {
    expect(svgImageSources('plain text ![i](i.png)')).toEqual([]);
  });
});
