/**
 * voice-typing.ts — the controller behind the ribbon's microphone in the edit
 * modes (Raw, Split, Edit): speak, and the words land at the caret.
 *
 * The same engines as voice notes (`dictationEngine()` in voice-comments.ts),
 * but the transcript goes into the document instead of a sidecar:
 *   - Windows (default): Windows voice typing. A tap focuses the editor and
 *     presses Win+H; the shell types straight into it. Voice typing has its
 *     own panel with its own listening state and stop button — which this app
 *     can't observe — so the tap is a one-shot hand-off and the store never
 *     leaves `idle`. A second tap presses Win+H again, which closes it.
 *   - Whisper: the first tap opens the mic (`ui/pcm-capture.ts`) while the
 *     model loads; the second sends the audio to `ipc.whisperTranscribe`
 *     (`transcribing`) and inserts the answer.
 *   - Android: the on-device SpeechRecognizer (`ipc.stt*`); the recognizer
 *     ends the utterance on silence, or the second tap does.
 *
 * The text goes to the tab the capture started on, through whichever editor
 * that tab shows when the answer arrives (Edit adapter in wysiwyg mode, CM6
 * otherwise) — `joinDictation` (core) supplies the spacing. Failures are a
 * status-bar notice: there is no sheet here to hold the voice-notes error box.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { captureErrorFor } from '../core/dictation-errors';
import { ipc } from '../ipc/commands';
import { getEditAdapter, getSourceAdapter } from './editor-registry';
import { startPcmCapture, type PcmCapture } from './pcm-capture';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';
import { dictationEngine } from './voice-comments';

/** idle → listening (mic live) → [transcribing (Whisper)] → idle. */
export type TypingPhase = 'idle' | 'listening' | 'transcribing';

export interface VoiceTypingState {
  phase: TypingPhase;
  /** The tab the in-flight capture types into. */
  tabId: string | null;
  /** Android: the second tap landed; the recognizer is finishing the phrase. */
  stopping: boolean;
}

const initial: VoiceTypingState = { phase: 'idle', tabId: null, stopping: false };

export const voiceTypingStore = createStore<VoiceTypingState>()(() => initial);

export const useVoiceTypingStore = <T>(selector: (s: VoiceTypingState) => T): T =>
  useStore(voiceTypingStore, selector);

/** Android: how long the recognizer gets to answer a stop before the capture is dropped. */
export const TYPING_STOP_WATCHDOG_MS = 10_000;

// Bumped per capture; a late answer from an older one is ignored.
let session = 0;
let pcmCapture: PcmCapture | null = null;
let stopWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearStopWatchdog(): void {
  if (stopWatchdog !== null) {
    clearTimeout(stopWatchdog);
    stopWatchdog = null;
  }
}

/** The editor a tab currently shows, if it is one voice typing can type into. */
function editorFor(tabId: string) {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) {
    return undefined;
  }
  if (tab.mode === 'wysiwyg') {
    return getEditAdapter(tabId);
  }
  return tab.mode === 'raw' || tab.mode === 'split' ? getSourceAdapter(tabId) : undefined;
}

/** Put a finished transcript into the capture's tab. */
function insert(tabId: string, text: string): void {
  const editor = editorFor(tabId);
  if (!editor) {
    uiStore.getState().showNotice('Voice typing: the document is no longer open for editing.');
    return;
  }
  editor.insertText(text);
}

function reset(): void {
  clearStopWatchdog();
  voiceTypingStore.setState(initial);
}

/** A capture failed: back to idle, with the reason in the status bar. */
function fail(id: number, raw: string): void {
  if (id !== session) {
    return;
  }
  session++;
  pcmCapture?.cancel();
  pcmCapture = null;
  reset();
  const error = captureErrorFor(raw, dictationEngine() ?? 'windows');
  uiStore.getState().showNotice(`Voice typing: ${error.title}`);
}

/** A rejection's capture code: `IpcError` codes lead, the message follows. */
function rejectionCode(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && !message.startsWith(code) ? `${code}:${message}` : message;
}

/* ---- public actions ---------------------------------------------------- */

/** The ribbon microphone: start dictating into the active tab, or finish. */
export function toggleVoiceTyping(): void {
  const { phase } = voiceTypingStore.getState();
  if (phase === 'listening') {
    stopVoiceTyping();
    return;
  }
  if (phase !== 'idle') {
    return; // transcribing — the button is busy
  }
  const tabId = tabsStore.getState().activeTabId;
  if (!tabId || !editorFor(tabId)) {
    return;
  }
  const engine = dictationEngine();
  if (engine === null) {
    uiStore
      .getState()
      .showNotice(
        'Windows voice typing only exists on Windows — pick Whisper in Settings > Voice notes.',
      );
    return;
  }
  if (engine === 'windows') {
    editorFor(tabId)?.focus();
    void ipc.voiceTypingToggle().catch((e: unknown) => {
      const reason = e instanceof Error ? e.message : String(e);
      const error = captureErrorFor(
        reason.includes('VOICE_TYPING_FAILED') ? reason : `VOICE_TYPING_FAILED:${reason}`,
        'windows',
      );
      uiStore.getState().showNotice(`Voice typing: ${error.title}`);
    });
    return;
  }
  const id = ++session;
  voiceTypingStore.setState({ phase: 'listening', tabId, stopping: false });
  if (engine === 'whisper') {
    void captureWhisper(id);
  } else {
    void captureAndroid(id, tabId);
  }
}

/**
 * Finish the live capture (second tap, a tab switch, leaving the edit modes):
 * whatever was said still lands in the tab it was said for.
 */
export function stopVoiceTyping(): void {
  const { phase, tabId, stopping } = voiceTypingStore.getState();
  if (phase !== 'listening' || stopping || tabId === null) {
    return;
  }
  const id = session;
  if (dictationEngine() === 'whisper') {
    const capture = pcmCapture;
    pcmCapture = null;
    if (!capture) {
      // The mic never opened (still opening, or it failed and this raced it).
      fail(id, 'WHISPER_FAILED:the microphone was not capturing');
      return;
    }
    const pcm = capture.stop();
    voiceTypingStore.setState({ phase: 'transcribing' });
    void transcribe(id, tabId, pcm, capture.sampleRate);
    return;
  }
  voiceTypingStore.setState({ stopping: true });
  void ipc.sttStop().catch(() => {});
  clearStopWatchdog();
  stopWatchdog = setTimeout(() => {
    stopWatchdog = null;
    fail(id, 'STT_STOP_TIMEOUT');
  }, TYPING_STOP_WATCHDOG_MS);
}

/* ---- engines ----------------------------------------------------------- */

/** Whisper: open the mic and load the model at the same time. */
async function captureWhisper(id: number): Promise<void> {
  const current = () => id === session && voiceTypingStore.getState().phase === 'listening';
  const { whisperModel, whisperUseGpu } = settingsStore.getState().settings;
  const prepared = ipc.whisperPrepare(whisperModel, whisperUseGpu);
  prepared.catch(() => {}); // awaited below; this only keeps it from being unhandled
  let capture: PcmCapture;
  try {
    capture = await startPcmCapture({
      onLimit: () => {
        if (current()) {
          stopVoiceTyping();
          uiStore
            .getState()
            .showNotice('Voice typing stopped at the 10-minute limit — tap the microphone again.');
        }
      },
    });
  } catch (e) {
    if (current()) fail(id, rejectionCode(e));
    return;
  }
  if (!current()) {
    capture.cancel(); // stopped while the mic was opening
    return;
  }
  pcmCapture = capture;
  try {
    await prepared;
  } catch (e) {
    if (current()) fail(id, rejectionCode(e));
  }
}

/** Whisper: the second tap's audio → text → the document. */
async function transcribe(
  id: number,
  tabId: string,
  pcm: Float32Array,
  sampleRate: number,
): Promise<void> {
  if (pcm.length === 0) {
    fail(id, 'STT_NO_MATCH');
    return;
  }
  try {
    const { whisperModel, whisperUseGpu } = settingsStore.getState().settings;
    const text = (await ipc.whisperTranscribe(pcm, sampleRate, whisperModel, whisperUseGpu)).trim();
    if (id !== session) {
      return;
    }
    if (!text) {
      fail(id, 'STT_NO_MATCH');
      return;
    }
    reset();
    insert(tabId, text);
  } catch (e) {
    fail(id, rejectionCode(e));
  }
}

/** Android: permission → one recognized utterance → the document. */
async function captureAndroid(id: number, tabId: string): Promise<void> {
  let granted: boolean;
  try {
    granted = (await ipc.sttPermission()) || (await ipc.sttRequestPermission());
  } catch {
    fail(id, 'PERMISSION_BRIDGE_FAILED');
    return;
  }
  if (!granted) {
    fail(id, 'PERMISSION_DENIED');
    return;
  }
  try {
    const text = (await ipc.sttStart()).trim();
    if (id !== session) {
      return;
    }
    if (!text) {
      fail(id, 'STT_NO_MATCH');
      return;
    }
    reset();
    insert(tabId, text);
  } catch (e) {
    fail(id, e instanceof Error ? e.message : String(e));
  }
}
