/**
 * The availability store: one `find_programs` scan per refresh, mapped onto
 * every agent, the install tools and the custom program; stale answers
 * dropped; and the pure row model the Settings dialog renders from.
 */
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { AI_TUI_AGENTS, DEFAULT_SETTINGS } from '../../../core/settings';
import { AI_TUI_AGENT_IDS } from '../../../core/types';
import { INSTALL_TOOLS } from '../../../core/tui-install';
import { ipc } from '../../../ipc/commands';
import { settingsStore } from '../settings';
import {
  UNKNOWN_AVAILABILITY,
  agentRowModel,
  availabilityOf,
  customProgram,
  installContextOf,
  programsToCheck,
  tuiAvailabilityStore,
} from '../tui-availability';

let findPrograms: MockInstance<typeof ipc.findPrograms>;

function reset(): void {
  settingsStore.getState().replace({ ...DEFAULT_SETTINGS });
  tuiAvailabilityStore.setState({
    agents: Object.fromEntries(AI_TUI_AGENT_IDS.map((id) => [id, UNKNOWN_AVAILABILITY])) as never,
    tools: Object.fromEntries(INSTALL_TOOLS.map((t) => [t, UNKNOWN_AVAILABILITY])) as never,
    custom: UNKNOWN_AVAILABILITY,
    checking: false,
  });
}

/** A scan answer: everything missing except the named programs. */
function answer(installed: Record<string, string>): (names: string[]) => Promise<never> {
  return async (names: string[]) =>
    Object.fromEntries(names.map((n) => [n, installed[n] ?? null])) as never;
}

beforeEach(() => {
  reset();
  findPrograms = vi.spyOn(ipc, 'findPrograms');
});

afterEach(() => {
  findPrograms.mockRestore();
});

describe('programsToCheck', () => {
  test('asks for every agent command, every install tool, and the custom program once', () => {
    const names = programsToCheck('aider');
    for (const id of AI_TUI_AGENT_IDS) {
      expect(names).toContain(AI_TUI_AGENTS[id].program);
    }
    for (const tool of INSTALL_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names).toContain('aider');
    expect(new Set(names).size).toBe(names.length);
    // A custom command naming a known agent adds nothing.
    expect(programsToCheck('claude')).toEqual(programsToCheck(null));
  });

  test('customProgram is the first token of the command line, or null', () => {
    expect(customProgram('aider --model "gpt 5"')).toBe('aider');
    expect(customProgram('/usr/bin/aider')).toBe('/usr/bin/aider');
    expect(customProgram('')).toBeNull();
    expect(customProgram('   ')).toBeNull();
  });
});

describe('availabilityOf', () => {
  test('a path is installed, null is missing, an unanswered name stays unknown', () => {
    const found = { claude: '/usr/local/bin/claude', codex: null };
    expect(availabilityOf(found, 'claude')).toEqual({
      status: 'installed',
      path: '/usr/local/bin/claude',
    });
    expect(availabilityOf(found, 'codex')).toEqual({ status: 'missing', path: null });
    expect(availabilityOf(found, 'gemini')).toEqual(UNKNOWN_AVAILABILITY);
  });
});

describe('agentRowModel', () => {
  test('unknown shows nothing and offers nothing', () => {
    expect(agentRowModel(UNKNOWN_AVAILABILITY, true)).toEqual({
      dimmed: false,
      hint: null,
      title: null,
      install: false,
    });
  });

  test('installed shows a check mark with the path, undimmed, no Install', () => {
    expect(agentRowModel({ status: 'installed', path: 'C:\\bin\\claude.exe' }, true)).toEqual({
      dimmed: false,
      hint: '✓ C:\\bin\\claude.exe',
      title: 'C:\\bin\\claude.exe',
      install: false,
    });
  });

  test('missing dims the row; Install only when a route exists', () => {
    expect(agentRowModel({ status: 'missing', path: null }, true)).toEqual({
      dimmed: true,
      hint: 'not found on PATH',
      title: null,
      install: true,
    });
    const noRoute = agentRowModel({ status: 'missing', path: null }, false);
    expect(noRoute.dimmed).toBe(true);
    expect(noRoute.install).toBe(false);
    expect(noRoute.hint).toMatch(/Node\.js/);
  });
});

describe('refresh', () => {
  test('one scan fills agents, tools and custom; checking toggles around it', async () => {
    settingsStore.getState().update({ aiTuiAgent: 'custom', aiTuiCustomCommand: 'aider --pro' });
    findPrograms.mockImplementation(
      answer({ claude: '/home/u/.local/bin/claude', npm: '/usr/bin/npm', aider: '/usr/bin/aider' }),
    );

    const pending = tuiAvailabilityStore.getState().refresh();
    expect(tuiAvailabilityStore.getState().checking).toBe(true);
    await pending;

    const state = tuiAvailabilityStore.getState();
    expect(findPrograms).toHaveBeenCalledTimes(1);
    expect(state.checking).toBe(false);
    expect(state.agents.claude).toEqual({
      status: 'installed',
      path: '/home/u/.local/bin/claude',
    });
    expect(state.agents.chatgpt).toEqual({ status: 'missing', path: null });
    expect(state.agents.copilot.status).toBe('missing');
    expect(state.agents.opencode.status).toBe('missing');
    expect(state.tools.npm.status).toBe('installed');
    expect(state.tools.winget.status).toBe('missing');
    expect(state.custom).toEqual({ status: 'installed', path: '/usr/bin/aider' });
    expect(installContextOf(state.tools)).toEqual({
      hasNpm: true,
      hasBrew: false,
      hasWinget: false,
      hasScoop: false,
    });
  });

  test('no custom command configured: custom stays unknown', async () => {
    findPrograms.mockImplementation(answer({}));
    await tuiAvailabilityStore.getState().refresh();
    expect(tuiAvailabilityStore.getState().custom).toEqual(UNKNOWN_AVAILABILITY);
    expect(findPrograms.mock.calls[0]![0]).toEqual(programsToCheck(null));
  });

  test('a scan that fails leaves every status as it was', async () => {
    findPrograms.mockImplementation(answer({ claude: '/x/claude' }));
    await tuiAvailabilityStore.getState().refresh();
    findPrograms.mockRejectedValue(new Error('no such command'));
    await tuiAvailabilityStore.getState().refresh();
    const state = tuiAvailabilityStore.getState();
    expect(state.agents.claude.status).toBe('installed');
    expect(state.checking).toBe(false);
  });

  test('the newest refresh wins over an older one that answers late', async () => {
    let releaseFirst: (v: Record<string, string | null>) => void = () => {};
    findPrograms.mockImplementationOnce(
      () => new Promise<Record<string, string | null>>((resolve) => (releaseFirst = resolve)),
    );
    findPrograms.mockImplementationOnce(answer({ claude: '/new/claude' }));

    const first = tuiAvailabilityStore.getState().refresh();
    const second = tuiAvailabilityStore.getState().refresh();
    await second;
    expect(tuiAvailabilityStore.getState().agents.claude.path).toBe('/new/claude');

    // The stale answer says claude is gone — and is ignored.
    releaseFirst(Object.fromEntries(programsToCheck(null).map((n) => [n, null])));
    await first;
    expect(tuiAvailabilityStore.getState().agents.claude.path).toBe('/new/claude');
    expect(tuiAvailabilityStore.getState().checking).toBe(false);
  });
});
