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
 * Capture never records an audio file. The engine per platform is
 * `dictationEngine()`:
 *   - Android: the on-device SpeechRecognizer through the `ipc.stt*` bridge,
 *     which returns the transcript directly.
 *   - Windows (default): Windows voice typing. The sheet focuses a draft box
 *     and `ipc.voiceTypingToggle()` presses Win+H, so the shell types what
 *     the user says into it. The note finishes by itself once the draft has
 *     gone quiet for `VOICE_TYPING_IDLE_MS` (voice typing stopped: its own
 *     mic button, or silence), or on a second tap; either way Win+H is
 *     pressed again and the draft becomes the note.
 *     (Windows.Media.SpeechRecognition can't be used: an app without package
 *     identity only ever hears silence through it.)
 *   - Whisper (macOS/Linux default, Windows opt-in): the mic is captured into
 *     memory (`ui/pcm-capture.ts`) while the model loads, and the second tap
 *     sends the PCM to `ipc.whisperTranscribe` — the `transcribing` phase —
 *     whose answer becomes the note. Offline; the model is downloaded once
 *     from Settings ▸ Voice notes.
 * The `desktopDictationEngine` setting picks between the desktop two.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  commentsPathFor,
  lineQuote,
  newCommentId,
  noteRefFor,
  parseCommentsFile,
  serializeCommentsFile,
  type VoiceComment,
} from '../core/comments';
import { captureErrorFor, type CaptureError, type DictationEngine } from '../core/dictation-errors';
import { sanitizeFileBaseName } from '../core/title';
import { ipc, IpcError } from '../ipc/commands';
import { currentProvider } from '../ipc/provider';
import { startPcmCapture, type PcmCapture } from './pcm-capture';
import { isAndroid, isWindows } from './platform';
import { workspaceRootFor } from './session/facade';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';

/**
 * Panel lifecycle: closed → ready (mic idle, line chosen) → capturing (mic
 * live) → [transcribing (Whisper is turning the capture into text)] →
 * viewing (the note list). `viewing` is also reachable directly from `ready`
 * ("show notes") to read what's already there.
 */
export type Phase = 'closed' | 'ready' | 'capturing' | 'transcribing' | 'viewing';

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
  /**
   * Why the last capture failed, shown IN the sheet under the microphone with
   * steps to fix it (see core/dictation-errors). Cleared by the next tap.
   */
  error: CaptureError | null;
  /**
   * The second tap landed and the engine is finishing the phrase in flight
   * (capturing phase only). The mic shows "Finishing…" and ignores taps; a
   * watchdog fails the capture if the engine never answers.
   */
  stopping: boolean;
  /**
   * Windows: what voice typing has typed into the sheet's draft box so far
   * (capturing phase). Becomes the note's transcript on the second tap.
   */
  draft: string;
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
  error: null,
  stopping: false,
  draft: '',
};

export const voiceStore = createStore<VoiceCommentsState>()(() => initial);

export const useVoiceStore = <T>(selector: (s: VoiceCommentsState) => T): T =>
  useStore(voiceStore, selector);

/* ---- helpers ----------------------------------------------------------- */

/**
 * Which engine this platform dictates with. Android: the on-device
 * SpeechRecognizer (`ipc.stt*`). Desktop: the `desktopDictationEngine`
 * setting — 'auto' is Windows voice typing on Windows and Whisper elsewhere.
 * Null only when Windows voice typing is chosen on a non-Windows desktop.
 */
export function dictationEngine(): DictationEngine | null {
  if (isAndroid()) {
    return 'android';
  }
  const choice = settingsStore.getState().settings.desktopDictationEngine;
  if (choice === 'whisper') {
    return 'whisper';
  }
  if (choice === 'windowsVoiceTyping') {
    return isWindows() ? 'windows' : null;
  }
  return isWindows() ? 'windows' : 'whisper';
}

/** A capture-in-flight phase (the mic is live, or its audio is being transcribed). */
function inFlight(phase: Phase): boolean {
  return phase === 'capturing' || phase === 'transcribing';
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

/**
 * How long after the second tap the engine has to hand back the transcript
 * before the capture is failed with STT_STOP_TIMEOUT (Android). It only
 * guards against a bridge that never answers, so the mic can't stay stuck on
 * "Finishing…".
 */
export const STOP_WATCHDOG_MS = 10_000;
let stopWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearStopWatchdog(): void {
  if (stopWatchdog !== null) {
    clearTimeout(stopWatchdog);
    stopWatchdog = null;
  }
}

/**
 * Windows: after the second tap, how long voice typing gets to type the
 * phrase in flight into the draft before the draft is saved.
 */
export const VOICE_TYPING_SETTLE_MS = 1200;
// Whether this app pressed Win+H to open voice typing and hasn't closed it.
let voiceTypingOn = false;

/**
 * Windows: once voice typing has typed something, this long without a change
 * to the draft finishes the note — voice typing has stopped (its own mic
 * button, or silence), so the user needn't tap again.
 */
export const VOICE_TYPING_IDLE_MS = 3000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** Press Win+H again to close voice typing, if this app opened it. */
function closeVoiceTyping(): void {
  if (voiceTypingOn) {
    voiceTypingOn = false;
    void ipc.voiceTypingToggle().catch(() => {});
  }
}

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
  if (inFlight(voiceStore.getState().phase)) {
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
    error: null,
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
    error: null,
  });
}

/** From the ready phase, show the note list instead (nothing captured). */
export function showNotes(): void {
  if (voiceStore.getState().phase === 'ready') {
    voiceStore.setState({ phase: 'viewing', line: null, quote: '', error: null });
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
  const engine = dictationEngine();
  if (engine === null) {
    uiStore
      .getState()
      .showNotice(
        'Windows voice typing only exists on Windows — pick Whisper in Settings > Voice notes.',
      );
    return;
  }
  captureId = newCommentId(new Set(comments.map((c) => c.id)));
  voiceStore.setState({ phase: 'capturing', error: null, stopping: false, draft: '' });
  if (engine === 'windows') {
    return; // the draft box calls voiceTypingFieldReady() once it has focus
  }
  if (engine === 'whisper') {
    void captureWhisper(captureId);
    return;
  }
  void captureDictation(captureId);
}

// Whisper: the live microphone buffer of the in-flight capture.
let pcmCapture: PcmCapture | null = null;

/** A rejection's capture code: `IpcError` codes lead, the message follows. */
function rejectionCode(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && !message.startsWith(code) ? `${code}:${message}` : message;
}

/**
 * Whisper: open the mic and, at the same time, load the model — so the load
 * overlaps the talking, and a missing model fails the capture before the
 * user has dictated a note into the void.
 */
async function captureWhisper(id: string): Promise<void> {
  const current = () => captureId === id && voiceStore.getState().phase === 'capturing';
  const prepared = ipc.whisperPrepare(settingsStore.getState().settings.whisperModel);
  prepared.catch(() => {}); // awaited below; this only keeps it from being unhandled
  let capture: PcmCapture;
  try {
    capture = await startPcmCapture({
      onLimit: () => {
        // Ten minutes: stop and transcribe what there is. The note is saved,
        // and the status bar says why it ended.
        if (captureId === id && voiceStore.getState().phase === 'capturing') {
          stopCapture();
          uiStore
            .getState()
            .showNotice(
              'Voice note stopped at the 10-minute limit — tap the microphone for the rest.',
            );
        }
      },
    });
  } catch (e) {
    if (current()) {
      failCapture(rejectionCode(e));
    }
    return;
  }
  if (!current()) {
    capture.cancel(); // closed (or failed) while the mic was opening
    return;
  }
  pcmCapture = capture;
  try {
    await prepared;
  } catch (e) {
    if (current()) {
      failCapture(rejectionCode(e));
    }
  }
}

/** Whisper: the second tap's audio → `ipc.whisperTranscribe` → the note. */
async function transcribeCapture(id: string, pcm: Float32Array, sampleRate: number): Promise<void> {
  const current = () => captureId === id && voiceStore.getState().phase === 'transcribing';
  if (pcm.length === 0) {
    if (current()) failCapture('STT_NO_MATCH');
    return;
  }
  try {
    const modelId = settingsStore.getState().settings.whisperModel;
    const text = (await ipc.whisperTranscribe(pcm, sampleRate, modelId)).trim();
    if (!current()) {
      return; // closed while transcribing: the words are dropped, as cancelled
    }
    if (text) {
      await finishCapture(text);
    } else {
      failCapture('STT_NO_MATCH');
    }
  } catch (e) {
    if (current()) {
      failCapture(rejectionCode(e));
    }
  }
}

/**
 * Windows: the sheet's draft box is on screen and focused — press Win+H so
 * voice typing types into it. Once per capture.
 */
export function voiceTypingFieldReady(): void {
  if (voiceStore.getState().phase !== 'capturing' || voiceTypingOn || captureId === null) {
    return;
  }
  voiceTypingOn = true;
  const id = captureId;
  void ipc.voiceTypingToggle().catch((e: unknown) => {
    voiceTypingOn = false;
    if (captureId === id && voiceStore.getState().phase === 'capturing') {
      const reason = e instanceof Error ? e.message : String(e);
      failCapture(
        reason.includes('VOICE_TYPING_FAILED') ? reason : `VOICE_TYPING_FAILED:${reason}`,
      );
    }
  });
}

/**
 * Windows: voice typing (or the user) changed the draft box. Restarts the
 * quiet timer that finishes the note by itself.
 */
export function updateDraft(draft: string): void {
  voiceStore.setState({ draft });
  clearIdleTimer();
  const { phase, stopping } = voiceStore.getState();
  if (phase !== 'capturing' || stopping || !draft.trim()) {
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stopCapture();
  }, VOICE_TYPING_IDLE_MS);
}

/** Permission → availability → dictation, through the platform's `stt*` bridge. */
async function captureDictation(id: string): Promise<void> {
  // A result that arrives after its capture was abandoned (closed, timed out,
  // or superseded by a newer capture) must not land on the newer one.
  const current = () => captureId === id && voiceStore.getState().phase === 'capturing';
  // Stage 1 — permission. A rejection here (vs. a clean "not granted") means the
  // permission bridge itself failed, which is worth its own message.
  let granted: boolean;
  try {
    granted = (await ipc.sttPermission()) || (await ipc.sttRequestPermission());
  } catch {
    if (current()) failCapture('PERMISSION_BRIDGE_FAILED');
    return;
  }
  if (!granted) {
    if (current()) failCapture('PERMISSION_DENIED');
    return;
  }
  // Stage 2 — availability (best-effort; a flaky check shouldn't block a try).
  try {
    if (!(await ipc.sttAvailable())) {
      if (current()) failCapture('STT_UNAVAILABLE');
      return;
    }
  } catch {
    // Ignore — attempt recognition anyway; sttStart surfaces a real problem.
  }
  // Stage 3 — recognition. Map the error code so the message is actionable.
  try {
    const text = await ipc.sttStart(); // resolves on the final result
    if (!current()) {
      return; // abandoned mid-capture
    }
    await finishCapture(text.trim());
  } catch (e) {
    if (current()) {
      failCapture(e instanceof Error ? e.message : String(e));
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
  clearStopWatchdog();
  clearIdleTimer();
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
    stopping: false,
  });
  await saveNow();
}

/**
 * A capture failed: drop back to the ready phase for the same line and show
 * the reason IN the sheet, with steps to fix it. (A status-bar notice was
 * invisible here — the sheet's backdrop dims the status bar.)
 */
function failCapture(raw: string): void {
  captureId = null;
  clearStopWatchdog();
  clearIdleTimer();
  closeVoiceTyping();
  pcmCapture?.cancel();
  pcmCapture = null;
  if (inFlight(voiceStore.getState().phase)) {
    voiceStore.setState({
      phase: 'ready',
      stopping: false,
      error: captureErrorFor(raw, dictationEngine() ?? 'windows'),
    });
  }
}

/** The error box's "Open voice notes settings" button (a missing Whisper model). */
export function openVoiceSettings(): void {
  closePanel();
  uiStore.getState().openSettings('voice');
}

/** The error box's "Open … settings" button: jump to the Windows Settings page. */
export function openCaptureSettings(uri: string): void {
  void openUrl(uri).catch(() => {
    uiStore
      .getState()
      .showNotice('Could not open Windows Settings. Open it from the Start menu instead.');
  });
}

/**
 * Stop the live capture (the second mic tap); the final result still resolves
 * `sttStart`. Further taps are ignored until it does, and a watchdog makes
 * sure the sheet can't stay stuck if it never does.
 */
export function stopCapture(): void {
  const { phase, stopping } = voiceStore.getState();
  if (phase !== 'capturing' || stopping) {
    return;
  }
  voiceStore.setState({ stopping: true });
  clearIdleTimer();
  const id = captureId;
  if (dictationEngine() === 'whisper') {
    const capture = pcmCapture;
    pcmCapture = null;
    if (!capture || id === null) {
      // The mic never opened (still opening, or it failed and this raced it).
      failCapture('WHISPER_FAILED:the microphone was not capturing');
      return;
    }
    const pcm = capture.stop();
    voiceStore.setState({ phase: 'transcribing', stopping: false });
    void transcribeCapture(id, pcm, capture.sampleRate);
    return;
  }
  if (dictationEngine() === 'windows') {
    // Close voice typing; the phrase in flight lands in the draft as it closes.
    closeVoiceTyping();
    setTimeout(() => {
      if (captureId !== id || voiceStore.getState().phase !== 'capturing') {
        return;
      }
      const text = voiceStore.getState().draft.trim();
      if (text) {
        void finishCapture(text);
      } else {
        failCapture('VOICE_TYPING_EMPTY');
      }
    }, VOICE_TYPING_SETTLE_MS);
    return;
  }
  void ipc.sttStop().catch(() => {
    // The watchdog below covers a stop that never reaches the engine.
  });
  clearStopWatchdog();
  stopWatchdog = setTimeout(() => {
    stopWatchdog = null;
    if (captureId === id && voiceStore.getState().phase === 'capturing') {
      failCapture('STT_STOP_TIMEOUT');
    }
  }, STOP_WATCHDOG_MS);
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
  const { phase } = voiceStore.getState();
  if (phase === 'capturing') {
    // Flip phase first so the capture completion guard bails out.
    voiceStore.setState({ phase: 'closed' });
    const engine = dictationEngine();
    if (engine === 'windows') {
      closeVoiceTyping();
    } else if (engine === 'whisper') {
      pcmCapture?.cancel();
      pcmCapture = null;
    } else {
      void ipc.sttStop().catch(() => {});
    }
    captureId = null;
  } else if (phase === 'transcribing') {
    // Whisper is still working on the audio; its answer is dropped on arrival.
    captureId = null;
  }
  clearStopWatchdog();
  clearIdleTimer();
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
    error: null,
    stopping: false,
    draft: '',
  } satisfies Omit<VoiceCommentsState, 'phase' | 'armed'>;
}
