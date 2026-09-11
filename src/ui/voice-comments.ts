/**
 * voice-comments.ts — the controller behind the voice-notes feature.
 *
 * Mirrors the tab-agnostic module-dispatch style of `session.ts`: a single
 * vanilla Zustand store holds the transient state, and the UI
 * (`VoiceComments.tsx`, the ribbon's Review-mode button, the preview pane's hold
 * gesture) is a pure projection of it. All file I/O goes through
 * `currentProvider()` so a note in a synced (SAF) workspace gets its comments
 * file in the same backend.
 *
 * The flow, designed for reviewing a document from the couch:
 *   1. In Review mode, the ribbon's voice-notes button ARMS the feature.
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
 * A CODE file reviewed in Review mode passes extra context with the hold
 * gesture (`openNoteAtLine(tab, line, opts)`, see `NoteTarget`): the
 * declaration (saved as the note's `unit`), its signature as the quote, and
 * the file's identifiers — which prime Whisper (`hint`) and snap the
 * transcript's spoken names to the real ones (`core/code/vocab.ts`), with a
 * per-name `undoSnap` in the sheet.
 *
 * Capture never records an audio file. The engine per platform is
 * `noteEngine()`:
 *   - Android: the on-device SpeechRecognizer through the `ipc.stt*` bridge,
 *     which returns the transcript directly (or Whisper, per the
 *     `androidDictationEngine` setting). Voice first: the keyboard is awkward.
 *   - Desktop (Windows, macOS, Linux): the note is TYPED. The sheet is a text
 *     box with a Save button; the OS's own dictation works into it like into
 *     any other field (Win+H on Windows, the Dictation key on macOS) — the
 *     sheet suggests it but never presses it. Whisper is the built-in
 *     alternative: with a model installed the microphone captures the mic into
 *     memory (`ui/pcm-capture.ts`) while the model loads, the second tap sends
 *     the PCM to `ipc.whisperTranscribe` — the `transcribing` phase — and the
 *     words are appended to the draft for the user to check and save. Without
 *     a model the microphone is an Install button that downloads one in place
 *     (`installWhisper`, through `stores/whisper-models.ts`).
 * `desktopDictationEngine` only steers the edit modes' voice typing
 * (`voice-typing.ts`, `dictationEngine()`); the note sheet ignores it.
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
  type ReviewContext,
  type VoiceComment,
} from '../core/comments';
import { snapIdentifiers, undoSnap as undoSnapIn, type Snap } from '../core/code/vocab';
import { firstNoteAt } from '../core/note-marks';
import { captureErrorFor, type CaptureError, type DictationEngine } from '../core/dictation-errors';
import { joinDictation } from '../core/dictation-insert';
import { isInstalled, recommendedModel } from '../core/whisper-models';
import { sanitizeFileBaseName } from '../core/title';
import { ipc, IpcError } from '../ipc/commands';
import { currentProvider } from '../ipc/provider';
import { startPcmCapture, type PcmCapture } from './pcm-capture';
import { isAndroid, isWindows } from './platform';
import { workspaceRootFor } from './session/facade';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';
import { whisperModelsStore } from './stores/whisper-models';

/**
 * Panel lifecycle: closed → ready (mic idle, line chosen) → capturing (mic
 * live) → [transcribing (Whisper is turning the capture into text)] →
 * viewing (the note list). `viewing` is also reachable directly from `ready`
 * ("show notes") to read what's already there.
 */
export type Phase = 'closed' | 'ready' | 'capturing' | 'transcribing' | 'viewing';

export interface VoiceCommentsState {
  /** The Review-mode review-notes toggle: while true, holding a line opens the panel. */
  armed: boolean;
  /**
   * The notes each Review pane draws its markers from, by tab id — loaded
   * by `loadMarks` when a pane is on screen while armed, kept in step with
   * every save from the sheet, and dropped when the toggle goes off. Only
   * tabs that asked have an entry; a tab's entry is `[]` while its file is
   * being read.
   */
  marks: Readonly<Record<string, readonly VoiceComment[]>>;
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
   * Desktop: the note being typed in the sheet's text box (ready phase; a
   * Whisper capture appends to it). Saved as the note's transcript by
   * `saveDraft`. Unused on Android, where the engine's answer is the note.
   */
  draft: string;
  /**
   * Review mode: the declaration the note is about (`showAllFilesState
   * (function)`), stored on the saved note so an agent finds the target after
   * the lines drift. Null for a markdown note.
   */
  unit: string | null;
  /**
   * Review mode: whisper.cpp's initial prompt for this capture — the file's
   * identifiers as spoken words (`core/code/vocab.ts` `identifierHint`).
   */
  hint: string | null;
  /** Review mode: the file's identifiers, for snapping the transcript. */
  identifiers: string[];
  /**
   * Review mode: where the review happened (branch, worktree, baseline) —
   * written into the sidecar's preamble on every save while the sheet is
   * open on that tab. Null for a markdown note or when git is absent.
   */
  context: ReviewContext | null;
  /**
   * What snapping changed in the last note ("shows all files" →
   * `` `showsAllFiles` ``). The sheet lists them with a per-snap undo; empty
   * whenever there is nothing to show.
   */
  snaps: Snap[];
  /** The note `snaps` belong to (the undo edits that note's transcript). */
  snapCommentId: string | null;
}

const initial: VoiceCommentsState = {
  armed: false,
  marks: {},
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
  unit: null,
  hint: null,
  identifiers: [],
  context: null,
  snaps: [],
  snapCommentId: null,
};

export const voiceStore = createStore<VoiceCommentsState>()(() => initial);

export const useVoiceStore = <T>(selector: (s: VoiceCommentsState) => T): T =>
  useStore(voiceStore, selector);

/* ---- helpers ----------------------------------------------------------- */

/**
 * Which engine this platform dictates with. Android: the
 * `androidDictationEngine` setting — the on-device SpeechRecognizer
 * (`ipc.stt*`) or Whisper. Desktop: the `desktopDictationEngine` setting —
 * 'auto' is Windows voice typing on Windows and Whisper elsewhere. Null only
 * when Windows voice typing is chosen on a non-Windows desktop.
 */
export function dictationEngine(): DictationEngine | null {
  const { settings } = settingsStore.getState();
  if (isAndroid()) {
    return settings.androidDictationEngine === 'whisper' ? 'whisper' : 'android';
  }
  const choice = settings.desktopDictationEngine;
  if (choice === 'whisper') {
    return 'whisper';
  }
  if (choice === 'windowsVoiceTyping') {
    return isWindows() ? 'windows' : null;
  }
  return isWindows() ? 'windows' : 'whisper';
}

/**
 * The engine the voice-note sheet captures with. Android: `dictationEngine()`.
 * Desktop: always Whisper — the note is typed by default, and the OS's own
 * dictation types into the box by itself, so the only engine the sheet
 * drives is the offline one.
 */
export function noteEngine(): DictationEngine {
  return isAndroid() ? (dictationEngine() ?? 'android') : 'whisper';
}

/** Desktop: is the chosen Whisper model on disk (the microphone works)? */
export function whisperReady(): boolean {
  const { models } = whisperModelsStore.getState();
  return isInstalled(models, settingsStore.getState().settings.whisperModel);
}

/**
 * The sheet's Install button: download the chosen model (the recommended one
 * when the chosen id is not in the manifest, in which case the setting is
 * pointed at it), with progress shown in place of the microphone.
 */
export async function installWhisper(): Promise<void> {
  const models = whisperModelsStore.getState();
  if (!models.loaded) {
    await models.refresh();
  }
  const { settings, update } = settingsStore.getState();
  const known = whisperModelsStore.getState().models.some((m) => m.id === settings.whisperModel);
  const id = known ? settings.whisperModel : recommendedModel();
  if (id !== settings.whisperModel) {
    update({ whisperModel: id });
  }
  await whisperModelsStore.getState().startDownload(id);
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
  const { commentsPath, comments, notePath, context } = voiceStore.getState();
  if (!commentsPath || !notePath) {
    return;
  }
  try {
    await currentProvider().atomicWriteText(
      commentsPath,
      serializeCommentsFile(comments, noteRefFor(commentsPath, notePath), context ?? undefined),
    );
  } catch {
    uiStore.getState().showNotice('Could not save review notes.');
  }
  syncMarks(notePath, comments);
}

/** After a save: every marked tab showing `notePath` gets the saved list. */
function syncMarks(notePath: string, comments: readonly VoiceComment[]): void {
  const { marks } = voiceStore.getState();
  let next: Record<string, readonly VoiceComment[]> | null = null;
  for (const tabId of Object.keys(marks)) {
    if (notePathFor(tabId) === notePath) {
      next ??= { ...marks };
      next[tabId] = comments;
    }
  }
  if (next) {
    voiceStore.setState({ marks: next });
  }
}

/**
 * A Review pane is on screen for `tabId` while the toggle is armed: read the
 * document's notes so the pane can mark the lines that have one. The entry
 * appears at once (empty) so a second call while the read is in flight is a
 * no-op; a read failure leaves it empty — the markers are a convenience, so
 * no notice. Resolves when the entry holds the notes.
 */
export async function loadMarks(tabId: string): Promise<void> {
  const { marks, armed } = voiceStore.getState();
  if (!armed || tabId in marks) {
    return;
  }
  voiceStore.setState({ marks: { ...marks, [tabId]: [] } });
  const notePath = notePathFor(tabId);
  if (!notePath) {
    return;
  }
  let comments: VoiceComment[];
  try {
    comments = await loadComments(notePath);
  } catch {
    return;
  }
  const current = voiceStore.getState().marks;
  if (tabId in current) {
    voiceStore.setState({ marks: { ...current, [tabId]: comments } });
  }
}

/** The pane left the screen: forget its notes (the next pane reads them afresh). */
export function dropMarks(tabId: string): void {
  const { marks } = voiceStore.getState();
  if (tabId in marks) {
    const next = { ...marks };
    delete next[tabId];
    voiceStore.setState({ marks: next });
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

/* ---- public actions ---------------------------------------------------- */

/**
 * Flip the Review-mode review-notes toggle. Disarming also closes the panel
 * and drops the markers (each pane asks again the next time it is armed).
 */
export function toggleArmed(): void {
  const { armed } = voiceStore.getState();
  if (armed) {
    closePanel();
  }
  voiceStore.setState({ armed: !armed, marks: {} });
}

/**
 * What a CODE file's Review pane knows about the thing being annotated, and
 * that a markdown document does not. Every field is optional: with none of
 * them the sheet behaves exactly as it does for markdown.
 */
export interface NoteTarget {
  /** The declaration, e.g. `showAllFilesState (function)` — saved on the note. */
  unit?: string;
  /** The quote to show and store instead of the raw line (a card's signature). */
  quote?: string;
  /** Whisper's initial prompt for this capture (`identifierHint`). */
  hint?: string;
  /** The file's identifiers: spoken ones snap to the real names. */
  identifiers?: string[];
  /** Where the review happened — the sidecar's preamble (`ReviewContext`). */
  context?: ReviewContext;
}

/**
 * The hold gesture landed on `line` of the tab's document: open the panel in
 * the `ready` phase for that line (mic idle). Loads the existing notes so the
 * list is a tap away and the new id can be minted collision-free.
 *
 * `opts` is the Review pane's extra context (see `NoteTarget`).
 */
export async function openNoteAtLine(
  tabId: string,
  line: number,
  opts?: NoteTarget,
): Promise<void> {
  const notePath = notePathFor(tabId);
  if (!notePath) {
    uiStore.getState().showNotice('Save the note before adding review notes.');
    return;
  }
  let comments: VoiceComment[];
  try {
    comments = await loadComments(notePath);
  } catch {
    uiStore.getState().showNotice('Could not read review notes.');
    return;
  }
  if (inFlight(voiceStore.getState().phase)) {
    return; // a capture is in flight — don't yank the line out from under it
  }
  if (!isAndroid() && !whisperModelsStore.getState().loaded) {
    // So the sheet knows whether to show a microphone or an Install button.
    void whisperModelsStore.getState().refresh();
  }
  voiceStore.setState({
    phase: 'ready',
    tabId,
    notePath,
    commentsPath: sidecarFor(notePath),
    comments,
    focusId: null,
    line,
    quote: opts?.quote ?? lineQuote(docTextFor(tabId), line),
    error: null,
    draft: '',
    unit: opts?.unit ?? null,
    hint: opts?.hint ?? null,
    identifiers: opts?.identifiers ?? [],
    context: opts?.context ?? null,
    snaps: [],
    snapCommentId: null,
  });
}

/**
 * Open the panel listing ALL of a note's review notes. With `focus` — a
 * marker's line, or a code card's declaration label — the first note there
 * leads the list (`core/note-marks firstNoteAt`); without it, no single focus.
 */
export async function openAllComments(
  tabId: string,
  focus?: { line?: number; unit?: string },
): Promise<void> {
  const notePath = notePathFor(tabId);
  if (!notePath) {
    uiStore.getState().showNotice('Save the note before adding review notes.');
    return;
  }
  let comments: VoiceComment[];
  try {
    comments = await loadComments(notePath);
  } catch {
    uiStore.getState().showNotice('Could not read review notes.');
    return;
  }
  voiceStore.setState({
    phase: 'viewing',
    tabId,
    notePath,
    commentsPath: sidecarFor(notePath),
    comments,
    focusId: focus ? (firstNoteAt(comments, focus)?.id ?? null) : null,
    line: null,
    quote: '',
    error: null,
    unit: null,
    hint: null,
    identifiers: [],
    snaps: [],
    snapCommentId: null,
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
 * second tap finishes it. A tap in any other phase is ignored. On desktop the
 * sheet only shows it once a Whisper model is installed (`whisperReady`).
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
  captureId = newCommentId(new Set(comments.map((c) => c.id)));
  voiceStore.setState({ phase: 'capturing', error: null, stopping: false });
  if (noteEngine() === 'whisper') {
    void captureWhisper(captureId);
    return;
  }
  void captureDictation(captureId);
}

/**
 * Desktop: the text box's Save button. The typed (or dictated) draft becomes
 * the note; nothing happens for an empty draft or outside the ready phase.
 */
export async function saveDraft(): Promise<void> {
  const { phase, draft, comments } = voiceStore.getState();
  const text = draft.trim();
  if (phase !== 'ready' || !text) {
    return;
  }
  captureId = newCommentId(new Set(comments.map((c) => c.id)));
  await finishCapture(text);
}

/** The text box changed (typing, or the OS's dictation typing into it). */
export function updateDraft(draft: string): void {
  voiceStore.setState({ draft });
}

/**
 * Where an engine's words go: on Android straight into a note; on desktop
 * onto the end of the draft, for the user to check and save.
 */
async function deliver(spoken: string): Promise<void> {
  if (isAndroid()) {
    await finishCapture(spoken);
    return;
  }
  captureId = null;
  const { draft } = voiceStore.getState();
  voiceStore.setState({
    phase: 'ready',
    stopping: false,
    draft: draft + joinDictation(draft, spoken),
  });
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
  const { whisperModel, whisperUseGpu } = settingsStore.getState().settings;
  const prepared = ipc.whisperPrepare(whisperModel, whisperUseGpu);
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
    const { whisperModel, whisperUseGpu } = settingsStore.getState().settings;
    // Review mode's identifier hint (if any) primes the decoder — see
    // core/code/vocab.ts.
    const hint = voiceStore.getState().hint ?? undefined;
    const text = (
      await ipc.whisperTranscribe(pcm, sampleRate, whisperModel, whisperUseGpu, hint)
    ).trim();
    if (!current()) {
      return; // closed while transcribing: the words are dropped, as cancelled
    }
    if (text) {
      await deliver(text);
    } else {
      failCapture('STT_NO_MATCH');
    }
  } catch (e) {
    if (current()) {
      failCapture(rejectionCode(e));
    }
  }
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
    await deliver(text.trim());
  } catch (e) {
    if (current()) {
      failCapture(e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Commit the in-flight capture: append + save the note. The document is
 * untouched. Every engine lands here, so this is where a code review's spoken
 * identifiers snap to the real names — the sheet then lists what changed with
 * an undo per name.
 */
async function finishCapture(spoken: string): Promise<void> {
  const { notePath, commentsPath, comments, line, quote, unit, identifiers } =
    voiceStore.getState();
  if (!notePath || !commentsPath || !captureId || line === null) {
    return;
  }
  const id = captureId;
  captureId = null;
  clearStopWatchdog();
  const { text: transcript, snaps } =
    identifiers.length > 0 ? snapIdentifiers(spoken, identifiers) : { text: spoken, snaps: [] };
  const comment: VoiceComment = {
    id,
    file: noteRefFor(commentsPath, notePath),
    line,
    quote,
    time: new Date().toISOString(),
    transcript,
    ...(unit ? { unit } : {}),
  };
  voiceStore.setState({
    phase: 'viewing',
    comments: [...comments, comment],
    focusId: id,
    line: null,
    quote: '',
    stopping: false,
    draft: '',
    snaps,
    snapCommentId: snaps.length > 0 ? id : null,
  });
  await saveNow();
}

/**
 * Undo one snapped name in the note that was just captured: the identifier
 * goes back to the words that were spoken, and the rest of the snaps stay
 * undoable. Saves like any other transcript edit.
 */
export function undoSnap(at: number): void {
  const { comments, snaps, snapCommentId } = voiceStore.getState();
  const comment = comments.find((c) => c.id === snapCommentId);
  if (!comment) {
    return;
  }
  const next = undoSnapIn(comment.transcript, snaps, at);
  if (next.text === comment.transcript) {
    return;
  }
  voiceStore.setState({
    comments: comments.map((c) => (c.id === comment.id ? { ...c, transcript: next.text } : c)),
    snaps: next.snaps,
    snapCommentId: next.snaps.length > 0 ? snapCommentId : null,
  });
  scheduleSave();
}

/**
 * A capture failed: drop back to the ready phase for the same line and show
 * the reason IN the sheet, with steps to fix it. (A status-bar notice was
 * invisible here — the sheet's backdrop dims the status bar.)
 */
function failCapture(raw: string): void {
  captureId = null;
  clearStopWatchdog();
  pcmCapture?.cancel();
  pcmCapture = null;
  if (inFlight(voiceStore.getState().phase)) {
    voiceStore.setState({
      phase: 'ready',
      stopping: false,
      error: captureErrorFor(raw, noteEngine()),
    });
  }
}

/** The error box's "Open voice notes settings" button (a missing Whisper model). */
export function openVoiceSettings(): void {
  closePanel();
  uiStore.getState().openSettings('voice');
}

/** The error box's "Open … settings" button: jump to a system Settings page. */
export function openCaptureSettings(uri: string): void {
  void openUrl(uri).catch(() => {
    uiStore
      .getState()
      .showNotice('Could not open the system settings. Open them from the Start menu instead.');
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
  const id = captureId;
  if (noteEngine() === 'whisper') {
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
    // A hand edit moves the text the snap offsets point at: drop the undo list
    // rather than leave it pointing somewhere stale.
    ...(s.snapCommentId === id ? { snaps: [], snapCommentId: null } : {}),
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
    if (noteEngine() === 'whisper') {
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
  voiceStore.setState({ phase: 'closed', ...initialTail() });
}

/** The reset fields shared by close (keeps a closed panel tidy; `armed` and `marks` are untouched). */
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
    unit: null,
    hint: null,
    identifiers: [],
    context: null,
    snaps: [],
    snapCommentId: null,
  } satisfies Omit<VoiceCommentsState, 'phase' | 'armed' | 'marks'>;
}
