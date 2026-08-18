/**
 * AppMenu — the shared pieces of the app's popover menus.
 *
 * Two menus offer the same app-level actions from opposite ends of the
 * chrome: the ribbon's ☰ button and the tab bar's own right-click menu (free
 * space after the last tab). Rather than let the two drift, the row widget and
 * the Themes page live here and both callers render them.
 *
 * A row is glyph + label with an optional right-aligned shortcut hint; the
 * glyph column doubles as the ✓ column for checkable rows, so checked and
 * unchecked labels stay aligned. `keepOpen` is for rows that navigate WITHIN
 * the popover (drill-in / back) or apply live and invite a second try (picking
 * a theme).
 */

import { Fragment } from 'react';
import { isAndroid } from '../platform';
import { useSettingsStore } from '../stores/settings';
import { currentThemeValue, themePickerGroups, useThemeRegistry } from '../stores/theme-registry';
import { useWindowTheme } from '../stores/window-theme';
import {
  canRevealThemesFolder,
  newTheme,
  openThemesFolder,
  openThemesHelp,
  reloadThemes,
  selectTheme,
  unpinThemeFromWindow,
} from '../theme-actions';

/** One row of a popover menu: glyph + label, optional right-aligned shortcut. */
export function AppMenuItem({
  glyph,
  label,
  shortcut,
  title,
  disabled,
  onPick,
  onSecondaryPick,
  onClose,
  keepOpen,
}: {
  glyph: string;
  label: string;
  shortcut?: string;
  title?: string;
  disabled?: boolean;
  onPick: () => void;
  /** Right-click variant of the row's action (theme rows: this window only).
   *  Rows that don't set it keep the browser's default context menu. */
  onSecondaryPick?: () => void;
  onClose: () => void;
  /** Drill-in / back rows stay open — they navigate within the popover. */
  keepOpen?: boolean;
}) {
  return (
    <button
      className="tab-menu-item app-menu-item"
      role="menuitem"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!keepOpen) {
          onClose();
        }
        onPick();
      }}
      onContextMenu={
        onSecondaryPick &&
        ((e) => {
          e.preventDefault();
          if (!keepOpen) {
            onClose();
          }
          onSecondaryPick();
        })
      }
    >
      <span>
        <span className="app-menu-glyph">{glyph}</span>
        {label}
      </span>
      {shortcut && <span className="app-menu-shortcut">{shortcut}</span>}
    </button>
  );
}

/** A hairline between groups of rows. */
export function AppMenuDivider() {
  return <div className="app-menu-divider" role="separator" />;
}

/**
 * The Themes page — every installed theme (same grouping and order as the
 * Settings dropdown, ✓ on the current one), then the folder actions that used
 * to live in Settings: Open folder / New theme… / Reload, plus Help, which
 * opens the bundled themes guide.
 *
 * It's a drill-in page of its popover rather than a flyout: one panel works
 * the same under a mouse and a finger (Android has no hover), and the theme
 * list can be long.
 */
export function ThemesMenuPage({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const plugins = useThemeRegistry((s) => s.plugins);
  const settings = useSettingsStore((s) => s.settings);
  const pinned = useWindowTheme((s) => s.override !== null);
  const current = currentThemeValue(settings);
  const groups = themePickerGroups(plugins);
  // Android runs a single webview — a per-window theme has nothing to be per
  // (and there is no right-click there either).
  const perWindow = !isAndroid();
  return (
    <>
      <AppMenuItem glyph="‹" label="Back" onPick={onBack} onClose={onClose} keepOpen />
      <AppMenuDivider />
      {/* Picking sets the theme for every window; right-clicking pins it here. */}
      {perWindow && (
        <>
          <div className="app-menu-heading">Right-click: this window only</div>
          {pinned && (
            <AppMenuItem
              glyph="⌂"
              label="Use shared theme"
              title="Stop pinning a theme to this window and follow the all-windows theme again"
              onPick={unpinThemeFromWindow}
              onClose={onClose}
              keepOpen
            />
          )}
          <AppMenuDivider />
        </>
      )}
      {groups.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <AppMenuDivider />}
          {group.label !== null && <div className="app-menu-heading">{group.label}</div>}
          {group.options.map((option) => (
            <AppMenuItem
              key={option.value}
              // The ✓ column is the glyph slot, so checked and unchecked rows
              // keep their labels aligned.
              glyph={option.value === current ? '✓' : ''}
              label={option.label}
              title={perWindow ? 'Set for all windows (right-click: this window only)' : undefined}
              onPick={() => selectTheme(option.value)}
              onSecondaryPick={perWindow ? () => selectTheme(option.value, true) : undefined}
              onClose={onClose}
              // Picking applies live — staying open lets the user try a few.
              keepOpen
            />
          ))}
        </Fragment>
      ))}
      <AppMenuDivider />
      {canRevealThemesFolder() && (
        <AppMenuItem
          glyph="📂"
          label="Open folder"
          title="Show the themes folder in your file manager"
          onPick={() => void openThemesFolder()}
          onClose={onClose}
        />
      )}
      <AppMenuItem
        glyph="✚"
        label="New theme…"
        title="Create a starter theme file, select it, and reveal it"
        onPick={() => void newTheme()}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="⟲"
        label="Reload"
        title="Re-read the themes folder after editing or adding files"
        onPick={() => void reloadThemes()}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="?"
        label="Help"
        title="How to create your own theme"
        onPick={openThemesHelp}
        onClose={onClose}
      />
    </>
  );
}
