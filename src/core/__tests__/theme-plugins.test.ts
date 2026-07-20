import { describe, expect, test } from 'vitest';
import {
  parseThemePlugin,
  themeModeDeclarations,
  themePluginToCss,
  themePluginsToCss,
} from '../theme-plugins';
import { BUILT_IN_THEMES } from '../theme-seeds';

describe('parseThemePlugin', () => {
  test('accepts a well-formed theme and derives name from id when absent', () => {
    const plugin = parseThemePlugin('midnight', {
      light: { bg: '#fff', fg: '#000' },
      dark: { bg: '#000', fg: '#fff' },
    });
    expect(plugin).not.toBeNull();
    expect(plugin!.id).toBe('midnight');
    expect(plugin!.name).toBe('midnight');
    expect(plugin!.light.bg).toBe('#fff');
    expect(plugin!.dark.fg).toBe('#fff');
  });

  test('keeps an explicit name and optional css', () => {
    const plugin = parseThemePlugin('x', {
      name: 'My Theme',
      light: { accent: '#123456' },
      dark: {},
      css: '.cm-content { letter-spacing: 0.2px; }',
    });
    expect(plugin!.name).toBe('My Theme');
    expect(plugin!.css).toContain('letter-spacing');
  });

  test('tolerates missing palette keys (partial theme)', () => {
    const plugin = parseThemePlugin('partial', { light: { bg: '#eee' }, dark: {} });
    expect(plugin).not.toBeNull();
    expect(Object.keys(plugin!.light)).toEqual(['bg']);
    expect(plugin!.dark).toEqual({});
  });

  test('drops unknown keys and unsafe color values', () => {
    const plugin = parseThemePlugin('sanitize', {
      light: {
        bg: '#fff',
        fg: 'red; } body { display:none', // value that would break out of its declaration
        bogusKey: '#000', // not one of the ten palette keys
      },
      dark: { accent: 'blue\n}' }, // newline is unsafe
    });
    expect(plugin!.light.bg).toBe('#fff');
    expect(plugin!.light).not.toHaveProperty('fg');
    expect(plugin!.light).not.toHaveProperty('bogusKey');
    expect(plugin!.dark).not.toHaveProperty('accent');
  });

  test('returns null for non-objects and for empty palettes', () => {
    expect(parseThemePlugin('a', null)).toBeNull();
    expect(parseThemePlugin('a', 'nope')).toBeNull();
    expect(parseThemePlugin('a', { light: {}, dark: {} })).toBeNull();
    expect(parseThemePlugin('a', { light: { bg: '' }, dark: {} })).toBeNull();
  });

  test('parses an optional per-mode syntax block', () => {
    const plugin = parseThemePlugin('syn', {
      light: { bg: '#fff' },
      dark: { bg: '#000' },
      syntax: {
        light: { heading1: '#0a0', bold: '#111', link: '#00f' },
        dark: { heading: '#6f6' },
      },
    });
    expect(plugin!.syntax).toEqual({
      light: { heading1: '#0a0', bold: '#111', link: '#00f' },
      dark: { heading: '#6f6' },
    });
  });

  test('drops unknown/unsafe syntax keys and omits syntax when empty', () => {
    const plugin = parseThemePlugin('syn2', {
      light: { bg: '#fff' },
      dark: {},
      syntax: {
        light: { heading1: 'red; }', bogus: '#000' },
        dark: { link: '' },
      },
    });
    // Every syntax value was unsafe/unknown → no syntax block at all.
    expect(plugin!.syntax).toBeUndefined();
  });

  test('a theme with only syntax colors (no palette) is invalid', () => {
    expect(
      parseThemePlugin('syn3', { light: {}, dark: {}, syntax: { light: { heading: '#0a0' } } }),
    ).toBeNull();
  });
});

describe('themePluginToCss', () => {
  test('emits scoped light + dark blocks and appends css', () => {
    const css = themePluginToCss({
      id: 'demo',
      name: 'Demo',
      light: { bg: '#ffffff', fg: '#111111' },
      dark: { bg: '#000000' },
      css: '/* extra */',
    });
    // The light block is scoped out of dark mode so it can't leak into base.css's
    // dark cascade (see the mode-locking test below).
    expect(css).toContain(":root[data-color-scheme='demo']:not([data-theme='dark']) {");
    expect(css).toContain('--bg: #ffffff;');
    expect(css).toContain('--fg: #111111;');
    expect(css).toContain(":root[data-color-scheme='demo'][data-theme='dark'] {");
    expect(css).toContain('/* extra */');
    // No dark --fg was supplied, so it must not appear in the dark block.
    expect(css).not.toContain('--fg: #000000;');
  });

  test("a light-only key is scoped out of dark mode (doesn't leak into the dark cascade)", () => {
    // `accent` is set only for light; `dark` omits it, so in OS dark mode the app
    // must fall back to base.css's default --accent, NOT the light value.
    const css = themePluginToCss({
      id: 'partial',
      name: 'Partial',
      light: { accent: '#aabbcc' },
      dark: { bg: '#000000' },
    });
    const lightSelector = ":root[data-color-scheme='partial']:not([data-theme='dark'])";
    const darkSelector = ":root[data-color-scheme='partial'][data-theme='dark']";
    const lightBlock = css.slice(css.indexOf(lightSelector), css.indexOf(darkSelector));
    const darkBlock = css.slice(css.indexOf(darkSelector));

    // The light value lives ONLY in the dark-excluded selector.
    expect(lightBlock).toContain(lightSelector);
    expect(lightBlock).toContain('--accent: #aabbcc;');
    // It never appears in the dark selector's block, so dark mode falls back.
    expect(darkBlock).not.toContain('--accent');
  });

  test('escapes quotes/backslashes in the id for the selector', () => {
    const css = themePluginToCss({
      id: "a'b\\c",
      name: 'x',
      light: { bg: '#fff' },
      dark: {},
    });
    expect(css).toContain("data-color-scheme='a\\'b\\\\c'");
  });

  test('emits --md-* syntax vars into the matching mode blocks', () => {
    const css = themePluginToCss({
      id: 'syn',
      name: 'Syn',
      light: { bg: '#ffffff' },
      dark: { bg: '#000000' },
      syntax: {
        light: { heading1: '#00aa00', link: '#0000ff' },
        dark: { heading: '#66ff66' },
      },
    });
    const lightBlock = css.slice(
      css.indexOf(":root[data-color-scheme='syn']:not([data-theme='dark']) {"),
      css.indexOf(":root[data-color-scheme='syn'][data-theme='dark']"),
    );
    const darkBlock = css.slice(css.indexOf(":root[data-color-scheme='syn'][data-theme='dark']"));
    expect(lightBlock).toContain('--md-heading1: #00aa00;');
    expect(lightBlock).toContain('--md-link: #0000ff;');
    expect(lightBlock).not.toContain('--md-heading:');
    expect(darkBlock).toContain('--md-heading: #66ff66;');
    expect(darkBlock).not.toContain('--md-heading1:');
  });

  test('renders every seeded built-in without throwing', () => {
    const css = themePluginsToCss(BUILT_IN_THEMES);
    for (const theme of BUILT_IN_THEMES) {
      expect(css).toContain(`data-color-scheme='${theme.id}'`);
    }
  });
});

describe('themeModeDeclarations', () => {
  const plugin = parseThemePlugin('exp', {
    light: { bg: '#fff', accent: '#00703c' },
    dark: { bg: '#000' },
    syntax: { light: { heading: '#123123', link: '#0000ff' }, dark: {} },
  })!;

  test('emits bare declarations (no selector) for the requested mode', () => {
    const light = themeModeDeclarations(plugin, 'light');
    expect(light).toContain('--bg: #fff;');
    expect(light).toContain('--accent: #00703c;');
    expect(light).toContain('--md-heading: #123123;');
    expect(light).toContain('--md-link: #0000ff;');
    expect(light).not.toContain(':root');
    expect(light).not.toContain('{');
  });

  test('modes are independent; missing keys are simply absent', () => {
    const dark = themeModeDeclarations(plugin, 'dark');
    expect(dark).toContain('--bg: #000;');
    expect(dark).not.toContain('--accent');
    expect(dark).not.toContain('--md-heading');
  });

  test('an empty mode yields an empty string', () => {
    const bare = parseThemePlugin('bare', { light: { bg: '#eee' }, dark: {} })!;
    expect(themeModeDeclarations(bare, 'dark')).toBe('');
  });
});
