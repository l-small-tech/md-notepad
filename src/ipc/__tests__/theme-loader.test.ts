import { afterEach, describe, expect, test, vi } from 'vitest';

// The path plugin is not available under Vitest; a POSIX join is all the loader
// needs (it only ever joins the themes dir with `<id>.json`).
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
}));

import { loadThemePlugins } from '../theme-loader';
import { ipc } from '../commands';
import { BUILT_IN_THEMES, SEED_VERSION } from '../../core/theme-seeds';

const DIR = '/themes';
const lightGreen = BUILT_IN_THEMES.find((t) => t.id === 'light-green')!;
const lgPath = `${DIR}/light-green.json`;

/**
 * Back the ipc fs calls with an in-memory folder so we can assert exactly which
 * files the loader (re)writes. `createDir` succeeds; list/read/write operate on
 * the map. Returns the map plus the recorded writes.
 */
function mockThemesFolder(initial: Record<string, string>) {
  const fs = new Map(Object.entries(initial));
  const writes: { path: string; text: string }[] = [];
  vi.spyOn(ipc, 'createDir').mockResolvedValue(undefined);
  vi.spyOn(ipc, 'listThemeFiles').mockImplementation(async () => [...fs.keys()]);
  vi.spyOn(ipc, 'readTextFile').mockImplementation(async (path: string) => {
    const text = fs.get(path);
    if (text === undefined) {
      throw new Error(`ENOENT ${path}`);
    }
    return { text, mtimeMs: 0 };
  });
  vi.spyOn(ipc, 'atomicWriteText').mockImplementation(async (path: string, text: string) => {
    fs.set(path, text);
    writes.push({ path, text });
  });
  return { fs, writes };
}

/** The on-disk JSON a current-build seed would have written for light-green. */
function currentLightGreenFile(): string {
  return JSON.stringify({
    name: lightGreen.name,
    version: SEED_VERSION,
    light: lightGreen.light,
    dark: lightGreen.dark,
    syntax: lightGreen.syntax,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('loadThemePlugins — built-in refresh', () => {
  test('refreshes a legacy built-in copy that carries no version stamp', async () => {
    // A stale file like the one an early build left on Android: palette only,
    // a genuinely-dark `dark` block, no syntax, no version.
    const legacy = JSON.stringify({
      name: 'Light Green',
      light: { bg: '#eaf1e4' },
      dark: { bg: '#111c15' },
    });
    const { writes } = mockThemesFolder({ [lgPath]: legacy });

    const plugins = await loadThemePlugins(DIR);

    const rewrite = writes.find((w) => w.path === lgPath);
    expect(rewrite, 'stale light-green should be rewritten').toBeDefined();
    const written = JSON.parse(rewrite!.text);
    expect(written.version).toBe(SEED_VERSION);
    expect(written.syntax).toBeDefined();

    // The loaded plugin now reflects the fresh definition: the mode-locked dark
    // block mirrors light (green, not #111c15) and headings are dark green.
    const lg = plugins.find((p) => p.id === 'light-green')!;
    expect(lg.dark.bg).toBe(lightGreen.dark.bg);
    expect(lg.syntax?.light.heading1).toBe(lightGreen.syntax?.light.heading1);
  });

  test('leaves an up-to-date built-in copy untouched', async () => {
    const { writes } = mockThemesFolder({ [lgPath]: currentLightGreenFile() });

    await loadThemePlugins(DIR);

    expect(writes.find((w) => w.path === lgPath)).toBeUndefined();
  });

  test('does not clobber an existing built-in file it cannot parse', async () => {
    const { writes } = mockThemesFolder({ [lgPath]: '{ this is not valid json' });

    await loadThemePlugins(DIR);

    expect(writes.find((w) => w.path === lgPath)).toBeUndefined();
  });

  test('never rewrites a user-authored (non-built-in) theme', async () => {
    const user = JSON.stringify({ name: 'Mine', light: { bg: '#123456' } });
    const userPath = `${DIR}/my-cool-theme.json`;
    const { writes } = mockThemesFolder({ [userPath]: user });

    await loadThemePlugins(DIR);

    expect(writes.find((w) => w.path === userPath)).toBeUndefined();
  });

  test('seeds every built-in on a first run (empty folder)', async () => {
    const { writes } = mockThemesFolder({});

    const plugins = await loadThemePlugins(DIR);

    expect(writes).toHaveLength(BUILT_IN_THEMES.length);
    for (const theme of BUILT_IN_THEMES) {
      expect(plugins.some((p) => p.id === theme.id)).toBe(true);
    }
  });
});
