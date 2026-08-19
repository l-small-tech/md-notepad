/**
 * theme-inject.ts: baking the app theme's resolved `--wb-*` values into a
 * saved board's root tag — the string surgery that makes a whiteboard inside
 * an `<img>` (markdown preview, rich editor) follow the app theme.
 */

import { describe, expect, it } from 'vitest';
import { createScene } from '../scene';
import { setColorMode } from '../layers';
import { serializeWhiteboard } from '../serialize';
import { boardThemeFingerprint, injectBoardThemeVars, isThemableBoardSvg } from '../theme-inject';

const VARS = new Map<string, string>([
  ['--wb-bg', '#101418'],
  ['--wb-c0', 'rgb(230, 230, 230)'],
  ['--wb-c3', 'color-mix(in srgb, #62a0ef 80%, white)'],
]);

describe('isThemableBoardSvg', () => {
  it('accepts a serialized themed board', () => {
    expect(isThemableBoardSvg(serializeWhiteboard(createScene()))).toBe(true);
  });

  it('rejects a fixed-mode board — literal colours by request', () => {
    const fixed = serializeWhiteboard(setColorMode(createScene(), 'fixed'));
    expect(isThemableBoardSvg(fixed)).toBe(false);
  });

  it('rejects a themed:false board (no wb-board class at all)', () => {
    const off = serializeWhiteboard(createScene({ meta: { themed: false } }));
    expect(isThemableBoardSvg(off)).toBe(false);
  });

  it('rejects a foreign SVG and non-SVG text', () => {
    expect(isThemableBoardSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe(false);
    expect(isThemableBoardSvg('not xml at all')).toBe(false);
  });

  it('accepts wb-board among other class tokens, wherever the tag starts', () => {
    const source = `<?xml version="1.0"?>\n<!-- note -->\n<svg xmlns="x" class="foo wb-board bar">\n</svg>`;
    expect(isThemableBoardSvg(source)).toBe(true);
  });
});

describe('injectBoardThemeVars', () => {
  it('adds an inline style with the resolved vars to the root tag only', () => {
    const board = serializeWhiteboard(createScene());
    const themed = injectBoardThemeVars(board, VARS);
    const rootEnd = themed.indexOf('>');
    const rootTag = themed.slice(0, rootEnd);
    expect(rootTag).toContain(
      'style="--wb-bg:#101418;--wb-c0:rgb(230, 230, 230);' +
        '--wb-c3:color-mix(in srgb, #62a0ef 80%, white)"',
    );
    // Nothing after the root tag changed.
    expect(themed.slice(rootEnd)).toBe(board.slice(board.indexOf('>')));
  });

  it('appends to an existing root style so the theme wins on conflicts', () => {
    const source = `<svg xmlns="x" class="wb-board" style="outline:none;">\n</svg>`;
    const themed = injectBoardThemeVars(source, VARS);
    expect(themed).toContain('style="outline:none;--wb-bg:#101418;');
    expect(themed.match(/style=/g)).toHaveLength(1);
  });

  it('keeps a single-quoted style attribute single-quoted', () => {
    const source = `<svg xmlns="x" class="wb-board" style='fill:url("#p")'>\n</svg>`;
    const themed = injectBoardThemeVars(source, VARS);
    expect(themed).toContain(`style='fill:url("#p");--wb-bg:#101418;`);
  });

  it('passes non-themable sources through byte-identical', () => {
    const fixed = serializeWhiteboard(setColorMode(createScene(), 'fixed'));
    expect(injectBoardThemeVars(fixed, VARS)).toBe(fixed);
    const foreign = '<svg xmlns="x"><rect/></svg>';
    expect(injectBoardThemeVars(foreign, VARS)).toBe(foreign);
  });

  it('passes through unchanged when no vars resolved', () => {
    const board = serializeWhiteboard(createScene());
    expect(injectBoardThemeVars(board, new Map())).toBe(board);
  });

  it('handles a quoted ">" inside an attribute before the tag closes', () => {
    const source = `<svg xmlns="x" class="wb-board" data-x="a>b">\n</svg>`;
    const themed = injectBoardThemeVars(source, VARS);
    expect(themed).toContain('data-x="a>b" style="--wb-bg:#101418;');
  });
});

describe('boardThemeFingerprint', () => {
  it('is stable for equal var sets and distinct for different ones', () => {
    const same = new Map(VARS);
    expect(boardThemeFingerprint(VARS)).toBe(boardThemeFingerprint(same));
    const other = new Map(VARS);
    other.set('--wb-bg', '#ffffff');
    expect(boardThemeFingerprint(other)).not.toBe(boardThemeFingerprint(VARS));
  });
});
