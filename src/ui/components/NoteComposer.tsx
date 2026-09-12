/**
 * NoteComposer — the inline review-note composer.
 *
 * A pure projection of `voiceStore` (src/ui/voice-comments.ts), rendered by
 * `EditorHost` through a portal INTO the Review pane, right under the line
 * (or code card head) that was held — the way a word processor opens a
 * comment box beside the text, with nothing covering the document. In the
 * `ready`, `capturing` and `transcribing` phases it shows the held line and
 * the way to add a note: a text box with Save (the OS's own dictation types
 * into it on desktop), and a microphone — on Android the on-device
 * recognizer, on desktop Whisper, which is an Install button until a model
 * is on disk (`stores/whisper-models.ts` for the download's progress). In
 * `saved` — a code note whose spoken names were snapped — it shows the saved
 * text with an undo per name, and Done.
 */

import { useEffect, useRef } from 'react';
import {
  closePanel,
  installWhisper,
  openCaptureSettings,
  openVoiceSettings,
  saveDraft,
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
import type { Snap } from '../../core/code/vocab';

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

export function NoteComposer() {
  const state = useVoiceStore((s) => s);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = state.phase !== 'closed';
  // The held line may sit at the bottom of the window: bring the whole box
  // into view once it is in the document (the pane places the slot first).
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() =>
        rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      );
      return () => cancelAnimationFrame(id);
    }
  }, [open]);
  if (state.phase === 'closed') {
    return null;
  }
  const capturing = state.phase === 'capturing' || state.phase === 'transcribing';
  const where = state.unit ?? (state.line !== null ? `Line ${state.line}` : '');
  return (
    <div
      ref={rootRef}
      className={`vn-composer${isAndroid() ? ' vn-composer-android' : ''}`}
      role="dialog"
      aria-label={state.phase === 'saved' ? 'Review note saved' : 'New review note'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closePanel();
        }
      }}
    >
      <div className="vn-composer-head">
        <span className="vn-composer-title">
          <span className="vn-composer-icon" aria-hidden="true">
            💬
          </span>
          {state.phase === 'saved' ? 'Saved' : 'New review note'}
          {where && <span className="vn-composer-where">{where}</span>}
        </span>
        <button
          className="vn-composer-close"
          onClick={closePanel}
          aria-label={capturing ? 'Cancel' : 'Close'}
          title={capturing ? 'Cancel' : 'Close (Esc)'}
        >
          ✕
        </button>
      </div>
      {state.quote && <div className="vc-quote vc-quote-target">{state.quote}</div>}
      {state.phase === 'saved' ? (
        <SavedView state={state} />
      ) : isAndroid() ? (
        <AndroidCapture state={state} />
      ) : (
        <DesktopCapture state={state} />
      )}
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

/**
 * Android: the microphone leads (the keyboard is awkward), the text box is
 * there for a tablet with one. A finished dictation IS the note; typing
 * needs Save.
 */
function AndroidCapture({ state }: { state: VoiceCommentsState }) {
  const capturing = state.phase === 'capturing';
  const transcribing = state.phase === 'transcribing';
  const finishing = (capturing && state.stopping) || transcribing;
  const busy = capturing || transcribing;
  const error = busy ? null : state.error;
  const label = transcribing
    ? 'Transcribing…'
    : finishing
      ? 'Finishing…'
      : capturing
        ? 'Listening… tap again to finish'
        : error
          ? 'Tap to try again'
          : 'Tap to speak, or type below';
  return (
    <div className="vc-capturing vn-android">
      <MicButton state={state} />
      <div className="vc-capture-label">{label}</div>
      {error && <ErrorBox error={error} />}
      <DraftBox draft={state.draft} disabled={busy} autoFocus={false} />
      <div className="vc-actions">
        <button className="vc-btn vc-btn-quiet" onClick={closePanel}>
          Cancel
        </button>
        <button
          className="vc-btn vc-save"
          onClick={() => void saveDraft()}
          disabled={busy || !state.draft.trim()}
        >
          Save note
        </button>
      </div>
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
            'Ctrl+Enter saves.',
          ].join(' ');
  return (
    <div className="vc-capturing vc-desktop">
      <DraftBox draft={state.draft} disabled={busy} autoFocus />
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
        <span className="vc-actions-spacer" />
        <button className="vc-btn vc-btn-quiet" onClick={closePanel} disabled={busy}>
          Cancel
        </button>
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
 * The note's text box. Grows with the text; focused on mount on desktop, so
 * typing — or the OS's dictation, which types wherever the caret is — starts
 * right away. Ctrl/Cmd+Enter saves.
 */
function DraftBox({
  draft,
  disabled,
  autoFocus,
}: {
  draft: string;
  disabled: boolean;
  autoFocus: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
    }
  }, [autoFocus]);
  useEffect(() => {
    const box = ref.current;
    if (box) {
      box.style.height = 'auto';
      box.style.height = `${Math.max(box.scrollHeight, 56)}px`;
    }
  }, [draft]);
  return (
    <textarea
      ref={ref}
      className="vc-transcript vc-draft"
      value={draft}
      disabled={disabled}
      rows={2}
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

/** After a save with snapped names: the saved text (still editable) and the undo chips. */
function SavedView({ state }: { state: VoiceCommentsState }) {
  const comment = state.comments.find((c) => c.id === state.snapCommentId);
  return (
    <div className="vc-capturing vc-desktop">
      {comment && (
        <textarea
          className="vc-transcript vc-draft"
          value={comment.transcript}
          rows={2}
          aria-label="Saved review note text"
          onChange={(e) => updateTranscript(comment.id, e.target.value)}
        />
      )}
      {state.snaps.length > 0 && <Snaps snaps={state.snaps} />}
      <div className="vc-actions">
        <span className="vc-actions-spacer" />
        <button className="vc-btn vc-save" onClick={closePanel}>
          Done
        </button>
      </div>
    </div>
  );
}
