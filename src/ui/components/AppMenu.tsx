/**
 * AppMenu — the shared pieces of the app's popover menus.
 *
 * Three menus offer the same app-level actions from opposite ends of the
 * chrome: the ribbon's ☰ button, the tab bar's own right-click menu (free
 * space after the last tab), and the "+ ⌄" new-tab picker. Rather than let
 * them drift, the row widget, the Themes page, and the two shared row blocks
 * (`AppActionRows`, `NewTabRows`) live here and every caller renders them.
 *
 * A row is glyph + label with an optional right-aligned shortcut hint; the
 * glyph column doubles as the ✓ column for checkable rows, so checked and
 * unchecked labels stay aligned. `keepOpen` is for rows that navigate WITHIN
 * the popover (drill-in / back) or apply live and invite a second try (picking
 * a theme).
 */

import { Fragment, type ReactNode } from 'react';
import { setFullscreen } from '../fullscreen';
import { detectPlatform } from '../keymap';
import { runNewTabChoice, terminalsAvailable } from '../new-tab';
import { isAndroid } from '../platform';
import { openTerminal } from '../terminal-open';
import { useSettingsStore } from '../stores/settings';
import { uiStore, useUiStore } from '../stores/ui';
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

/** Which modifier the shortcut hints name. Shared so every menu agrees. */
export const IS_MAC = detectPlatform(navigator.platform) === 'mac';

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
  glyph: ReactNode;
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

/**
 * The shell icon the terminal rows wear — a terminal window with a prompt,
 * drawn rather than borrowed from a font so it reads as a shell at every UI
 * scale (the ❯ it replaces read as a submenu arrow next to the other rows).
 * `currentColor` keeps it on-theme, including in a row's disabled state.
 */
function ShellGlyph() {
  return (
    <svg className="app-menu-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.9 6.6 6.9 8.4 4.9 10.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.4 10.4h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The "what kind of tab" rows — note, drawing, and the terminal profile(s).
 *
 * Shared because the choice is offered from two places: the "+" button's
 * picker and the bar menu's New tab page. Terminal profiles sit in the same
 * flat list as the document kinds rather than under a heading of their own:
 * "Shell" is one more thing the + button makes, not a separate section. They
 * are absent entirely on Android, which has no pty.
 */
export function NewTabRows({ onClose }: { onClose: () => void }) {
  const profiles = useSettingsStore((s) => s.settings.terminalProfiles);

  return (
    <>
      <AppMenuItem
        glyph="📝"
        label="Markdown note"
        onPick={() => runNewTabChoice('note')}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="✎"
        label="Vector drawing (.svg)"
        onPick={() => runNewTabChoice('drawing')}
        onClose={onClose}
      />
      {terminalsAvailable() &&
        profiles.map((profile) => (
          <AppMenuItem
            key={profile.id}
            glyph={<ShellGlyph />}
            label={profile.name}
            onPick={() => openTerminal(profile.id)}
            onClose={onClose}
          />
        ))}
    </>
  );
}

/**
 * The app-level rows every popover carries: Themes, Settings, and the two
 * full-screen stages.
 *
 * Shared so the tab bar's menu and the "+" picker cannot drift — a user who
 * opened the picker to start something is one row away from the settings and
 * the stage that thing should open into, without hunting for a second menu.
 * Themes is a drill-in page rather than a flyout (see `ThemesMenuPage`), so
 * the caller owns the page state and passes `onOpenThemes`.
 */
export function AppActionRows({
  onOpenThemes,
  onClose,
}: {
  onOpenThemes: () => void;
  onClose: () => void;
}) {
  const stage = useUiStore((s) => s.fullscreenView);

  return (
    <>
      <AppMenuItem
        glyph="🎨"
        label="Themes"
        title="Pick a theme, or make your own"
        shortcut="›"
        onPick={onOpenThemes}
        onClose={onClose}
        keepOpen
      />
      <AppMenuItem
        glyph="⚙"
        label="Settings"
        shortcut={IS_MAC ? '⌘,' : 'Ctrl+,'}
        onPick={() => uiStore.getState().openSettings()}
        onClose={onClose}
      />
      <AppMenuDivider />
      {/* Both rows toggle: picking the stage you are already in returns to
          normal, so the ✓ reads as a switch rather than a destination. */}
      <AppMenuItem
        glyph={stage === 'window' ? '✓' : '⤢'}
        label={isAndroid() ? 'Full screen' : 'Full window'}
        title="Hide the app chrome and show only the document"
        onPick={() => setFullscreen(stage === 'window' ? 'normal' : 'window')}
        onClose={onClose}
      />
      {/* Android's window already fills the screen — the OS stage would look
          identical to the chrome-hiding one (see ui/fullscreen.ts). */}
      {!isAndroid() && (
        <AppMenuItem
          glyph={stage === 'screen' ? '✓' : '⛶'}
          label="Full screen"
          title="Hide the app chrome and make the window fullscreen"
          shortcut={IS_MAC ? '⌃⌘F' : 'F11'}
          onPick={() => setFullscreen(stage === 'screen' ? 'normal' : 'screen')}
          onClose={onClose}
        />
      )}
    </>
  );
}
