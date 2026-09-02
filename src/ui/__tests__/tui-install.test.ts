/**
 * The Install button's action: which shell dialect it picks from the
 * configured shell, that it opens ONE shell tab in the default workspace
 * with the command as `initialInput`, and that closing that tab re-checks
 * availability.
 */
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

// The session facade's module graph reaches the Tauri plugins; only the
// default workspace path is read here.
const defaultWorkspacePath = vi.fn<() => string | null>(() => '/home/u/notes');
vi.mock('../session', () => ({
  getDefaultWorkspacePath: () => defaultWorkspacePath(),
}));
// Which OS the command is shaped for. The UA in node is empty (→ 'linux');
// the Windows case is forced explicitly.
const os = vi.fn<() => 'windows' | 'mac' | 'linux'>(() => 'linux');
vi.mock('../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform')>()),
  desktopOs: () => os(),
}));

import { DEFAULT_SETTINGS } from '../../core/settings';
import { ipc } from '../../ipc/commands';
import { defaultShellStore, resetDefaultShell } from '../stores/default-shell';
import { settingsStore } from '../stores/settings';
import { tabsStore } from '../stores/tabs';
import { terminalsStore } from '../stores/terminals';
import { tuiAvailabilityStore } from '../stores/tui-availability';
import { installAgent, whenTabCloses } from '../tui-install';

let defaultShell: MockInstance<typeof ipc.defaultShell>;
let findPrograms: MockInstance<typeof ipc.findPrograms>;

function terminalTabs() {
  return tabsStore.getState().tabs.filter((t) => t.kind === 'terminal');
}

/** The one pane of the newest terminal tab. */
function newestPane() {
  const tab = terminalTabs().at(-1)!;
  const session = terminalsStore.getState().sessions[tab.id]!;
  return terminalsStore.getState().panes[session.activePaneId]!;
}

beforeEach(() => {
  settingsStore.getState().replace({ ...DEFAULT_SETTINGS });
  os.mockReturnValue('linux');
  resetDefaultShell();
  defaultShell = vi.spyOn(ipc, 'defaultShell').mockResolvedValue('bash');
  findPrograms = vi
    .spyOn(ipc, 'findPrograms')
    .mockImplementation(async (names) => Object.fromEntries(names.map((n) => [n, null])));
  tuiAvailabilityStore.setState({
    tools: {
      npm: { status: 'installed', path: '/usr/bin/npm' },
      brew: { status: 'missing', path: null },
      winget: { status: 'missing', path: null },
      scoop: { status: 'missing', path: null },
    },
  });
});

afterEach(() => {
  defaultShell.mockRestore();
  findPrograms.mockRestore();
  for (const tab of terminalTabs()) {
    tabsStore.getState().closeTab(tab.id);
  }
});

describe('installAgent', () => {
  test('opens one shell tab in the default workspace and types the command', async () => {
    const before = terminalTabs().length;
    const tabId = await installAgent('gemini');

    expect(tabId).not.toBeNull();
    expect(terminalTabs()).toHaveLength(before + 1);
    const pane = newestPane();
    expect(pane.tabId).toBe(tabId);
    expect(pane.profileId).toBe('shell');
    expect(pane.cwd).toBe('/home/u/notes');
    expect(pane.initialInput).toBe('npm install -g @google/gemini-cli');
  });

  test('the configured shell decides the dialect (Windows PowerShell 5.1 here)', async () => {
    os.mockReturnValue('windows');
    settingsStore.getState().update({ terminalShell: 'powershell.exe' });
    tuiAvailabilityStore.setState({
      tools: {
        npm: { status: 'missing', path: null },
        brew: { status: 'missing', path: null },
        winget: { status: 'installed', path: 'C:\\winget.exe' },
        scoop: { status: 'missing', path: null },
      },
    });

    const resolve = vi.spyOn(defaultShellStore.getState(), 'resolve');
    await installAgent('gemini');

    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
    expect(newestPane().initialInput).toMatch(
      /^winget install -e --id OpenJS\.NodeJS\.LTS; if \(\$\?\)/,
    );
  });

  test('an automatic shell asks the shared default-shell cache which one it is', async () => {
    os.mockReturnValue('windows');
    // The same cache the Settings dialog and terminal panes consult, so the
    // install line is spelled for the shell they will actually spawn.
    defaultShellStore.setState({ program: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
    const resolve = vi.spyOn(defaultShellStore.getState(), 'resolve');
    await installAgent('claude');
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockRestore();
    expect(defaultShell).not.toHaveBeenCalled();
    // pwsh 7: the native installer, no winget on this machine.
    expect(newestPane().initialInput).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  test('no route (Windows, npm-only tool, neither npm nor winget) opens nothing', async () => {
    os.mockReturnValue('windows');
    tuiAvailabilityStore.setState({
      tools: {
        npm: { status: 'missing', path: null },
        brew: { status: 'missing', path: null },
        winget: { status: 'missing', path: null },
        scoop: { status: 'missing', path: null },
      },
    });
    const before = terminalTabs().length;
    expect(await installAgent('copilot')).toBeNull();
    expect(terminalTabs()).toHaveLength(before);
  });

  test('closing the install tab re-checks availability', async () => {
    const tabId = (await installAgent('gemini'))!;
    expect(findPrograms).not.toHaveBeenCalled();

    tabsStore.getState().closeTab(tabId);
    await Promise.resolve();

    expect(findPrograms).toHaveBeenCalledTimes(1);
    // Closing some OTHER tab afterwards does not scan again.
    const other = newNoteTab();
    tabsStore.getState().closeTab(other);
    await Promise.resolve();
    expect(findPrograms).toHaveBeenCalledTimes(1);
  });
});

/** A fresh note tab's id (`newTab` returns nothing; the new tab is last). */
function newNoteTab(): string {
  tabsStore.getState().newTab();
  return tabsStore.getState().tabs.at(-1)!.id;
}

describe('whenTabCloses', () => {
  test('fires once, only for the watched tab, and can be cancelled', () => {
    const a = newNoteTab();
    const b = newNoteTab();
    const onClose = vi.fn();
    whenTabCloses(a, onClose);

    tabsStore.getState().closeTab(b);
    expect(onClose).not.toHaveBeenCalled();
    tabsStore.getState().closeTab(a);
    expect(onClose).toHaveBeenCalledTimes(1);

    const c = newNoteTab();
    const cancelled = vi.fn();
    whenTabCloses(c, cancelled)();
    tabsStore.getState().closeTab(c);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
