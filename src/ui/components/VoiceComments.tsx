/**
 * VoiceComments — the voice-note capture sheet + note list.
 *
 * A pure projection of `voiceStore` (src/ui/voice-comments.ts): in the `ready`,
 * `capturing` and `transcribing` phases it shows the chosen line and the way
 * to add a note — on Android a big two-tap microphone (tap to start, tap
 * again to finish), on desktop a text box with a Save button, a hint about the
 * OS's own dictation, and a Whisper microphone that is an Install button until
 * a model is on disk (`stores/whisper-models.ts` for the download's progress);
 * in `viewing` it lists the note's voice notes. Mounted once at the app root;
 * it renders nothing while closed.
 */

import { useEffect, useRef } from 'react';
import {
  closePanel,
  deleteComment,
  installWhisper,
  openCaptureSettings,
  openVoiceSettings,
  saveDraft,
  showNotes,
  toggleMic,
  undoSnap,
  updateDraft,
  updateTranscript,
  useVoiceStore,
  whisperReady,
  type VoiceCommentsState,
} from '../voice-comments';
import { desktopOs, isAndroid } from '../platform';
import { useSettingsStore } from '../stores/settings';
import { useWhisperModels, whisperModelsStore } from '../stores/whisper-models';
import { downloadPercent } from '../../core/whisper-models';
import type { VoiceComment } from '../../core/comments';
import type { Snap } from '../../core/code/vocab';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * What snapping changed in this note, each undoable: "shows all files" became
 * `` `showsAllFiles` ``. Rendered only while there is something to undo.
 */
function Snaps({ snaps }: { snaps: Snap[] }) {
  return (
    <div className="vc-snaps">
      <span className="vc-snaps-label">Matched names</span>
      {snaps.map((snap, i) => (
        <span className="vc-snap" key={`${snap.index}-${snap.to}`}>
          <code>{snap.to.replace(/`/g, '')}</code>
          <button
            className="vc-snap-undo"
            onClick={() => undoSnap(i)}
            title={`Put "${snap.from}" back`}
            aria-label={`Undo ${snap.to.replace(/`/g, '')}`}
          >
            undo
          </button>
        </span>
      ))}
    </div>
  );
}

function CommentCard({
  comment,
  focused,
  snaps,
}: {
  comment: VoiceComment;
  focused: boolean;
  snaps: Snap[];
}) {
  return (
    <div className={`vc-card${focused ? ' vc-card-focus' : ''}`}>
      <div className="vc-card-meta">
        <span>
          {comment.line !== null ? `Line ${comment.line} · ` : ''}
          {comment.unit ? `${comment.unit} · ` : ''}
          {formatTime(comment.time)}
        </span>
        <button
          className="vc-btn-danger"
          onClick={() => void deleteComment(comment.id)}
          aria-label="Delete review note"
        >
          Delete
        </button>
      </div>
      {comment.quote && <div className="vc-quote">{comment.quote}</div>}
      <textarea
        className="vc-transcript"
        value={comment.transcript}
        placeholder="Transcript…"
        onChange={(e) => updateTranscript(comment.id, e.target.value)}
      />
      {snaps.length > 0 && <Snaps snaps={snaps} />}
    </div>
  );
}

export function VoiceComments() {
  const state = useVoiceStore((s) => s);
  if (state.phase === 'closed') {
    return null;
  }
  const capturing = state.phase === 'capturing' || state.phase === 'transcribing';
  const title =
    state.phase === 'viewing'
      ? 'Review notes'
      : state.unit
        ? // Review mode: the declaration says more than its line number does.
          `Review note · ${state.unit}`
        : state.line !== null
          ? `Review note · line ${state.line}`
          : 'Review note';
  return (
    <div
      className={`vc-backdrop${isAndroid() ? ' vc-android' : ''}`}
      onClick={(e) => {
        // Click on the backdrop (not the panel) closes.
        if (e.target === e.currentTarget) {
          closePanel();
        }
      }}
    >
      <div className="vc-panel" role="dialog" aria-label="Review notes">
        <div className="vc-header">
          <span>{title}</span>
          <div className="vc-header-actions">
            {state.phase === 'ready' && (
              <button
                className="vc-add"
                onClick={showNotes}
                aria-label="Show all review notes"
                title="Show this document's review notes"
              >
                {state.comments.length > 0 ? `Notes (${state.comments.length})` : 'Notes'}
              </button>
            )}
            <button
              className="vc-close"
              onClick={closePanel}
              aria-label={capturing ? 'Cancel' : 'Close'}
            >
              ✕
            </button>
          </div>
        </div>
        {state.phase === 'viewing' ? <ViewingBody state={state} /> : <CaptureView state={state} />}
      </div>
    </div>
  );
}

const MicIcon = (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3M8 21h8" />
  </svg>
);

/** The two-tap microphone: idle in `ready`, pulsing in `capturing`, busy in `transcribing`. */
function MicButton({ state, small }: { state: VoiceCommentsState; small?: boolean }) {
  const capturing = state.phase === 'capturing';
  const transcribing = state.phase === 'transcribing';
  const finishing = (capturing && state.stopping) || transcribing;
  return (
    <button
      className={`vc-mic${small ? ' vc-mic-small' : ''}${capturing && !finishing ? ' vc-mic-live' : ''}${finishing ? ' vc-mic-finishing' : ''}${transcribing ? ' vc-mic-transcribing' : ''}`}
      onClick={toggleMic}
      // Keep the caret in the text box (desktop), so dictation and typing
      // carry on where they were.
      onMouseDown={(e) => e.preventDefault()}
      disabled={transcribing}
      aria-pressed={capturing}
      aria-busy={finishing}
      aria-label={
        transcribing
          ? 'Transcribing'
          : finishing
            ? 'Finishing'
            : capturing
              ? 'Finish recording'
              : 'Start recording'
      }
      title={small ? 'Dictate offline with Whisper' : undefined}
    >
      {MicIcon}
    </button>
  );
}

/** What the last capture said went wrong, with the steps to fix it. */
function ErrorBox({ error }: { error: NonNullable<VoiceCommentsState['error']> }) {
  return (
    <div className="vc-error" role="alert">
      <div className="vc-error-title">{error.title}</div>
      <ol className="vc-error-steps">
        {error.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {error.settings && (
        <button
          className="vc-btn vc-error-action"
          onClick={() => openCaptureSettings(error.settings!.uri)}
        >
          {error.settings.label}
        </button>
      )}
      {error.appSettings && (
        <button className="vc-btn vc-error-action" onClick={openVoiceSettings}>
          {error.appSettings.label}
        </button>
      )}
      {error.note && <div className="vc-error-note">{error.note}</div>}
      <div className="vc-error-code">Error code: {error.code}</div>
    </div>
  );
}

/** The capture body: Android's voice-first sheet, or the desktop text box. */
function CaptureView({ state }: { state: VoiceCommentsState }) {
  return isAndroid() ? <AndroidCapture state={state} /> : <DesktopCapture state={state} />;
}

/** Android: the big microphone — the keyboard is awkward, so voice comes first. */
function AndroidCapture({ state }: { state: VoiceCommentsState }) {
  const capturing = state.phase === 'capturing';
  const transcribing = state.phase === 'transcribing';
  const finishing = (capturing && state.stopping) || transcribing;
  const error = capturing || transcribing ? null : state.error;
  const label = transcribing
    ? 'Transcribing…'
    : finishing
      ? 'Finishing…'
      : capturing
        ? 'Listening… tap again to finish'
        : error
          ? 'Tap to try again'
          : 'Tap to start';
  return (
    <div className="vc-capturing">
      {state.quote && <div className="vc-quote vc-quote-target">{state.quote}</div>}
      <MicButton state={state} />
      <div className="vc-capture-label">{label}</div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

/** How the OS dictates into any text box, for the hint under the draft. */
function osDictationHint(): string | null {
  switch (desktopOs()) {
    case 'windows':
      return 'press Win+H to dictate with Windows voice typing';
    case 'mac':
      return 'press the Dictation key (Fn twice) to dictate with macOS Dictation';
    default:
      return null;
  }
}

/**
 * Desktop: type the note (or let the OS's dictation type it), then Save. The
 * Whisper microphone dictates offline into the same box; until a model is
 * installed its place is taken by an Install button that downloads one here.
 */
function DesktopCapture({ state }: { state: VoiceCommentsState }) {
  const capturing = state.phase === 'capturing';
  const transcribing = state.phase === 'transcribing';
  const finishing = (capturing && state.stopping) || transcribing;
  const busy = capturing || transcribing;
  const error = busy ? null : state.error;
  // Re-render when a download finishes or the chosen model changes.
  const models = useWhisperModels((s) => s.models);
  const download = useWhisperModels((s) => s.download);
  const chosen = useSettingsStore((s) => s.settings.whisperModel);
  const ready = models.length > 0 && chosen !== '' && whisperReady();
  const running = download.kind === 'downloading' || download.kind === 'verifying';
  const percent = running ? downloadPercent(download) : null;
  const os = osDictationHint();
  const hint = transcribing
    ? 'Transcribing…'
    : finishing
      ? 'Finishing…'
      : capturing
        ? 'Listening… tap the microphone again to finish'
        : [
            `Type your note${os ? `, or ${os}` : ''}.`,
            ready
              ? 'The microphone dictates offline with Whisper.'
              : 'Or install Whisper to dictate offline, on this computer.',
          ].join(' ');
  return (
    <div className="vc-capturing vc-desktop">
      {state.quote && <div className="vc-quote vc-quote-target">{state.quote}</div>}
      <DraftBox draft={state.draft} disabled={busy} />
      <div className="vc-actions">
        {ready ? (
          <MicButton state={state} small />
        ) : running ? (
          <div className="vc-install-progress" role="status" aria-live="polite">
            <span className="vc-install-label">
              {download.kind === 'verifying'
                ? 'Verifying the Whisper model…'
                : percent === null
                  ? 'Downloading the Whisper model…'
                  : `Downloading the Whisper model… ${percent}%`}
            </span>
            <div
              className="settings-progress vc-install-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              <div
                className={`settings-progress-bar${percent === null ? ' settings-progress-indeterminate' : ''}`}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
            <button
              className="vc-btn vc-btn-quiet"
              onClick={() => whisperModelsStore.getState().cancelDownload()}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="vc-btn vc-install"
            onClick={() => void installWhisper()}
            onMouseDown={(e) => e.preventDefault()}
            title="Download the offline speech model once; then the microphone dictates here"
          >
            {MicIcon}
            {download.kind === 'failed' ? 'Retry Whisper download' : 'Install Whisper'}
          </button>
        )}
        <button
          className="vc-btn vc-save"
          onClick={() => void saveDraft()}
          disabled={busy || !state.draft.trim()}
        >
          Save note
        </button>
      </div>
      <div className="vc-capture-label vc-hint">{hint}</div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

/**
 * Desktop: the note's text box. Focused on mount, so typing — or the OS's
 * dictation, which types wherever the caret is — starts right away.
 */
function DraftBox({ draft, disabled }: { draft: string; disabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <textarea
      ref={ref}
      className="vc-transcript vc-draft"
      value={draft}
      disabled={disabled}
      placeholder="Type your note…"
      aria-label="Review note text"
      onChange={(e) => updateDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void saveDraft();
        }
      }}
    />
  );
}

function ViewingBody({ state }: { state: VoiceCommentsState }) {
  if (state.comments.length === 0) {
    return (
      <div className="vc-body">
        <div className="vc-empty">No review notes on this document yet.</div>
      </div>
    );
  }
  // Focused first, then the rest in file order.
  const ordered = [...state.comments].sort((a, b) => {
    if (a.id === state.focusId) return -1;
    if (b.id === state.focusId) return 1;
    return 0;
  });
  return (
    <div className="vc-body">
      {ordered.map((c) => (
        <CommentCard
          key={c.id}
          comment={c}
          focused={c.id === state.focusId}
          snaps={c.id === state.snapCommentId ? state.snaps : []}
        />
      ))}
    </div>
  );
}
