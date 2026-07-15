/**
 * VoiceComments — the capture sheet + transcript panel.
 *
 * A pure projection of `voiceStore` (src/ui/voice-comments.ts): it renders the
 * live-capture state while dictating/recording, then the note's comments once
 * captured or when a gutter marker is opened. Mounted once at the app root; it
 * renders nothing while the panel is closed.
 */

import { useEffect, useState } from 'react';
import {
  addFromPanel,
  audioDataUrl,
  closePanel,
  deleteComment,
  stopCapture,
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

/** Lazily resolve a comment's audio clip to a playable object URL. */
function AudioClip({ notePath, audio }: { notePath: string; audio: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void audioDataUrl(notePath, audio)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        revoked = u;
        setUrl(u);
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (revoked) {
        URL.revokeObjectURL(revoked);
      }
    };
  }, [notePath, audio]);
  if (!url) {
    return null;
  }
  return <audio className="vc-audio" controls src={url} />;
}

function CommentCard({
  comment,
  notePath,
  focused,
  orphaned,
}: {
  comment: VoiceComment;
  notePath: string;
  focused: boolean;
  orphaned: boolean;
}) {
  return (
    <div
      className={`vc-card${focused ? ' vc-card-focus' : ''}${orphaned ? ' vc-card-orphan' : ''}`}
    >
      <div className="vc-card-meta">
        <span>
          {formatTime(comment.time)}
          {orphaned && <span className="vc-orphan-tag"> · unanchored</span>}
        </span>
        <button
          className="vc-btn-danger"
          onClick={() => void deleteComment(comment.id)}
          aria-label="Delete voice comment"
        >
          Delete
        </button>
      </div>
      <textarea
        className="vc-transcript"
        value={comment.transcript}
        placeholder="Transcript…"
        onChange={(e) => updateTranscript(comment.id, e.target.value)}
      />
      {comment.audio && <AudioClip notePath={notePath} audio={comment.audio} />}
    </div>
  );
}

export function VoiceComments() {
  const state = useVoiceStore((s) => s);
  if (state.phase === 'closed') {
    return null;
  }
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
      <div className="vc-panel" role="dialog" aria-label="Voice comments">
        <div className="vc-header">
          <span>{state.phase === 'capturing' ? 'New voice comment' : 'Voice comments'}</span>
          <div className="vc-header-actions">
            {state.phase === 'viewing' && (
              <button
                className="vc-add"
                onClick={() => void addFromPanel()}
                aria-label="Add a voice comment"
                title="Add a voice comment on the current line"
              >
                ＋
              </button>
            )}
            <button className="vc-close" onClick={closePanel} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        {state.phase === 'capturing' ? (
          <CaptureView state={state} />
        ) : (
          <ViewingBody state={state} />
        )}
      </div>
    </div>
  );
}

function CaptureView({ state }: { state: VoiceCommentsState }) {
  const listening = state.captureKind === 'android';
  return (
    <div className="vc-capturing">
      <div className="vc-pulse" aria-hidden="true">
        🎙️
      </div>
      <div className="vc-capture-label">
        {listening ? 'Listening… speak now' : 'Recording…'}
      </div>
      <button className="vc-btn" onClick={stopCapture}>
        {listening ? 'Stop' : 'Stop & save'}
      </button>
    </div>
  );
}

function ViewingBody({ state }: { state: VoiceCommentsState }) {
  const anchored = new Set(state.anchoredIds);
  const notePath = state.notePath ?? '';
  if (state.comments.length === 0) {
    return <div className="vc-body">
      <div className="vc-empty">No voice comments on this note yet.</div>
    </div>;
  }
  // Focused first, then the rest in file order; orphans keep their place but are
  // flagged so a transcript whose anchor was edited away is never lost.
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
          notePath={notePath}
          focused={c.id === state.focusId}
          orphaned={!anchored.has(c.id)}
        />
      ))}
    </div>
  );
}
