/**
 * Loads pluggable theme files from the themes folder (see ipc/paths.ts for the
 * location). Kept in `src/ipc` because it does file I/O; the pure model
 * (validation, CSS rendering) lives in core/theme-plugins.ts.
 *
 * Flow (see `loadThemePlugins`): ensure the folder exists → list `*.json` → seed
 * any missing built-in example and refresh any stale one (an older SEED_VERSION
 * stamp) → read + validate each. Invalid or unreadable files are skipped
 * individually, never failing the batch, so one bad hand-edit can't strip every
 * theme.
 *
 * The themes folder is always app-owned local storage (internal on desktop, the
 * external files dir on Android), never a SAF synced tree, so this talks to the
 * std::fs-backed `ipc` commands directly rather than going through the storage
 * provider.
 */

import { join } from '@tauri-apps/api/path';
import { ipc, IpcError } from './commands';
import {
  parseThemePlugin,
  type ThemePlugin,
  type Palette,
  type SyntaxColors,
} from '../core/theme-plugins';
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
  const body: {
    name: string;
    version?: number;
    light: Palette;
    dark: Palette;
    syntax?: SyntaxColors;
    css?: string;
  } = {
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    light: plugin.light,
    dark: plugin.dark,
    ...(plugin.syntax ? { syntax: plugin.syntax } : {}),
    ...(plugin.css ? { css: plugin.css } : {}),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Read the `version` stamp of an existing theme file. Returns:
 *  - the number, when the file is valid JSON carrying a finite `version`;
 *  - `0` for valid JSON with no stamp (a legacy seed, written before versioning
 *    or by an older build) — old enough to refresh;
 *  - `null` when the file can't be read or parsed, so the caller leaves it
 *    alone rather than risk clobbering a locked or hand-broken file.
 */
async function readSeededVersion(path: string): Promise<number | null> {
  try {
    const { text } = await ipc.readTextFile(path);
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === 'object') {
      const v = (raw as Record<string, unknown>).version;
      if (typeof v === 'number' && Number.isFinite(v)) {
        return v;
      }
    }
    return 0;
  } catch {
    return null;
  }
}

/**
 * Ensure every built-in example is present and current. Writes a built-in when
 * no file for its id exists, and refreshes an existing copy whose stamped
 * version is older than the shipped SEED_VERSION (so a fixed color or added
 * syntax block reaches devices seeded by an earlier build). A copy that is
 * already current — or that a user has bumped past ours — is left untouched, as
 * is any unreadable file. Returns the number of files written. `existingById`
 * maps a built-in id to its actual on-disk path (which may differ in case from
 * `<id>.json`), so a refresh overwrites the user's real file rather than
 * spawning a case-variant duplicate.
 */
async function seedBuiltIns(themesDir: string, existingById: Map<string, string>): Promise<number> {
  let written = 0;
  for (const theme of BUILT_IN_THEMES) {
    const existingPath = existingById.get(theme.id);
    if (existingPath) {
      const onDisk = await readSeededVersion(existingPath);
      if (onDisk === null || onDisk >= (theme.version ?? 0)) {
        continue;
      }
    }
    const path = existingPath ?? (await join(themesDir, `${theme.id}.json`));
    try {
      await ipc.atomicWriteText(path, toFileJson(theme));
      written += 1;
    } catch {
      // A failed seed/refresh is non-fatal: the theme just keeps its old copy
      // (or won't appear until writable); the rest of the folder still loads.
    }
  }
  return written;
}

/**
 * Ensure the themes folder exists, seed missing built-ins and refresh stale
 * ones, then read and validate every `*.json` into a `ThemePlugin`. Duplicate
 * ids resolve to the first (sorted) file. Never throws for a missing folder or a
 * bad file.
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
  // First path wins per id (matches the dedup in the read loop below), so a
  // refresh targets the same file the registry will end up loading.
  const existingById = new Map<string, string>();
  for (const path of paths) {
    const id = slugFromPath(path);
    if (!existingById.has(id)) {
      existingById.set(id, path);
    }
  }
  const seeded = await seedBuiltIns(themesDir, existingById);

  // Re-list only if we wrote files this run (a fresh seed adds new paths; a
  // refresh rewrites an existing one, which the read loop already re-reads).
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
 *  template fills all ten keys for both modes so the user edits in place. The
 *  optional `syntax` block demonstrates recoloring markdown elements (the
 *  `--md-*` vars) — seeded with the app's defaults so it's a no-op until edited. */
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
  syntax: {
    light: {
      heading: '#3574f0',
      bold: '#1f1f1f',
      italic: '#6e6e6e',
      link: '#3574f0',
      code: '#c42b1c',
      quote: '#6e6e6e',
      list: '#6e6e6e',
    },
    dark: {
      heading: '#6ea1ff',
      bold: '#e8e8e8',
      italic: '#9a9a9a',
      link: '#6ea1ff',
      code: '#ff6b5e',
      quote: '#9a9a9a',
      list: '#9a9a9a',
    },
  },
};
