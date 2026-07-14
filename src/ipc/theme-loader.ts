/**
 * Loads pluggable theme files from the themes folder (see ipc/paths.ts for the
 * location). Kept in `src/ipc` because it does file I/O; the pure model
 * (validation, CSS rendering) lives in core/theme-plugins.ts.
 *
 * Flow (see `loadThemePlugins`): ensure the folder exists → seed any missing
 * built-in example on first run → list `*.json` → read + validate each. Invalid
 * or unreadable files are skipped individually, never failing the batch, so one
 * bad hand-edit can't strip every theme.
 *
 * The themes folder is always app-owned local storage (internal on desktop, the
 * external files dir on Android), never a SAF synced tree, so this talks to the
 * std::fs-backed `ipc` commands directly rather than going through the storage
 * provider.
 */

import { join } from '@tauri-apps/api/path';
import { ipc, IpcError } from './commands';
import { parseThemePlugin, type ThemePlugin, type Palette } from '../core/theme-plugins';
import { BUILT_IN_THEMES } from '../core/theme-seeds';

/** Filename slug (no extension), lowercased and reduced to a safe id. */
function slugFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const noExt = base.replace(/\.[^.]*$/, '');
  const slug = noExt
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'theme';
}

/** The on-disk JSON shape (the plugin minus its filename-derived id). */
function toFileJson(plugin: ThemePlugin): string {
  const body: { name: string; light: Palette; dark: Palette; css?: string } = {
    name: plugin.name,
    light: plugin.light,
    dark: plugin.dark,
    ...(plugin.css ? { css: plugin.css } : {}),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Write the built-in example themes that aren't already present. Only writes a
 * file whose id has no existing `.json`, so a user's edits to (or deletion of) a
 * seeded theme are never overwritten on the next launch.
 */
async function seedBuiltIns(themesDir: string, existingIds: Set<string>): Promise<number> {
  let seeded = 0;
  for (const theme of BUILT_IN_THEMES) {
    if (existingIds.has(theme.id)) {
      continue;
    }
    const path = await join(themesDir, `${theme.id}.json`);
    try {
      await ipc.atomicWriteText(path, toFileJson(theme));
      seeded += 1;
    } catch {
      // A failed seed is non-fatal: the theme just won't appear until the file
      // can be written; the rest of the folder still loads.
    }
  }
  return seeded;
}

/**
 * Ensure the themes folder exists, seed missing built-ins, then read and
 * validate every `*.json` into a `ThemePlugin`. Duplicate ids resolve to the
 * first (sorted) file. Never throws for a missing folder or a bad file.
 */
export async function loadThemePlugins(themesDir: string): Promise<ThemePlugin[]> {
  try {
    await ipc.createDir(themesDir);
  } catch (e) {
    // EXISTS is expected after first run; anything else means we can't use the
    // folder — return no plugins and let the app fall back to the default palette.
    if (!(e instanceof IpcError && e.code === 'EXISTS')) {
      return [];
    }
  }

  let paths = await ipc.listThemeFiles(themesDir).catch(() => [] as string[]);
  const existingIds = new Set(paths.map(slugFromPath));
  const seeded = await seedBuiltIns(themesDir, existingIds);

  // Re-list only if we actually wrote new example files this run.
  if (seeded > 0) {
    paths = await ipc.listThemeFiles(themesDir).catch(() => paths);
  }

  const byId = new Map<string, ThemePlugin>();
  for (const path of paths) {
    const id = slugFromPath(path);
    if (byId.has(id)) {
      continue;
    }
    const plugin = await readThemeFile(path, id);
    if (plugin) {
      byId.set(id, plugin);
    }
  }
  return [...byId.values()];
}

async function readThemeFile(path: string, id: string): Promise<ThemePlugin | null> {
  try {
    const { text } = await ipc.readTextFile(path);
    return parseThemePlugin(id, JSON.parse(text));
  } catch {
    // Unreadable or not valid JSON — skip this one file.
    return null;
  }
}

/**
 * A JSON starter for the "New theme…" button: a full, working theme (the app's
 * own default light/dark palette) the user renames and tweaks. Picks a free
 * `my-theme[-N].json` so it never clobbers an existing id, and returns the new
 * id + path (the caller selects the id and reveals the file).
 */
export async function writeThemeTemplate(
  themesDir: string,
  existingIds: Set<string>,
): Promise<{ id: string; path: string }> {
  const base = 'my-theme';
  let id = base;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${n++}`;
  }
  const path = await join(themesDir, `${id}.json`);
  await ipc.atomicWriteText(path, toFileJson({ ...TEMPLATE, id, name: 'My Theme' }));
  return { id, path };
}

/** Starter palette = the app's default (base.css) light/dark values; the
 *  template fills all ten keys for both modes so the user edits in place. */
const TEMPLATE: ThemePlugin = {
  id: 'my-theme',
  name: 'My Theme',
  light: {
    bg: '#ffffff',
    editorBg: '#f7f7f5',
    bgAlt: '#f5f5f5',
    bgHover: '#ececec',
    fg: '#1f1f1f',
    fgMuted: '#6e6e6e',
    accent: '#3574f0',
    border: '#e1e1e1',
    danger: '#c42b1c',
    selection: '#b5d1ff',
  },
  dark: {
    bg: '#1e1e1e',
    editorBg: '#1a1a1a',
    bgAlt: '#252526',
    bgHover: '#2e2e30',
    fg: '#e8e8e8',
    fgMuted: '#9a9a9a',
    accent: '#6ea1ff',
    border: '#3c3c3c',
    danger: '#ff6b5e',
    selection: '#2a4a78',
  },
};
