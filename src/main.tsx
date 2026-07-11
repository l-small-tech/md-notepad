import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { confirm, message, open, save } from '@tauri-apps/plugin-dialog';
import { nanoid } from 'nanoid';
import { normalizeSettings, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS } from './core/settings';
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
import './styles/app.css';
import './styles/preview.css';
import { App } from './ui/App';
import type { Settings } from './core/types';
import { settingsStore } from './ui/stores/settings';
import { tabsStore, tabDisplayTitle } from './ui/stores/tabs';
import {
  appendImagesToMd,
  closeTab,
  createSessionController,
  importFilesInto,
  openFile,
  saveActiveTab,
  saveActiveTabAs,
  type ConfirmDialog,
  type OpenFilesDialog,
  type PickDirectoryDialog,
  type PickFileDialog,
  type SaveDiscardCancelDialog,
  type SaveFileDialog,
} from './ui/session';
import { uiStore } from './ui/stores/ui';
import { isImagePath } from './core/images';
import { ipc } from './ipc/commands';
import { resolveDocsDir, resolvePaths } from './ipc/paths';
import { detectPlatform, keyEventToAction, type ShortcutAction } from './ui/keymap';
import { cycleReaderView, initReaderFullscreen, stepBackReaderView } from './ui/reader-fullscreen';
import { isDark, subscribeDark } from './ui/theme';
import { checkForUpdate, setBeforeRestart } from './ui/update';

const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
];

// NOTE: deliberately no <StrictMode>. StrictMode double-invokes effects in dev,
// which fights the "editors are mounted exactly once" architecture (see
// src/ui/README.md). Core logic is covered by Vitest instead.

/* ---- Settings → DOM (theme, ligatures, fonts, editor font size) --------- */

function applyDomSettings(): void {
  const { ligatures, fontSize, editorFont, uiFont, readerMargins } =
    settingsStore.getState().settings;
  const root = document.documentElement;
  root.dataset.theme = isDark() ? 'dark' : 'light';
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
}

applyDomSettings();
settingsStore.subscribe(applyDomSettings);
// Follow the OS live while the setting is "system".
subscribeDark(applyDomSettings);

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

function applyWindowTitle(): void {
  const active = tabsStore.getState().activeTab();
  const title = active ? `${tabDisplayTitle(active)} — MD Notepad` : 'MD Notepad';
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

const saveFileDialog: SaveFileDialog = async (suggestedName) => {
  try {
    return await save({ defaultPath: suggestedName, filters: MARKDOWN_FILTERS });
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
      filters: kind === 'image' ? IMAGE_FILTERS : undefined,
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

function clampFontSize(px: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, px));
}

function dispatchShortcut(action: ShortcutAction): void {
  const store = tabsStore.getState();
  switch (action.type) {
    case 'new-tab':
      store.newTab();
      break;
    case 'close-tab':
      closeTab(store.activeTabId);
      break;
    case 'next-tab':
      store.activateAdjacent(1);
      break;
    case 'prev-tab':
      store.activateAdjacent(-1);
      break;
    case 'rename-tab':
      store.beginRename(store.activeTabId);
      break;
    case 'set-mode':
      store.setMode(store.activeTabId, action.mode);
      break;
    case 'open-file':
      openFile();
      break;
    case 'save':
      saveActiveTab();
      break;
    case 'save-as':
      saveActiveTabAs();
      break;
    case 'open-settings':
      uiStore.getState().openSettings();
      break;
    case 'font-inc':
      settingsStore
        .getState()
        .update({ fontSize: clampFontSize(settingsStore.getState().settings.fontSize + 1) });
      break;
    case 'font-dec':
      settingsStore
        .getState()
        .update({ fontSize: clampFontSize(settingsStore.getState().settings.fontSize - 1) });
      break;
    case 'font-reset':
      settingsStore.getState().update({ fontSize: DEFAULT_SETTINGS.fontSize });
      break;
    case 'toggle-fullscreen':
      // Advances the read-mode view one stage (window → screen → normal).
      // Only READ mode enters; the cycle no-ops in edit modes.
      cycleReaderView();
      break;
  }
}

window.addEventListener('keydown', (event) => {
  // Escape closes the settings modal when it's open (standard modal behavior;
  // the dialog itself is custom DOM, so the one global listener owns this).
  if (event.key === 'Escape' && uiStore.getState().settingsOpen) {
    event.preventDefault();
    uiStore.getState().closeSettings();
    return;
  }
  // Escape steps the reader view back one stage (screen → window → normal;
  // checked after the settings modal so a dialog opened while fullscreen
  // closes first).
  if (event.key === 'Escape' && uiStore.getState().readerView !== 'normal') {
    event.preventDefault();
    stepBackReaderView();
    return;
  }
  const action = keyEventToAction(event, platform);
  if (!action) {
    // Not ours — let CM6 (mod+F search) and the browser handle it.
    return;
  }
  event.preventDefault();
  dispatchShortcut(action);
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
  // Auto-exit reader full screen when the active tab leaves read mode.
  initReaderFullscreen();

  createRoot(document.getElementById('root')!).render(<App />);

  // File-opening entry points target the main window only: first-launch CLI
  // args sit in managed state (see src-tauri/src/lib.rs), and the
  // single-instance plugin focuses main and emits second-instance argv to it.
  if (IS_MAIN_WINDOW) {
    void ipc
      .drainStartupFiles()
      .then((files) => (files.length > 0 ? controller.openPaths(files) : undefined))
      .catch(() => {});

    void listen<string[]>('open-files', (event) => {
      void controller.openPaths(event.payload);
    }).catch(() => {});

    // A closing torn-off window hands its tabs back here (no data loss, no
    // zombie window at next boot). Ack it so the sender can delete its
    // manifest; without the ack it keeps the manifest and gets restored.
    void listen<{ tabs: PersistedTab[]; from: string }>('adopt-tabs', (event) => {
      void controller.adoptTabs(event.payload.tabs).then(() => {
        void emit(`adopt-ack-${event.payload.from}`).catch(() => {});
      });
      void appWindow.setFocus().catch(() => {});
    }).catch(() => {});
  } else {
    // The main window is quitting the app: flush, then close (the manifest
    // stays, so this window — tabs, geometry — returns at next launch).
    void listen('main-closing', () => {
      void (async () => {
        await Promise.race([controller.flushNow(), delay(2000)]);
        await controller.dispose().catch(() => {});
        void appWindow.destroy();
      })();
    }).catch(() => {});
  }

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
  if (IS_MAIN_WINDOW) {
    setTimeout(() => void checkForUpdate({ manual: false }), 3000);
  }

  /**
   * Closing the MAIN window quits the app: broadcast so torn-off windows
   * flush + close themselves (their manifests survive — the whole window
   * layout returns next launch), give them a moment, then sweep stragglers.
   */
  async function closeSecondaryWindows(): Promise<void> {
    let others = (await getAllWebviewWindows()).filter((w) => w.label !== WINDOW_LABEL);
    if (others.length === 0) {
      return;
    }
    void emit('main-closing').catch(() => {});
    const deadline = Date.now() + 2000;
    while (others.length > 0 && Date.now() < deadline) {
      await delay(100);
      others = (await getAllWebviewWindows()).filter((w) => w.label !== WINDOW_LABEL);
    }
    for (const w of others) {
      void w.destroy().catch(() => {});
    }
  }

  /**
   * Closing a TORN-OFF window hands its tabs back to the main window (nothing
   * is lost, and no surprise window resurrects next boot). The manifest is
   * deleted only after main acknowledges the adoption; if main never answers
   * (quitting, hung), the manifest stays and the window returns next launch.
   */
  async function handTabsBackToMain(): Promise<void> {
    const tabs = await controller.exportTabsForHandoff(); // flushes first
    if (tabs.length === 0) {
      await controller.discardManifest().catch(() => {});
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
          void emitTo('main', 'adopt-tabs', { tabs, from: WINDOW_LABEL }).catch(() => {});
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

  // Close path: never prompt. Flush what's pending, then destroy.
  void appWindow
    .onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        if (IS_MAIN_WINDOW) {
          // Own flush and the secondaries' flushes run in parallel; both are
          // bounded so a pathological write (disk full) can't hang close.
          await Promise.race([
            Promise.all([controller.flushNow(), closeSecondaryWindows()]),
            delay(4000),
          ]);
        } else {
          await Promise.race([handTabsBackToMain(), delay(4000)]);
        }
      } finally {
        await controller.dispose().catch(() => {});
        void appWindow.destroy();
      }
    })
    .catch(() => {});
}

void boot();
