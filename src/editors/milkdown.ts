/**
 * milkdown.ts — the Milkdown/Crepe WYSIWYG adapter (recipe in ./README.md).
 *
 * Loaded ONLY via a dynamic import from EditorHost's wysiwyg AdapterFactory
 * (invariant I8): importing this module pulls the whole @milkdown/crepe chunk
 * plus its theme CSS, so startup must never touch it. The two CSS imports below
 * therefore ride along in this lazy chunk — never in the entry bundle.
 *
 * Like CM6 this is a projection of the DocModel (I1), but WYSIWYG editors
 * NORMALIZE markdown, so the write-back rule is stricter (I2): serialization is
 * pushed into the model ONLY after a genuine user edit since attach. Merely
 * opening a note in rich mode and switching back must be byte-identical. That
 * guarantee is enforced by the write-back guard (core/mode-sync.ts) fed at the
 * ProseMirror transaction level — see "the transaction-tagging pattern" below.
 */

import { Crepe } from '@milkdown/crepe';
import {
  editorViewCtx,
  editorViewOptionsCtx,
  nodeViewCtx,
  parserCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import type { DocModel } from '../core/doc-model';
import { imageMimeType, localImageToInline } from '../core/images';
import { createWritebackGuard, type EditorAdapter, type WritebackGuard } from '../core/mode-sync';
import { dirName } from '../core/session/plan-flush';
import { ipc } from '../ipc/commands';
import { markdownNormalizes, shouldShowNormalizationHint } from './wysiwyg-normalize';
import { imageFilesFromDataTransfer, readImageFile } from './image-paste';
import '@milkdown/crepe/theme/common/style.css';
import '../styles/wysiwyg.css';

/**
 * Transaction meta flag marking content WE set (initial load, model→editor
 * sync). Such transactions change the doc but are not user edits, so the guard
 * must ignore them — otherwise opening a doc in rich mode would immediately
 * normalize it.
 */
const PROGRAMMATIC_META = 'md-notepad-programmatic';

export interface MilkdownOptions {
  /**
   * Called once per tab when entering rich mode WOULD reformat the current
   * markdown (content preserved). EditorHost surfaces the status-bar hint.
   */
  onNormalizationHint?: () => void;
  /**
   * Save a pasted image and return how to reference it (alt + src), or null on
   * failure. When set, a paste carrying image files is intercepted and an image
   * node inserted at the caret instead of the raw bytes.
   */
  saveImage?: (data: {
    base64: string;
    ext: string;
    name: string | null;
  }) => Promise<{ alt: string; src: string } | null>;
  /**
   * Current path of the document being edited (or null when unsaved). Used to
   * resolve RELATIVE image references so they can be read off disk and shown
   * inline — the app CSP blocks loading a local file by path, so a raw `<img>`
   * would otherwise render broken. A getter, not a value: a note tab is assigned
   * its path AFTER it first opens, and a rename can move it later.
   */
  getDocPath?: () => string | null;
}

/**
 * ProseMirror node view for the `image` node that shows local images inline.
 * It resolves the node's (relative or local) `src` to a data URL read off disk
 * and puts THAT on the DOM `<img>`, while never touching `node.attrs.src` — so
 * serialization (I2 write-back) still emits the original path, not a giant data
 * URL. Being a leaf node view, ProseMirror ignores our async `src` mutation
 * (its default `ignoreMutation`), so the swap can't echo back into the doc.
 *
 * `cache` is the adapter-lifetime abs-path → data-URL map (one disk read per
 * image); `getDocPath` supplies the directory relative refs resolve against.
 */
function createImageNodeView(
  node: ProseNode,
  cache: Map<string, string>,
  getDocPath: () => string | null,
): NodeView {
  const img = document.createElement('img');

  function apply(n: ProseNode): void {
    const alt = (n.attrs.alt as string) ?? '';
    const title = (n.attrs.title as string) ?? '';
    const raw = (n.attrs.src as string) ?? '';
    img.alt = alt;
    if (title) {
      img.title = title;
    } else {
      img.removeAttribute('title');
    }
    // Tag the element with the src it currently WANTS, so a slow disk read that
    // resolves after the node was edited to a different image is discarded.
    img.dataset.mdSrc = raw;
    const docPath = getDocPath();
    const abs = localImageToInline(docPath ? dirName(docPath) : null, raw);
    if (abs === null) {
      // External, already-inlined, or unresolvable — use the src verbatim.
      img.setAttribute('src', raw);
      return;
    }
    const cached = cache.get(abs);
    if (cached !== undefined) {
      img.setAttribute('src', cached);
      return;
    }
    // Blank until the bytes arrive, to avoid a broken-image flash on the path.
    img.removeAttribute('src');
    void ipc
      .readFileBase64(abs)
      .then((b64) => {
        const dataUrl = `data:${imageMimeType(abs)};base64,${b64}`;
        cache.set(abs, dataUrl);
        if (img.dataset.mdSrc === raw) {
          img.setAttribute('src', dataUrl);
        }
      })
      .catch(() => {
        // Missing/unreadable — fall back to the raw path (renders broken, which
        // is the honest signal that the image can't be found).
        if (img.dataset.mdSrc === raw) {
          img.setAttribute('src', raw);
        }
      });
  }

  apply(node);
  return {
    dom: img,
    update(updated: ProseNode): boolean {
      if (updated.type.name !== 'image') {
        return false;
      }
      apply(updated);
      return true;
    },
  };
}

/**
 * Insert an image at the current selection. Uses the schema's inline `image`
 * node (present in Crepe's commonmark preset even with the ImageBlock upload
 * feature disabled); falls back to typing the markdown if that node is ever
 * absent. The dispatch routes through the adapter's dispatchTransaction, so the
 * write-back guard serializes it into the model.
 */
function insertImageNode(view: EditorView, alt: string, src: string): void {
  const { state } = view;
  const imageType = state.schema.nodes.image;
  if (imageType) {
    view.dispatch(state.tr.replaceSelectionWith(imageType.create({ src, alt }), false));
  } else {
    view.dispatch(state.tr.insertText(`![${alt}](${src})`));
  }
}

export function createMilkdownAdapter(options: MilkdownOptions = {}): EditorAdapter {
  let crepe: Crepe | null = null;
  let view: EditorView | null = null;
  let guard: WritebackGuard | null = null;
  let unsubscribe: (() => void) | null = null;
  /** One-time-per-tab hint gate; the adapter instance lives for the tab. */
  let hintShown = false;
  /**
   * Reentrancy flag guarding the model→editor path against our own write-back
   * echo (the guard pushes with source 'milkdown', which re-enters the model
   * subscription synchronously — the doc-model.ts echo-suppression pattern).
   */
  let pushingSelf = false;

  /** Current editor markdown. Empty before create / after destroy. */
  function serialize(): string {
    return crepe ? crepe.getMarkdown() : '';
  }

  /**
   * Replace the whole document from markdown, tagged programmatic so the guard
   * never counts it as a user edit. Used for external model changes (e.g. a
   * file-reload while the tab sits in rich mode).
   */
  function setContentProgrammatic(text: string): void {
    crepe?.editor.action((ctx) => {
      const v = ctx.get(editorViewCtx);
      const doc = ctx.get(parserCtx)(text);
      if (!doc) {
        return;
      }
      const tr = v.state.tr.replace(0, v.state.doc.content.size, new Slice(doc.content, 0, 0));
      tr.setMeta(PROGRAMMATIC_META, true);
      v.dispatch(tr);
    });
  }

  async function attach(host: HTMLElement, model: DocModel): Promise<void> {
    const initialText = model.getText();

    guard = createWritebackGuard({
      serialize,
      push: (text) => {
        pushingSelf = true;
        try {
          model.pushText(text, 'milkdown');
        } finally {
          pushingSelf = false;
        }
      },
    });
    const boundGuard = guard;

    crepe = new Crepe({
      root: host,
      defaultValue: initialText,
      // Trim features that fight the minimal look or are non-goals for v1:
      // no image upload UI, no LaTeX math, no AI, no document top bar. The
      // slash menu / selection toolbar / table UI stay — they're the point.
      features: {
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.TopBar]: false,
      },
    });

    // The transaction-tagging pattern (README "#1 pitfall"): route EVERY
    // ProseMirror transaction through the guard. Milkdown does not set its own
    // dispatchTransaction (it spreads editorViewOptionsCtx into the view), so
    // we own it — which means we must apply the new state ourselves, exactly
    // as ProseMirror's default dispatch would, then report to the guard.
    const imageCache = new Map<string, string>();
    const getDocPath = options.getDocPath ?? (() => null);

    crepe.editor.config((ctx) => {
      // Render local images inline (see createImageNodeView). Registered through
      // nodeViewCtx — Milkdown merges these entries into the view's nodeViews
      // (last wins), so we add `image` without clobbering the node views Crepe's
      // other features register. With the ImageBlock feature off nothing else
      // claims `image`, so ours is the only one.
      const imageEntry: [string, NodeViewConstructor] = [
        'image',
        (imgNode) => createImageNodeView(imgNode, imageCache, getDocPath),
      ];
      ctx.update(nodeViewCtx, (views) => [
        ...views.filter(([name]) => name !== 'image'),
        imageEntry,
      ]);
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        // Intercept a paste carrying image files: save each and insert an image
        // node at the caret (a normal, non-programmatic edit, so the guard
        // writes it back to the model). Non-image pastes fall through.
        handlePaste(v: EditorView, event: ClipboardEvent): boolean {
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
                insertImageNode(v, ref.alt, ref.src);
              }
            }
          })();
          return true;
        },
        dispatchTransaction(tr: Transaction) {
          if (!view) {
            return;
          }
          view.updateState(view.state.apply(tr));
          boundGuard.noteTransaction({
            docChanged: tr.docChanged,
            programmatic: tr.getMeta(PROGRAMMATIC_META) === true,
          });
        },
      }));
    });

    await crepe.create();
    view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));

    // Normalization hint: if parse→serialize of the current text differs, rich
    // mode will reformat syntax on the first edit. Warn once per tab.
    if (!hintShown) {
      const roundTripped = crepe.editor.action((ctx) => {
        const parse = ctx.get(parserCtx);
        const stringify = ctx.get(serializerCtx);
        const doc = parse(initialText);
        return doc ? stringify(doc) : initialText;
      });
      if (shouldShowNormalizationHint(markdownNormalizes(initialText, roundTripped), hintShown)) {
        hintShown = true;
        options.onNormalizationHint?.();
      }
    }

    // Model → editor: apply external changes (not our own write-back echo).
    // Re-parse programmatically so the guard never sees them as user edits.
    unsubscribe = model.subscribe((change) => {
      if (pushingSelf) {
        return;
      }
      if (change.text === serialize()) {
        return;
      }
      setContentProgrammatic(change.text);
    });
  }

  function detach(): void {
    // MUST flush pending write-back BEFORE tearing down (EditorAdapter contract
    // — this is what makes fast mode-toggling lossless). flushSync serializes
    // the current editor state and pushes it while the editor still exists.
    guard?.flushSync();
    guard?.dispose();
    guard = null;
    unsubscribe?.();
    unsubscribe = null;
    view = null;
    // Crepe.destroy is async; we don't await it (detach is sync by contract).
    // The host element is owned by mode-sync/EditorHost, which clears it.
    void crepe?.destroy();
    crepe = null;
  }

  return {
    attach,
    detach,
    focus() {
      view?.focus();
    },
  };
}
