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
  whisperPrepare: vi.fn(),
  whisperTranscribe: vi.fn(),
}));
const platform = vi.hoisted(() => ({ windows: false, android: true }));
const writes = vi.hoisted(() => [] as { path: string; text: string }[]);
const settings = vi.hoisted(() => ({
  voiceNotesLocation: 'nextToFile',
  voiceNotesFolderName: 'Voice Notes',
  desktopDictationEngine: 'auto',
  androidDictationEngine: 'system',
  whisperModel: 'small.en-q5_1',
  whisperUseGpu: true,
}));
const notices = vi.hoisted(() => [] as string[]);
const opened = vi.hoisted(() => [] as (string | undefined)[]);
/** The fake microphone: what `startPcmCapture` resolves with, and its calls. */
const mic = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  onLimit: null as null | (() => void),
}));

vi.mock('../../ipc/commands', () => ({ ipc, IpcError: class extends Error {} }));
vi.mock('../../ipc/provider', () => ({
  currentProvider: () => ({
    // No sidecar yet: an empty file parses to no notes.
    readTextFile: () => Promise.resolve({ text: '', mtimeMs: 0 }),
    atomicWriteText: (path: string, text: string) => {
      writes.push({ path, text });
      return Promise.resolve();
    },
  }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../platform', () => ({
  isAndroid: () => platform.android,
  isWindows: () => platform.windows,
}));
vi.mock('../session/facade', () => ({ workspaceRootFor: () => null }));
vi.mock('../stores/settings', () => ({
  settingsStore: { getState: () => ({ settings }) },
}));
/** The tabs the controller can see (a Review-mode test needs a real one). */
const tabs = vi.hoisted(
  () => [] as { id: string; filePath: string | null; notePath: string | null; text: string }[],
);
vi.mock('../stores/tabs', () => ({
  tabsStore: {
    getState: () => ({
      tabs: tabs.map((t) => ({ ...t, model: { getText: () => t.text } })),
    }),
  },
}));
vi.mock('../stores/ui', () => ({
  uiStore: {
    getState: () => ({
      showNotice: (text: string) => notices.push(text),
      openSettings: (tab?: string) => opened.push(tab),
    }),
  },
}));
vi.mock('../pcm-capture', () => ({
  startPcmCapture: (options: { onLimit?: () => void }) => {
    mic.onLimit = options.onLimit ?? null;
    return mic.start();
  },
}));

import {
  closePanel,
  dictationEngine,
  openNoteAtLine,
  openVoiceSettings,
  STOP_WATCHDOG_MS,
  toggleMic,
  undoSnap,
  updateDraft,
  updateTranscript,
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
  notices.length = 0;
  tabs.length = 0;
  opened.length = 0;
  platform.windows = false;
  platform.android = true;
  settings.desktopDictationEngine = 'auto';
  settings.androidDictationEngine = 'system';
  settings.whisperModel = 'small.en-q5_1';
  settings.whisperUseGpu = true;
  ipc.voiceTypingToggle.mockReset().mockResolvedValue(undefined);
  ipc.whisperPrepare.mockReset().mockResolvedValue(undefined);
  ipc.whisperTranscribe.mockReset();
  mic.stop.mockReset().mockReturnValue(new Float32Array([0.1, -0.1, 0.2]));
  mic.cancel.mockReset();
  mic.onLimit = null;
  mic.start
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve({ sampleRate: 16_000, stop: mic.stop, cancel: mic.cancel }),
    );
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
    platform.android = false;
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

describe('dictationEngine: the desktop engine setting', () => {
  test('Android dictates with the on-device recognizer unless Whisper is chosen there', () => {
    settings.desktopDictationEngine = 'whisper'; // the desktop setting means nothing here
    expect(dictationEngine()).toBe('android');
    settings.androidDictationEngine = 'whisper';
    expect(dictationEngine()).toBe('whisper');
  });

  test('auto is Windows voice typing on Windows and Whisper elsewhere', () => {
    platform.android = false;
    platform.windows = true;
    expect(dictationEngine()).toBe('windows');
    platform.windows = false;
    expect(dictationEngine()).toBe('whisper');
  });

  test('an explicit choice wins; Windows voice typing off Windows is no engine', () => {
    platform.android = false;
    platform.windows = true;
    settings.desktopDictationEngine = 'whisper';
    expect(dictationEngine()).toBe('whisper');
    settings.desktopDictationEngine = 'windowsVoiceTyping';
    expect(dictationEngine()).toBe('windows');
    platform.windows = false;
    expect(dictationEngine()).toBeNull();
  });

  test('with no engine, the first tap explains instead of capturing', () => {
    platform.android = false;
    settings.desktopDictationEngine = 'windowsVoiceTyping';
    openReady();
    toggleMic();
    expect(state().phase).toBe('ready');
    expect(notices[0]).toMatch(/Whisper in Settings/);
  });
});

describe('voice-note capture with Whisper (offline)', () => {
  beforeEach(() => {
    platform.android = false;
    platform.windows = false;
  });

  test('first tap opens the mic and warms the model; second tap transcribes and saves', async () => {
    const answer = deferred<string>();
    ipc.whisperTranscribe.mockReturnValue(answer.promise);
    openReady();

    toggleMic();
    await settle();
    expect(state().phase).toBe('capturing');
    expect(mic.start).toHaveBeenCalledTimes(1);
    expect(ipc.whisperPrepare).toHaveBeenCalledWith('small.en-q5_1', true);
    expect(ipc.sttStart).not.toHaveBeenCalled();

    toggleMic();
    expect(mic.stop).toHaveBeenCalledTimes(1);
    expect(state().phase).toBe('transcribing');
    expect(state().stopping).toBe(false);
    expect(ipc.whisperTranscribe).toHaveBeenCalledTimes(1);
    const [pcm, rate, model, gpu] = ipc.whisperTranscribe.mock.calls[0] as [
      Float32Array,
      number,
      string,
      boolean,
    ];
    expect(Array.from(pcm)).toEqual([0.1, -0.1, 0.2].map((v) => Math.fround(v)));
    expect(rate).toBe(16_000);
    expect(model).toBe('small.en-q5_1');
    expect(gpu).toBe(true);

    toggleMic(); // taps while transcribing do nothing
    expect(ipc.whisperTranscribe).toHaveBeenCalledTimes(1);

    answer.resolve('  Move the tax column before the demo. ');
    await settle();
    expect(state().phase).toBe('viewing');
    expect(state().comments.map((c) => c.transcript)).toEqual([
      'Move the tax column before the demo.',
    ]);
    expect(writes).toHaveLength(1);
  });

  test('the chosen model and the GPU switch are what is transcribed with', async () => {
    settings.whisperModel = 'base.en-q5_1';
    settings.whisperUseGpu = false;
    ipc.whisperTranscribe.mockResolvedValue('ok');
    openReady();
    toggleMic();
    await settle();
    expect(ipc.whisperPrepare).toHaveBeenCalledWith('base.en-q5_1', false);
    toggleMic();
    await settle();
    expect(ipc.whisperTranscribe.mock.calls[0]?.[2]).toBe('base.en-q5_1');
    expect(ipc.whisperTranscribe.mock.calls[0]?.[3]).toBe(false);
  });

  test('Android with Whisper chosen captures PCM like a desktop, not the recognizer', async () => {
    platform.android = true;
    settings.androidDictationEngine = 'whisper';
    ipc.whisperTranscribe.mockResolvedValue('ok');
    openReady();
    toggleMic();
    await settle();
    expect(mic.start).toHaveBeenCalledTimes(1);
    expect(ipc.sttStart).not.toHaveBeenCalled();
    toggleMic();
    await settle();
    expect(ipc.whisperTranscribe).toHaveBeenCalledTimes(1);
  });

  test('a missing model fails the capture before anything is said, with the settings button', async () => {
    ipc.whisperPrepare.mockRejectedValue(
      Object.assign(new Error('whisper model not downloaded'), { code: 'WHISPER_NO_MODEL' }),
    );
    openReady();
    toggleMic();
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toContain('WHISPER_NO_MODEL');
    expect(state().error?.appSettings?.tab).toBe('voice');
    expect(mic.cancel).toHaveBeenCalledTimes(1); // the mic that had opened is released

    openVoiceSettings();
    expect(state().phase).toBe('closed');
    expect(opened).toEqual(['voice']);
  });

  test('a refused microphone shows in the sheet and never loads audio', async () => {
    mic.start.mockRejectedValue(new Error('WHISPER_MIC_DENIED'));
    openReady();
    toggleMic();
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toBe('WHISPER_MIC_DENIED');
    expect(state().error?.title).toMatch(/refused/);
  });

  test('an empty transcript is "did not catch that"; a transcription error keeps its code', async () => {
    ipc.whisperTranscribe.mockResolvedValueOnce('   ');
    openReady();
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toBe('STT_NO_MATCH');

    ipc.whisperTranscribe.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 'WHISPER_FAILED' }),
    );
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(state().error?.code).toBe('WHISPER_FAILED:boom');
    expect(writes).toEqual([]);
  });

  test('silence (no frames) is not sent to the engine', async () => {
    mic.stop.mockReturnValue(new Float32Array(0));
    openReady();
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(ipc.whisperTranscribe).not.toHaveBeenCalled();
    expect(state().error?.code).toBe('STT_NO_MATCH');
  });

  test('closing while capturing drops the audio; closing while transcribing drops the words', async () => {
    openReady();
    toggleMic();
    await settle();
    closePanel();
    expect(mic.cancel).toHaveBeenCalledTimes(1);
    expect(mic.stop).not.toHaveBeenCalled();

    const answer = deferred<string>();
    ipc.whisperTranscribe.mockReturnValue(answer.promise);
    openReady();
    toggleMic();
    await settle();
    toggleMic();
    expect(state().phase).toBe('transcribing');
    closePanel();
    answer.resolve('never saved');
    await settle();
    expect(state().phase).toBe('closed');
    expect(writes).toEqual([]);
  });

  test('a close while the mic is still opening releases it once it does', async () => {
    const opening = deferred<{
      sampleRate: number;
      stop: () => Float32Array;
      cancel: () => void;
    }>();
    mic.start.mockReturnValue(opening.promise);
    openReady();
    toggleMic();
    closePanel();
    opening.resolve({ sampleRate: 16_000, stop: mic.stop, cancel: mic.cancel });
    await settle();
    expect(mic.cancel).toHaveBeenCalledTimes(1);
  });

  test('the ten-minute cap stops the capture, transcribes it, and says why', async () => {
    ipc.whisperTranscribe.mockResolvedValue('a very long note');
    openReady();
    toggleMic();
    await settle();
    mic.onLimit?.();
    expect(state().phase).toBe('transcribing');
    expect(notices[0]).toMatch(/10-minute limit/);
    await settle();
    expect(state().phase).toBe('viewing');
    expect(state().comments.map((c) => c.transcript)).toEqual(['a very long note']);
  });

  test('a second tap before the mic has opened fails cleanly instead of hanging', async () => {
    mic.start.mockReturnValue(new Promise(() => {}));
    openReady();
    toggleMic();
    toggleMic();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toContain('WHISPER_FAILED');
  });

  test('a stale transcript from an abandoned capture never lands on the next one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    ipc.whisperTranscribe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    openReady();
    toggleMic();
    await settle();
    toggleMic();
    closePanel();
    openReady();
    toggleMic();
    await settle();
    toggleMic();
    first.resolve('stale words');
    await settle();
    expect(state().phase).toBe('transcribing');
    second.resolve('fresh words');
    await settle();
    expect(state().comments.map((c) => c.transcript)).toEqual(['fresh words']);
  });
});

describe('reviewing a code file: unit, whisper hint, snapped names', () => {
  /** A `.ts` tab whose line 96 is a function signature. */
  function openCodeTab(): void {
    tabs.push({
      id: 't1',
      filePath: 'C:/repo/src/core/text-files.ts',
      notePath: null,
      text: 'a\nb\nexport function showAllFilesState(\n',
    });
  }

  const IDENTIFIERS = ['showAllFilesState', 'isMarkdownPath', 'dirKey'];

  test('the hold gesture carries the unit, the signature quote, the hint and the identifiers', async () => {
    openCodeTab();
    await openNoteAtLine('t1', 3, {
      unit: 'showAllFilesState (function)',
      quote: 'showAllFilesState(dir: string): { show: boolean }',
      hint: 'show all files state, is markdown path',
      identifiers: IDENTIFIERS,
    });
    expect(state().phase).toBe('ready');
    expect(state().unit).toBe('showAllFilesState (function)');
    // The card's signature wins over the raw line.
    expect(state().quote).toBe('showAllFilesState(dir: string): { show: boolean }');
    expect(state().hint).toBe('show all files state, is markdown path');
    expect(state().identifiers).toEqual(IDENTIFIERS);
  });

  test('with no options it behaves exactly as a markdown note does', async () => {
    openCodeTab();
    await openNoteAtLine('t1', 3);
    expect(state().quote).toBe('export function showAllFilesState(');
    expect(state().unit).toBeNull();
    expect(state().hint).toBeNull();
    expect(state().identifiers).toEqual([]);
    expect(state().snaps).toEqual([]);
  });

  test('the hint reaches whisper; the transcript snaps and the unit is saved', async () => {
    platform.android = false;
    platform.windows = false;
    ipc.whisperTranscribe.mockResolvedValue('show all files state misses the hidden dirs');
    openCodeTab();
    await openNoteAtLine('t1', 3, {
      unit: 'showAllFilesState (function)',
      hint: 'show all files state',
      identifiers: IDENTIFIERS,
    });
    toggleMic();
    await settle();
    toggleMic();
    await settle();

    expect(ipc.whisperTranscribe.mock.calls[0]?.[4]).toBe('show all files state');
    expect(state().comments.map((c) => c.transcript)).toEqual([
      '`showAllFilesState` misses the hidden dirs',
    ]);
    expect(state().comments[0]?.unit).toBe('showAllFilesState (function)');
    expect(state().snaps.map((s) => s.to)).toEqual(['`showAllFilesState`']);
    expect(state().snapCommentId).toBe(state().comments[0]?.id);
    expect(writes[0]?.text).toContain('- unit: showAllFilesState (function)');
    expect(writes[0]?.text).toContain('`showAllFilesState` misses the hidden dirs');
  });

  test('the review context lands in the sidecar preamble; without one nothing is added', async () => {
    ipc.sttStart.mockResolvedValue('looks fine');
    openCodeTab();
    await openNoteAtLine('t1', 3, {
      unit: 'showAllFilesState (function)',
      context: {
        branch: 'feat/explorer',
        worktree: 'C:/repo/worktrees/explorer',
        baseBranch: 'development',
        baseRef: '3c77f30',
      },
    });
    expect(state().context?.branch).toBe('feat/explorer');
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(writes[0]?.text).toContain(
      '- branch: feat/explorer (worktree: C:/repo/worktrees/explorer)',
    );
    expect(writes[0]?.text).toContain('- compared against: development (merge-base 3c77f30)');

    writes.length = 0;
    await openNoteAtLine('t1', 3);
    expect(state().context).toBeNull();
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(writes[0]?.text).not.toContain('- branch:');
  });

  test('with no identifiers nothing is snapped and no unit line is written', async () => {
    ipc.sttStart.mockResolvedValue('show all files state misses the hidden dirs');
    openCodeTab();
    await openNoteAtLine('t1', 3);
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(state().comments.map((c) => c.transcript)).toEqual([
      'show all files state misses the hidden dirs',
    ]);
    expect(state().snaps).toEqual([]);
    expect(writes[0]?.text).not.toContain('- unit:');
  });

  test('undoSnap puts one name back, saves, and leaves the rest undoable', async () => {
    ipc.sttStart.mockResolvedValue('dir key and show all files state');
    openCodeTab();
    await openNoteAtLine('t1', 3, { identifiers: IDENTIFIERS });
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(state().comments[0]?.transcript).toBe('`dirKey` and `showAllFilesState`');
    expect(state().snaps).toHaveLength(2);

    undoSnap(0);
    expect(state().comments[0]?.transcript).toBe('dir key and `showAllFilesState`');
    expect(state().snaps.map((s) => s.to)).toEqual(['`showAllFilesState`']);
    vi.advanceTimersByTime(600);
    await settle();
    expect(writes[writes.length - 1]?.text).toContain('dir key and `showAllFilesState`');

    undoSnap(0);
    expect(state().comments[0]?.transcript).toBe('dir key and show all files state');
    expect(state().snaps).toEqual([]);
    expect(state().snapCommentId).toBeNull();
    // Nothing left to undo, and an out-of-range index is harmless.
    undoSnap(0);
    expect(state().comments[0]?.transcript).toBe('dir key and show all files state');
  });

  test('editing the transcript by hand drops the stale undo list', async () => {
    ipc.sttStart.mockResolvedValue('dir key is wrong');
    openCodeTab();
    await openNoteAtLine('t1', 3, { identifiers: IDENTIFIERS });
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(state().snaps).toHaveLength(1);
    const id = state().comments[0]!.id;
    updateTranscript(id, 'something else entirely');
    expect(state().snaps).toEqual([]);
    expect(state().snapCommentId).toBeNull();
  });

  test('closing the sheet forgets the review context', async () => {
    openCodeTab();
    await openNoteAtLine('t1', 3, { unit: 'dirKey (function)', identifiers: IDENTIFIERS });
    closePanel();
    expect(state().unit).toBeNull();
    expect(state().identifiers).toEqual([]);
    expect(state().snaps).toEqual([]);
    expect(state().snapCommentId).toBeNull();
  });
});
