import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { confirm, message, open, save } from '@tauri-apps/plugin-dialog';
import { normalizeSettings, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS } from './core/settings';
import { loadPersistedSettings, savePersistedSettings } from './ipc/settings-store';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/fira-code/700.css';
import './styles/base.css';
import './styles/app.css';
import './styles/preview.css';
import { App } from './ui/App';
import { settingsStore } from './ui/stores/settings';
import { tabsStore, tabDisplayTitle } from './ui/stores/tabs';
import {
  closeTab,
  createSessionController,
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
import { ipc } from './ipc/commands';
import { resolvePaths } from './ipc/paths';
import { detectPlatform, keyEventToAction, type ShortcutAction } from './ui/keymap';
import { isDark, subscribeDark } from './ui/theme';
import { checkForUpdate, setBeforeRestart } from './ui/update';

const MARKDOWN_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
];

// NOTE: deliberately no <StrictMode>. StrictMode double-invokes effects in dev,
// which fights the "editors are mounted exactly once" architecture (see
// src/ui/README.md). Core logic is covered by Vitest instead.

/* ---- Settings → DOM (theme, ligatures, editor font size) ---------------- */

function applyDomSettings(): void {
  const { ligatures, fontSize } = settingsStore.getState().settings;
  const root = document.documentElement;
  root.dataset.theme = isDark() ? 'dark' : 'light';
  root.classList.toggle('no-ligatures', !ligatures);
  root.style.setProperty('--editor-font-size', `${fontSize}px`);
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

  // Flush on blur so a crash after tabbing away still keeps the latest text;
  // re-check open file tabs for external changes when the window regains
  // focus (plan.md M3 — "on window focus and before every save").
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

  // Close path: never prompt (plan.md M2). Flush what's pending, then destroy.
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
