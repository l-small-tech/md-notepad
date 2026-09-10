/**
 * VoiceComments — the voice-note capture sheet + note list.
 *
 * A pure projection of `voiceStore` (src/ui/voice-comments.ts): in the `ready`
 * and `capturing` phases it shows the chosen line and a big two-tap microphone
 * (tap to start, tap again to finish); in `viewing` it lists the note's voice
 * notes. Mounted once at the app root; it renders nothing while closed.
 */

import {
  closePanel,
  deleteComment,
  openCaptureSettings,
  showNotes,
  toggleMic,
  updateTranscript,
  useVoiceStore,
  type VoiceCommentsState,
} from '../voice-comments';
import { isAndroid } from '../platform';
import type { VoiceComment } from '../../core/comments';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function CommentCard({ comment, focused }: { comment: VoiceComment; focused: boolean }) {
  return (
    <div className={`vc-card${focused ? ' vc-card-focus' : ''}`}>
      <div className="vc-card-meta">
        <span>
          {comment.line !== null ? `Line ${comment.line} · ` : ''}
          {formatTime(comment.time)}
        </span>
        <button
          className="vc-btn-danger"
          onClick={() => void deleteComment(comment.id)}
          aria-label="Delete voice note"
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
    </div>
  );
}

export function VoiceComments() {
  const state = useVoiceStore((s) => s);
  if (state.phase === 'closed') {
    return null;
  }
  const capturing = state.phase === 'capturing';
  const title =
    state.phase === 'viewing'
      ? 'Voice notes'
      : state.line !== null
        ? `Voice note · line ${state.line}`
        : 'Voice note';
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
      <div className="vc-panel" role="dialog" aria-label="Voice notes">
        <div className="vc-header">
          <span>{title}</span>
          <div className="vc-header-actions">
            {state.phase === 'ready' && (
              <button
                className="vc-add"
                onClick={showNotes}
                aria-label="Show all voice notes"
                title="Show this note's voice notes"
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

/** The two-tap microphone: idle in `ready`, pulsing in `capturing`. */
function CaptureView({ state }: { state: VoiceCommentsState }) {
  const capturing = state.phase === 'capturing';
  const finishing = capturing && state.stopping;
  const error = capturing ? null : state.error;
  const label = finishing
    ? 'Finishing…'
    : capturing
      ? 'Listening… tap again to finish'
      : error
        ? 'Tap to try again'
        : 'Tap to start';
  return (
    <div className="vc-capturing">
      {state.quote && <div className="vc-quote vc-quote-target">{state.quote}</div>}
      <button
        className={`vc-mic${capturing && !finishing ? ' vc-mic-live' : ''}${finishing ? ' vc-mic-finishing' : ''}`}
        onClick={toggleMic}
        aria-pressed={capturing}
        aria-busy={finishing}
        aria-label={finishing ? 'Finishing' : capturing ? 'Finish recording' : 'Start recording'}
      >
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
      </button>
      <div className="vc-capture-label">{label}</div>
      {error && (
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
          {error.note && <div className="vc-error-note">{error.note}</div>}
          <div className="vc-error-code">Error code: {error.code}</div>
        </div>
      )}
    </div>
  );
}

function ViewingBody({ state }: { state: VoiceCommentsState }) {
  if (state.comments.length === 0) {
    return (
      <div className="vc-body">
        <div className="vc-empty">No voice notes on this document yet.</div>
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
        <CommentCard key={c.id} comment={c} focused={c.id === state.focusId} />
      ))}
    </div>
  );
}
