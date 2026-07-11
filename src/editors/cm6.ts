/**
 * cm6.ts — the CodeMirror 6 source editor adapter (recipe in ./README.md).
 *
 * Used by both `raw` and `split` modes; mode-sync never re-creates it when
 * toggling between them. The adapter is a projection of the DocModel
 * (invariant I1): editor edits push into the model, model changes from
 * elsewhere (file reload, WYSIWYG write-back) are applied back with a single
 * transaction. Echo is suppressed with the reentrancy-flag pattern from
 * doc-model.ts's header.
 *
 * Theming is deliberately CSS-variable driven: the base theme and the syntax
 * HighlightStyle reference `var(--fg)`, `var(--accent)`, … from base.css, so
 * a light/dark flip (which only rewrites `data-theme` on <html>) restyles the
 * editor with zero reconfiguration — no cross-layer coupling to the settings
 * store. The theme/font/wrap Compartments exist as the reconfiguration hooks
 * M6 will drive (font size and word wrap), and to keep the recipe's shape.
 */

import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { DocModel } from '../core/doc-model';
import type { EditorAdapter } from '../core/mode-sync';
import type { CursorPos } from '../core/types';
import { imageFilesFromDataTransfer, readImageFile } from './image-paste';

export interface Cm6Options {
  /**
   * Reports the caret on doc, selection, or focus changes. `line`/`col` drive
   * the status bar; `anchor`/`head` are the document offsets the session
   * flusher persists (and restores via `initialSelection`).
   */
  onSelection?: (pos: { line: number; col: number; anchor: number; head: number }) => void;
  /** Initial soft-wrap state (M6 toggles it via `setWordWrap`). */
  wordWrap?: boolean;
  /** Caret to restore on attach (from the persisted session). Clamped to length. */
  initialSelection?: CursorPos;
  /**
   * Save a pasted image and return how to reference it (alt + src), or null on
   * failure. When set, a paste carrying image files is intercepted and the
   * reference inserted at the caret instead of the raw bytes.
   */
  saveImage?: (data: {
    base64: string;
    ext: string;
    name: string | null;
  }) => Promise<{ alt: string; src: string } | null>;
}

/** Ribbon formatting actions the adapter can apply to the current selection. */
export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'heading'
  | 'quote'
  | 'bulletList'
  | 'orderedList'
  | 'link';

/** The concrete adapter type — superset of EditorAdapter with M2/M6 hooks. */
export interface Cm6Adapter extends EditorAdapter {
  getSelection(): CursorPos;
  setSelection(anchor: number, head: number): void;
  setWordWrap(on: boolean): void;
  setFontSize(px: number): void;
  /** Apply a ribbon formatting action to the current selection/line, then refocus. */
  format(action: FormatAction): void;
  /** Insert a file/image reference at the caret (from the ribbon's link pickers). */
  insertLinkTo(label: string, url: string, image: boolean): void;
}

/** Colors come from CSS variables so themes switch without touching CM6. */
const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--accent)' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.monospace, tags.content], color: 'var(--fg)' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: [tags.list, tags.quote], color: 'var(--fg-muted)' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--fg-muted)' },
  { tag: tags.keyword, color: 'var(--accent)' },
]);

const baseTheme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    // Slightly distinct from the chrome (ribbon / active tab) so the writing
    // surface reads as its own recessed panel — falls back to --bg pre-JS.
    backgroundColor: 'var(--editor-bg, var(--bg))',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--fg)',
    padding: '10px 12px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-alt)',
    color: 'var(--fg)',
    borderColor: 'var(--border)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-textfield': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
  },
  '.cm-button': {
    backgroundColor: 'var(--bg-hover)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    backgroundImage: 'none',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--selection)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)' },
});

function fontSizeTheme(fontSize: string) {
  return EditorView.theme({ '.cm-content': { fontSize }, '.cm-gutters': { fontSize } });
}

/**
 * Toggle an inline markdown wrapper (`**` / `*`) around the main selection.
 * Recognises markers already present just inside or just outside the selection
 * and strips them, so the ribbon button is a true toggle. With no selection it
 * drops an empty pair and parks the caret between the markers.
 */
function toggleInlineWrap(view: EditorView, marker: string): void {
  const { state } = view;
  const range = state.selection.main;
  const doc = state.doc;
  const len = marker.length;

  const selected = doc.sliceString(range.from, range.to);
  if (selected.length >= 2 * len && selected.startsWith(marker) && selected.endsWith(marker)) {
    // Markers sit inside the selection — unwrap.
    const inner = selected.slice(len, selected.length - len);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: inner },
      selection: { anchor: range.from, head: range.from + inner.length },
    });
    return;
  }

  const before = doc.sliceString(Math.max(0, range.from - len), range.from);
  const after = doc.sliceString(range.to, Math.min(doc.length, range.to + len));
  if (before === marker && after === marker) {
    // Markers hug the selection on the outside — strip them.
    view.dispatch({
      changes: [
        { from: range.from - len, to: range.from },
        { from: range.to, to: range.to + len },
      ],
      selection: { anchor: range.from - len, head: range.to - len },
    });
    return;
  }

  if (range.empty) {
    view.dispatch({
      changes: { from: range.from, insert: marker + marker },
      selection: { anchor: range.from + len },
    });
    return;
  }
  view.dispatch({
    changes: [
      { from: range.from, insert: marker },
      { from: range.to, insert: marker },
    ],
    selection: { anchor: range.from + len, head: range.to + len },
  });
}

/**
 * Cycle the heading level of the caret's line: none → # → ## → ### → none.
 * The caret rides through the prefix change (default selection mapping).
 */
function cycleHeading(view: EditorView): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const match = /^(#{1,6})\s+/.exec(line.text);
  let insert: string;
  let to = line.from;
  if (match) {
    const level = match[1]!.length;
    to = line.from + match[0].length;
    insert = level >= 3 ? '' : `${'#'.repeat(level + 1)} `;
  } else {
    insert = '# ';
  }
  // Map the caret FORWARD through the change (assoc 1) so a caret sitting at
  // the line start rides to the far side of an inserted `# ` prefix rather
  // than being stranded before it.
  const changes = state.changes({ from: line.from, to, insert });
  view.dispatch({ changes, selection: state.selection.map(changes, 1) });
}

/**
 * Toggle a line-level markdown prefix across every line the selection spans.
 * If all spanned lines already carry the prefix it is stripped; otherwise it
 * is added to the lines that lack it. `prefixFor` receives the running ordinal
 * so ordered lists can number 1., 2., 3., …
 */
function toggleLinePrefix(
  view: EditorView,
  detect: RegExp,
  prefixFor: (ordinal: number) => string,
): void {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);

  const lines = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    lines.push(state.doc.line(n));
  }
  const allPrefixed = lines.every((line) => detect.test(line.text));

  const changes = [];
  let ordinal = 0;
  for (const line of lines) {
    const match = detect.exec(line.text);
    if (allPrefixed && match) {
      changes.push({ from: line.from, to: line.from + match[0].length });
    } else if (!allPrefixed && !match) {
      ordinal += 1;
      changes.push({ from: line.from, insert: prefixFor(ordinal) });
    }
  }
  if (changes.length > 0) {
    // Bind the caret to the RIGHT of the inserted prefix (assoc 1). Without
    // this, clicking "bullet list" on a line drops the caret behind the dash
    // (`|- text`), so the next keystroke lands in the wrong place; assoc 1
    // parks it after `- ` where typing continues the item.
    const changeSet = state.changes(changes);
    view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, 1) });
  }
}

/**
 * Wrap the selection as a markdown link, `[text](url)`, and leave `url`
 * selected so the user can type the destination immediately. With no selection
 * a `text` placeholder is inserted and left selected instead.
 */
function insertLink(view: EditorView): void {
  const { state } = view;
  const range = state.selection.main;
  const label = state.doc.sliceString(range.from, range.to) || 'text';
  const snippet = `[${label}](url)`;
  const urlFrom = range.from + label.length + 3; // past `[label](`
  const selection = range.empty
    ? { anchor: range.from + 1, head: range.from + 1 + label.length } // select the placeholder label
    : { anchor: urlFrom, head: urlFrom + 3 }; // select `url`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: snippet },
    selection,
  });
}

/**
 * Insert a link (`[label](url)`) or image (`![label](url)`) reference at the
 * caret, replacing any selection with the reference and leaving the caret just
 * past it. A `url` containing whitespace is wrapped in angle brackets so the
 * markdown destination stays valid (CommonMark `<…>` form).
 */
function insertReference(view: EditorView, label: string, url: string, image: boolean): void {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.doc.sliceString(range.from, range.to);
  const finalLabel = selected || label;
  const dest = /\s/.test(url) ? `<${url}>` : url;
  const snippet = `${image ? '!' : ''}[${finalLabel}](${dest})`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: snippet },
    selection: { anchor: range.from + snippet.length },
  });
  view.focus();
}

function applyFormat(view: EditorView, action: FormatAction): void {
  switch (action) {
    case 'bold':
      toggleInlineWrap(view, '**');
      break;
    case 'italic':
      toggleInlineWrap(view, '*');
      break;
    case 'strikethrough':
      toggleInlineWrap(view, '~~');
      break;
    case 'code':
      toggleInlineWrap(view, '`');
      break;
    case 'heading':
      cycleHeading(view);
      break;
    case 'quote':
      toggleLinePrefix(view, /^> /, () => '> ');
      break;
    case 'bulletList':
      toggleLinePrefix(view, /^- /, () => '- ');
      break;
    case 'orderedList':
      toggleLinePrefix(view, /^\d+\. /, (n) => `${n}. `);
      break;
    case 'link':
      insertLink(view);
      break;
  }
  view.focus();
}

export function createCm6Adapter(options: Cm6Options = {}): Cm6Adapter {
  const wrapCompartment = new Compartment();
  const fontSizeCompartment = new Compartment();
  const themeCompartment = new Compartment();

  let view: EditorView | null = null;
  let unsubscribe: (() => void) | null = null;
  // Current word-wrap state, kept in a mutable var (not just the attach
  // options) so `setWordWrap` toggles persist across a detach → re-attach
  // cycle — e.g. toggling wrap while in wysiwyg mode, then switching back to
  // raw must show the new value, not the creation-time one.
  let wordWrap = options.wordWrap !== false;
  // Reentrancy flags: `pushingSelf` guards the model→editor path against our
  // own echo; `applyingExternal` guards the editor→model path against changes
  // we are pushing INTO the editor from the model.
  let pushingSelf = false;
  let applyingExternal = false;

  function reportSelection() {
    if (!view || !options.onSelection) {
      return;
    }
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    options.onSelection({
      line: line.number,
      col: sel.head - line.from + 1,
      anchor: sel.anchor,
      head: sel.head,
    });
  }

  // Intercept a paste that carries image files: save each via options.saveImage
  // and insert the returned reference at the caret. A paste with no image files
  // (or no saveImage wired) falls through to CM6's normal text paste.
  const imagePasteHandler = EditorView.domEventHandlers({
    paste(event, view) {
      if (!options.saveImage) {
        return false;
      }
      const files = imageFilesFromDataTransfer(event.clipboardData);
      if (files.length === 0) {
        return false;
      }
      event.preventDefault();
      void (async () => {
        for (const file of files) {
          const ref = await options.saveImage!(await readImageFile(file));
          if (ref) {
            insertReference(view, ref.alt, ref.src, true);
          }
        }
      })();
      return true;
    },
  });

  function attach(host: HTMLElement, model: DocModel): void {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternal) {
        pushingSelf = true;
        try {
          model.pushText(update.state.doc.toString(), 'cm6');
        } finally {
          pushingSelf = false;
        }
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        reportSelection();
      }
    });

    const docText = model.getText();
    // Clamp a restored caret to the current document — the note file could
    // have shrunk on disk since the selection was saved.
    const initial = options.initialSelection;
    const selection = initial
      ? {
          anchor: Math.min(initial.anchor, docText.length),
          head: Math.min(initial.head, docText.length),
        }
      : undefined;

    const state = EditorState.create({
      doc: docText,
      selection,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        markdown({ base: markdownLanguage }),
        search({ top: true }),
        imagePasteHandler,
        themeCompartment.of([baseTheme, syntaxHighlighting(highlightStyle)]),
        // Font size defaults to the CSS variable so M1 needs no wiring; M6's
        // setFontSize reconfigures this compartment to an explicit px value.
        fontSizeCompartment.of(fontSizeTheme('var(--editor-font-size, 14px)')),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'off' }),
        updateListener,
      ],
    });

    view = new EditorView({ state, parent: host });

    // Model → editor: apply external changes (not our own echo) as one
    // transaction so scroll/cursor survive; never recreate the view.
    unsubscribe = model.subscribe((change) => {
      if (pushingSelf || !view) {
        return;
      }
      if (change.text === view.state.doc.toString()) {
        return;
      }
      applyingExternal = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: change.text },
        });
      } finally {
        applyingExternal = false;
      }
    });

    reportSelection();
  }

  function detach(): void {
    // CM6 pushes synchronously on every edit, so there is no deferred
    // write-back to flush here — the detach contract is trivially met.
    unsubscribe?.();
    unsubscribe = null;
    view?.destroy();
    view = null;
  }

  return {
    attach,
    detach,
    focus() {
      view?.focus();
    },
    getSelection() {
      const sel = view?.state.selection.main;
      return { anchor: sel?.anchor ?? 0, head: sel?.head ?? 0 };
    },
    setSelection(anchor, head) {
      if (!view) {
        return;
      }
      const max = view.state.doc.length;
      view.dispatch({
        selection: { anchor: Math.min(anchor, max), head: Math.min(head, max) },
        scrollIntoView: true,
      });
    },
    setWordWrap(on) {
      wordWrap = on;
      view?.dispatch({
        effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []),
      });
    },
    setFontSize(px) {
      view?.dispatch({
        effects: fontSizeCompartment.reconfigure(fontSizeTheme(`${px}px`)),
      });
    },
    format(action) {
      if (view) {
        applyFormat(view, action);
      }
    },
    insertLinkTo(label, url, image) {
      if (view) {
        insertReference(view, label, url, image);
      }
    },
  };
}
