/**
 * note-marks.ts — the review-note marker and its expanded callout, built as
 * DOM for both Review panes (`pane.ts` beside a markdown block, `code-review.ts`
 * in a card's head). Notes are user text, so this builds elements and sets
 * `textContent` / `value` rather than assembling HTML.
 *
 * The marker (`.vn-mark`) shows the count; a tap on it is the pane's to
 * handle (it toggles the callout). The callout (`.vn-callout`) lists each
 * note the way a word processor's comment thread does: the text is a text
 * box that commits on `change` (`noteEditFromEvent`), a Delete button asks
 * twice (`confirmDelete`), and an "All notes" button (`[data-vn-all]`) hands
 * off to the host's overview. The pane wires the callbacks.
 * Styles: `styles/voice-comments.css`.
 */

import type { VoiceComment } from '../core/comments';

export const MARK_CLASS = 'vn-mark';
export const CALLOUT_CLASS = 'vn-callout';
/** The wrapper a pane inserts for the host's inline composer (a React portal). */
export const COMPOSER_CLASS = 'vn-composer-slot';

/** How long a Delete button stays on "Delete?" before it goes back to Delete. */
export const DELETE_CONFIRM_MS = 3000;

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

/** What the callout can do; a missing callback hides that control. */
export interface CalloutActions {
  edit: boolean;
  remove: boolean;
  all: boolean;
}

/** The expanded list of a block's / card's notes. */
export function buildCallout(
  doc: Document,
  notes: readonly VoiceComment[],
  actions: CalloutActions,
): HTMLElement {
  const callout = doc.createElement('div');
  callout.className = CALLOUT_CLASS;
  callout.setAttribute('role', 'region');
  callout.setAttribute('aria-label', markLabel(notes.length));
  for (const note of notes) {
    const item = doc.createElement('div');
    item.className = 'vn-note';
    item.dataset.vnId = note.id;
    const meta = doc.createElement('div');
    meta.className = 'vn-note-meta';
    const where = doc.createElement('span');
    where.className = 'vn-note-where';
    where.textContent = [note.line !== null ? `Line ${note.line}` : null, note.unit ?? null]
      .filter((s): s is string => s !== null)
      .join(' · ');
    const when = doc.createElement('span');
    when.className = 'vn-note-when';
    when.textContent = formatTime(note.time);
    meta.append(where, when);
    if (actions.remove) {
      const del = doc.createElement('button');
      del.type = 'button';
      del.className = 'vn-delete';
      del.dataset.vnDelete = note.id;
      del.textContent = 'Delete';
      del.setAttribute('aria-label', 'Delete review note');
      meta.appendChild(del);
    }
    const text = doc.createElement('textarea');
    text.className = 'vn-note-text';
    text.dataset.vnId = note.id;
    text.value = note.transcript;
    text.rows = 1;
    text.placeholder = 'Empty note';
    text.setAttribute('aria-label', 'Review note text');
    if (!actions.edit) {
      text.readOnly = true;
    }
    item.append(meta, text);
    callout.appendChild(item);
  }
  if (actions.all) {
    const all = doc.createElement('button');
    all.type = 'button';
    all.className = 'vn-open';
    all.dataset.vnAll = '';
    all.textContent = 'All notes';
    all.title = "Every review note in this document and the workspace's others";
    callout.appendChild(all);
  }
  return callout;
}

/**
 * A `change` event from a callout text box → the note id and its new text,
 * or null for anything else. Committing on `change` (not on every keystroke)
 * keeps the callout still while the reviewer types: the save re-renders it.
 */
export function noteEditFromEvent(event: Event): { id: string; text: string } | null {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains('vn-note-text')) {
    return null;
  }
  const id = target.dataset.vnId;
  return id ? { id, text: target.value } : null;
}

/**
 * Two-step delete: the first tap turns the button into "Delete?" for
 * `DELETE_CONFIRM_MS`; a second tap within that window is the confirmation.
 * Returns true when the delete is confirmed.
 */
export function confirmDelete(button: HTMLElement, win: Pick<Window, 'setTimeout'>): boolean {
  if (button.dataset.confirm !== undefined) {
    return true;
  }
  button.dataset.confirm = '';
  button.textContent = 'Delete?';
  button.setAttribute('aria-label', 'Tap again to delete this review note');
  win.setTimeout(() => {
    if (button.dataset.confirm !== undefined) {
      delete button.dataset.confirm;
      button.textContent = 'Delete';
      button.setAttribute('aria-label', 'Delete review note');
    }
  }, DELETE_CONFIRM_MS);
  return false;
}

/**
 * Size a callout text box to its content (the box grows with the note, so
 * nothing scrolls inside a scrolling document). Called after insertion.
 */
export function fitNoteBoxes(root: ParentNode): void {
  for (const box of root.querySelectorAll<HTMLTextAreaElement>('textarea.vn-note-text')) {
    box.style.height = 'auto';
    if (box.scrollHeight > 0) {
      box.style.height = `${box.scrollHeight}px`;
    }
  }
}
