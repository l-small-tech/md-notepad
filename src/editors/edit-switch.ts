/**
 * edit-switch.ts — the ONE adapter mode-sync holds for Edit mode on a markdown
 * tab, in front of the two editors that mode can mean.
 *
 * Edit is Milkdown for a note and the deck editor for a Marp deck, and which
 * of the two a document is depends on its CONTENT (`marp: true` in the
 * frontmatter), which can change under an open tab. mode-sync caches one
 * adapter per kind, so the choice cannot be made in its factory; it is made
 * here, at attach time, and re-made whenever the text crosses the line while
 * Edit is showing — the wrong editor is detached (flushing its write-back, as
 * the contract demands) and the right one attached in its place.
 *
 * Both inner editors stay lazy (invariant I8): a factory runs the first time
 * its editor is actually needed and never before.
 */

import type { AdapterFactory, EditorAdapter } from './adapter';
import type { DocModel } from '../core/doc-model';

export type EditKind = 'markdown' | 'deck';

export interface EditSwitchOptions {
  isDeck: (text: string) => boolean;
  markdown: AdapterFactory;
  deck: AdapterFactory;
}

export interface EditSwitchAdapter extends EditorAdapter {
  /** Which editor is attached right now; null while detached or mid-swap. */
  activeKind(): EditKind | null;
}

export function createEditSwitchAdapter(options: EditSwitchOptions): EditSwitchAdapter {
  const instances = new Map<EditKind, EditorAdapter>();
  let attached: { host: HTMLElement; model: DocModel } | null = null;
  let inner: EditorAdapter | null = null;
  let kind: EditKind | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Serializes swaps; never rejects. */
  let chain: Promise<void> = Promise.resolve();

  async function instance(which: EditKind): Promise<EditorAdapter> {
    let adapter = instances.get(which);
    if (!adapter) {
      adapter = await options[which]();
      instances.set(which, adapter);
    }
    return adapter;
  }

  const kindOf = (model: DocModel): EditKind =>
    options.isDeck(model.getText()) ? 'deck' : 'markdown';

  function queueSwap(): void {
    chain = chain.then(async () => {
      const target = attached;
      if (!target || !inner || kindOf(target.model) === kind) {
        return;
      }
      try {
        const want = kindOf(target.model);
        const next = await instance(want);
        if (attached !== target) {
          return;
        }
        inner.detach(); // flushes; may push, which re-enters `onChange` harmlessly
        inner = null;
        kind = null;
        await next.attach(target.host, target.model);
        if (attached !== target) {
          next.detach();
          return;
        }
        inner = next;
        kind = want;
      } catch (error) {
        console.error('[edit-switch] swap failed', error);
      }
    });
  }

  return {
    async attach(host, model) {
      const target = { host, model };
      attached = target;
      const want = kindOf(model);
      try {
        const next = await instance(want);
        await next.attach(host, model);
        inner = next;
        kind = want;
      } catch (error) {
        attached = null;
        throw error; // mode-sync reverts the switch
      }
      unsubscribe = model.subscribe(() => {
        if (attached === target && kindOf(model) !== kind) {
          queueSwap();
        }
      });
    },
    detach() {
      attached = null;
      unsubscribe?.();
      unsubscribe = null;
      inner?.detach();
      inner = null;
      kind = null;
    },
    focus: () => inner?.focus(),
    revealLine: (line) => inner?.revealLine?.(line),
    revealHeading: (index, place) => inner?.revealHeading?.(index, place),
    activeKind: () => kind,
  };
}
