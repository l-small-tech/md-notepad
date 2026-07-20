/**
 * Mode switching without data loss — the hardest pattern in this app.
 * Read this file together with its tests (__tests__/mode-sync.test.ts)
 * before touching any editor code.
 *
 * The problem: WYSIWYG editors NORMALIZE markdown. Parsing a document into
 * Milkdown and serializing it straight back can change list markers,
 * whitespace, emphasis characters — even if the user typed nothing. If mode
 * switches naively round-tripped the text, merely LOOKING at a note in
 * WYSIWYG would rewrite it and mark it dirty.
 *
 * The solution has two parts:
 *
 * 1. The write-back guard (`createWritebackGuard`): Milkdown's serialization
 *    is pushed into the DocModel only after a genuine user edit since attach
 *    (`docChanged && !programmatic`). Mount → look around → switch back is
 *    byte-identical. The first real keystroke makes Milkdown's serialization
 *    canonical — whole-document normalization is ACCEPTED at that point
 *    (documented decision; diff-based partial write-back was rejected as
 *    fragile, remark position info does not survive ProseMirror editing).
 *
 * 2. The mode-switch state machine (`createModeSync`):
 *    - raw ⇄ split share one source editor; switching only toggles the
 *      preview pane (a UI concern), the editor is never re-mounted.
 *    - {raw,split} → wysiwyg loads the (lazy) adapter FIRST, then detaches
 *      the source editor, then attaches. A load/parse failure reverts to the
 *      previous mode with the canonical text untouched.
 *    - `detach()` must synchronously flush any pending write-back — that
 *      guarantee is what makes fast mode-toggling lossless.
 *    - Transitions are serialized through a promise chain; concurrent
 *      setMode calls cannot interleave.
 *
 * Known, accepted limitation: undo history is per-editor and is lost across
 * raw ⇄ wysiwyg switches (industry norm for dual-mode markdown editors).
 */

import type { DocModel } from './doc-model';
import type { EditorMode } from './types';

/**
 * Contract every editor implements (CM6 in M1, Milkdown/Crepe in M5 — see
 * src/editors/README.md). Adapters must survive attach → detach → attach
 * cycles: a failed switch re-attaches the previous adapter.
 */
export interface EditorAdapter {
  attach(host: HTMLElement, model: DocModel): void | Promise<void>;
  /** MUST synchronously flush any pending write-back before tearing down. */
  detach(): void;
  focus(): void;
  /**
   * Scroll the given 1-based source line into view (outline jump). Optional:
   * source editors (CM6) implement it; rendered editors have no line concept.
   */
  revealLine?(line: number): void;
  /**
   * Scroll the nth rendered heading (0-based, document order) into view.
   * Optional: rendered editors (Milkdown) implement it.
   */
  revealHeading?(index: number): void;
}

/** Factories may lazy-import their chunk (invariant I8: milkdown loads on demand). */
export type AdapterFactory = () => EditorAdapter | Promise<EditorAdapter>;

type AdapterKind = 'source' | 'wysiwyg';

export interface ModeSyncOptions {
  model: DocModel;
  host: HTMLElement;
  initialMode: EditorMode;
  adapters: Record<AdapterKind, AdapterFactory>;
  /** A switch failed (chunk load or parse error); mode was reverted. UI shows a toast. */
  onError?: (error: unknown, failedMode: EditorMode) => void;
}

export interface ModeSync {
  getMode(): EditorMode;
  /** Resolves when this transition (and everything queued before it) settled. */
  setMode(mode: EditorMode): Promise<void>;
  /** Resolves once the initial attach finished. */
  whenIdle(): Promise<void>;
  focus(): void;
  /**
   * The currently attached adapter, or null mid-transition. Optional so store
   * tests can keep stubbing ModeSync with the five core members.
   */
  getActiveAdapter?(): EditorAdapter | null;
  /** Detach the active editor (flushing write-back). The instance is dead afterwards. */
  dispose(): Promise<void>;
}

function kindFor(mode: EditorMode): AdapterKind {
  return mode === 'wysiwyg' ? 'wysiwyg' : 'source';
}

export function createModeSync(options: ModeSyncOptions): ModeSync {
  let mode = options.initialMode;
  let active: EditorAdapter | null = null;
  let disposed = false;
  /** Serializes ALL attach/detach work. Never rejects — errors are reported via onError. */
  let chain: Promise<void> = Promise.resolve();
  const instances = new Map<AdapterKind, EditorAdapter>();

  async function adapterFor(kind: AdapterKind): Promise<EditorAdapter> {
    const existing = instances.get(kind);
    if (existing) {
      return existing;
    }
    const created = await options.adapters[kind]();
    instances.set(kind, created);
    return created;
  }

  // Initial attach is transition #1 on the chain.
  chain = chain.then(async () => {
    try {
      const first = await adapterFor(kindFor(mode));
      await first.attach(options.host, options.model);
      active = first;
    } catch (error) {
      options.onError?.(error, mode);
    }
  });

  function enqueueTransition(target: EditorMode): Promise<void> {
    chain = chain.then(async () => {
      if (disposed || target === mode) {
        return;
      }
      if (kindFor(target) === kindFor(mode)) {
        // raw ⇄ split: same editor stays attached; the preview pane is the
        // UI's business. Nothing can fail here.
        mode = target;
        return;
      }

      const previous = active;
      const previousMode = mode;
      try {
        // Load/create the next adapter BEFORE detaching the current one, so
        // a failed lazy import leaves the user exactly where they were.
        const next = await adapterFor(kindFor(target));
        if (previous) {
          previous.detach(); // flushes pending write-back synchronously
        }
        active = null;
        await next.attach(options.host, options.model); // may parse; may throw
        active = next;
        mode = target;
      } catch (error) {
        // Revert. If we already detached the previous editor, re-attach it —
        // adapters are required to support re-attach.
        if (active === null && previous) {
          try {
            await previous.attach(options.host, options.model);
            active = previous;
          } catch {
            // Host is left empty; the UI's error surface owns recovery.
          }
        }
        mode = previousMode;
        options.onError?.(error, target);
      }
    });
    return chain;
  }

  return {
    getMode: () => mode,
    setMode: (target) => enqueueTransition(target),
    whenIdle: () => chain,
    focus: () => active?.focus(),
    getActiveAdapter: () => active,
    dispose() {
      chain = chain.then(() => {
        disposed = true;
        active?.detach();
        active = null;
      });
      return chain;
    },
  };
}

/* ------------------------------------------------------------------------ */

export interface WritebackGuardOptions {
  /** Milkdown → markdown, for the CURRENT editor state. */
  serialize: () => string;
  /** Push into the DocModel (adapter tags it with source 'milkdown'). */
  push: (text: string) => void;
  /** Serialization debounce while typing. Default 150ms. */
  debounceMs?: number;
}

export interface WritebackGuard {
  /**
   * Feed every editor transaction through this. `programmatic` marks
   * transactions the adapter itself caused (initial setContent, model→editor
   * sync) — those must NEVER count as user edits, or opening a doc in
   * WYSIWYG would immediately normalize it.
   */
  noteTransaction(info: { docChanged: boolean; programmatic: boolean }): void;
  /** Serialize + push immediately if anything is pending. Called by detach(). */
  flushSync(): void;
  hasUserEdit(): boolean;
  dispose(): void;
}

export function createWritebackGuard(options: WritebackGuardOptions): WritebackGuard {
  const debounceMs = options.debounceMs ?? 150;
  let userEdited = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush() {
    clearTimer();
    if (!pending) {
      return;
    }
    pending = false;
    options.push(options.serialize());
  }

  return {
    noteTransaction({ docChanged, programmatic }) {
      if (!docChanged || programmatic) {
        return;
      }
      userEdited = true;
      pending = true;
      clearTimer();
      timer = setTimeout(flush, debounceMs);
    },
    flushSync: flush,
    hasUserEdit: () => userEdited,
    dispose() {
      clearTimer();
      pending = false;
    },
  };
}
