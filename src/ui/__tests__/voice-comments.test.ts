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
const sidecar = vi.hoisted(() => ({ text: '' }));
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
    // The sidecar on disk (empty by default: no notes yet).
    readTextFile: () => Promise.resolve({ text: sidecar.text, mtimeMs: 0 }),
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
  settingsStore: {
    getState: () => ({
      settings,
      update: (patch: Partial<typeof settings>) => Object.assign(settings, patch),
    }),
  },
}));
/** The Whisper model list the sheet consults: what is installed, and downloads asked for. */
const whisperModels = vi.hoisted(() => ({
  loaded: true,
  installed: [] as string[],
  downloads: [] as string[],
  refreshes: 0,
}));
vi.mock('../stores/whisper-models', () => ({
  whisperModelsStore: {
    getState: () => ({
      loaded: whisperModels.loaded,
      models: ['tiny.en-q5_1', 'small.en-q5_1', 'large-v3-turbo-q5_0'].map((id) => ({
        id,
        file: `ggml-${id}.bin`,
        label: id,
        bytes: 1,
        multilingual: false,
        installed: whisperModels.installed.includes(id),
        partialBytes: 0,
      })),
      refresh: () => {
        whisperModels.refreshes++;
        whisperModels.loaded = true;
        return Promise.resolve();
      },
      startDownload: (id: string) => {
        whisperModels.downloads.push(id);
        whisperModels.installed.push(id);
        return Promise.resolve();
      },
    }),
  },
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

import { serializeCommentsFile } from '../../core/comments';
import {
  clearReveal,
  closePanel,
  deleteNote,
  dictationEngine,
  dropMarks,
  editNote,
  installWhisper,
  loadMarks,
  mutateNotes,
  noteEngine,
  onNotesChanged,
  openNoteAtLine,
  requestReveal,
  toggleArmed,
  openVoiceSettings,
  saveDraft,
  STOP_WATCHDOG_MS,
  toggleMic,
  undoSnap,
  updateDraft,
  updateTranscript,
  voiceStore,
  whisperReady,
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
  sidecar.text = '';
  tabs.length = 0;
  opened.length = 0;
  platform.windows = false;
  platform.android = true;
  settings.desktopDictationEngine = 'auto';
  settings.androidDictationEngine = 'system';
  settings.whisperModel = 'small.en-q5_1';
  settings.whisperUseGpu = true;
  ipc.voiceTypingToggle.mockReset().mockResolvedValue(undefined);
  whisperModels.loaded = true;
  whisperModels.installed = [];
  whisperModels.downloads = [];
  whisperModels.refreshes = 0;
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
    // The note is saved and the composer closes; the pane is asked to show it.
    expect(state().phase).toBe('closed');
    expect(state().stopping).toBe(false);
    expect(state().reveal).toMatchObject({ path: 'C:/notes/pricing.md', line: 3, unit: null });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('C:/notes/pricing.comments.md');
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
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toContain('fresh words');
    expect(writes[0]?.text).not.toContain('stale words');
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
    expect(state().phase).toBe('closed');
    expect(state().error).toBeNull();
    expect(writes).toHaveLength(1);
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

describe('desktop: the note is typed; Whisper is the microphone', () => {
  beforeEach(() => {
    platform.android = false;
    platform.windows = true;
  });

  test('Save turns the draft into the note; an empty draft is nothing', async () => {
    openReady();
    await saveDraft();
    expect(state().phase).toBe('ready');
    expect(writes).toEqual([]);

    updateDraft('  Move the tax column before the demo. ');
    await saveDraft();
    expect(state().phase).toBe('closed');
    expect(state().draft).toBe('');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toContain('Move the tax column before the demo.');
  });

  test('Save is only for the ready phase', async () => {
    openReady();
    voiceStore.setState({ phase: 'saved', draft: 'stray' });
    await saveDraft();
    expect(state().comments).toEqual([]);
  });

  test('the sheet never presses Win+H, whatever the engine setting says', async () => {
    settings.desktopDictationEngine = 'windowsVoiceTyping';
    whisperModels.installed = ['small.en-q5_1'];
    expect(noteEngine()).toBe('whisper');
    openReady();
    toggleMic();
    await settle();
    expect(state().phase).toBe('capturing');
    expect(ipc.voiceTypingToggle).not.toHaveBeenCalled();
    expect(mic.start).toHaveBeenCalledTimes(1);
  });

  test('a Whisper capture lands in the draft, after what was typed, for the user to save', async () => {
    whisperModels.installed = ['small.en-q5_1'];
    ipc.whisperTranscribe.mockResolvedValue(' ship it on Friday ');
    openReady();
    updateDraft('Also:');
    toggleMic();
    await settle();
    toggleMic();
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().draft).toBe('Also: ship it on Friday');
    expect(state().comments).toEqual([]);
    expect(writes).toEqual([]);

    await saveDraft();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toContain('Also: ship it on Friday');
  });

  test('the identifier snap happens on save, so a typed name snaps like a spoken one', async () => {
    openReady();
    voiceStore.setState({ identifiers: ['showsAllFiles'] });
    updateDraft('the shows all files flag is wrong');
    await saveDraft();
    expect(state().comments[0]?.transcript).toBe('the `showsAllFiles` flag is wrong');
    expect(state().snaps).toHaveLength(1);
  });

  test('whisperReady is about the chosen model being on disk', () => {
    expect(whisperReady()).toBe(false);
    whisperModels.installed = ['tiny.en-q5_1'];
    expect(whisperReady()).toBe(false);
    whisperModels.installed = ['tiny.en-q5_1', 'small.en-q5_1'];
    expect(whisperReady()).toBe(true);
  });

  test('Install downloads the chosen model, and the microphone appears', async () => {
    expect(whisperReady()).toBe(false);
    await installWhisper();
    expect(whisperModels.downloads).toEqual(['small.en-q5_1']);
    expect(whisperReady()).toBe(true);
  });

  test('Install with a chosen id the manifest no longer has falls back to the recommended one', async () => {
    settings.whisperModel = 'medium.en';
    await installWhisper();
    expect(whisperModels.downloads).toEqual(['small.en-q5_1']);
    expect(settings.whisperModel).toBe('small.en-q5_1');
    expect(whisperReady()).toBe(true);
  });

  test('Install fetches the model list first when it has not been loaded', async () => {
    whisperModels.loaded = false;
    await installWhisper();
    expect(whisperModels.refreshes).toBe(1);
    expect(whisperModels.downloads).toEqual(['small.en-q5_1']);
  });

  test('opening the sheet asks for the model list once, so it knows which button to show', async () => {
    tabs.push({ id: 't1', filePath: 'C:/notes/a.md', notePath: null, text: 'one\ntwo' });
    whisperModels.loaded = false;
    await openNoteAtLine('t1', 2);
    expect(whisperModels.refreshes).toBe(1);
    expect(state().draft).toBe('');
    closePanel();
    await openNoteAtLine('t1', 1);
    expect(whisperModels.refreshes).toBe(1);
  });

  test('closing the sheet drops an unsaved draft', () => {
    openReady();
    updateDraft('half a thought');
    closePanel();
    expect(state().draft).toBe('');
    expect(writes).toEqual([]);
  });

  test('a Whisper failure is explained with the Whisper steps', async () => {
    whisperModels.installed = ['small.en-q5_1'];
    ipc.whisperPrepare.mockRejectedValue(new Error('WHISPER_NO_MODEL'));
    openReady();
    toggleMic();
    await settle();
    expect(state().phase).toBe('ready');
    expect(state().error?.code).toContain('WHISPER_NO_MODEL');
    expect(state().error?.appSettings?.tab).toBe('voice');
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

  test('the note sheet always has an engine: Whisper on desktop, the setting on Android', () => {
    platform.android = false;
    settings.desktopDictationEngine = 'windowsVoiceTyping';
    expect(noteEngine()).toBe('whisper');
    platform.android = true;
    expect(noteEngine()).toBe('android');
    settings.androidDictationEngine = 'whisper';
    expect(noteEngine()).toBe('whisper');
  });
});

describe('voice-note capture with Whisper (offline)', () => {
  beforeEach(() => {
    platform.android = false;
    platform.windows = false;
  });

  test('first tap opens the mic and warms the model; second tap transcribes into the draft', async () => {
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
    // Desktop: the words wait in the draft for a look, then Save makes the note.
    expect(state().phase).toBe('ready');
    expect(state().draft).toBe('Move the tax column before the demo.');
    expect(writes).toHaveLength(0);
    await saveDraft();
    expect(state().phase).toBe('closed');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toContain('Move the tax column before the demo.');
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
    expect(state().phase).toBe('ready');
    expect(state().draft).toBe('a very long note');
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
    expect(state().draft).toBe('fresh words');
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
    expect(state().draft).toBe('show all files state misses the hidden dirs');
    await saveDraft();

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
    // Nothing snapped: no `saved` stop for undo — straight to closed.
    expect(state().phase).toBe('closed');
    expect(state().snaps).toEqual([]);
    expect(writes[0]?.text).toContain('show all files state misses the hidden dirs');
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

describe('note markers: the notes each Review pane draws from', () => {
  const noteOn = (id: string, line: number, unit?: string) => ({
    id,
    file: 'a.md',
    line,
    quote: '',
    time: '2026-01-01T00:00:00.000Z',
    transcript: id,
    ...(unit ? { unit } : {}),
  });

  beforeEach(() => {
    tabs.push({ id: 't1', filePath: 'C:/notes/a.md', notePath: null, text: 'one\ntwo\nthree' });
    tabs.push({ id: 't2', filePath: 'C:/notes/a.md', notePath: null, text: 'one\ntwo\nthree' });
    tabs.push({ id: 'untitled', filePath: null, notePath: null, text: '' });
    sidecar.text = serializeCommentsFile(
      [noteOn('c1', 2), noteOn('c2', 3, 'f (function)')],
      'a.md',
    );
  });

  afterEach(() => {
    voiceStore.setState({ armed: false, marks: {} });
  });

  test("loadMarks reads the tab's notes only while armed, once per tab", async () => {
    await loadMarks('t1');
    expect(state().marks).toEqual({});

    toggleArmed();
    const first = loadMarks('t1');
    expect(state().marks.t1).toEqual([]); // claimed at once, so a second ask is a no-op
    await Promise.all([first, loadMarks('t1')]);
    expect(state().marks.t1!.map((n) => n.id)).toEqual(['c1', 'c2']);

    // An unsaved tab has no sidecar to read: its entry stays empty, quietly.
    await loadMarks('untitled');
    expect(state().marks.untitled).toEqual([]);
    expect(notices).toEqual([]);
  });

  test('a delete from a callout updates every marked tab on that document; disarming drops them all', async () => {
    toggleArmed();
    await loadMarks('t1');
    await loadMarks('t2');
    const changed: string[][] = [];
    const off = onNotesChanged((_path, _sidecar, notes) => changed.push(notes.map((n) => n.id)));
    await deleteNote('t1', 'c1');
    off();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('C:/notes/a.comments.md');
    expect(writes[0]?.text).not.toContain('^c1');
    expect(state().marks.t1!.map((n) => n.id)).toEqual(['c2']);
    expect(state().marks.t2!.map((n) => n.id)).toEqual(['c2']);
    expect(changed).toEqual([['c2']]);

    dropMarks('t2');
    expect(Object.keys(state().marks)).toEqual(['t1']);
    toggleArmed();
    expect(state().armed).toBe(false);
    expect(state().marks).toEqual({});
  });

  test('an edit rewrites the note in place and keeps the review context on the file', async () => {
    sidecar.text = serializeCommentsFile([noteOn('c1', 2)], 'a.md', {
      branch: 'feat/x',
      baseBranch: 'development',
    });
    await editNote('t1', 'c1', 'better words');
    expect(writes[0]?.text).toContain('better words');
    expect(writes[0]?.text).toContain('- branch: feat/x');
    expect(writes[0]?.text).toContain('- compared against: development');
    // An unsaved tab has nothing to edit; nothing is written and nothing said.
    await editNote('untitled', 'c1', 'x');
    expect(writes).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  test('an open composer on the document sees the edit, so its ids stay fresh; a failed write says so', async () => {
    openReady();
    voiceStore.setState({
      notePath: 'C:/notes/a.md',
      commentsPath: 'C:/notes/a.comments.md',
      comments: [noteOn('c1', 2), noteOn('c2', 3)],
    });
    const next = await mutateNotes('C:/notes/a.md', 'C:/notes/a.comments.md', (notes) =>
      notes.filter((n) => n.id !== 'c2'),
    );
    expect(next?.map((n) => n.id)).toEqual(['c1']);
    expect(state().comments.map((n) => n.id)).toEqual(['c1']);
    expect(state().phase).toBe('ready');
  });

  test('a reveal request is kept until the pane that shows the document takes it', () => {
    requestReveal('C:/notes/a.md', 7, 'f (function)');
    const first = state().reveal!;
    expect(first).toMatchObject({ path: 'C:/notes/a.md', line: 7, unit: 'f (function)' });
    requestReveal('C:/notes/b.md', 1, null);
    clearReveal(first.seq); // stale: the newer request stands
    expect(state().reveal?.path).toBe('C:/notes/b.md');
    clearReveal(state().reveal!.seq);
    expect(state().reveal).toBeNull();
  });
});
