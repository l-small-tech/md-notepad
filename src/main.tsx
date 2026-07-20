import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { confirm, message, open, save } from '@tauri-apps/plugin-dialog';
import { nanoid } from 'nanoid';
import { normalizeSettings } from './core/settings';
import { parseManifest, type PersistedTab, type SessionManifest } from './core/session/plan-flush';
import { editorFontStack, uiFontStack } from './core/fonts';
import { loadPersistedSettings, savePersistedSettings } from './ipc/settings-store';
// Bundled typefaces (all SIL OFL 1.1). Importing a family only registers its
// @font-face rules — the WebView fetches woff2 data lazily, the first time
// rendered text actually uses that family — so the unchosen fonts cost
// nothing at runtime. Stacks/labels live in core/fonts.ts.
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/fira-code/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/cascadia-code/400.css';
import '@fontsource/cascadia-code/500.css';
import '@fontsource/cascadia-code/700.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import '@fontsource/source-code-pro/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/700.css';
import '@fontsource/inconsolata/400.css';
import '@fontsource/inconsolata/500.css';
import '@fontsource/inconsolata/700.css';
import '@fontsource/victor-mono/400.css';
import '@fontsource/victor-mono/500.css';
import '@fontsource/victor-mono/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import './styles/base.css';
import './styles/themes.css';
import './styles/app.css';
import './styles/preview.css';
import './styles/voice-comments.css';
import { App } from './ui/App';
import { DEFAULT_COLOR_SCHEME, type Settings } from './core/types';
import { settingsStore } from './ui/stores/settings';
import { tabsStore, tabDisplayTitle } from './ui/stores/tabs';
import {
  appendImagesToMd,
  createSessionController,
  getDefaultWorkspacePath,
  importFilesInto,
  type ConfirmDialog,
  type OpenFilesDialog,
  type PickDirectoryDialog,
  type PickFileDialog,
  type SaveDiscardCancelDialog,
  type SaveFileDialog,
} from './ui/session';
import { uiStore } from './ui/stores/ui';
import { exportPreviewStore } from './ui/stores/export-preview';
import { isImagePath } from './core/images';
import { ipc } from './ipc/commands';
import { initProviders } from './ipc/provider';
import { resolveDocsDir, resolvePaths, resolveThemesDir } from './ipc/paths';
import { themeRegistryStore } from './ui/stores/theme-registry';
import { importFilters } from './core/import/registry';
import { themePluginsToCss } from './core/theme-plugins';
import { detectPlatform, keyEventToAction } from './ui/keymap';
import { runShortcutAction } from './ui/commands';
import { searchStore } from './ui/stores/search';
import { isAndroid } from './ui/platform';
import { stepBackFullscreen } from './ui/fullscreen';
import { isDark, subscribeDark } from './ui/theme';
import { checkForUpdate, setBeforeRestart } from './ui/update';

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
  ...importFilters,
];
const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
];

// NOTE: deliberately no <StrictMode>. StrictMode double-invokes effects in dev,
// which fights the "editors are mounted exactly once" architecture (see
// src/ui/README.md). Core logic is covered by Vitest instead.

/* ---- Settings → DOM (theme, ligatures, fonts, editor font size) --------- */

function applyDomSettings(): void {
  const { ligatures, fontSize, editorFont, uiFont, readerMargins, cursorStyle, colorScheme } =
    settingsStore.getState().settings;
  const root = document.documentElement;
  root.dataset.theme = isDark() ? 'dark' : 'light';
  // Palette family — each value (paired with data-theme) maps to the ten color
  // variables via the injected theme-plugin CSS. The built-in System/Light/Dark
  // modes (`colorScheme === 'default'`) render the green built-ins — Light
  // Green in light mode, Dark Green in dark — instead of the plain base.css
  // palette; if those theme files were deleted the id matches no injected
  // block and falls through to base.css anyway.
  root.dataset.colorScheme =
    colorScheme === DEFAULT_COLOR_SCHEME ? (isDark() ? 'dark-green' : 'light-green') : colorScheme;
  root.classList.toggle('no-ligatures', !ligatures);
  root.style.setProperty('--editor-font-size', `${fontSize}px`);
  // Editor/content typeface; the UI chrome either follows it ('match', the
  // base.css default of --font-ui) or gets its own sans stack.
  root.style.setProperty('--font-mono', editorFontStack(editorFont));
  const ui = uiFontStack(uiFont);
  if (ui === null) {
    root.style.removeProperty('--font-ui');
  } else {
    root.style.setProperty('--font-ui', ui);
  }
  // Read-mode margins — preview.css maps each value to a responsive gutter.
  root.dataset.readerMargins = readerMargins;
  // Editor caret style — base.css maps each value to --caret-width (+ underscore geometry).
  root.dataset.cursor = cursorStyle;
}

applyDomSettings();
settingsStore.subscribe(applyDomSettings);
// Follow the OS live while the setting is "system".
subscribeDark(applyDomSettings);

// Android: base.css pins the body (position: fixed) under this flag so the
// root scroller can never pan the app shell off screen. Set once — the
// runtime never changes.
if (isAndroid()) {
  document.documentElement.dataset.android = 'true';
}

/* ---- Pluggable themes → injected <style> -------------------------------- */

// The loaded theme plugins are rendered to one <style id="theme-plugins"> whose
// `:root[data-color-scheme='<id>']` blocks work exactly like the old built-in
// styles/themes.css. Re-run on every registry change (e.g. "Reload themes"),
// mirroring how applyDomSettings tracks the settings store. CSP allows this
// inline <style> (style-src 'unsafe-inline'); a linked file would be blocked.
function injectThemeStyles(): void {
  const css = themePluginsToCss(themeRegistryStore.getState().plugins);
  let style = document.getElementById('theme-plugins');
  if (!(style instanceof HTMLStyleElement)) {
    style = document.createElement('style');
    style.id = 'theme-plugins';
    document.head.appendChild(style);
  }
  style.textContent = css;
}

/* ---- Settings persistence (tauri-plugin-store, debounced) ---------------- */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write-through so rapid field edits collapse into one save. */
function persistSettingsDebounced(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const settings = settingsStore.getState().settings;
    void savePersistedSettings(settings).catch(() => {
      // A failed settings write is non-fatal — the in-memory value still holds
      // for the session; the next change retries.
    });
    // Multi-window: mirror the change into the other windows live (theme, fonts
    // …). Receivers compare before replacing, so the echo converges instead of
    // ping-ponging. No-op outside a Tauri webview.
    void emit('settings-changed', settings).catch(() => {});
  }, 400);
}

/* ---- Window identity (M8 multi-window) ----------------------------------- */

const appWindow = getCurrentWindow();
/** 'main' for the primary window; 'w-<nanoid>' for torn-off tab windows. */
const WINDOW_LABEL = appWindow.label;
const IS_MAIN_WINDOW = WINDOW_LABEL === 'main';

/** Shared construction options so every window looks like the main one. */
const WINDOW_OPTIONS = {
  title: 'MD Notepad',
  width: 900,
  height: 650,
  minWidth: 400,
  minHeight: 300,
  decorations: false,
} as const;

/** Create a window and resolve/reject on Tauri's created/error events. */
function spawnWindow(
  label: string,
  extra: { url?: string; x?: number; y?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new WebviewWindow(label, { ...WINDOW_OPTIONS, ...extra });
    void w.once('tauri://created', () => resolve());
    void w.once('tauri://error', (e) => reject(new Error(JSON.stringify(e.payload))));
  });
}

/**
 * Tear-off spawner injected into the session controller: the new window gets
 * its one-tab manifest via the URL (small — the tab's content was already
 * flushed to disk, only paths/ids travel) and adopts it during its own boot.
 */
async function spawnTabWindow(
  manifest: SessionManifest,
  pos: { x: number; y: number } | null,
): Promise<void> {
  await spawnWindow(`w-${nanoid(10)}`, {
    url: `index.html?adopt=${encodeURIComponent(JSON.stringify(manifest))}`,
    ...(pos ? { x: pos.x, y: pos.y } : {}),
  });
}

/* ---- Window title mirrors the active tab -------------------------------- */

let lastWindowTitle = '';

// A dev run (`npm run tauri:dev`) serves the frontend from Vite, so import.meta
// .env.DEV is true here but false in the built release. Tag the window/taskbar
// title so a dev instance is obvious next to an installed release (the amber
// icon from tauri.dev.conf.json is the other half of that distinction).
const APP_NAME = import.meta.env.DEV ? 'MD Notepad Dev' : 'MD Notepad';

function applyWindowTitle(): void {
  const active = tabsStore.getState().activeTab();
  const title = active ? `${tabDisplayTitle(active)} — ${APP_NAME}` : APP_NAME;
  if (title === lastWindowTitle) {
    return;
  }
  lastWindowTitle = title;
  // No-op outside a Tauri webview (e.g. `vite` alone); never throw at boot.
  void appWindow.setTitle(title).catch(() => {});
}

/* ---- Session controller (created during boot) --------------------------- */

const confirmDialog: ConfirmDialog = async (msg, title) => {
  try {
    return await confirm(msg, { title, kind: 'warning' });
  } catch {
    // Outside a Tauri webview there is no native dialog; don't block the close.
    return true;
  }
};

const openFilesDialog: OpenFilesDialog = async () => {
  try {
    const selected = await open({ multiple: true, filters: MARKDOWN_FILTERS });
    if (!selected) {
      return null;
    }
    return Array.isArray(selected) ? selected : [selected];
  } catch {
    return null;
  }
};

const saveFileDialog: SaveFileDialog = async (suggestedName, filters) => {
  try {
    return await save({ defaultPath: suggestedName, filters: filters ?? MARKDOWN_FILTERS });
  } catch {
    return null;
  }
};

const pickDirectoryDialog: PickDirectoryDialog = async () => {
  try {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === 'string' ? selected : null;
  } catch {
    return null;
  }
};

const pickFileDialog: PickFileDialog = async (kind) => {
  try {
    const selected = await open({
      multiple: false,
      filters: kind === 'image' ? IMAGE_FILTERS : kind === 'import' ? importFilters : undefined,
    });
    return typeof selected === 'string' ? selected : null;
  } catch {
    return null;
  }
};

const saveDiscardCancelDialog: SaveDiscardCancelDialog = async (msg, title) => {
  try {
    const result = await message(msg, {
      title,
      kind: 'warning',
      buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
    });
    if (result === 'Yes') {
      return 'save';
    }
    if (result === 'No') {
      return 'discard';
    }
    return 'cancel';
  } catch {
    // Outside a Tauri webview there is no native dialog; don't block the close.
    return 'discard';
  }
};

/* ---- Global keyboard shortcuts (single listener) ------------------------ */

const platform = detectPlatform(navigator.platform);

window.addEventListener('keydown', (event) => {
  // Escape closes the export-preview modal (same custom-DOM-modal contract as
  // the settings dialog below).
  if (event.key === 'Escape' && exportPreviewStore.getState().open) {
    event.preventDefault();
    exportPreviewStore.getState().close();
    return;
  }
  // Escape closes the settings modal when it's open (standard modal behavior;
  // the dialog itself is custom DOM, so the one global listener owns this).
  if (event.key === 'Escape' && uiStore.getState().settingsOpen) {
    event.preventDefault();
    uiStore.getState().closeSettings();
    return;
  }
  // Escape steps the full-screen view back one stage (screen → window →
  // normal; checked after the settings modal so a dialog opened while
  // fullscreen closes first).
  if (event.key === 'Escape' && uiStore.getState().fullscreenView !== 'normal') {
    event.preventDefault();
    stepBackFullscreen();
    return;
  }
  const action = keyEventToAction(event, platform);
  if (!action) {
    // Not ours — let CM6 (mod+F search) and the browser handle it.
    return;
  }
  // While the command palette or the search panel is open it owns the
  // keyboard: its input stops propagation for the keys it handles, and
  // anything that still bubbles here must not trigger a global shortcut
  // underneath the overlay.
  if (uiStore.getState().paletteOpen || searchStore.getState().open) {
    return;
  }
  event.preventDefault();
  runShortcutAction(action);
});

/* ---- Boot: settings → paths → restore session → mount → wire lifecycle --- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boot(): Promise<void> {
  // Load persisted settings BEFORE resolving paths so a saved notesDir wins,
  // and before React mounts so the first paint uses the saved theme/font. A
  // corrupt/missing store degrades to defaults via normalizeSettings.
  settingsStore.getState().replace(normalizeSettings(await loadPersistedSettings()));
  // Only now arm the debounced saver, so the initial load doesn't echo back a
  // write; every subsequent field edit persists.
  settingsStore.subscribe(persistSettingsDebounced);

  // Install the platform storage provider BEFORE the controller captures
  // currentProvider(): on Android this routes local + synced (SAF) workspaces;
  // desktop stays on the plain local FS.
  initProviders();

  // Load pluggable themes and inject their CSS before mount so the first paint
  // uses the saved color scheme. Seeds the built-in examples on first run.
  await themeRegistryStore.getState().load(await resolveThemesDir());
  injectThemeStyles();
  themeRegistryStore.subscribe(injectThemeStyles);

  const paths = await resolvePaths(settingsStore.getState().settings);

  // M8: a freshly torn-off window carries its one-tab manifest in the URL
  // (the spawning window flushed the tab's content to disk first).
  const adoptParam = new URLSearchParams(window.location.search).get('adopt');

  // Creating the controller registers the flush requester and the interactive
  // close handler (used by the keyboard dispatcher and TabBar via ./ui/session).
  const controller = createSessionController({
    paths,
    docsDir: await resolveDocsDir(),
    isMain: IS_MAIN_WINDOW,
    manifestName: IS_MAIN_WINDOW ? 'session.json' : `session-${WINDOW_LABEL}.json`,
    initialManifest: adoptParam ? parseManifest(adoptParam) : null,
    spawnTabWindow,
    confirm: confirmDialog,
    openDialog: openFilesDialog,
    saveDialog: saveFileDialog,
    saveDiscardCancel: saveDiscardCancelDialog,
    pickDirectory: pickDirectoryDialog,
    pickFile: pickFileDialog,
  });

  // Rebuild the tabs from disk BEFORE React mounts, so the first paint is the
  // restored session, never a flash of an empty Untitled tab.
  await controller.restore();

  // Bring back the windows that were open last run: every torn-off window left
  // a session-<label>.json behind; the window-state plugin restores each
  // label's last geometry when the window is created.
  if (IS_MAIN_WINDOW) {
    void (async () => {
      let manifestPaths: string[];
      try {
        manifestPaths = await ipc.listSessionManifests(paths.sessionDir);
      } catch {
        return;
      }
      for (const manifestPath of manifestPaths) {
        const name = manifestPath.replaceAll('\\', '/').split('/').pop() ?? '';
        const match = /^session-(w-[A-Za-z0-9_-]+)\.json$/.exec(name);
        if (!match) {
          continue;
        }
        let manifest: SessionManifest | null;
        try {
          manifest = parseManifest((await ipc.readTextFile(manifestPath)).text);
        } catch {
          manifest = null;
        }
        // Corrupt, or nothing but never-flushed empty placeholders → sweep the
        // file instead of resurrecting an empty window forever.
        const meaningful = manifest?.tabs.some(
          (t) => !(t.kind === 'note' && t.notePath === null && t.customTitle === null),
        );
        if (!meaningful) {
          void ipc.deletePath(manifestPath).catch(() => {});
          continue;
        }
        await spawnWindow(match[1]!, { url: 'index.html' }).catch(() => {});
      }
    })();
  }

  applyWindowTitle();
  tabsStore.subscribe(applyWindowTitle);

  createRoot(document.getElementById('root')!).render(<App />);

  // First-launch CLI args sit in managed state until the frontend drains
  // them; only the main window exists at that point (see src-tauri/src/lib.rs).
  if (IS_MAIN_WINDOW) {
    void ipc
      .drainStartupFiles()
      .then((files) => (files.length > 0 ? controller.openPaths(files) : undefined))
      .catch(() => {});
  }

  // Android: files from an "Open with"/"Share" intent arrive as content:// URIs
  // held in the androidfs plugin. Drain them at boot (cold-start intent) and on
  // window focus (warm start — a new intent resumes the app). copyInExternal
  // copies each into the notes dir and opens the local copy.
  const drainIncomingUris = (): void => {
    if (!isAndroid()) {
      return;
    }
    void ipc
      .takeIncomingUris()
      .then((uris) => (uris.length > 0 ? controller.openIncoming(uris) : undefined))
      .catch(() => {});
  };
  drainIncomingUris();

  // Watch local workspace roots with OS file events (debounced in Rust) so the
  // explorer refreshes when other apps or sync tools touch a workspace — no
  // polling, no manual refresh needed. Synced (SAF) workspaces can't be
  // watched and keep the manual button; Android skips all of this (the watch
  // command isn't registered there). Re-armed whenever the workspace set or
  // the notes dir changes.
  if (!isAndroid()) {
    let watchedSignature = '';
    const syncWatchedDirs = (): void => {
      const defaultPath = getDefaultWorkspacePath();
      const roots = [
        ...(defaultPath === null ? [] : [defaultPath]),
        ...settingsStore
          .getState()
          .settings.workspaces.filter((w) => w.kind !== 'synced')
          .map((w) => w.path),
      ];
      const signature = JSON.stringify(roots);
      if (signature === watchedSignature) {
        return;
      }
      watchedSignature = signature;
      void ipc.watchDirs(roots).catch(() => {});
    };
    syncWatchedDirs();
    settingsStore.subscribe(syncWatchedDirs);

    // Trailing debounce on top of Rust's: a long burst (sync tool writing many
    // files) still collapses into few re-lists. refreshExplorer is idempotent
    // and cheap when the drawer is closed (the list effect early-returns).
    let fsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    void listen('fs-changed', () => {
      if (fsRefreshTimer !== null) {
        clearTimeout(fsRefreshTimer);
      }
      fsRefreshTimer = setTimeout(() => {
        fsRefreshTimer = null;
        uiStore.getState().refreshExplorer();
      }, 300);
    }).catch(() => {});
  }

  // Second-instance argv (user opens a .md while the app runs). Windows close
  // independently, so main may be gone by then — the Rust single-instance
  // callback targets exactly one surviving window (main preferred); every
  // window listens, scoped to its own label.
  void appWindow
    .listen<string[]>('open-files', (event) => {
      void controller.openPaths(event.payload);
    })
    .catch(() => {});

  // A closing window hands its tabs to a surviving one (no data loss, no
  // zombie window at next boot). Any window can adopt — the sender picks a
  // single target (main preferred) and emits to that label only. Flush before
  // acking so the adopted tabs are on disk before the sender deletes its
  // manifest; without the ack the sender keeps its manifest and that window
  // gets restored next launch instead.
  void appWindow
    .listen<{ tabs: PersistedTab[]; from: string }>('adopt-tabs', (event) => {
      void controller
        .adoptTabs(event.payload.tabs)
        .then(() => controller.flushNow())
        .then(() => {
          void emit(`adopt-ack-${event.payload.from}`).catch(() => {});
        });
      void appWindow.setFocus().catch(() => {});
    })
    .catch(() => {});

  // Any window may ask everyone to flush (update-restart does).
  void listen('flush-all', () => {
    void controller.flushNow();
  }).catch(() => {});

  // Live settings sync between windows (see persistSettingsDebounced).
  void listen<Settings>('settings-changed', (event) => {
    const next = normalizeSettings(event.payload);
    if (JSON.stringify(next) !== JSON.stringify(settingsStore.getState().settings)) {
      settingsStore.getState().replace(next);
    }
  }).catch(() => {});

  // OS drag-drop into the explorer. Tauri intercepts file drags (HTML5 drop
  // never fires), so hit-test its physical cursor position against the
  // explorer's data-drop-dir attributes: hovering highlights the target
  // workspace/folder, dropping copies the md/image files into it.
  const elementAt = (position: { x: number; y: number }): Element | null => {
    const scale = window.devicePixelRatio || 1;
    return document.elementFromPoint(position.x / scale, position.y / scale);
  };
  const dropDirAt = (position: { x: number; y: number }): string | null =>
    elementAt(position)?.closest('[data-drop-dir]')?.getAttribute('data-drop-dir') ?? null;
  // An md file row also advertises itself as a drop target (data-drop-file):
  // dropping images onto it embeds them at the end of that file instead of
  // copying them into the folder.
  const dropFileAt = (position: { x: number; y: number }): string | null =>
    elementAt(position)?.closest('[data-drop-file]')?.getAttribute('data-drop-file') ?? null;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'over') {
        // Highlight the md file under the cursor when there is one, else the
        // workspace/folder — same single dropTargetDir drives both highlights.
        uiStore
          .getState()
          .setDropTarget(dropFileAt(payload.position) ?? dropDirAt(payload.position));
      } else if (payload.type === 'drop') {
        const file = dropFileAt(payload.position);
        const dir = dropDirAt(payload.position);
        uiStore.getState().setDropTarget(null);
        if (file && payload.paths.some(isImagePath)) {
          void appendImagesToMd(file, payload.paths);
        } else if (dir) {
          void importFilesInto(dir, payload.paths);
        } else {
          // Not over the explorer (e.g. the editor area): open as tabs.
          void controller.openPaths(payload.paths);
        }
      } else {
        uiStore.getState().setDropTarget(null);
      }
    })
    .catch(() => {});

  // Flush on blur so a crash after tabbing away still keeps the latest text;
  // re-check open file tabs for external changes when the window regains
  // focus ("on window focus and before every save").
  void appWindow
    .onFocusChanged(({ payload: focused }) => {
      if (focused) {
        void controller.checkAllFileConflicts();
        // A warm-start "Open with"/"Share" intent refocuses the window.
        drainIncomingUris();
      } else {
        void controller.flushNow();
      }
    })
    .catch(() => {});

  // Update check (M7): deferred so it can never delay first paint or restore;
  // failures are silent inside checkForUpdate. The pre-restart hook flushes
  // every window's session so installing an update costs zero typed text.
  setBeforeRestart(async () => {
    void emit('flush-all').catch(() => {});
    await controller.flushNow();
    await delay(600); // give the other windows a beat to finish their flush
  });
  // The updater/process plugins are desktop-only (mobile updates via the store),
  // so skip the check on Android — otherwise it logs "updater.check not allowed".
  // Also skip in a dev run: it points at the release's endpoint (different
  // identifier) and a "restart to update" prompt makes no sense for `cargo run`.
  if (IS_MAIN_WINDOW && !isAndroid() && !import.meta.env.DEV) {
    setTimeout(() => void checkForUpdate({ manual: false }), 3000);
  }

  /**
   * Closing a TORN-OFF window hands its tabs to a surviving window — main
   * when it's alive, else any other window (nothing is lost, and no surprise
   * window resurrects next boot). The manifest is deleted only after the
   * target acknowledges the adoption; if it never answers (quitting, hung),
   * the manifest stays and the window returns next launch. When this is the
   * LAST window standing there is no one to hand to: fold the tabs into
   * main's manifest instead, so relaunch opens one window with everything.
   */
  async function handTabsToSurvivor(): Promise<void> {
    const tabs = await controller.exportTabsForHandoff(); // flushes first
    if (tabs.length === 0) {
      await controller.discardManifest().catch(() => {});
      return;
    }
    const others = (await getAllWebviewWindows()).filter((w) => w.label !== WINDOW_LABEL);
    const target = others.find((w) => w.label === 'main') ?? others[0];
    if (!target) {
      await controller.bequeathTabsToMain(tabs).catch(() => {});
      return;
    }
    const acked = await new Promise<boolean>((resolve) => {
      let unlisten: (() => void) | null = null;
      const timer = setTimeout(() => {
        unlisten?.();
        resolve(false);
      }, 1500);
      listen(`adopt-ack-${WINDOW_LABEL}`, () => {
        clearTimeout(timer);
        unlisten?.();
        resolve(true);
      })
        .then((un) => {
          unlisten = un;
          void emitTo(target.label, 'adopt-tabs', { tabs, from: WINDOW_LABEL }).catch(() => {});
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
    if (acked) {
      await controller.discardManifest().catch(() => {});
    }
  }

  // Close path: never prompt. Windows close independently — the app exits
  // when the last one is destroyed. Flush what's pending, then destroy.
  void appWindow
    .onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        if (IS_MAIN_WINDOW) {
          // Main keeps its manifest (session.json), so its tabs — and any
          // still-open secondaries, via theirs — return at next launch.
          // Bounded so a pathological write (disk full) can't hang close.
          await Promise.race([controller.flushNow(), delay(4000)]);
        } else {
          await Promise.race([handTabsToSurvivor(), delay(4000)]);
        }
      } finally {
        await controller.dispose().catch(() => {});
        void appWindow.destroy();
      }
    })
    .catch(() => {});
}

void boot();
