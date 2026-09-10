/**
 * voice-comments.ts — the controller behind the voice-notes feature.
 *
 * Mirrors the tab-agnostic module-dispatch style of `session.ts`: a single
 * vanilla Zustand store holds the transient state, and the UI
 * (`VoiceComments.tsx`, the ribbon's Read-mode button, the preview pane's hold
 * gesture) is a pure projection of it. All file I/O goes through
 * `currentProvider()` so a note in a synced (SAF) workspace gets its comments
 * file and audio clips in the same backend.
 *
 * The flow, designed for reviewing a document from the couch:
 *   1. In Read mode, the ribbon's voice-notes button ARMS the feature.
 *   2. While armed, press-and-hold a line of the rendered document. The pane
 *      reports the source line; the panel opens in the `ready` phase, showing
 *      the line's text and a big microphone.
 *   3. Tap the mic to start, tap again to finish. The transcript is appended
 *      to `<name>.comments.md` with the file name, line, quote and UTC time.
 *      The document itself is never modified.
 *
 * Two capture paths converge on the same persistence:
 *  - Android: on-device `SpeechRecognizer` via the `ipc.stt*` bridges — returns
 *    a transcript directly.
 *  - Desktop: `MediaRecorder` in the webview — saves a `.webm` clip beside the
 *    note and leaves the transcript blank for the user to type (there is no
 *    reliable on-device STT in the desktop webviews).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  commentsPathFor,
  lineQuote,
  newCommentId,
  parseCommentsFile,
  serializeCommentsFile,
  type VoiceComment,
} from '../core/comments';
import { baseName, dirName, joinPath } from '../core/session/plan-flush';
import { ipc, IpcError } from '../ipc/commands';
import { currentProvider } from '../ipc/provider';
import { isAndroid } from './platform';
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
  /** 'android' = live dictation; 'desktop' = audio recording. */
  captureKind: 'android' | 'desktop' | null;
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
  captureKind: null,
};

export const voiceStore = createStore<VoiceCommentsState>()(() => initial);

export const useVoiceStore = <T>(selector: (s: VoiceCommentsState) => T): T =>
  useStore(voiceStore, selector);

/* ---- helpers ----------------------------------------------------------- */

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

/** Read + parse a note's comments file; [] when it doesn't exist yet. */
async function loadComments(notePath: string): Promise<VoiceComment[]> {
  try {
    const { text } = await currentProvider().readTextFile(commentsPathFor(notePath));
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
      serializeCommentsFile(comments, baseName(notePath)),
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

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/* ---- desktop MediaRecorder capture ------------------------------------- */

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let mediaChunks: Blob[] = [];
// The id minted for the in-flight capture (shared by the audio file + entry).
let captureId: string | null = null;

function teardownMedia(): void {
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
  mediaChunks = [];
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
  if (voiceStore.getState().phase === 'capturing') {
    return; // a capture is in flight — don't yank the line out from under it
  }
  voiceStore.setState({
    phase: 'ready',
    tabId,
    notePath,
    commentsPath: commentsPathFor(notePath),
    comments,
    focusId: null,
    line,
    quote: lineQuote(docTextFor(tabId), line),
    captureKind: null,
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
    commentsPath: commentsPathFor(notePath),
    comments,
    focusId: null,
    line: null,
    quote: '',
    captureKind: null,
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

/** Mint the id, flip to `capturing`, and start the platform capture. */
function startCapture(): void {
  const { tabId, line, comments } = voiceStore.getState();
  if (!tabId || line === null) {
    return;
  }
  captureId = newCommentId(new Set(comments.map((c) => c.id)));
  voiceStore.setState({
    phase: 'capturing',
    captureKind: isAndroid() ? 'android' : 'desktop',
  });
  if (isAndroid()) {
    void captureAndroid();
  } else {
    void captureDesktop();
  }
}

/**
 * Turn an Android `SpeechRecognizer` reject ("STT_ERROR:<code>" / "PERMISSION_
 * DENIED" / "STT_BUSY" / "STT_UNAVAILABLE") into a message that says what to do.
 * The codes are `android.speech.SpeechRecognizer.ERROR_*`.
 */
function sttErrorMessage(raw: string): string {
  if (raw.includes('PERMISSION_DENIED')) {
    return 'Microphone permission is required for voice notes.';
  }
  if (raw.includes('STT_BUSY')) {
    return 'Still finishing the last recording — try again in a moment.';
  }
  if (raw.includes('STT_UNAVAILABLE')) {
    return 'On-device speech recognition is unavailable on this device.';
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

async function captureAndroid(): Promise<void> {
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
      failCapture('On-device speech recognition is unavailable on this device.');
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
    await finishCapture(text.trim(), null);
  } catch (e) {
    if (voiceStore.getState().phase === 'capturing') {
      failCapture(sttErrorMessage(e instanceof Error ? e.message : String(e)));
    }
  }
}

async function captureDesktop(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStream = stream;
    mediaChunks = [];
    const rec = new MediaRecorder(stream);
    mediaRecorder = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) {
        mediaChunks.push(e.data);
      }
    };
    rec.onstop = () => {
      const blob = new Blob(mediaChunks, { type: rec.mimeType || 'audio/webm' });
      teardownMedia();
      if (voiceStore.getState().phase !== 'capturing') {
        return; // cancelled
      }
      void finishCaptureDesktop(blob);
    };
    rec.start();
  } catch {
    teardownMedia();
    failCapture('Could not access the microphone.');
  }
}

async function finishCaptureDesktop(blob: Blob): Promise<void> {
  const { notePath } = voiceStore.getState();
  if (!notePath || !captureId) {
    return;
  }
  const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
  const audioName = `${stem(notePath)}.${captureId}.${ext}`;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await currentProvider().writeFileBase64(
      joinPath(dirName(notePath), audioName),
      bytesToBase64(bytes),
    );
  } catch {
    failCapture('Could not save the audio clip.');
    return;
  }
  await finishCapture('', audioName);
}

/** Commit the in-flight capture: append + save the note. The document is untouched. */
async function finishCapture(transcript: string, audio: string | null): Promise<void> {
  const { notePath, comments, line, quote } = voiceStore.getState();
  if (!notePath || !captureId || line === null) {
    return;
  }
  const id = captureId;
  captureId = null;
  const comment: VoiceComment = {
    id,
    file: baseName(notePath),
    line,
    quote,
    time: new Date().toISOString(),
    transcript,
    audio,
  };
  const next = [...comments, comment];
  voiceStore.setState({
    phase: 'viewing',
    comments: next,
    focusId: id,
    line: null,
    quote: '',
    captureKind: null,
  });
  await saveNow();
}

/** A capture failed: report it and drop back to the ready phase for the same line. */
function failCapture(message: string): void {
  captureId = null;
  teardownMedia();
  uiStore.getState().showNotice(message);
  if (voiceStore.getState().phase === 'capturing') {
    voiceStore.setState({ phase: 'ready', captureKind: null });
  }
}

/** Stop the live capture (the second mic tap). */
export function stopCapture(): void {
  const { captureKind } = voiceStore.getState();
  if (captureKind === 'desktop') {
    mediaRecorder?.stop(); // onstop → finishCaptureDesktop
  } else if (captureKind === 'android') {
    void ipc.sttStop(); // final still resolves sttStart → finishCapture
  }
}

/** Edit a note's transcript text (debounced save). */
export function updateTranscript(id: string, transcript: string): void {
  voiceStore.setState((s) => ({
    comments: s.comments.map((c) => (c.id === id ? { ...c, transcript } : c)),
  }));
  scheduleSave();
}

/** Delete a note: its audio clip (if any) and its entry. */
export async function deleteComment(id: string): Promise<void> {
  const { comments, notePath } = voiceStore.getState();
  const removed = comments.find((c) => c.id === id);
  if (removed?.audio && notePath) {
    try {
      await currentProvider().deletePath(joinPath(dirName(notePath), removed.audio));
    } catch {
      // Best effort — a leftover clip is harmless.
    }
  }
  voiceStore.setState((s) => ({
    comments: s.comments.filter((c) => c.id !== id),
    focusId: s.focusId === id ? null : s.focusId,
  }));
  await saveNow();
}

/** Close the panel; cancels an in-flight capture without committing it. The toggle stays armed. */
export function closePanel(): void {
  const { phase, captureKind } = voiceStore.getState();
  if (phase === 'capturing') {
    // Flip phase first so the capture completion guards bail out.
    voiceStore.setState({ phase: 'closed' });
    if (captureKind === 'desktop') {
      mediaRecorder?.stop();
    } else if (captureKind === 'android') {
      void ipc.sttStop();
    }
    captureId = null;
    teardownMedia();
  }
  voiceStore.setState({ phase: 'closed', ...initialTail() });
}

/** Resolve a note's audio clip to a playable data: URL. */
export async function audioDataUrl(notePath: string, audio: string): Promise<string> {
  const b64 = await currentProvider().readFileBase64(joinPath(dirName(notePath), audio));
  const type = audio.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';
  const bytes = base64ToBytes(b64);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type });
  return URL.createObjectURL(blob);
}

/** Note stem (base name without extension) for naming sibling audio clips. */
function stem(notePath: string): string {
  const base = baseName(notePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
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
    captureKind: null,
  } satisfies Omit<VoiceCommentsState, 'phase' | 'armed'>;
}
