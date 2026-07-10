/**
 * DocModel — the single source of truth for one document (invariant I1).
 *
 * The canonical representation is the markdown STRING. Editors (CodeMirror,
 * Milkdown) and the preview are projections of it: they push text in and
 * subscribe to changes, they never hold authoritative state of their own.
 *
 * Echo suppression: subscriptions fire SYNCHRONOUSLY inside `pushText`, so
 * an adapter always hears its own change — DURING its own push, before any
 * "remember what I pushed" bookkeeping after the call could run. The
 * correct filter is therefore a reentrancy flag around the push
 * (see the 'echo suppression' test and src/editors/README.md):
 *
 *   let pushingSelf = false;
 *   model.subscribe((change) => {
 *     if (pushingSelf) return;          // own push echoing back
 *     applyToEditor(change.text);       // someone else changed the doc
 *   });
 *   // in the editor's change handler:
 *   pushingSelf = true;
 *   try { model.pushText(editorText, 'cm6'); } finally { pushingSelf = false; }
 *
 * `pushText` returns the resulting version — useful for assertions and
 * logging, but NOT sufficient for echo suppression by itself, precisely
 * because dispatch happens before the caller can store the returned value.
 *
 * Dirty tracking is a plain string comparison against a snapshot per
 * persistence target. O(n), deliberately: notes are small, and this can
 * never drift the way a boolean flag can. If profiling ever shows this
 * matters, swap the snapshot for length+hash — the interface won't change.
 */

/** Who produced a text change. Adapters use this for policy, not filtering. */
export type TextSource = 'cm6' | 'milkdown' | 'file-load' | 'restore' | 'programmatic';

export interface DocChange {
  text: string;
  version: number;
  source: TextSource;
}

/**
 * 'session' — flushed to the session store (note file / buffer file).
 * 'file'    — explicitly saved to the tab's file (file tabs only).
 */
export type PersistKind = 'session' | 'file';

export interface DocModel {
  getText(): string;
  getVersion(): number;
  /**
   * Replace the canonical text. No-op (returns current version) when `next`
   * is identical — callers may push unconditionally.
   * Returns the version representing the document after this call.
   */
  pushText(next: string, source: TextSource): number;
  subscribe(listener: (change: DocChange) => void): () => void;
  /** Snapshot current text as "persisted" for the given target. */
  markPersisted(kind: PersistKind): void;
  isDirty(kind: PersistKind): boolean;
}

export function createDocModel(initialText: string): DocModel {
  let text = initialText;
  let version = 0;
  const listeners = new Set<(change: DocChange) => void>();
  const persisted: Record<PersistKind, string> = {
    session: initialText,
    file: initialText,
  };

  return {
    getText: () => text,
    getVersion: () => version,

    pushText(next, source) {
      if (next === text) {
        return version;
      }
      text = next;
      version += 1;
      const change: DocChange = { text, version, source };
      // Copy before iterating: a listener may unsubscribe (or subscribe)
      // during dispatch.
      for (const listener of [...listeners]) {
        listener(change);
      }
      return version;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    markPersisted(kind) {
      persisted[kind] = text;
    },

    isDirty(kind) {
      return persisted[kind] !== text;
    },
  };
}
