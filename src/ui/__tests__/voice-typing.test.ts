import { beforeEach, describe, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  sttPermission: vi.fn(),
  sttRequestPermission: vi.fn(),
  sttStart: vi.fn(),
  sttStop: vi.fn(),
  voiceTypingToggle: vi.fn(),
  whisperPrepare: vi.fn(),
  whisperTranscribe: vi.fn(),
}));
const engine = vi.hoisted(() => ({
  current: 'whisper' as 'whisper' | 'windows' | 'android' | null,
}));
const notices = vi.hoisted(() => [] as string[]);
const tabs = vi.hoisted(() => ({
  activeTabId: 't1' as string | null,
  list: [{ id: 't1', mode: 'raw' }] as { id: string; mode: string }[],
}));
/** Fake editors: what each adapter was asked to insert / whether it was focused. */
const editors = vi.hoisted(() => ({
  source: { insertText: vi.fn(), focus: vi.fn() },
  rich: { insertText: vi.fn(), focus: vi.fn() },
}));
const mic = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }));

vi.mock('../../ipc/commands', () => ({ ipc }));
vi.mock('../voice-comments', () => ({ dictationEngine: () => engine.current }));
vi.mock('../editor-registry', () => ({
  getSourceAdapter: () => editors.source,
  getRichAdapter: () => editors.rich,
}));
vi.mock('../stores/settings', () => ({
  settingsStore: {
    getState: () => ({ settings: { whisperModel: 'small.en-q5_1', whisperUseGpu: true } }),
  },
}));
vi.mock('../stores/tabs', () => ({
  tabsStore: { getState: () => ({ activeTabId: tabs.activeTabId, tabs: tabs.list }) },
}));
vi.mock('../stores/ui', () => ({
  uiStore: { getState: () => ({ showNotice: (text: string) => notices.push(text) }) },
}));
vi.mock('../pcm-capture', () => ({ startPcmCapture: () => mic.start() }));

import {
  stopVoiceTyping,
  toggleVoiceTyping,
  TYPING_STOP_WATCHDOG_MS,
  voiceTypingStore,
} from '../voice-typing';

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  notices.length = 0;
  engine.current = 'whisper';
  tabs.activeTabId = 't1';
  tabs.list = [{ id: 't1', mode: 'raw' }];
  voiceTypingStore.setState({ phase: 'idle', tabId: null, stopping: false });
  ipc.whisperPrepare.mockResolvedValue(undefined);
  ipc.voiceTypingToggle.mockResolvedValue(undefined);
  ipc.sttStop.mockResolvedValue(undefined);
  mic.start.mockResolvedValue({ sampleRate: 16000, stop: mic.stop, cancel: mic.cancel });
  mic.stop.mockReturnValue(new Float32Array([0.1, 0.2]));
});

describe('whisper', () => {
  test('first tap listens, second transcribes into the tab at the caret', async () => {
    toggleVoiceTyping();
    expect(voiceTypingStore.getState()).toMatchObject({ phase: 'listening', tabId: 't1' });
    await settle();
    ipc.whisperTranscribe.mockResolvedValue('  hello world ');
    toggleVoiceTyping();
    expect(voiceTypingStore.getState().phase).toBe('transcribing');
    await settle();
    expect(editors.source.insertText).toHaveBeenCalledWith('hello world');
    expect(voiceTypingStore.getState().phase).toBe('idle');
  });

  test('a rich-mode tab gets the text through the rich editor', async () => {
    tabs.list = [{ id: 't1', mode: 'wysiwyg' }];
    toggleVoiceTyping();
    await settle();
    ipc.whisperTranscribe.mockResolvedValue('hi');
    toggleVoiceTyping();
    await settle();
    expect(editors.rich.insertText).toHaveBeenCalledWith('hi');
    expect(editors.source.insertText).not.toHaveBeenCalled();
  });

  test('the text goes to the tab it was said for, even after a tab switch', async () => {
    toggleVoiceTyping();
    await settle();
    tabs.activeTabId = 't2';
    tabs.list = [
      { id: 't1', mode: 'wysiwyg' },
      { id: 't2', mode: 'raw' },
    ];
    ipc.whisperTranscribe.mockResolvedValue('kept');
    stopVoiceTyping();
    await settle();
    expect(editors.rich.insertText).toHaveBeenCalledWith('kept');
  });

  test('silence is a notice, not an insert', async () => {
    toggleVoiceTyping();
    await settle();
    ipc.whisperTranscribe.mockResolvedValue('   ');
    toggleVoiceTyping();
    await settle();
    expect(editors.source.insertText).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(voiceTypingStore.getState().phase).toBe('idle');
  });

  test('a missing model fails the capture and closes the mic', async () => {
    ipc.whisperPrepare.mockRejectedValue(new Error('WHISPER_NO_MODEL'));
    toggleVoiceTyping();
    await settle();
    expect(voiceTypingStore.getState().phase).toBe('idle');
    expect(notices[0]).toMatch(/^Voice typing: /);
  });

  test('a closed tab drops the text with a notice', async () => {
    toggleVoiceTyping();
    await settle();
    tabs.list = [];
    ipc.whisperTranscribe.mockResolvedValue('lost');
    toggleVoiceTyping();
    await settle();
    expect(editors.source.insertText).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
  });

  test('Review and Draw modes are not typed into', () => {
    tabs.list = [{ id: 't1', mode: 'read' }];
    toggleVoiceTyping();
    expect(voiceTypingStore.getState().phase).toBe('idle');
    expect(mic.start).not.toHaveBeenCalled();
  });
});

describe('windows voice typing', () => {
  test('a tap focuses the editor and hands off to Win+H without a listening state', () => {
    engine.current = 'windows';
    toggleVoiceTyping();
    expect(editors.source.focus).toHaveBeenCalled();
    expect(ipc.voiceTypingToggle).toHaveBeenCalledTimes(1);
    expect(voiceTypingStore.getState().phase).toBe('idle');
  });

  test('a failed key press is a notice', async () => {
    engine.current = 'windows';
    ipc.voiceTypingToggle.mockRejectedValue(new Error('VOICE_TYPING_FAILED:denied'));
    toggleVoiceTyping();
    await settle();
    expect(notices).toHaveLength(1);
  });
});

describe('android', () => {
  test('one recognized utterance lands at the caret', async () => {
    engine.current = 'android';
    ipc.sttPermission.mockResolvedValue(true);
    ipc.sttStart.mockResolvedValue('from the phone');
    toggleVoiceTyping();
    await settle();
    expect(editors.source.insertText).toHaveBeenCalledWith('from the phone');
    expect(voiceTypingStore.getState().phase).toBe('idle');
  });

  test('a stop the recognizer never answers times out', async () => {
    vi.useFakeTimers();
    engine.current = 'android';
    ipc.sttPermission.mockResolvedValue(true);
    ipc.sttStart.mockReturnValue(new Promise(() => {}));
    toggleVoiceTyping();
    await settle();
    toggleVoiceTyping();
    expect(ipc.sttStop).toHaveBeenCalled();
    expect(voiceTypingStore.getState().stopping).toBe(true);
    vi.advanceTimersByTime(TYPING_STOP_WATCHDOG_MS);
    expect(voiceTypingStore.getState().phase).toBe('idle');
    expect(notices).toHaveLength(1);
  });

  test('permission denied is a notice', async () => {
    engine.current = 'android';
    ipc.sttPermission.mockResolvedValue(false);
    ipc.sttRequestPermission.mockResolvedValue(false);
    toggleVoiceTyping();
    await settle();
    expect(ipc.sttStart).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
  });
});
