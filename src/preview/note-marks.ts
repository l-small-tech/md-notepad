/**
 * note-marks.ts — the review-note marker and its expanded callout, built as
 * DOM for both Review panes (`pane.ts` beside a markdown block, `code-review.ts`
 * in a card's head). Notes are user text, so this builds elements and sets
 * `textContent` rather than assembling HTML.
 *
 * The marker (`.vn-mark`) shows the count; a tap on it is the pane's to
 * handle (it toggles the callout). The callout (`.vn-callout`) lists each
 * note's transcript read-only, with an "Open" button (`[data-vn-open]`) that
 * hands off to the host's sheet, where notes are edited and deleted.
 * Styles: `styles/voice-comments.css`.
 */

import type { VoiceComment } from '../core/comments';

export const MARK_CLASS = 'vn-mark';
export const CALLOUT_CLASS = 'vn-callout';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** "1 review note" / "3 review notes" */
export function markLabel(count: number): string {
  return `${count} review ${count === 1 ? 'note' : 'notes'}`;
}

/**
 * The marker. `tag` is `button` where a real button fits (the markdown pane's
 * margin) and `span` where the marker sits inside another button (a card's
 * head — nested buttons are invalid HTML and Chrome refuses to focus them).
 */
export function buildMark(
  doc: Document,
  count: number,
  expanded: boolean,
  tag: 'button' | 'span' = 'button',
): HTMLElement {
  const mark = doc.createElement(tag);
  mark.className = MARK_CLASS;
  if (tag === 'button') {
    (mark as HTMLButtonElement).type = 'button';
  } else {
    mark.setAttribute('role', 'button');
  }
  mark.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  mark.setAttribute('aria-label', `${markLabel(count)} — ${expanded ? 'hide' : 'show'}`);
  mark.title = `${markLabel(count)} — click to ${expanded ? 'hide' : 'show'}`;
  const icon = doc.createElement('span');
  icon.className = 'vn-mark-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '💬';
  const num = doc.createElement('span');
  num.className = 'vn-mark-count';
  num.textContent = String(count);
  mark.append(icon, num);
  return mark;
}

/** The expanded list of a block's / card's notes. */
export function buildCallout(doc: Document, notes: readonly VoiceComment[]): HTMLElement {
  const callout = doc.createElement('div');
  callout.className = CALLOUT_CLASS;
  callout.setAttribute('role', 'region');
  callout.setAttribute('aria-label', markLabel(notes.length));
  for (const note of notes) {
    const item = doc.createElement('div');
    item.className = 'vn-note';
    const meta = doc.createElement('div');
    meta.className = 'vn-note-meta';
    meta.textContent = [
      note.line !== null ? `Line ${note.line}` : null,
      note.unit ?? null,
      formatTime(note.time),
    ]
      .filter((s): s is string => s !== null)
      .join(' · ');
    const text = doc.createElement('div');
    text.className = 'vn-note-text';
    text.textContent = note.transcript.trim() || '(empty note)';
    item.append(meta, text);
    callout.appendChild(item);
  }
  const open = doc.createElement('button');
  open.type = 'button';
  open.className = 'vn-open';
  open.dataset.vnOpen = '';
  open.textContent = 'Open in Review notes';
  callout.appendChild(open);
  return callout;
}
