import { describe, expect, test } from 'vitest';
import { parseThemePlugin, themePluginToCss, themePluginsToCss } from '../theme-plugins';
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
    expect(css).toContain(":root[data-color-scheme='demo'] {");
    expect(css).toContain('--bg: #ffffff;');
    expect(css).toContain('--fg: #111111;');
    expect(css).toContain(":root[data-color-scheme='demo'][data-theme='dark'] {");
    expect(css).toContain('/* extra */');
    // No dark --fg was supplied, so it must not appear in the dark block.
    expect(css).not.toContain('--fg: #000000;');
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

  test('renders every seeded built-in without throwing', () => {
    const css = themePluginsToCss(BUILT_IN_THEMES);
    for (const theme of BUILT_IN_THEMES) {
      expect(css).toContain(`data-color-scheme='${theme.id}'`);
    }
  });
});
