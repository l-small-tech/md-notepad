/**
 * The single source of truth for app-level actions.
 *
 * `runShortcutAction` is the one implementation behind every global keyboard
 * shortcut — the body moved here verbatim from main.tsx's `dispatchShortcut`
 * so the command palette and the keydown listener share it exactly.
 *
 * `buildCommands` is the palette's command table: every ShortcutAction that
 * makes sense as a palette entry (each delegating to `runShortcutAction`, so
 * behavior can never drift from the shortcut), plus a few palette-only
 * commands that call existing session/store functions directly.
 */

import { DEFAULT_SETTINGS, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../core/settings';
import type { EditorMode } from '../core/types';
import { detectPlatform, type ShortcutAction } from './keymap';
import {
  addWorkspace,
  closeAllTabs,
  closeTab,
  openDocs,
  openExportPreview,
  openFile,
  saveActiveTab,
  saveActiveTabAs,
} from './session';
import { cycleFullscreen } from './fullscreen';
import { searchStore } from './stores/search';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';

export interface AppCommand {
  /** Stable kebab-case identifier. */
  id: string;
  /** Palette label, e.g. "New tab". */
  title: string;
  /** Extra fuzzy-search terms not worth putting in the title. */
  keywords?: string[];
  /** Display-only shortcut hint ("Ctrl+N" / "⌘N" per platform). */
  shortcut?: string;
  /** When present and false, the command is hidden from the palette. */
  enabled?: () => boolean;
  run: () => void;
}

function clampFontSize(px: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, px));
}

/** Execute a global-shortcut action (moved verbatim from main.tsx). */
export function runShortcutAction(action: ShortcutAction): void {
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
      // Advances the full-screen view one stage (normal → window → screen →
      // normal), available in every editor mode.
      cycleFullscreen();
      break;
    case 'open-palette':
      uiStore.getState().togglePalette();
      break;
    case 'toggle-outline':
      uiStore.getState().toggleOutline();
      break;
    case 'global-search':
      // Toggle like the palette: the shortcut both opens and dismisses it.
      searchStore.getState().setOpen(!searchStore.getState().open);
      break;
  }
}

/* ---- Palette command table ----------------------------------------------- */

// Same mac-vs-other distinction keymap.ts resolves at dispatch time; guarded
// so importing this module in a node test needs no DOM.
const IS_MAC =
  typeof navigator !== 'undefined' && detectPlatform(navigator.platform ?? '') === 'mac';

/** "Ctrl+Shift+S" / "⇧⌘S" from a key name + modifier flags. */
function modKey(key: string, opts: { shift?: boolean } = {}): string {
  return IS_MAC ? `${opts.shift ? '⇧' : ''}⌘${key}` : `Ctrl+${opts.shift ? 'Shift+' : ''}${key}`;
}

function hasActiveTab(): boolean {
  return tabsStore.getState().activeTab() !== undefined;
}

/** An active tab that holds markdown text (not an image/import viewer). */
function hasActiveTextTab(): boolean {
  const tab = tabsStore.getState().activeTab();
  return tab !== undefined && tab.kind !== 'image' && tab.kind !== 'import';
}

/** A palette entry that delegates to the shared shortcut implementation. */
function fromAction(
  id: string,
  title: string,
  action: ShortcutAction,
  extra: Partial<Pick<AppCommand, 'keywords' | 'shortcut' | 'enabled'>> = {},
): AppCommand {
  return { id, title, ...extra, run: () => runShortcutAction(action) };
}

const MODE_ENTRIES: { id: string; title: string; mode: EditorMode; key: string }[] = [
  { id: 'mode-raw', title: 'Mode: Raw', mode: 'raw', key: '1' },
  { id: 'mode-split', title: 'Mode: Split', mode: 'split', key: '2' },
  { id: 'mode-rich', title: 'Mode: Rich', mode: 'wysiwyg', key: '3' },
  { id: 'mode-read', title: 'Mode: Read', mode: 'read', key: '4' },
];

export function buildCommands(): AppCommand[] {
  return [
    // Tabs
    fromAction('new-tab', 'New tab', { type: 'new-tab' }, { shortcut: modKey('N') }),
    fromAction(
      'close-tab',
      'Close tab',
      { type: 'close-tab' },
      { shortcut: modKey('W'), enabled: hasActiveTab },
    ),
    fromAction(
      'next-tab',
      'Next tab',
      { type: 'next-tab' },
      { shortcut: modKey('Tab'), enabled: hasActiveTab },
    ),
    fromAction(
      'prev-tab',
      'Previous tab',
      { type: 'prev-tab' },
      { shortcut: modKey('Tab', { shift: true }), enabled: hasActiveTab },
    ),
    fromAction(
      'rename-tab',
      'Rename tab',
      { type: 'rename-tab' },
      { shortcut: 'F2', enabled: hasActiveTab },
    ),
    // Files
    fromAction(
      'open-file',
      'Open file…',
      { type: 'open-file' },
      { keywords: ['browse'], shortcut: modKey('O') },
    ),
    fromAction('save', 'Save', { type: 'save' }, { shortcut: modKey('S'), enabled: hasActiveTab }),
    fromAction(
      'save-as',
      'Save as…',
      { type: 'save-as' },
      { shortcut: modKey('S', { shift: true }), enabled: hasActiveTab },
    ),
    {
      id: 'export',
      title: 'Export…',
      keywords: ['pdf', 'docx', 'html', 'word', 'share', 'save', 'print', 'standalone', 'theme'],
      enabled: hasActiveTextTab,
      run: () => openExportPreview(),
    },
    // View modes
    ...MODE_ENTRIES.map(({ id, title, mode, key }) =>
      fromAction(
        id,
        title,
        { type: 'set-mode', mode },
        { keywords: ['view', 'editor'], shortcut: modKey(key), enabled: hasActiveTab },
      ),
    ),
    // Display
    fromAction(
      'font-increase',
      'Increase text size',
      { type: 'font-inc' },
      { keywords: ['zoom', 'font', 'bigger'], shortcut: modKey('=') },
    ),
    fromAction(
      'font-decrease',
      'Decrease text size',
      { type: 'font-dec' },
      { keywords: ['zoom', 'font', 'smaller'], shortcut: modKey('-') },
    ),
    fromAction(
      'font-reset',
      'Reset text size',
      { type: 'font-reset' },
      { keywords: ['zoom', 'font', 'default'], shortcut: modKey('0') },
    ),
    fromAction(
      'toggle-fullscreen',
      'Toggle full screen',
      { type: 'toggle-fullscreen' },
      { keywords: ['distraction', 'free', 'zen'], shortcut: IS_MAC ? '⌃⌘F' : 'F11' },
    ),
    // App
    fromAction(
      'open-settings',
      'Open settings',
      { type: 'open-settings' },
      { keywords: ['preferences', 'options', 'theme'], shortcut: modKey(',') },
    ),
    fromAction(
      'global-search',
      'Search in workspaces',
      { type: 'global-search' },
      {
        keywords: ['find', 'grep', 'text', 'notes', 'everywhere'],
        shortcut: modKey('F', { shift: true }),
      },
    ),
    fromAction(
      'toggle-outline',
      'Toggle outline',
      { type: 'toggle-outline' },
      {
        keywords: ['headings', 'toc', 'table', 'contents', 'navigate'],
        shortcut: modKey('O', { shift: true }),
      },
    ),
    // Palette-only commands (no keyboard shortcut today)
    {
      id: 'toggle-explorer',
      title: 'Toggle file explorer',
      keywords: ['sidebar', 'files', 'workspace', 'drawer'],
      run: () => uiStore.getState().toggleExplorer(),
    },
    {
      id: 'open-docs',
      title: 'Open documentation',
      keywords: ['help', 'manual', 'guide'],
      run: () => openDocs(),
    },
    {
      id: 'add-workspace',
      title: 'Add workspace…',
      keywords: ['folder', 'directory', 'notes'],
      run: () => addWorkspace(),
    },
    {
      id: 'close-all-tabs',
      title: 'Close all tabs',
      enabled: hasActiveTab,
      run: () => closeAllTabs(),
    },
  ];
}
