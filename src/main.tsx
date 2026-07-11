import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen } from '@tauri-apps/api/event';
import { confirm, message, open, save } from '@tauri-apps/plugin-dialog';
import { normalizeSettings, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS } from './core/settings';
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
    void savePersistedSettings(settingsStore.getState().settings).catch(() => {
      // A failed settings write is non-fatal — the in-memory value still holds
      // for the session; the next change retries.
    });
  }, 400);
}

/* ---- Window title mirrors the active tab -------------------------------- */

const appWindow = getCurrentWindow();
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
  // Creating the controller registers the flush requester and the interactive
  // close handler (used by the keyboard dispatcher and TabBar via ./ui/session).
  const controller = createSessionController({
    paths,
    docsDir: await resolveDocsDir(),
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

  applyWindowTitle();
  tabsStore.subscribe(applyWindowTitle);
  // Auto-exit reader full screen when the active tab leaves read mode.
  initReaderFullscreen();

  createRoot(document.getElementById('root')!).render(<App />);

  // First-launch CLI args (`md-notepad some.md`) — see src-tauri/src/lib.rs
  // for why these can't just arrive as an event.
  void ipc
    .drainStartupFiles()
    .then((files) => (files.length > 0 ? controller.openPaths(files) : undefined))
    .catch(() => {});

  // Second-instance argv (double-clicking a .md while the app runs) — the
  // single-instance plugin focuses this window and emits the paths here.
  void listen<string[]>('open-files', (event) => {
    void controller.openPaths(event.payload);
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
  // the session so installing an update costs zero typed text.
  setBeforeRestart(() => controller.flushNow());
  setTimeout(() => void checkForUpdate({ manual: false }), 3000);

  // Close path: never prompt. Flush what's pending, then destroy.
  void appWindow
    .onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        // Bound the wait so a pathological write (disk full) can't hang close.
        await Promise.race([controller.flushNow(), delay(3000)]);
      } finally {
        await controller.dispose().catch(() => {});
        void appWindow.destroy();
      }
    })
    .catch(() => {});
}

void boot();
