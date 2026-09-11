import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The controller's collaborators: the speech bridge is the thing under test's
// counterpart, everything else is a minimal stand-in.
const ipc = vi.hoisted(() => ({
  sttPermission: vi.fn(),
  sttRequestPermission: vi.fn(),
  sttAvailable: vi.fn(),
  sttStart: vi.fn(),
  sttStop: vi.fn(),
  voiceTypingToggle: vi.fn(),
}));
const platform = vi.hoisted(() => ({ windows: false }));
const writes = vi.hoisted(() => [] as { path: string; text: string }[]);

vi.mock('../../ipc/commands', () => ({ ipc, IpcError: class extends Error {} }));
vi.mock('../../ipc/provider', () => ({
  currentProvider: () => ({
    atomicWriteText: (path: string, text: string) => {
      writes.push({ path, text });
      return Promise.resolve();
    },
  }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../platform', () => ({
  isAndroid: () => !platform.windows,
  isWindows: () => platform.windows,
}));
vi.mock('../session/facade', () => ({ workspaceRootFor: () => null }));
vi.mock('../stores/settings', () => ({
  settingsStore: {
    getState: () => ({
      settings: { voiceNotesLocation: 'nextToFile', voiceNotesFolderName: 'Voice Notes' },
    }),
  },
}));
vi.mock('../stores/tabs', () => ({ tabsStore: { getState: () => ({ tabs: [] }) } }));
vi.mock('../stores/ui', () => ({ uiStore: { getState: () => ({ showNotice: vi.fn() }) } }));

import {
  closePanel,
  STOP_WATCHDOG_MS,
  toggleMic,
  updateDraft,
  voiceStore,
  VOICE_TYPING_IDLE_MS,
  VOICE_TYPING_SETTLE_MS,
  voiceTypingFieldReady,
} from '../voice-comments';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the capture's awaits (permission → availability → start) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** The sheet open on line 3 of a saved note, mic idle. */
function openReady(): void {
  voiceStore.setState({
    phase: 'ready',
    tabId: 't1',
    notePath: 'C:/notes/pricing.md',
    commentsPath: 'C:/notes/pricing.comments.md',
    comments: [],
    focusId: null,
    line: 3,
    quote: 'The new pricing goes live on Friday.',
    error: null,
    stopping: false,
    draft: '',
  });
}

const state = () => voiceStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  ipc.sttPermission.mockReset().mockResolvedValue(true);
  ipc.sttRequestPermission.mockReset().mockResolvedValue(true);
  ipc.sttAvailable.mockReset().mockResolvedValue(true);
  ipc.sttStart.mockReset();
  ipc.sttStop.mockReset().mockResolvedValue(undefined);
  writes.length = 0;
  platform.windows = false;
  ipc.voiceTypingToggle.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  closePanel();
  vi.useRealTimers();
});

describe('voice-note capture on Android: two taps', () => {
  test('the second tap asks the engine to finish once; more taps wait for it', async () => {
    const start = deferred<string>();
    ipc.sttStart.mockReturnValue(start.promise);
    openReady();

    toggleMic();
    await settle();
    expect(state().phase).toBe('capturing');
    expect(ipc.sttStart).toHaveBeenCalledTimes(1);

    toggleMic();
    expect(state().stopping).toBe(true);
    toggleMic();
    toggleMic();
    expect(ipc.sttStop).toHaveBeenCalledTimes(1);
    expect(ipc.sttStart).toHaveBeenCalledTimes(1);

    start.resolve('  Ship it on Friday. ');
    await settle();
    expect(state().phase).toBe('viewing');
    expect(state().stopping).toBe(false);
    expect(state().comments.map((c) => c.transcript)).toEqual(['Ship it on Friday.']);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toContain('Ship it on Friday.');
  });

  test('an engine that never answers the stop cannot leave the mic stuck', async () => {
    ipc.sttStart.mockReturnValue(new Promise<string>(() => {}));
    openReady();
    toggleMic();
    await settle();
    toggleMic();

    vi.advanceTimersByTime(STOP_WATCHDOG_MS - 1);
    expect(state().phase).toBe('capturing');
    vi.advanceTimersByTime(1);
    expect(state().phase).toBe('ready');
    expect(state().stopping).toBe(false);
    expect(state().error?.code).toBe('STT_STOP_TIMEOUT');

    // …and the mic works again.
    toggleMic();
    await settle();
    expect(state().phase).toBe('capturing');
    expect(state().error).toBeNull();
    expect(ipc.sttStart).toHaveBeenCalledTimes(2);
  });

  test('a late result from an abandoned capture never lands on the next one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    ipc.sttStart.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    openReady();
    toggleMic();
    await settle();
    toggleMic();
    vi.advanceTimersByTime(STOP_WATCHDOG_MS); // first capture given up on
    toggleMic(); // second capture
    await settle();

    first.resolve('stale words');
    await settle();
    expect(state().phase).toBe('capturing');
    expect(state().comments).toEqual([]);

    toggleMic();
    second.resolve('fresh words');
    await settle();
    expect(state().comments.map((c) => c.transcript)).toEqual(['fresh words']);
  });

  test('a stop that settles normally disarms the watchdog', async () => {
    const start = deferred<string>();
    ipc.sttStart.mockReturnValue(start.promise);
    openReady();
    toggleMic();
    await settle();
    toggleMic();
    start.resolve('Done.');
    await settle();
    vi.advanceTimersByTime(STOP_WATCHDOG_MS * 2);
    expect(state().phase).toBe('viewing');
    expect(state().error).toBeNull();
  });

  test('closing mid-capture stops the engine and drops its result', async () => {
    const start = deferred<string>();
    ipc.sttStart.mockReturnValue(start.promise);
    openReady();
    toggleMic();
    await settle();

    closePanel();
    expect(ipc.sttStop).toHaveBeenCalledTimes(1);
    start.resolve('never saved');
    await settle();
    expect(state().phase).toBe('closed');
    expect(writes).toEqual([]);
  });

  test('an engine error shows in the sheet and the next tap clears it', async () => {
    ipc.sttStart.mockRejectedValueOnce(new Error('STT_PRIVACY'));
    openReady();
    toggleMic();
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toBe('STT_PRIVACY');

    ipc.sttStart.mockReturnValue(new Promise<string>(() => {}));
    toggleMic();
    expect(state().error).toBeNull();
  });
});

describe('voice-note capture on Windows: voice typing', () => {
  beforeEach(() => {
    platform.windows = true;
  });

  test('the first tap opens the draft box; voice typing starts once it has focus', async () => {
    openReady();
    toggleMic();
    await settle();
    expect(state().phase).toBe('capturing');
    expect(ipc.sttStart).not.toHaveBeenCalled();
    expect(ipc.voiceTypingToggle).not.toHaveBeenCalled();

    voiceTypingFieldReady();
    voiceTypingFieldReady(); // a re-render must not press Win+H twice
    expect(ipc.voiceTypingToggle).toHaveBeenCalledTimes(1);
  });

  test('the second tap closes voice typing and saves what it typed', async () => {
    openReady();
    toggleMic();
    voiceTypingFieldReady();
    updateDraft('Move the tax column');
    toggleMic();
    expect(state().stopping).toBe(true);
    expect(ipc.voiceTypingToggle).toHaveBeenCalledTimes(2);

    // The phrase in flight still lands while voice typing closes.
    updateDraft('Move the tax column before the demo. ');
    vi.advanceTimersByTime(VOICE_TYPING_SETTLE_MS);
    await settle();
    expect(state().phase).toBe('viewing');
    expect(state().comments.map((c) => c.transcript)).toEqual([
      'Move the tax column before the demo.',
    ]);
    expect(writes).toHaveLength(1);
  });

  test('nothing typed: the sheet says how to check voice typing', async () => {
    openReady();
    toggleMic();
    voiceTypingFieldReady();
    toggleMic();
    vi.advanceTimersByTime(VOICE_TYPING_SETTLE_MS);
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toBe('VOICE_TYPING_EMPTY');
    expect(writes).toEqual([]);
  });

  test('Win+H failing shows an error instead of a dead mic', async () => {
    ipc.voiceTypingToggle.mockRejectedValueOnce(new Error('VOICE_TYPING_FAILED:Access is denied.'));
    openReady();
    toggleMic();
    voiceTypingFieldReady();
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toContain('VOICE_TYPING_FAILED');
  });

  test('closing mid-capture closes voice typing and saves nothing', async () => {
    openReady();
    toggleMic();
    voiceTypingFieldReady();
    updateDraft('half a thought');
    closePanel();
    expect(ipc.voiceTypingToggle).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(VOICE_TYPING_SETTLE_MS);
    await settle();
    expect(state().phase).toBe('closed');
    expect(writes).toEqual([]);
  });

  test('the note finishes by itself once voice typing goes quiet', async () => {
    openReady();
    toggleMic();
    voiceTypingFieldReady();
    updateDraft('Ship it');
    vi.advanceTimersByTime(VOICE_TYPING_IDLE_MS - 1);
    updateDraft('Ship it on Friday.'); // still talking: the timer restarts
    vi.advanceTimersByTime(VOICE_TYPING_IDLE_MS - 1);
    expect(state().phase).toBe('capturing');
    expect(state().stopping).toBe(false);

    vi.advanceTimersByTime(1);
    expect(state().stopping).toBe(true);
    expect(ipc.voiceTypingToggle).toHaveBeenCalledTimes(2); // voice typing closed
    vi.advanceTimersByTime(VOICE_TYPING_SETTLE_MS);
    await settle();
    expect(state().phase).toBe('viewing');
    expect(state().comments.map((c) => c.transcript)).toEqual(['Ship it on Friday.']);
  });

  test('before anything is typed, it waits for the user', () => {
    openReady();
    toggleMic();
    voiceTypingFieldReady();
    vi.advanceTimersByTime(VOICE_TYPING_IDLE_MS * 10);
    expect(state().phase).toBe('capturing');
    expect(ipc.voiceTypingToggle).toHaveBeenCalledTimes(1);
  });
});
