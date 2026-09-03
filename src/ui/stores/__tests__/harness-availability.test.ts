/**
 * The availability store: one `find_programs` scan per refresh, mapped onto
 * every harness, the install tools and the custom program; stale answers
 * dropped; the automatic default a scan settles; and the pure row model the
 * Settings dialog renders from.
 */
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { HARNESSES, DEFAULT_SETTINGS } from '../../../core/settings';
import { HARNESS_IDS } from '../../../core/types';
import { INSTALL_TOOLS } from '../../../core/harness-install';
import { ipc } from '../../../ipc/commands';
import { settingsStore } from '../settings';
import {
  UNKNOWN_AVAILABILITY,
  harnessRowModel,
  availabilityOf,
  customProgram,
  installContextOf,
  programsToCheck,
  harnessAvailabilityStore,
  harnessInstalled,
} from '../harness-availability';

let findPrograms: MockInstance<typeof ipc.findPrograms>;

function reset(): void {
  settingsStore.getState().replace({ ...DEFAULT_SETTINGS });
  harnessAvailabilityStore.setState({
    harnesses: Object.fromEntries(HARNESS_IDS.map((id) => [id, UNKNOWN_AVAILABILITY])) as never,
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
  test('asks for every harness command, every install tool, and the custom program once', () => {
    const names = programsToCheck('aider');
    for (const id of HARNESS_IDS) {
      expect(names).toContain(HARNESSES[id].program);
    }
    for (const tool of INSTALL_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names).toContain('aider');
    expect(new Set(names).size).toBe(names.length);
    // A custom command naming a known harness adds nothing.
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

describe('harnessRowModel', () => {
  test('unknown shows nothing and offers nothing', () => {
    expect(harnessRowModel(UNKNOWN_AVAILABILITY, true)).toEqual({
      dimmed: false,
      installing: false,
      hint: null,
      title: null,
      install: false,
    });
  });

  test('installed shows a check mark with the path, undimmed, no Install', () => {
    expect(harnessRowModel({ status: 'installed', path: 'C:\\bin\\claude.exe' }, true)).toEqual({
      dimmed: false,
      installing: false,
      hint: '✓ C:\\bin\\claude.exe',
      title: 'C:\\bin\\claude.exe',
      install: false,
    });
  });

  test('missing dims the row; Install only when a route exists', () => {
    expect(harnessRowModel({ status: 'missing', path: null }, true)).toEqual({
      dimmed: true,
      installing: false,
      hint: 'not found on PATH',
      title: null,
      install: true,
    });
    const noRoute = harnessRowModel({ status: 'missing', path: null }, false);
    expect(noRoute.dimmed).toBe(true);
    expect(noRoute.install).toBe(false);
    expect(noRoute.hint).toMatch(/Node\.js/);
  });

  test('installing replaces the Install button with a pending hint until found', () => {
    const pending = harnessRowModel({ status: 'missing', path: null }, true, true);
    expect(pending.installing).toBe(true);
    expect(pending.install).toBe(false);
    expect(pending.hint).toMatch(/^Installing/);
    // Found on PATH wins over the (still open) install tab.
    const found = harnessRowModel({ status: 'installed', path: '/usr/bin/claude' }, true, true);
    expect(found.installing).toBe(false);
    expect(found.hint).toBe('✓ /usr/bin/claude');
  });
});

describe('setInstalling', () => {
  test('adds and removes a harness once, never duplicating it', () => {
    const { setInstalling } = harnessAvailabilityStore.getState();
    setInstalling('claude', true);
    setInstalling('claude', true);
    expect(harnessAvailabilityStore.getState().installing).toEqual(['claude']);
    setInstalling('gemini', true);
    setInstalling('claude', false);
    expect(harnessAvailabilityStore.getState().installing).toEqual(['gemini']);
    setInstalling('gemini', false);
    expect(harnessAvailabilityStore.getState().installing).toEqual([]);
  });
});

describe('refresh', () => {
  test('one scan fills harnesses, tools and custom; checking toggles around it', async () => {
    settingsStore.getState().update({ harness: 'custom', harnessCustomCommand: 'aider --pro' });
    findPrograms.mockImplementation(
      answer({ claude: '/home/u/.local/bin/claude', npm: '/usr/bin/npm', aider: '/usr/bin/aider' }),
    );

    const pending = harnessAvailabilityStore.getState().refresh();
    expect(harnessAvailabilityStore.getState().checking).toBe(true);
    await pending;

    const state = harnessAvailabilityStore.getState();
    expect(findPrograms).toHaveBeenCalledTimes(1);
    expect(state.checking).toBe(false);
    expect(state.harnesses.claude).toEqual({
      status: 'installed',
      path: '/home/u/.local/bin/claude',
    });
    expect(state.harnesses.chatgpt).toEqual({ status: 'missing', path: null });
    expect(state.harnesses.copilot.status).toBe('missing');
    expect(state.harnesses.opencode.status).toBe('missing');
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
    await harnessAvailabilityStore.getState().refresh();
    expect(harnessAvailabilityStore.getState().custom).toEqual(UNKNOWN_AVAILABILITY);
    expect(findPrograms.mock.calls[0]![0]).toEqual(programsToCheck(null));
  });

  test('a scan that fails leaves every status as it was', async () => {
    findPrograms.mockImplementation(answer({ claude: '/x/claude' }));
    await harnessAvailabilityStore.getState().refresh();
    findPrograms.mockRejectedValue(new Error('no such command'));
    await harnessAvailabilityStore.getState().refresh();
    const state = harnessAvailabilityStore.getState();
    expect(state.harnesses.claude.status).toBe('installed');
    expect(state.checking).toBe(false);
  });

  test('the newest refresh wins over an older one that answers late', async () => {
    let releaseFirst: (v: Record<string, string | null>) => void = () => {};
    findPrograms.mockImplementationOnce(
      () => new Promise<Record<string, string | null>>((resolve) => (releaseFirst = resolve)),
    );
    findPrograms.mockImplementationOnce(answer({ claude: '/new/claude' }));

    const first = harnessAvailabilityStore.getState().refresh();
    const second = harnessAvailabilityStore.getState().refresh();
    await second;
    expect(harnessAvailabilityStore.getState().harnesses.claude.path).toBe('/new/claude');

    // The stale answer says claude is gone — and is ignored.
    releaseFirst(Object.fromEntries(programsToCheck(null).map((n) => [n, null])));
    await first;
    expect(harnessAvailabilityStore.getState().harnesses.claude.path).toBe('/new/claude');
    expect(harnessAvailabilityStore.getState().checking).toBe(false);
  });
});

describe('the automatic default', () => {
  test("a scan settles 'auto' on the first installed harness, in preference order", async () => {
    expect(settingsStore.getState().settings.harness).toBe('auto');
    findPrograms.mockImplementation(answer({ gemini: '/usr/bin/gemini', codex: '/usr/bin/codex' }));
    await harnessAvailabilityStore.getState().refresh();
    // ChatGPT (codex) outranks Gemini; Claude, which outranks both, is absent.
    expect(settingsStore.getState().settings.harness).toBe('chatgpt');
  });

  test('Claude wins whenever it is installed', async () => {
    findPrograms.mockImplementation(
      answer({ claude: '/usr/bin/claude', codex: '/usr/bin/codex', gemini: '/usr/bin/gemini' }),
    );
    await harnessAvailabilityStore.getState().refresh();
    expect(settingsStore.getState().settings.harness).toBe('claude');
  });

  test("nothing installed leaves the setting on 'auto', and a later install settles it", async () => {
    findPrograms.mockImplementation(answer({}));
    await harnessAvailabilityStore.getState().refresh();
    expect(settingsStore.getState().settings.harness).toBe('auto');

    findPrograms.mockImplementation(answer({ grok: '/usr/bin/grok' }));
    await harnessAvailabilityStore.getState().refresh();
    expect(settingsStore.getState().settings.harness).toBe('grok');
  });

  test('a choice the user made is never overwritten', async () => {
    settingsStore.getState().update({ harness: 'opencode' });
    findPrograms.mockImplementation(answer({ claude: '/usr/bin/claude' }));
    await harnessAvailabilityStore.getState().refresh();
    expect(settingsStore.getState().settings.harness).toBe('opencode');
  });
});

describe('harnessInstalled', () => {
  const none = Object.fromEntries(
    HARNESS_IDS.map((id) => [id, { status: 'missing', path: null }]),
  ) as never;

  test('false only once a scan has found nothing at all', () => {
    expect(harnessInstalled({ harnesses: none, custom: { status: 'missing', path: null } })).toBe(
      false,
    );
  });

  test('a known harness on PATH, or a custom command that resolved, is enough', () => {
    const withClaude = {
      ...(none as unknown as Record<string, { status: string; path: string | null }>),
      claude: { status: 'installed', path: '/usr/bin/claude' },
    } as never;
    expect(harnessInstalled({ harnesses: withClaude, custom: UNKNOWN_AVAILABILITY })).toBe(true);
    expect(
      harnessInstalled({ harnesses: none, custom: { status: 'installed', path: '/x/aider' } }),
    ).toBe(true);
  });

  test('an unscanned machine counts as installed — never refuse to launch on a guess', () => {
    const unknown = Object.fromEntries(
      HARNESS_IDS.map((id) => [id, UNKNOWN_AVAILABILITY]),
    ) as never;
    expect(harnessInstalled({ harnesses: unknown, custom: UNKNOWN_AVAILABILITY })).toBe(true);
  });
});
