import { describe, expect, test } from 'vitest';
import {
  parseThemePlugin,
  themeDeclarations,
  themePluginToCss,
  themePluginsToCss,
} from '../theme-plugins';
import { BUILT_IN_THEMES } from '../theme-seeds';

describe('parseThemePlugin', () => {
  test('accepts a well-formed theme and derives name from id when absent', () => {
    const plugin = parseThemePlugin('midnight', {
      mode: 'dark',
      branding: { bg: '#000', fg: '#fff' },
    });
    expect(plugin).not.toBeNull();
    expect(plugin!.id).toBe('midnight');
    expect(plugin!.name).toBe('midnight');
    expect(plugin!.mode).toBe('dark');
    expect(plugin!.branding.bg).toBe('#000');
    expect(plugin!.branding.fg).toBe('#fff');
  });

  test('keeps an explicit name and optional css', () => {
    const plugin = parseThemePlugin('x', {
      name: 'My Theme',
      mode: 'light',
      branding: { accent: '#123456' },
      css: '.cm-content { letter-spacing: 0.2px; }',
    });
    expect(plugin!.name).toBe('My Theme');
    expect(plugin!.css).toContain('letter-spacing');
  });

  test('a missing or misspelled mode defaults to light', () => {
    expect(parseThemePlugin('a', { branding: { bg: '#eee' } })!.mode).toBe('light');
    expect(parseThemePlugin('a', { mode: 'darkish', branding: { bg: '#eee' } })!.mode).toBe(
      'light',
    );
  });

  test('tolerates missing branding keys (partial theme)', () => {
    const plugin = parseThemePlugin('partial', { branding: { bg: '#eee' } });
    expect(plugin).not.toBeNull();
    expect(Object.keys(plugin!.branding)).toEqual(['bg']);
  });

  test('accepts the brand trio keys', () => {
    const plugin = parseThemePlugin('trio', {
      branding: { primary: '#111111', secondary: '#222222', tertiary: '#333333' },
    });
    expect(plugin!.branding).toEqual({
      primary: '#111111',
      secondary: '#222222',
      tertiary: '#333333',
    });
  });

  test('drops unknown keys and unsafe color values', () => {
    const plugin = parseThemePlugin('sanitize', {
      branding: {
        bg: '#fff',
        fg: 'red; } body { display:none', // value that would break out of its declaration
        primary: 'blue\n}', // newline is unsafe
        bogusKey: '#000', // not one of the branding keys
      },
    });
    expect(plugin!.branding.bg).toBe('#fff');
    expect(plugin!.branding).not.toHaveProperty('fg');
    expect(plugin!.branding).not.toHaveProperty('primary');
    expect(plugin!.branding).not.toHaveProperty('bogusKey');
  });

  test('returns null for non-objects and for empty branding', () => {
    expect(parseThemePlugin('a', null)).toBeNull();
    expect(parseThemePlugin('a', 'nope')).toBeNull();
    expect(parseThemePlugin('a', {})).toBeNull();
    expect(parseThemePlugin('a', { branding: {} })).toBeNull();
    expect(parseThemePlugin('a', { branding: { bg: '' } })).toBeNull();
  });

  test('rejects files in the retired light/dark format (no branding key)', () => {
    expect(
      parseThemePlugin('legacy', {
        name: 'Old Theme',
        light: { bg: '#fff', fg: '#000' },
        dark: { bg: '#000', fg: '#fff' },
      }),
    ).toBeNull();
  });

  test('parses an optional flat syntax block', () => {
    const plugin = parseThemePlugin('syn', {
      branding: { bg: '#fff' },
      syntax: { heading1: '#0a0', bold: '#111', link: '#00f' },
    });
    expect(plugin!.syntax).toEqual({ heading1: '#0a0', bold: '#111', link: '#00f' });
  });

  test('drops unknown/unsafe syntax keys and omits syntax when empty', () => {
    const plugin = parseThemePlugin('syn2', {
      branding: { bg: '#fff' },
      syntax: { heading1: 'red; }', bogus: '#000', link: '' },
    });
    // Every syntax value was unsafe/unknown → no syntax block at all.
    expect(plugin!.syntax).toBeUndefined();
  });

  test('a theme with only syntax colors (no branding) is invalid', () => {
    expect(parseThemePlugin('syn3', { syntax: { heading: '#0a0' } })).toBeNull();
    expect(parseThemePlugin('syn4', { branding: {}, syntax: { heading: '#0a0' } })).toBeNull();
  });
});

describe('themePluginToCss', () => {
  test('emits one unscoped scheme block and appends css', () => {
    const css = themePluginToCss({
      id: 'demo',
      name: 'Demo',
      mode: 'light',
      branding: { bg: '#ffffff', fg: '#111111' },
      css: '/* extra */',
    });
    // A single block, deliberately NOT scoped by data-theme: the UI pins
    // data-theme to the plugin's mode while it is selected.
    expect(css).toContain(":root[data-color-scheme='demo'] {");
    expect(css).not.toContain(':not([data-theme');
    expect(css).not.toContain("[data-theme='dark']");
    expect(css).toContain('--bg: #ffffff;');
    expect(css).toContain('--fg: #111111;');
    expect(css).toContain('/* extra */');
  });

  test('emits --brand-* vars for the trio', () => {
    const css = themePluginToCss({
      id: 'trio',
      name: 'Trio',
      mode: 'dark',
      branding: { bg: '#000000', primary: '#aa00aa', secondary: '#00aaaa', tertiary: '#aaaa00' },
    });
    expect(css).toContain('--brand-primary: #aa00aa;');
    expect(css).toContain('--brand-secondary: #00aaaa;');
    expect(css).toContain('--brand-tertiary: #aaaa00;');
  });

  test('escapes quotes/backslashes in the id for the selector', () => {
    const css = themePluginToCss({
      id: "a'b\\c",
      name: 'x',
      mode: 'light',
      branding: { bg: '#fff' },
    });
    expect(css).toContain("data-color-scheme='a\\'b\\\\c'");
  });

  test('emits --md-* syntax vars into the same block', () => {
    const css = themePluginToCss({
      id: 'syn',
      name: 'Syn',
      mode: 'light',
      branding: { bg: '#ffffff' },
      syntax: { heading1: '#00aa00', link: '#0000ff' },
    });
    const block = css.slice(css.indexOf(":root[data-color-scheme='syn'] {"));
    expect(block).toContain('--md-heading1: #00aa00;');
    expect(block).toContain('--md-link: #0000ff;');
    expect(block).not.toContain('--md-heading:');
  });

  test('renders every seeded built-in without throwing', () => {
    const css = themePluginsToCss(BUILT_IN_THEMES);
    for (const theme of BUILT_IN_THEMES) {
      expect(css).toContain(`data-color-scheme='${theme.id}'`);
    }
  });

  test('every seeded built-in carries a full brand trio', () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.branding.primary, theme.id).toBeDefined();
      expect(theme.branding.secondary, theme.id).toBeDefined();
      expect(theme.branding.tertiary, theme.id).toBeDefined();
    }
  });
});

describe('themeDeclarations', () => {
  const plugin = parseThemePlugin('exp', {
    branding: { bg: '#fff', accent: '#00703c', primary: '#00703c' },
    syntax: { heading: '#123123', link: '#0000ff' },
  })!;

  test('emits bare declarations (no selector)', () => {
    const decls = themeDeclarations(plugin);
    expect(decls).toContain('--bg: #fff;');
    expect(decls).toContain('--accent: #00703c;');
    expect(decls).toContain('--brand-primary: #00703c;');
    expect(decls).toContain('--md-heading: #123123;');
    expect(decls).toContain('--md-link: #0000ff;');
    expect(decls).not.toContain(':root');
    expect(decls).not.toContain('{');
  });

  test('missing keys are simply absent', () => {
    const bare = parseThemePlugin('bare', { branding: { bg: '#eee' } })!;
    const decls = themeDeclarations(bare);
    expect(decls).toBe('  --bg: #eee;');
  });
});
