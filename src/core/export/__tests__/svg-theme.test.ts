import { describe, expect, it } from 'vitest';
import { remapSvgColor, svgIntrinsicSize, themeSvg, type SvgTheme } from '../svg-theme';

/** A dark theme: black ink becomes near-white, white paper becomes near-black. */
const DARK: SvgTheme = { fg: '#e6e6e6', bg: '#1b1b1b' };
const LIGHT: SvgTheme = { fg: '#1a1a1a', bg: '#ffffff' };

describe('remapSvgColor', () => {
  it('maps pure black to the foreground and pure white to the background', () => {
    expect(remapSvgColor(0x000000, DARK)).toBe(0xe6e6e6);
    expect(remapSvgColor(0xffffff, DARK)).toBe(0x1b1b1b);
  });

  it('lands grays between the two ends, preserving the ordering', () => {
    const dark = remapSvgColor(0x333333, DARK);
    const light = remapSvgColor(0xcccccc, DARK);
    // On a dark theme the ink end is the LIGHT end, so a dark source gray
    // must come out lighter than a light source gray.
    expect(dark).toBeGreaterThan(light);
    expect(dark).toBeLessThan(0xe6e6e6);
    expect(light).toBeGreaterThan(0x1b1b1b);
  });

  it('leaves chromatic colors alone — color carries meaning in diagrams', () => {
    expect(remapSvgColor(0xd32f2f, DARK)).toBe(0xd32f2f);
    expect(remapSvgColor(0x2e7d32, DARK)).toBe(0x2e7d32);
  });

  it('treats a barely tinted gray as achromatic', () => {
    expect(remapSvgColor(0xf8f9fa, DARK)).not.toBe(0xf8f9fa);
  });

  it('leaves the drawing alone when a theme slot is not hex', () => {
    expect(remapSvgColor(0x000000, { fg: 'rgb(0,0,0)', bg: '#fff' })).toBe(0x000000);
  });
});

describe('themeSvg', () => {
  it('recolors paint attributes', () => {
    const out = themeSvg('<svg><rect fill="#ffffff" stroke="black"/></svg>', DARK);
    expect(out).toContain('fill="#1b1b1b"');
    expect(out).toContain('stroke="#e6e6e6"');
  });

  it('recolors single-quoted attributes and keeps the quote style', () => {
    expect(themeSvg("<svg><path stroke='#000'/></svg>", DARK)).toContain("stroke='#e6e6e6'");
  });

  it('recolors style attributes and <style> blocks', () => {
    const out = themeSvg(
      '<svg><style>.n { fill: #fff; stroke: #000 }</style><g style="fill:#000;opacity:.5"/></svg>',
      DARK,
    );
    expect(out).toContain('fill: #1b1b1b');
    expect(out).toContain('stroke: #e6e6e6');
    expect(out).toContain('fill: #e6e6e6;opacity:.5');
  });

  it('preserves alpha in #rrggbbaa and rgba() paints', () => {
    const out = themeSvg('<svg><rect fill="#00000080" stroke="rgba(0, 0, 0, 0.4)"/></svg>', DARK);
    expect(out).toContain('fill="#e6e6e680"');
    expect(out).toContain('stroke="rgba(230, 230, 230, 0.4)"');
  });

  it('leaves none, currentColor and url() paints untouched', () => {
    const svg = '<svg><rect fill="none" stroke="currentColor"/><g fill="url(#grad)"/></svg>';
    const out = themeSvg(svg, DARK);
    expect(out).toContain('fill="none"');
    expect(out).toContain('stroke="currentColor"');
    expect(out).toContain('fill="url(#grad)"');
  });

  it('recolors gradient stops', () => {
    const out = themeSvg('<svg><stop stop-color="#ffffff"/></svg>', DARK);
    expect(out).toContain('stop-color="#1b1b1b"');
  });

  it('substitutes custom properties so their colors can be remapped', () => {
    const out = themeSvg(
      '<svg><style>g{--ink:#000000}g path{stroke:var(--ink)}</style><path/></svg>',
      DARK,
    );
    expect(out).toContain('stroke: #e6e6e6');
    expect(out).not.toContain('var(--ink)');
  });

  it('falls back to a var() reference fallback when the property is undeclared', () => {
    const out = themeSvg('<svg><style>a{fill:var(--gone, #ffffff)}</style></svg>', DARK);
    expect(out).toContain('fill: #1b1b1b');
  });

  it('leaves a var() with neither declaration nor fallback alone', () => {
    const out = themeSvg('<svg><style>a{fill:var(--gone)}</style></svg>', DARK);
    expect(out).toContain('fill: var(--gone)');
  });

  it('collapses prefers-color-scheme blocks onto the light form', () => {
    // The reader's OS must not get a vote, and the ramp needs the LIGHT
    // palette to flip — a dark one fed in would come back inverted.
    const svg =
      '<svg><style>a{--bg:#ffffff}' +
      '@media (prefers-color-scheme: dark){a{--bg:#1e1e1e}}' +
      'a{fill:var(--bg)}</style></svg>';
    const out = themeSvg(svg, DARK);
    expect(out).not.toContain('@media');
    expect(out).toContain('fill: #1b1b1b'); // the white paper, not the dark one
  });

  it('unwraps a matching light media block in place, keeping the cascade', () => {
    const svg =
      '<svg><style>a{fill:#000000}' +
      '@media (prefers-color-scheme: light){a{fill:#ffffff}}</style></svg>';
    const out = themeSvg(svg, DARK);
    expect(out).not.toContain('@media');
    expect(out.indexOf('fill: #1b1b1b')).toBeGreaterThan(out.indexOf('fill: #e6e6e6'));
  });

  it('leaves unrelated media queries intact', () => {
    const out = themeSvg('<svg><style>@media print{a{fill:#000}}</style></svg>', DARK);
    expect(out).toContain('@media print{a{fill: #e6e6e6}}');
  });

  it('themes a whiteboard-shaped palette: paper flips, pen colors survive', () => {
    const svg =
      '<svg class="wb-board"><style>' +
      'svg.wb-board{--wb-bg:#ffffff;--wb-c0:#1a1a1a;--wb-c6:#e07b00}' +
      '@media (prefers-color-scheme: dark){svg.wb-board{--wb-bg:#1e1e1e;--wb-c0:#e6e6e6}}' +
      'svg.wb-board{background:var(--wb-bg,#ffffff)}' +
      'svg.wb-board .wb-c0:not(text){stroke:var(--wb-c0,#1a1a1a)}' +
      'svg.wb-board .wb-c6:not(text){stroke:var(--wb-c6,#e07b00)}' +
      '</style><path class="wb-c0" stroke="#1a1a1a"/></svg>';
    const out = themeSvg(svg, DARK);
    expect(out).toContain('background: #1b1b1b'); // white paper → the dark page
    // #1a1a1a is near-black, so it lands just short of the fg end.
    expect(out).toContain('.wb-c0:not(text){stroke: #d3d3d3}'); // dark ink → light
    expect(out).toContain('.wb-c6:not(text){stroke: #e07b00}'); // the orange pen stays
    expect(out).toContain('<path class="wb-c0" stroke="#d3d3d3"/>');
  });

  it('never touches text content — a label reading a hex code survives', () => {
    const out = themeSvg('<svg><text>#ffffff on black</text></svg>', DARK);
    expect(out).toContain('<text>#ffffff on black</text>');
  });

  it('pins the root fill and color so undeclared paints follow the theme', () => {
    const out = themeSvg('<svg viewBox="0 0 10 10"><rect/></svg>', DARK);
    expect(out).toContain('fill="#e6e6e6"');
    expect(out).toContain('color="#e6e6e6"');
  });

  it('leaves an existing root fill to the recoloring pass', () => {
    const out = themeSvg('<svg fill="#000"><rect/></svg>', DARK);
    expect(out).toContain('fill="#e6e6e6"');
    expect(out.match(/fill=/g)).toHaveLength(1);
  });

  it('keeps a self-closing root tag valid', () => {
    expect(themeSvg('<svg viewBox="0 0 1 1" />', DARK)).toMatch(/\/>$/);
  });

  it('strips the XML prolog and doctype', () => {
    const out = themeSvg(
      '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>',
      LIGHT,
    );
    expect(out.startsWith('<svg')).toBe(true);
  });

  it('returns markup with no svg element unchanged', () => {
    expect(themeSvg('not an image', DARK)).toBe('not an image');
  });
});

describe('svgIntrinsicSize', () => {
  it('reads width/height attributes', () => {
    expect(svgIntrinsicSize('<svg width="120" height="60"/>')).toEqual({ width: 120, height: 60 });
  });

  it('strips units', () => {
    expect(svgIntrinsicSize('<svg width="120px" height="60px"/>')).toEqual({
      width: 120,
      height: 60,
    });
  });

  it('falls back to the viewBox extent', () => {
    expect(svgIntrinsicSize('<svg viewBox="0 0 200 100"/>')).toEqual({ width: 200, height: 100 });
  });

  it('completes a missing dimension from the viewBox aspect ratio', () => {
    expect(svgIntrinsicSize('<svg width="400" viewBox="0 0 200 100"/>')).toEqual({
      width: 400,
      height: 200,
    });
    expect(svgIntrinsicSize('<svg height="50" viewBox="0 0 200 100"/>')).toEqual({
      width: 100,
      height: 50,
    });
  });

  it('ignores percentage dimensions', () => {
    expect(svgIntrinsicSize('<svg width="100%" height="100%"/>')).toBeNull();
    expect(svgIntrinsicSize('<svg width="100%" viewBox="0 0 30 10"/>')).toEqual({
      width: 30,
      height: 10,
    });
  });

  it('returns null without dimensions or a usable viewBox', () => {
    expect(svgIntrinsicSize('<svg/>')).toBeNull();
    expect(svgIntrinsicSize('<svg viewBox="0 0 0 0"/>')).toBeNull();
    expect(svgIntrinsicSize('no svg here')).toBeNull();
  });
});
