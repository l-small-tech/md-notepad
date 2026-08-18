/**
 * One terminal tab page: the host for its split tree of `TerminalPane`s.
 *
 * INVARIANT I10 — a terminal page keeps its box. This component is hidden
 * with `visibility: hidden` (plus `pointer-events: none`), NEVER
 * `display: none`, and is never unmounted while its tab exists. A pane hidden
 * with `display: none` measures 0×0, its `ResizeObserver` resizes the pty to
 * 1×1, and every TUI running in it redraws into a corner — a bug the user
 * sees the moment they switch back. `EditorHost` uses `display: none` for
 * exactly the opposite reason (a hidden CM6 must not lay out); the two must
 * stay different. See src/ui/README.md.
 *
 * The tab owns no pty. Each pane spawns and kills its own; this component
 * only decides where they go and which one has the keyboard.
 */

import { useMemo } from 'react';
import { resolveTerminalProfile } from '../../core/settings';
import { PaneTree } from './PaneTree';
import { TerminalPane } from './TerminalPane';
import { closeTab } from '../session';
import { useSettingsStore } from '../stores/settings';
import { tabsStore } from '../stores/tabs';
import { terminalsStore, useTerminalsStore } from '../stores/terminals';
import { useThemeRegistry } from '../stores/theme-registry';
import { terminalThemeFor } from '../terminal-theme';
import { useDark } from '../theme';

export function TerminalTab({ tabId, active }: { tabId: string; active: boolean }) {
  const session = useTerminalsStore((s) => s.sessions[tabId]);
  const panes = useTerminalsStore((s) => s.panes);
  const settings = useSettingsStore((s) => s.settings);
  const plugins = useThemeRegistry((s) => s.plugins);
  const dark = useDark();

  // One resolved palette for every pane in the app: two panes must never
  // disagree about what "blue" is.
  const theme = useMemo(() => {
    const plugin = plugins.find((p) => p.id === settings.colorScheme) ?? null;
    return terminalThemeFor(plugin, dark);
  }, [plugins, settings.colorScheme, dark]);

  if (!session) {
    return null;
  }

  return (
    <div
      className="terminal-tab"
      // I10: the box stays, so every pane keeps its measured size.
      style={active ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
      aria-hidden={!active}
    >
      <PaneTree
        node={session.tree}
        onRatio={(splitId, ratio) => terminalsStore.getState().setRatio(tabId, splitId, ratio)}
        renderPane={(paneId) => {
          const pane = panes[paneId];
          if (!pane) {
            return null;
          }
          return (
            <TerminalPane
              paneId={paneId}
              profile={resolveTerminalProfile(settings, pane.profileId)}
              settings={settings}
              theme={theme}
              active={active && session.activePaneId === paneId}
              cwd={pane.cwd}
              onTitle={(title) => {
                terminalsStore.getState().setPaneTitle(paneId, title);
                // Only the focused pane names the tab.
                if (terminalsStore.getState().sessions[tabId]?.activePaneId === paneId) {
                  tabsStore.getState().setTerminalTitle(tabId, title);
                }
              }}
              onCwd={(cwd) => terminalsStore.getState().setPaneCwd(paneId, cwd)}
              onExit={(code) => {
                terminalsStore.getState().markExited(paneId, code);
                if (settings.terminalOnExit !== 'close') {
                  return;
                }
                // Closing the LAST pane closes the tab, which is what makes
                // `exit` in a single-pane terminal behave like Ctrl+W.
                if (terminalsStore.getState().closePane(paneId)) {
                  closeTab(tabId);
                }
              }}
              onFocus={() => {
                terminalsStore.getState().focusPane(tabId, paneId);
                tabsStore.getState().activateTab(tabId);
              }}
            />
          );
        }}
      />
    </div>
  );
}
