import { describe, expect, test } from 'vitest';
import { parseColor } from '../color';
import { parseThemePlugin } from '../theme-plugins';
import {
  ANSI_NAMES,
  BASE_PALETTE_DARK,
  BASE_PALETTE_LIGHT,
  deriveTerminalColors,
  terminalColorsFor,
} from '../terminal-palette';
import { readFileSync } from 'node:fs';

/** WCAG relative luminance, mirroring what `ensureContrast` measures. */
function luminance(rgb: number): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((rgb >> 16) & 0xff) +
    0.7152 * channel((rgb >> 8) & 0xff) +
    0.0722 * (rgb & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const la = luminance(parseColor(a)!);
  const lb = luminance(parseColor(b)!);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('the base palette mirrors base.css', () => {
  // These constants exist so derivation works with no plugin selected and
  // without reading the DOM. If base.css moves, this fails and both move.
  const css = readFileSync(new URL('../../styles/base.css', import.meta.url), 'utf8');

  test.each([
    [
      'light',
      BASE_PALETTE_LIGHT,
      css.slice(css.indexOf(':root {'), css.indexOf("[data-theme='dark']")),
    ],
    ['dark', BASE_PALETTE_DARK, css.slice(css.indexOf("[data-theme='dark']"))],
  ])('%s', (_mode, palette, block) => {
    for (const [key, value] of Object.entries(palette)) {
      const variable = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      expect(block, `${variable} in base.css`).toContain(`${variable}: ${value}`);
    }
  });
});

describe('deriveTerminalColors', () => {
  test('maps the semantic keys onto the terminal colors that mean the same thing', () => {
    const colors = deriveTerminalColors(
      { editorBg: '#101010', fg: '#e0e0e0', accent: '#4488ff', danger: '#ff4444' },
      'dark',
    );
    expect(colors.background).toBe('#101010');
    expect(colors.foreground).toBe('#e0e0e0');
    // The cursor is the accent — it is the one caret the user hunts for.
    expect(colors.cursor).toBe('#4488ff');
    expect(colors.ansi[1]).toBe('#ff4444'); // red   ← danger
    expect(colors.ansi[4]).toBe('#4488ff'); // blue  ← accent
    expect(colors.ansi[15]).toBe('#e0e0e0'); // brightWhite ← fg
  });

  test('always produces 16 ANSI entries, even from an empty branding block', () => {
    expect(deriveTerminalColors({}, 'light').ansi).toHaveLength(16);
    expect(deriveTerminalColors({}, 'dark').ansi).toHaveLength(16);
  });

  test('an unparseable value (color-mix, a var()) falls back to base.css', () => {
    const colors = deriveTerminalColors({ editorBg: 'color-mix(in oklab, red, blue)' }, 'dark');
    expect(colors.background).toBe(BASE_PALETTE_DARK.editorBg);
  });

  test('holds every derived color to a contrast floor against the surface', () => {
    // An accent chosen to sit on chrome, not on the terminal background: the
    // floor is what stops it rendering as invisible blue-on-blue.
    const colors = deriveTerminalColors(
      { editorBg: '#0b0f14', fg: '#e6ebf2', accent: '#101720', danger: '#0d1219' },
      'dark',
    );
    for (const [index, hex] of colors.ansi.entries()) {
      if (index === 0) {
        continue; // ANSI black is a background color; exempt on purpose.
      }
      const floor = index === 8 ? 2 : 3;
      expect(contrast(hex, colors.background), `ansi ${index} (${hex})`).toBeGreaterThanOrEqual(
        floor - 0.001,
      );
    }
  });

  test('light and dark derive differently from the same branding', () => {
    const branding = { editorBg: '#ffffff', fg: '#000000' };
    expect(deriveTerminalColors(branding, 'light').ansi).not.toEqual(
      deriveTerminalColors(branding, 'dark').ansi,
    );
  });
});

describe('terminalColorsFor', () => {
  const plugin = parseThemePlugin('t', {
    name: 'T',
    mode: 'dark',
    branding: { editorBg: '#101010', fg: '#e0e0e0', accent: '#4488ff' },
  })!;

  test('no plugin derives from base.css for the requested mode', () => {
    expect(terminalColorsFor(null, true).background).toBe(BASE_PALETTE_DARK.editorBg);
    expect(terminalColorsFor(null, false).background).toBe(BASE_PALETTE_LIGHT.editorBg);
  });

  test("a plugin's own mode wins over the requested one", () => {
    // A dark theme paints a dark terminal even if `dark` is asked as false —
    // the plugin declares one look.
    expect(terminalColorsFor(plugin, false)).toEqual(terminalColorsFor(plugin, true));
  });

  test('an explicit terminal block wins, key by key', () => {
    const themed = parseThemePlugin('t', {
      name: 'T',
      mode: 'dark',
      branding: { editorBg: '#101010', fg: '#e0e0e0' },
      terminal: { cursor: '#ff00ff', red: '#123456' },
    })!;
    const colors = terminalColorsFor(themed, true);
    expect(colors.cursor).toBe('#ff00ff');
    expect(colors.ansi[ANSI_NAMES.indexOf('red')]).toBe('#123456');
    // Everything it did not set is still derived.
    expect(colors.background).toBe('#101010');
    expect(colors.ansi[ANSI_NAMES.indexOf('green')]).toBe(
      terminalColorsFor(plugin, true).ansi[ANSI_NAMES.indexOf('green')],
    );
  });

  test('an unsafe or unparseable terminal value is ignored, not painted', () => {
    const themed = parseThemePlugin('t', {
      name: 'T',
      mode: 'dark',
      branding: { editorBg: '#101010' },
      // `;}` would escape a CSS declaration — dropped by the plugin parser —
      // and 'not-a-color' survives that but cannot be parsed to an RGB value.
      terminal: { cursor: 'red; }', red: 'not-a-color' },
    })!;
    const colors = terminalColorsFor(themed, true);
    const derived = terminalColorsFor(
      parseThemePlugin('t2', { name: 'T', mode: 'dark', branding: { editorBg: '#101010' } })!,
      true,
    );
    expect(colors.cursor).toBe(derived.cursor);
    expect(colors.ansi[1]).toBe(derived.ansi[1]);
  });

  test('an explicit null clears an override rather than falling back', () => {
    const themed = parseThemePlugin('t', {
      name: 'T',
      mode: 'dark',
      branding: { editorBg: '#101010' },
      terminal: { cursorText: null },
    })!;
    expect(terminalColorsFor(themed, true).cursorText).toBeNull();
  });
});
