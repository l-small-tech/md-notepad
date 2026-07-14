/**
 * SettingsDialog (M6) — a minimal custom-DOM modal over the settings store
 * (the one deliberate exception to the native-dialogs rule, since a
 * form doesn't map onto plugin-dialog). Every field writes straight through
 * `settingsStore.update`, so changes take effect immediately (theme/ligatures/
 * font via the DOM subscription in main.tsx, word wrap via EditorHost, default
 * mode on the NEXT new tab) and persist via main.tsx's debounced saver.
 *
 * The notes-folder "Change…" button hands off to the session controller's
 * flow (folder picker → optional move) via the module-level dispatcher.
 */

import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { EditorFontId, EditorMode, Settings, UiFontId } from '../../core/types';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from '../../core/settings';
import { EDITOR_FONTS, UI_FONTS } from '../../core/fonts';
import { openDocs, requestChangeNotesDir } from '../session';
import { currentProvider } from '../../ipc/provider';
import { writeThemeTemplate } from '../../ipc/theme-loader';
import { settingsStore, useSettingsStore } from '../stores/settings';
import {
  themeRegistryStore,
  useThemeRegistry,
  APPEARANCE_MODES,
  themePluginOptions,
  isAppearanceMode,
} from '../stores/theme-registry';
import { DEFAULT_COLOR_SCHEME } from '../../core/types';
import { uiStore, useUiStore } from '../stores/ui';
import { checkForUpdate, useUpdateStore } from '../update';

const MODES: { value: EditorMode; label: string }[] = [
  { value: 'raw', label: 'Raw' },
  { value: 'split', label: 'Split' },
  { value: 'wysiwyg', label: 'Rich' },
  { value: 'read', label: 'Read' },
];

const READER_MARGINS: { value: Settings['readerMargins']; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
];

const CURSOR_STYLE_OPTIONS: { value: Settings['cursorStyle']; label: string }[] = [
  { value: 'bar', label: 'Bar (default)' },
  { value: 'thin', label: 'Thin' },
  { value: 'thick', label: 'Thick' },
  { value: 'underscore', label: 'Underscore' },
];

const IMAGE_LOCATIONS: { value: Settings['imagePasteLocation']; label: string }[] = [
  { value: 'subfolder', label: 'Subfolder next to the file' },
  { value: 'sameFolder', label: 'Same folder as the file' },
  { value: 'workspaceRoot', label: 'Shared folder at workspace root' },
];

function update(partial: Partial<Settings>): void {
  settingsStore.getState().update(partial);
}

/** Reveal the themes folder in the OS file manager so the user can drop in
 *  theme files (desktop only; the button is hidden where reveal is unavailable). */
async function openThemesFolder(): Promise<void> {
  const { themesDir } = themeRegistryStore.getState();
  if (themesDir) {
    await revealItemInDir(themesDir).catch(() => {});
  }
}

/** Write a starter theme file, reload the registry, select it, and reveal it. */
async function newTheme(): Promise<void> {
  const { themesDir, plugins, reload } = themeRegistryStore.getState();
  if (!themesDir) {
    return;
  }
  const existing = new Set(plugins.map((p) => p.id));
  const { id, path } = await writeThemeTemplate(themesDir, existing);
  await reload();
  update({ colorScheme: id });
  if (currentProvider().capabilities.isLocalFs) {
    await revealItemInDir(path).catch(() => {});
  }
}

/**
 * Manual update check (this app has no
 * menu bar, so Settings is its home). Outcome lands in the status bar: either
 * the update chip appears or a "up to date" notice shows.
 */
function UpdatesRow() {
  const phase = useUpdateStore((s) => s.phase);
  return (
    <div className="settings-row settings-row-notes">
      <span className="settings-label">Updates</span>
      <div className="settings-notes-value">
        <span className="settings-path">MD Notepad v{__APP_VERSION__}</span>
        <button
          className="settings-button"
          disabled={phase === 'checking' || phase === 'downloading'}
          onClick={() => void checkForUpdate({ manual: true })}
        >
          {phase === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const settings = useSettingsStore((s) => s.settings);
  const plugins = useThemeRegistry((s) => s.plugins);

  if (!open) {
    return null;
  }

  const pluginOptions = themePluginOptions(plugins);
  const canReveal = currentProvider().capabilities.isLocalFs;

  // Unified Theme picker: System/Light/Dark drive the built-in default palette;
  // a plugin id drives that scheme and follows the OS light/dark. The dropdown
  // shows the mode when on the default palette, else the plugin id.
  const themeValue =
    settings.colorScheme === DEFAULT_COLOR_SCHEME ? settings.theme : settings.colorScheme;
  const onThemeChange = (value: string) => {
    if (isAppearanceMode(value)) {
      update({ theme: value, colorScheme: DEFAULT_COLOR_SCHEME });
    } else {
      update({ colorScheme: value, theme: 'system' });
    }
  };
  const pluginMissing =
    settings.colorScheme !== DEFAULT_COLOR_SCHEME &&
    !pluginOptions.some((p) => p.value === settings.colorScheme);

  const close = () => uiStore.getState().closeSettings();

  return (
    <div
      className="settings-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button
            className="settings-button settings-docs-button"
            onClick={() => {
              close();
              openDocs();
            }}
          >
            Open Docs
          </button>
          <button className="settings-close" aria-label="Close settings" onClick={close}>
            ×
          </button>
        </header>

        <div className="settings-body">
          <label className="settings-row">
            <span className="settings-label">Theme</span>
            <select
              className="settings-control"
              value={themeValue}
              onChange={(e) => onThemeChange(e.target.value)}
            >
              {APPEARANCE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
              {pluginOptions.length > 0 && <option disabled>──────────</option>}
              {pluginOptions.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              {/* A saved theme whose file is missing still shows as the current
                  value (falls back to the default palette visually). */}
              {pluginMissing && (
                <option value={settings.colorScheme}>{settings.colorScheme} (missing)</option>
              )}
            </select>
          </label>

          <div className="settings-row settings-row-notes">
            <span className="settings-label">Themes folder</span>
            <div className="settings-notes-value">
              <span className="settings-hint">
                Drop in theme files, or ask your AI to make one (see Open Docs).
              </span>
              <div className="settings-theme-buttons">
                {canReveal && (
                  <button className="settings-button" onClick={() => void openThemesFolder()}>
                    Open folder
                  </button>
                )}
                <button className="settings-button" onClick={() => void newTheme()}>
                  New theme…
                </button>
                <button
                  className="settings-button"
                  onClick={() => void themeRegistryStore.getState().reload()}
                >
                  Reload
                </button>
              </div>
            </div>
          </div>

          <label className="settings-row">
            <span className="settings-label">Default mode (new tabs)</span>
            <select
              className="settings-control"
              value={settings.defaultMode}
              onChange={(e) => update({ defaultMode: e.target.value as EditorMode })}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-row">
            <span className="settings-label">Font size</span>
            <input
              className="settings-control settings-number"
              type="number"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              value={settings.fontSize}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) {
                  update({
                    fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(next))),
                  });
                }
              }}
            />
          </label>

          <label className="settings-row">
            <span className="settings-label">Editor font</span>
            <select
              className="settings-control"
              value={settings.editorFont}
              onChange={(e) => update({ editorFont: e.target.value as EditorFontId })}
            >
              {EDITOR_FONTS.map((f) => (
                <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-row">
            <span className="settings-label">Interface font (tabs, sidebar)</span>
            <select
              className="settings-control"
              value={settings.uiFont}
              onChange={(e) => update({ uiFont: e.target.value as UiFontId })}
            >
              {UI_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-row">
            <span className="settings-label">Read mode margins</span>
            <select
              className="settings-control"
              value={settings.readerMargins}
              onChange={(e) =>
                update({ readerMargins: e.target.value as Settings['readerMargins'] })
              }
            >
              {READER_MARGINS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-row">
            <span className="settings-label">Cursor style</span>
            <select
              className="settings-control"
              value={settings.cursorStyle}
              onChange={(e) => update({ cursorStyle: e.target.value as Settings['cursorStyle'] })}
            >
              {CURSOR_STYLE_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-row settings-row-inline">
            <input
              type="checkbox"
              checked={settings.wordWrap}
              onChange={(e) => update({ wordWrap: e.target.checked })}
            />
            <span className="settings-label">Word wrap</span>
          </label>

          <label className="settings-row settings-row-inline">
            <input
              type="checkbox"
              checked={settings.ligatures}
              onChange={(e) => update({ ligatures: e.target.checked })}
            />
            <span className="settings-label">Font ligatures (→ as one glyph)</span>
          </label>

          <label className="settings-row settings-row-inline">
            <input
              type="checkbox"
              checked={settings.liveSave}
              onChange={(e) => update({ liveSave: e.target.checked })}
            />
            <span className="settings-label">Live save (opened files save automatically)</span>
          </label>

          <label className="settings-row settings-row-inline">
            <input
              type="checkbox"
              checked={settings.confirmFileMove}
              onChange={(e) => update({ confirmFileMove: e.target.checked })}
            />
            <span className="settings-label">Confirm before moving files between folders</span>
          </label>

          <label className="settings-row settings-row-inline">
            <input
              type="checkbox"
              checked={settings.previewTabs}
              onChange={(e) => update({ previewTabs: e.target.checked })}
            />
            <span className="settings-label">
              Preview tabs (single-click opens in a reused, italic tab)
            </span>
          </label>

          <label className="settings-row">
            <span className="settings-label">Pasted / dropped images</span>
            <select
              className="settings-control"
              value={settings.imagePasteLocation}
              onChange={(e) =>
                update({ imagePasteLocation: e.target.value as Settings['imagePasteLocation'] })
              }
            >
              {IMAGE_LOCATIONS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          {settings.imagePasteLocation !== 'sameFolder' && (
            <label className="settings-row">
              <span className="settings-label">Image folder name</span>
              <input
                className="settings-control"
                type="text"
                value={settings.imageFolderName}
                spellCheck={false}
                placeholder="images"
                // Persist the raw text; normalizeSettings trims and defaults a
                // blank name on the next load, so an in-progress empty field is fine.
                onChange={(e) => update({ imageFolderName: e.target.value })}
                onBlur={(e) => {
                  if (e.target.value.trim().length === 0) {
                    update({ imageFolderName: 'images' });
                  }
                }}
              />
            </label>
          )}

          <div className="settings-row settings-row-notes">
            <span className="settings-label">Notes folder</span>
            <div className="settings-notes-value">
              <span className="settings-path" title={settings.notesDir ?? undefined}>
                {settings.notesDir ?? 'Default (app data folder)'}
              </span>
              {/* No folder picker on Android — the notes folder is fixed there. */}
              {currentProvider().capabilities.canPickDir && (
                <button className="settings-button" onClick={() => requestChangeNotesDir()}>
                  Change…
                </button>
              )}
            </div>
          </div>
          <UpdatesRow />
        </div>

        <footer className="settings-footer">
          <button className="settings-button" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
