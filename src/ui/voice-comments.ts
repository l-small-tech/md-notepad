/**
 * voice-comments.ts — the controller behind the voice-notes feature.
 *
 * Mirrors the tab-agnostic module-dispatch style of `session.ts`: a single
 * vanilla Zustand store holds the transient state, and the UI
 * (`VoiceComments.tsx`, the ribbon's Read-mode button, the preview pane's hold
 * gesture) is a pure projection of it. All file I/O goes through
 * `currentProvider()` so a note in a synced (SAF) workspace gets its comments
 * file in the same backend.
 *
 * The flow, designed for reviewing a document from the couch:
 *   1. In Read mode, the ribbon's voice-notes button ARMS the feature.
 *   2. While armed, press-and-hold a line of the rendered document. The pane
 *      reports the source line; the panel opens in the `ready` phase, showing
 *      the line's text and a big microphone.
 *   3. Tap the mic to start, tap again to finish. The transcript is appended
 *      to `<name>.comments.md` with a reference to the file, the line, its
 *      quote and the UTC time. The document itself is never modified.
 *
 * Where the sidecar lives is the `voiceNotesLocation` setting: the workspace's
 * shared "Voice Notes" folder (default) or beside the document. `sidecarFor`
 * resolves it through the session's workspace lookup.
 *
 * Capture is speech-to-text through the `ipc.stt*` bridges, which return a
 * transcript directly; nothing is ever recorded to an audio file. The engine
 * per platform is `dictationEngine()`: Android's on-device SpeechRecognizer,
 * or Windows' built-in dictation (the desktop default). macOS/Linux have no
 * engine yet, so the ribbon doesn't offer the feature there and
 * `startCapture` refuses as a second guard. A future opt-in engine (a local
 * Whisper model) plugs in at `dictationEngine()`.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  commentsPathFor,
  lineQuote,
  newCommentId,
  noteRefFor,
  parseCommentsFile,
  serializeCommentsFile,
  type VoiceComment,
} from '../core/comments';
import { sanitizeFileBaseName } from '../core/title';
import { ipc, IpcError } from '../ipc/commands';
import { currentProvider } from '../ipc/provider';
import { isAndroid, isWindows } from './platform';
import { workspaceRootFor } from './session/facade';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';

/**
 * Panel lifecycle: closed → ready (mic idle, line chosen) → capturing (mic
 * live) → viewing (the note list). `viewing` is also reachable directly from
 * `ready` ("show notes") to read what's already there.
 */
export type Phase = 'closed' | 'ready' | 'capturing' | 'viewing';

export interface VoiceCommentsState {
  /** The Read-mode voice-notes toggle: while true, holding a line opens the panel. */
  armed: boolean;
  phase: Phase;
  tabId: string | null;
  notePath: string | null;
  commentsPath: string | null;
  comments: VoiceComment[];
  /** Comment to highlight (listed first) when viewing. */
  focusId: string | null;
  /** 1-based line being annotated (ready/capturing). */
  line: number | null;
  /** That line's text at the time it was chosen. */
  quote: string;
}

const initial: VoiceCommentsState = {
  armed: false,
  phase: 'closed',
  tabId: null,
  notePath: null,
  commentsPath: null,
  comments: [],
  focusId: null,
  line: null,
  quote: '',
};

export const voiceStore = createStore<VoiceCommentsState>()(() => initial);

export const useVoiceStore = <T>(selector: (s: VoiceCommentsState) => T): T =>
  useStore(voiceStore, selector);

/* ---- helpers ----------------------------------------------------------- */

/** The speech-to-text engine that captures voice notes here, or null when none. */
export type DictationEngine = 'android' | 'windows';

/**
 * Which engine this platform dictates with. Android: the on-device
 * SpeechRecognizer. Windows: built-in Windows dictation, the desktop default.
 * Both sit behind the same `ipc.stt*` bridge. Null = voice notes can't be
 * captured here (macOS/Linux today).
 */
export function dictationEngine(): DictationEngine | null {
  if (isAndroid()) {
    return 'android';
  }
  if (isWindows()) {
    return 'windows';
  }
  return null;
}

/** The on-disk path a tab's content maps to (file tab wins over note buffer). */
function notePathFor(tabId: string): string | null {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab ? (tab.filePath ?? tab.notePath) : null;
}

/** Current document text for a tab (canonical DocModel string), or ''. */
function docTextFor(tabId: string): string {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab ? tab.model.getText() : '';
}

/** The sidecar path for a note, per the voice-notes location setting. */
export function sidecarFor(notePath: string): string {
  const { voiceNotesLocation, voiceNotesFolderName } = settingsStore.getState().settings;
  return commentsPathFor(notePath, {
    location: voiceNotesLocation,
    // Sanitize so a hand-edited setting can't escape the folder or add separators.
    folderName: sanitizeFileBaseName(voiceNotesFolderName) || 'Voice Notes',
    workspaceRoot: workspaceRootFor(notePath),
  });
}

/** Read + parse a note's comments file; [] when it doesn't exist yet. */
async function loadComments(notePath: string): Promise<VoiceComment[]> {
  try {
    const { text } = await currentProvider().readTextFile(sidecarFor(notePath));
    return parseCommentsFile(text);
  } catch (e) {
    if (e instanceof IpcError && e.code === 'NOT_FOUND') {
      return [];
    }
    throw e;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write of the current comments to disk (transcript edits). */
function scheduleSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 500);
}

async function flushSave(): Promise<void> {
  const { commentsPath, comments, notePath } = voiceStore.getState();
  if (!commentsPath || !notePath) {
    return;
  }
  try {
    await currentProvider().atomicWriteText(
      commentsPath,
      serializeCommentsFile(comments, noteRefFor(commentsPath, notePath)),
    );
  } catch {
    uiStore.getState().showNotice('Could not save voice notes.');
  }
}

/** Write immediately (structural changes: add/delete). */
async function saveNow(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await flushSave();
}

// The id minted for the in-flight capture.
let captureId: string | null = null;

/* ---- public actions ---------------------------------------------------- */

/** Flip the Read-mode voice-notes toggle. Disarming also closes the panel. */
export function toggleArmed(): void {
  const { armed } = voiceStore.getState();
  if (armed) {
    closePanel();
  }
  voiceStore.setState({ armed: !armed });
}

/**
 * The hold gesture landed on `line` of the tab's document: open the panel in
 * the `ready` phase for that line (mic idle). Loads the existing notes so the
 * list is a tap away and the new id can be minted collision-free.
 */
export async function openNoteAtLine(tabId: string, line: number): Promise<void> {
  const notePath = notePathFor(tabId);
  if (!notePath) {
    uiStore.getState().showNotice('Save the note before adding voice notes.');
    return;
  }
  let comments: VoiceComment[];
  try {
    comments = await loadComments(notePath);
  } catch {
    uiStore.getState().showNotice('Could not read voice notes.');
    return;
  }
  if (voiceStore.getState().phase === 'capturing') {
    return; // a capture is in flight — don't yank the line out from under it
  }
  voiceStore.setState({
    phase: 'ready',
    tabId,
    notePath,
    commentsPath: sidecarFor(notePath),
    comments,
    focusId: null,
    line,
    quote: lineQuote(docTextFor(tabId), line),
  });
}

/** Open the panel listing ALL of a note's voice notes (no single focus). */
export async function openAllComments(tabId: string): Promise<void> {
  const notePath = notePathFor(tabId);
  if (!notePath) {
    uiStore.getState().showNotice('Save the note before adding voice notes.');
    return;
  }
  let comments: VoiceComment[];
  try {
    comments = await loadComments(notePath);
  } catch {
    uiStore.getState().showNotice('Could not read voice notes.');
    return;
  }
  voiceStore.setState({
    phase: 'viewing',
    tabId,
    notePath,
    commentsPath: sidecarFor(notePath),
    comments,
    focusId: null,
    line: null,
    quote: '',
  });
}

/** From the ready phase, show the note list instead (nothing captured). */
export function showNotes(): void {
  if (voiceStore.getState().phase === 'ready') {
    voiceStore.setState({ phase: 'viewing', line: null, quote: '' });
  }
}

/**
 * The microphone button: first tap starts a capture for the chosen line,
 * second tap finishes it. A tap in any other phase is ignored.
 */
export function toggleMic(): void {
  const { phase } = voiceStore.getState();
  if (phase === 'ready') {
    startCapture();
  } else if (phase === 'capturing') {
    stopCapture();
  }
}

/** Mint the id, flip to `capturing`, and start on-device dictation. */
function startCapture(): void {
  const { tabId, line, comments } = voiceStore.getState();
  if (!tabId || line === null) {
    return;
  }
  if (dictationEngine() === null) {
    uiStore
      .getState()
      .showNotice('Voice notes need speech recognition, available on Android and Windows.');
    return;
  }
  captureId = newCommentId(new Set(comments.map((c) => c.id)));
  voiceStore.setState({ phase: 'capturing' });
  void captureDictation();
}

/**
 * Turn a bridge reject into a message that says what to do. Shared codes:
 * "PERMISSION_DENIED", "STT_BUSY", "STT_UNAVAILABLE". Android adds
 * "STT_ERROR:<code>" with `android.speech.SpeechRecognizer.ERROR_*` codes;
 * Windows (src-tauri commands/dictation.rs) adds the named STT_* codes below.
 */
function sttErrorMessage(raw: string): string {
  const windows = dictationEngine() === 'windows';
  if (raw.includes('PERMISSION_DENIED')) {
    return windows
      ? 'Microphone access is off. Turn on "Let desktop apps access your microphone" in Windows Settings, Privacy & security, Microphone.'
      : 'Microphone permission is required for voice notes.';
  }
  if (raw.includes('STT_BUSY')) {
    return 'Still finishing the last recording — try again in a moment.';
  }
  if (raw.includes('STT_UNAVAILABLE')) {
    return windows
      ? 'Windows speech recognition is unavailable on this PC.'
      : 'On-device speech recognition is unavailable on this device.';
  }
  if (raw.includes('STT_PRIVACY')) {
    return 'Windows dictation needs "Online speech recognition" turned on in Windows Settings, Privacy & security, Speech.';
  }
  if (raw.includes('STT_NO_MIC')) {
    return 'No microphone was found. Connect one and try again.';
  }
  if (raw.includes('STT_NETWORK')) {
    return 'Windows dictation lost its network connection. Check your connection and try again.';
  }
  if (raw.includes('STT_LANGUAGE')) {
    return 'Windows dictation does not support your speech language. Check Windows Settings, Time & language, Speech.';
  }
  if (raw.includes('STT_AUDIO_QUALITY')) {
    return 'The audio was too noisy or quiet to transcribe. Try again closer to the microphone.';
  }
  if (raw.includes('STT_NO_MATCH')) {
    return "Didn't catch that — try again and speak clearly.";
  }
  const m = /STT_ERROR:(-?\d+)/.exec(raw);
  switch (m ? Number(m[1]) : null) {
    case 6: // SPEECH_TIMEOUT
    case 7: // NO_MATCH
      return "Didn't catch that — try again and speak clearly.";
    case 1: // NETWORK_TIMEOUT
    case 2: // NETWORK
      return 'Network error during recognition. Check your connection or install offline voice typing.';
    case 8: // RECOGNIZER_BUSY
      return 'The recognizer is busy — try again in a moment.';
    case 9: // INSUFFICIENT_PERMISSIONS
      return 'Microphone permission is required for voice notes.';
    case 12: // LANGUAGE_UNAVAILABLE
    case 13: // LANGUAGE_NOT_SUPPORTED
      return 'No speech model for this language. Install offline voice typing, or connect to the network.';
    default:
      return 'Speech recognition failed. Try again.';
  }
}

/** Permission → availability → dictation, through the platform's `stt*` bridge. */
async function captureDictation(): Promise<void> {
  // Stage 1 — permission. A rejection here (vs. a clean "not granted") means the
  // permission bridge itself failed, which is worth its own message.
  let granted: boolean;
  try {
    granted = (await ipc.sttPermission()) || (await ipc.sttRequestPermission());
  } catch {
    failCapture('Could not request microphone permission.');
    return;
  }
  if (!granted) {
    failCapture('Microphone permission denied.');
    return;
  }
  // Stage 2 — availability (best-effort; a flaky check shouldn't block a try).
  try {
    if (!(await ipc.sttAvailable())) {
      failCapture(sttErrorMessage('STT_UNAVAILABLE'));
      return;
    }
  } catch {
    // Ignore — attempt recognition anyway; sttStart surfaces a real problem.
  }
  // Stage 3 — recognition. Map the error code so the message is actionable.
  try {
    const text = await ipc.sttStart(); // resolves on the final result
    if (voiceStore.getState().phase !== 'capturing') {
      return; // panel was closed mid-capture
    }
    await finishCapture(text.trim());
  } catch (e) {
    if (voiceStore.getState().phase === 'capturing') {
      failCapture(sttErrorMessage(e instanceof Error ? e.message : String(e)));
    }
  }
}

/** Commit the in-flight capture: append + save the note. The document is untouched. */
async function finishCapture(transcript: string): Promise<void> {
  const { notePath, commentsPath, comments, line, quote } = voiceStore.getState();
  if (!notePath || !commentsPath || !captureId || line === null) {
    return;
  }
  const id = captureId;
  captureId = null;
  const comment: VoiceComment = {
    id,
    file: noteRefFor(commentsPath, notePath),
    line,
    quote,
    time: new Date().toISOString(),
    transcript,
  };
  voiceStore.setState({
    phase: 'viewing',
    comments: [...comments, comment],
    focusId: id,
    line: null,
    quote: '',
  });
  await saveNow();
}

/** A capture failed: report it and drop back to the ready phase for the same line. */
function failCapture(message: string): void {
  captureId = null;
  uiStore.getState().showNotice(message);
  if (voiceStore.getState().phase === 'capturing') {
    voiceStore.setState({ phase: 'ready' });
  }
}

/** Stop the live capture (the second mic tap); the final result still resolves `sttStart`. */
export function stopCapture(): void {
  if (voiceStore.getState().phase === 'capturing') {
    void ipc.sttStop();
  }
}

/** Edit a note's transcript text (debounced save). */
export function updateTranscript(id: string, transcript: string): void {
  voiceStore.setState((s) => ({
    comments: s.comments.map((c) => (c.id === id ? { ...c, transcript } : c)),
  }));
  scheduleSave();
}

/** Delete a note's entry. */
export async function deleteComment(id: string): Promise<void> {
  voiceStore.setState((s) => ({
    comments: s.comments.filter((c) => c.id !== id),
    focusId: s.focusId === id ? null : s.focusId,
  }));
  await saveNow();
}

/** Close the panel; cancels an in-flight capture without committing it. The toggle stays armed. */
export function closePanel(): void {
  if (voiceStore.getState().phase === 'capturing') {
    // Flip phase first so the capture completion guard bails out.
    voiceStore.setState({ phase: 'closed' });
    void ipc.sttStop();
    captureId = null;
  }
  voiceStore.setState({ phase: 'closed', ...initialTail() });
}

/** The reset fields shared by close (keeps a closed panel tidy; `armed` is untouched). */
function initialTail() {
  return {
    tabId: null,
    notePath: null,
    commentsPath: null,
    comments: [],
    focusId: null,
    line: null,
    quote: '',
  } satisfies Omit<VoiceCommentsState, 'phase' | 'armed'>;
}
