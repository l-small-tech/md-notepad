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

describe('the optional terminal block', () => {
  test('is absent unless declared — every shipped theme derives instead', () => {
    expect(parseThemePlugin('t', { branding: { bg: '#fff' } })!.terminal).toBeUndefined();
    expect(
      parseThemePlugin('t', { branding: { bg: '#fff' }, terminal: 'nope' })!.terminal,
    ).toBeUndefined();
    // Nothing usable in it is the same as not declaring it.
    expect(
      parseThemePlugin('t', { branding: { bg: '#fff' }, terminal: { nonsense: '#fff' } })!.terminal,
    ).toBeUndefined();
  });

  test('keeps the ANSI names and the four chrome colors', () => {
    const plugin = parseThemePlugin('t', {
      branding: { bg: '#fff' },
      terminal: {
        background: '#101010',
        foreground: '#e0e0e0',
        cursor: '#ff0',
        selection: '#333',
        black: '#000',
        brightWhite: '#fff',
      },
    })!;
    expect(plugin.terminal).toEqual({
      background: '#101010',
      foreground: '#e0e0e0',
      cursor: '#ff0',
      selection: '#333',
      black: '#000',
      brightWhite: '#fff',
    });
  });

  test('null is preserved on the two nullable keys — it means "no override"', () => {
    const plugin = parseThemePlugin('t', {
      branding: { bg: '#fff' },
      terminal: { cursorText: null, selectionText: '#fff' },
    })!;
    expect(plugin.terminal).toEqual({ cursorText: null, selectionText: '#fff' });
  });

  test('rejects values that would escape a CSS declaration, like branding does', () => {
    const plugin = parseThemePlugin('t', {
      branding: { bg: '#fff' },
      terminal: { red: 'red; }', green: '#0f0', blue: '', cursor: 42 },
    })!;
    expect(plugin.terminal).toEqual({ green: '#0f0' });
  });

  test('the console surface (image + opacity) parses out of the same block', () => {
    const plugin = parseThemePlugin('t', {
      branding: { bg: '#fff' },
      terminal: { background: '#101010', backgroundImage: 'forest.png', backgroundOpacity: 0.6 },
    })!;
    expect(plugin.consoleBackground).toEqual({ image: 'forest.png', opacity: 0.6 });
    // …and stays OUT of the color map the renderer takes.
    expect(plugin.terminal).toEqual({ background: '#101010' });
  });

  test('an image name that is not a bare file name is dropped', () => {
    const reject = (image: unknown) =>
      parseThemePlugin('t', { branding: { bg: '#fff' }, terminal: { backgroundImage: image } })!
        .consoleBackground;
    expect(reject('../../etc/passwd.png')).toBeUndefined();
    expect(reject('sub/dir/pic.png')).toBeUndefined();
    expect(reject('C:\\pics\\a.png')).toBeUndefined();
    expect(reject('https://example.com/a.png')).toBeUndefined();
    // A quote or paren would break out of the url("…") it ends up inside.
    expect(reject('a").png')).toBeUndefined();
    expect(reject('notes.txt')).toBeUndefined();
    expect(reject(42)).toBeUndefined();
  });

  test('opacity is clamped, not rejected', () => {
    const opacity = (value: unknown) =>
      parseThemePlugin('t', { branding: { bg: '#fff' }, terminal: { backgroundOpacity: value } })!
        .consoleBackground?.opacity;
    expect(opacity(2)).toBe(1);
    expect(opacity(-1)).toBe(0);
    expect(opacity(0.25)).toBe(0.25);
    expect(opacity('0.5')).toBeUndefined();
    expect(opacity(Number.NaN)).toBeUndefined();
  });

  test('a terminal block with only colors declares no console surface', () => {
    expect(
      parseThemePlugin('t', { branding: { bg: '#fff' }, terminal: { red: '#f00' } })!
        .consoleBackground,
    ).toBeUndefined();
  });

  test('never reaches the generated CSS — it is not a variable', () => {
    const plugin = parseThemePlugin('t', {
      branding: { bg: '#fff' },
      terminal: { background: '#101010' },
    })!;
    expect(themeDeclarations(plugin)).not.toContain('#101010');
  });
});
