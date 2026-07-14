/**
 * voice-comments.ts — the controller behind the voice-comment feature.
 *
 * Mirrors the tab-agnostic module-dispatch style of `session.ts`: a single
 * vanilla Zustand store holds the transient panel state, and the UI
 * (`VoiceComments.tsx`) is a pure projection of it. All file I/O goes through
 * `currentProvider()` so a note in a synced (SAF) workspace gets its comments
 * file and audio clips in the same backend.
 *
 * Two capture paths converge on the same persistence:
 *  - Android: on-device `SpeechRecognizer` via the `ipc.stt*` bridges — returns
 *    a transcript directly.
 *  - Desktop: `MediaRecorder` in the webview — saves a `.webm` clip beside the
 *    note and leaves the transcript blank for the user to type (there is no
 *    reliable on-device STT in the desktop webviews).
 *
 * The gutter markers are derived from the anchor tokens already in the document
 * (see `voice-gutter.ts`), so this controller never has to "load comments to
 * render markers" — it loads the comments file lazily, only when the panel opens
 * or a new comment is added.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  commentsPathFor,
  findAnchors,
  newCommentId,
  parseCommentsFile,
  serializeCommentsFile,
  type VoiceComment,
} from '../core/comments';
import { baseName, dirName, joinPath } from '../core/session/plan-flush';
import { ipc, IpcError } from '../ipc/commands';
import { currentProvider } from '../ipc/provider';
import { getSourceAdapter } from './editor-registry';
import { isAndroid } from './platform';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';

/** Panel lifecycle: closed → capturing (mic live) → viewing (transcripts). */
type Phase = 'closed' | 'capturing' | 'viewing';

export interface VoiceCommentsState {
  phase: Phase;
  tabId: string | null;
  notePath: string | null;
  commentsPath: string | null;
  comments: VoiceComment[];
  /** Ids that still have an anchor in the document (for orphan flagging). */
  anchoredIds: string[];
  /** Comment to highlight/scroll to when viewing. */
  focusId: string | null;
  /** 1-based line being annotated/viewed. */
  line: number | null;
  /** 'android' = live dictation; 'desktop' = audio recording. */
  captureKind: 'android' | 'desktop' | null;
}

const initial: VoiceCommentsState = {
  phase: 'closed',
  tabId: null,
  notePath: null,
  commentsPath: null,
  comments: [],
  anchoredIds: [],
  focusId: null,
  line: null,
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

/** Ids currently anchored in the tab's document. */
function anchoredIdsFor(tabId: string): string[] {
  return findAnchors(docTextFor(tabId)).map((a) => a.id);
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
  const { commentsPath, comments } = voiceStore.getState();
  if (!commentsPath) {
    return;
  }
  try {
    await currentProvider().atomicWriteText(commentsPath, serializeCommentsFile(comments));
  } catch {
    uiStore.getState().showNotice('Could not save voice comments.');
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
// The id minted for the in-flight capture (shared by the audio file + anchor).
let captureId: string | null = null;

function teardownMedia(): void {
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
  mediaChunks = [];
}

/* ---- public actions ---------------------------------------------------- */

/** Open the panel to view the comment for `id` on `line`. */
export async function openComment(tabId: string, id: string, line: number): Promise<void> {
  const notePath = notePathFor(tabId);
  if (!notePath) {
    return;
  }
  let comments: VoiceComment[] = [];
  try {
    comments = await loadComments(notePath);
  } catch {
    uiStore.getState().showNotice('Could not read voice comments.');
  }
  voiceStore.setState({
    phase: 'viewing',
    tabId,
    notePath,
    commentsPath: commentsPathFor(notePath),
    comments,
    anchoredIds: anchoredIdsFor(tabId),
    focusId: id,
    line,
    captureKind: null,
  });
}

/**
 * Open the panel showing ALL of a note's comments (no single focus). This is the
 * read-mode entry point: the preview has no gutter markers to click, so the
 * ribbon opens the full list to view/play/edit/delete — and add from within it.
 */
export async function openAllComments(tabId: string): Promise<void> {
  const notePath = notePathFor(tabId);
  if (!notePath) {
    uiStore.getState().showNotice('Save the note before adding voice comments.');
    return;
  }
  let comments: VoiceComment[] = [];
  try {
    comments = await loadComments(notePath);
  } catch {
    uiStore.getState().showNotice('Could not read voice comments.');
  }
  voiceStore.setState({
    phase: 'viewing',
    tabId,
    notePath,
    commentsPath: commentsPathFor(notePath),
    comments,
    anchoredIds: anchoredIdsFor(tabId),
    focusId: null,
    line: null,
    captureKind: null,
  });
}

/**
 * Add a comment from within the panel (the "+" button). Anchors to the source
 * editor's current caret line — which is valid in read mode too, since the CM6
 * source editor stays attached (just hidden) there.
 */
export async function addFromPanel(): Promise<void> {
  const { tabId } = voiceStore.getState();
  if (!tabId) {
    return;
  }
  const line = getSourceAdapter(tabId)?.anchorLineAt() ?? 1;
  await addCommentAtLine(tabId, line);
}

/**
 * Begin adding a voice comment on `line`. Loads existing comments (to dedupe the
 * new id), mints the id, then starts the platform capture. The anchor token and
 * the stored comment are written only when capture completes.
 */
export async function addCommentAtLine(tabId: string, line: number): Promise<void> {
  const notePath = notePathFor(tabId);
  if (!notePath) {
    uiStore.getState().showNotice('Save the note before adding a voice comment.');
    return;
  }
  const adapter = getSourceAdapter(tabId);
  if (!adapter) {
    return;
  }
  let existing: VoiceComment[];
  try {
    existing = await loadComments(notePath);
  } catch {
    existing = [];
  }
  const used = new Set<string>([...anchoredIdsFor(tabId), ...existing.map((c) => c.id)]);
  captureId = newCommentId(used);

  voiceStore.setState({
    phase: 'capturing',
    tabId,
    notePath,
    commentsPath: commentsPathFor(notePath),
    comments: existing,
    anchoredIds: anchoredIdsFor(tabId),
    focusId: null,
    line,
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
    return 'Microphone permission is required for voice comments.';
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
      return 'Microphone permission is required for voice comments.';
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

/** Commit the in-flight capture: insert the anchor, append + save the comment. */
async function finishCapture(transcript: string, audio: string | null): Promise<void> {
  const { tabId, comments, line } = voiceStore.getState();
  if (!tabId || !captureId || line === null) {
    return;
  }
  const id = captureId;
  captureId = null;
  getSourceAdapter(tabId)?.insertAnchorAtLine(line, id);
  const comment: VoiceComment = {
    id,
    time: new Date().toISOString(),
    transcript,
    audio,
  };
  const next = [...comments, comment];
  voiceStore.setState({
    phase: 'viewing',
    comments: next,
    anchoredIds: anchoredIdsFor(tabId),
    focusId: id,
  });
  await saveNow();
}

function failCapture(message: string): void {
  captureId = null;
  teardownMedia();
  uiStore.getState().showNotice(message);
  voiceStore.setState({ phase: 'closed', ...initialTail() });
}

/** Stop the live capture early (user tapped Stop). */
export function stopCapture(): void {
  const { captureKind } = voiceStore.getState();
  if (captureKind === 'desktop') {
    mediaRecorder?.stop(); // onstop → finishCaptureDesktop
  } else if (captureKind === 'android') {
    void ipc.sttStop(); // final still resolves sttStart → finishCapture
  }
}

/** Edit a comment's transcript text (debounced save). */
export function updateTranscript(id: string, transcript: string): void {
  voiceStore.setState((s) => ({
    comments: s.comments.map((c) => (c.id === id ? { ...c, transcript } : c)),
  }));
  scheduleSave();
}

/** Delete a comment: remove its anchor token, its audio clip, and its entry. */
export async function deleteComment(id: string): Promise<void> {
  const { tabId, comments, notePath } = voiceStore.getState();
  if (tabId) {
    getSourceAdapter(tabId)?.removeAnchor(id);
  }
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
    anchoredIds: tabId ? anchoredIdsFor(tabId) : s.anchoredIds,
    focusId: s.focusId === id ? null : s.focusId,
  }));
  await saveNow();
}

/** Close the panel; cancels an in-flight capture without committing it. */
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

/** Resolve a comment's audio clip to a playable data: URL. */
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

/** The reset fields shared by close/fail (keeps a closed panel tidy). */
function initialTail() {
  return {
    tabId: null,
    notePath: null,
    commentsPath: null,
    comments: [],
    anchoredIds: [],
    focusId: null,
    line: null,
    captureKind: null,
  } satisfies Omit<VoiceCommentsState, 'phase'>;
}
