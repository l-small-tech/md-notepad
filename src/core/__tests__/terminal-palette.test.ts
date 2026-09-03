import { describe, expect, test } from 'vitest';
import { contrastRatio, luminance, parseColor } from '../color';
import { BUILT_IN_THEMES } from '../theme-seeds';
import { parseThemePlugin } from '../theme-plugins';
import {
  ANSI_NAMES,
  BASE_PALETTE_DARK,
  BASE_PALETTE_LIGHT,
  DEFAULT_ANSI_LIGHT,
  deriveTerminalColors,
  terminalColorsFor,
  terminalEnvHints,
} from '../terminal-palette';
import { readFileSync } from 'node:fs';

/** The measured contrast between two hex colors — the same math the floor uses. */
function contrast(a: string, b: string): number {
  return contrastRatio(parseColor(a)!, parseColor(b)!);
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

  // The light floors are the whole point of this file for harnesses: an agent
  // that assumes a dark terminal paints its prose in ANSI colors, and on a
  // light surface those are what the user has to read.
  describe('light mode clears the AA body-text floor', () => {
    const lightThemes = [
      { id: '(no plugin)', branding: {} },
      ...BUILT_IN_THEMES.filter((theme) => theme.mode === 'light'),
    ];

    test.each(lightThemes.map((theme) => [theme.id, theme.branding] as const))(
      '%s',
      (_id, branding) => {
        const colors = deriveTerminalColors(branding, 'light');
        for (const [index, hex] of colors.ansi.entries()) {
          if (index === 0) {
            continue; // ANSI black is a background color; exempt on purpose.
          }
          const floor = index === 8 ? 3 : 4.5;
          expect(contrast(hex, colors.background), `ansi ${index} (${hex})`).toBeGreaterThanOrEqual(
            floor - 0.001,
          );
        }
      },
    );

    test('every color also clears the floor against the app-default surface', () => {
      // A theme may omit `editorBg`; then base.css's light surface is what the
      // terminal is painted on, so that is what the palette is measured against.
      const colors = deriveTerminalColors({ fg: '#101010' }, 'light');
      expect(colors.background).toBe(BASE_PALETTE_LIGHT.editorBg);
      for (const [index, hex] of colors.ansi.entries()) {
        if (index === 0) continue;
        expect(
          contrast(hex, BASE_PALETTE_LIGHT.editorBg),
          `ansi ${index} (${hex})`,
        ).toBeGreaterThanOrEqual((index === 8 ? 3 : 4.5) - 0.001);
      }
    });

    test('white (normal text) is never lighter than brightBlack (dim text)', () => {
      // Backwards ordering is what made a TUI's prose harder to read than its
      // own comments — see the `ansi[7]` note in terminal-palette.ts. The
      // tolerance is for a theme like Beacon, whose `fgMuted` is already
      // near-ink: there the two land within noise of each other, which is fine.
      for (const { id, branding } of lightThemes) {
        const { ansi } = deriveTerminalColors(branding, 'light');
        const white = luminance(parseColor(ansi[7]!)!);
        const brightBlack = luminance(parseColor(ansi[8]!)!);
        expect(white, `${id} white vs brightBlack`).toBeLessThanOrEqual(brightBlack + 0.02);
      }
    });

    test('the built-in light palette is legible on white without derivation', () => {
      // `DEFAULT_ANSI_LIGHT` is also the renderer's standalone light palette.
      for (const [index, hex] of DEFAULT_ANSI_LIGHT.entries()) {
        if (index === 0) continue;
        expect(contrast(hex, '#ffffff'), `ansi ${index} (${hex})`).toBeGreaterThanOrEqual(
          index === 8 ? 3 : 4.5,
        );
      }
    });
  });

  test('dark mode keeps its own, lower floor', () => {
    // Raising the light floor must not have moved dark themes: a light-text
    // ratio reads heavier on a dark surface than the same number does on paper.
    // `#6b6b6b` on this surface measures ~3.6 — over the dark floor, under the
    // light one — so it survives untouched only while the two differ.
    const colors = deriveTerminalColors({ editorBg: '#0b0f14', danger: '#6b6b6b' }, 'dark');
    expect(contrast('#6b6b6b', colors.background)).toBeGreaterThan(3);
    expect(contrast('#6b6b6b', colors.background)).toBeLessThan(4.5);
    expect(colors.ansi[1]).toBe('#6b6b6b');
  });

  test('light and dark derive differently from the same branding', () => {
    const branding = { editorBg: '#ffffff', fg: '#000000' };
    expect(deriveTerminalColors(branding, 'light').ansi).not.toEqual(
      deriveTerminalColors(branding, 'dark').ansi,
    );
  });
});

describe('terminalEnvHints', () => {
  test('COLORFGBG names the palette indices a light or dark surface implies', () => {
    // The rxvt convention: `fg;bg` as palette indices. Every "is this terminal
    // light?" helper that predates OSC 11 reads exactly this.
    expect(terminalEnvHints(false).COLORFGBG).toBe('0;15');
    expect(terminalEnvHints(true).COLORFGBG).toBe('15;0');
  });

  test('the Grok CLI gets its appearance pinned to the console it draws on', () => {
    expect(terminalEnvHints(false).GROK_APPEARANCE).toBe('light');
    expect(terminalEnvHints(true).GROK_APPEARANCE).toBe('dark');
    // Never the LC_ twin: that one is forwarded over SSH by AcceptEnv LC_*.
    expect(terminalEnvHints(false)).not.toHaveProperty('LC_GROK_APPEARANCE');
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
