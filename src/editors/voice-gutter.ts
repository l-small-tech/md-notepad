/**
 * voice-gutter.ts — the CodeMirror gutter that surfaces voice-comment anchors,
 * plus the mobile long-press gesture that starts a new comment.
 *
 * Both concerns are strictly presentational / input-only: the gutter markers are
 * DERIVED from the anchor tokens already in the document (`findAnchors`), and the
 * long-press handler only reports a line number outward. Neither dispatches a
 * document change, so this extension cannot desync the DocModel projection
 * (invariant I1) — it is safe to add to the CM6 `attach` extension list.
 *
 * Marker placement is doc-derived, so it needs no external state: a `<!-- ^cX -->`
 * token in the text IS the "there's a comment on this line" signal. When the
 * anchor is edited away the marker vanishes on the next `docChanged`, and the
 * controller surfaces the now-orphaned transcript separately.
 */

import { gutter, GutterMarker, EditorView } from '@codemirror/view';
import { StateField, RangeSetBuilder, type RangeSet } from '@codemirror/state';
import { findAnchors } from '../core/comments';

/** Callbacks the host (EditorHost) wires into the editor. */
export interface VoiceGutterOptions {
  /** A gutter marker was activated — open the transcript for that line's anchor. */
  onOpen: (id: string, line: number) => void;
  /** A source line was long-pressed (touch) — start a new voice comment there. */
  onLongPress?: (line: number) => void;
  /** Long-press hold duration in ms (default 500). */
  longPressMs?: number;
}

/** The speech-bubble glyph shown in the gutter for an anchored line. */
class VoiceMarker extends GutterMarker {
  toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-voice-marker';
    el.textContent = '💬';
    el.setAttribute('aria-label', 'Voice comment');
    return el;
  }
}

const MARKER = new VoiceMarker();

/**
 * Build the gutter marker set for a document: one marker per anchored line
 * (deduped — several anchors on one line still show a single bubble). Markers
 * are keyed to the line's start offset, which RangeSet requires be ascending.
 */
function buildMarkers(doc: {
  toString(): string;
  lineAt(pos: number): { from: number };
}): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const text = doc.toString();
  let lastLineStart = -1;
  for (const anchor of findAnchors(text)) {
    const lineStart = doc.lineAt(anchor.from).from;
    if (lineStart === lastLineStart) {
      continue; // one bubble per line
    }
    builder.add(lineStart, lineStart, MARKER);
    lastLineStart = lineStart;
  }
  return builder.finish();
}

/** Minimal CSS-variable-driven styling; keeps the gutter self-contained. */
const gutterTheme = EditorView.theme({
  '.cm-voice-gutter': {
    width: '1.4em',
    cursor: 'pointer',
  },
  '.cm-voice-marker': {
    display: 'inline-block',
    width: '100%',
    textAlign: 'center',
    fontSize: '0.85em',
    lineHeight: 'inherit',
    // Sits slightly muted until hovered so it doesn't shout over the text.
    opacity: '0.85',
  },
  '.cm-voice-gutter .cm-gutterElement:hover .cm-voice-marker': {
    opacity: '1',
  },
});

/**
 * The gutter extension. `id`/`line` for the open callback are resolved from the
 * clicked line's first anchor. Returns an extension array to spread into the CM6
 * state's `extensions`.
 */
export function createVoiceGutter(options: VoiceGutterOptions) {
  const markerField = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => buildMarkers(state.doc),
    update: (value, tr) => (tr.docChanged ? buildMarkers(tr.state.doc) : value),
  });

  const openAnchorOnLine = (view: EditorView, lineFrom: number): boolean => {
    const lineNo = view.state.doc.lineAt(lineFrom).number;
    const lineText = view.state.doc.line(lineNo).text;
    const anchors = findAnchors(view.state.doc.toString()).filter(
      (a) => view.state.doc.lineAt(a.from).number === lineNo,
    );
    if (anchors.length === 0 || lineText === undefined) {
      return false;
    }
    options.onOpen(anchors[0]!.id, lineNo);
    return true;
  };

  const voiceGutter = gutter({
    class: 'cm-voice-gutter',
    markers: (view) => view.state.field(markerField),
    // Reserve a constant column width so anchoring a line never shifts text.
    initialSpacer: () => MARKER,
    domEventHandlers: {
      mousedown: (view, line) => openAnchorOnLine(view, line.from),
    },
  });

  return [markerField, voiceGutter, gutterTheme, longPressHandler(options)];
}

/**
 * Touch long-press on the editor content: a `pointerdown` starts a hold timer;
 * moving beyond a small threshold or lifting early cancels it. When it fires we
 * resolve the line under the initial point and report it. Mouse/pen input is
 * ignored so desktop selection is untouched — desktop adds comments via the
 * ribbon instead.
 */
function longPressHandler(options: VoiceGutterOptions) {
  const holdMs = options.longPressMs ?? 500;
  const MOVE_CANCEL_PX = 10;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return EditorView.domEventHandlers({
    pointerdown(event, view) {
      if (event.pointerType !== 'touch' || !options.onLongPress) {
        return false;
      }
      startX = event.clientX;
      startY = event.clientY;
      clear();
      timer = setTimeout(() => {
        timer = null;
        // The view may have been destroyed mid-hold; touching a dead view throws.
        if (!view.dom.isConnected) {
          return;
        }
        const pos = view.posAtCoords({ x: startX, y: startY });
        if (pos === null) {
          return;
        }
        options.onLongPress!(view.state.doc.lineAt(pos).number);
      }, holdMs);
      return false; // don't preempt CM6's own touch handling
    },
    pointermove(event) {
      if (timer === null) {
        return false;
      }
      if (
        Math.abs(event.clientX - startX) > MOVE_CANCEL_PX ||
        Math.abs(event.clientY - startY) > MOVE_CANCEL_PX
      ) {
        clear();
      }
      return false;
    },
    pointerup() {
      clear();
      return false;
    },
    pointercancel() {
      clear();
      return false;
    },
    pointerleave() {
      clear();
      return false;
    },
  });
}
