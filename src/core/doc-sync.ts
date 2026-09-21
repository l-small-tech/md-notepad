/**
 * Doc sync — keeps every open copy of ONE file in step while the user types.
 *
 * The same file may be open in several tabs ("mirrors"): twice in one window
 * (Markdown in one tab, Present/Review/Draw in another) or once in each of
 * several windows. Each tab keeps its own {@link DocModel} (invariant I1 is
 * per tab); this hub is the fan-out layer between them, keyed by the file's
 * path key:
 *
 *   - a local edit is pushed into every sibling model in this window, and —
 *     once another window is known to hold the file — sent to the other
 *     windows as a `text` message (whole text; editors apply it as a minimal
 *     diff, so carets and scroll positions survive);
 *   - a save is announced as `saved`, so every mirror adopts the new on-disk
 *     baseline instead of mistaking a sibling's write for an external change;
 *   - a newly attached copy says `hello`; holders answer `here`, plus their
 *     text when it carries unsaved edits the newcomer could not read off disk.
 *
 * Last writer wins, on whole texts: one person types in one place at a time,
 * so there is nothing to merge. Pure — the transport (Tauri events) and the
 * store wiring live in src/ui/doc-sync.ts.
 */

import type { DocModel } from './doc-model';

export type DocSyncMessage =
  | { type: 'hello'; key: string }
  | { type: 'here'; key: string }
  | { type: 'text'; key: string; text: string }
  | { type: 'saved'; key: string; text: string; mtimeMs: number };

export interface DocSyncPeer {
  /** Tab id — unique within this window. */
  id: string;
  /** Path key of the file the tab is bound to. */
  key: string;
  model: DocModel;
  /** A mirror wrote `text` to the file at `mtimeMs`: adopt it as the baseline. */
  onSaved: (text: string, mtimeMs: number) => void;
}

export interface DocSyncHub {
  /** Start syncing a tab; returns its detach function. */
  attach(peer: DocSyncPeer): () => void;
  /** Feed in a message from ANOTHER window (never this window's own echo). */
  receive(message: DocSyncMessage): void;
  /** Tab `id` just saved (or reloaded) `text` at `mtimeMs`: tell its mirrors. */
  notifySaved(id: string, text: string, mtimeMs: number): void;
  /**
   * Did a MIRROR of `key` hold `text` within the last few seconds? Text found
   * on disk that a mirror held moments ago is that mirror's save racing its
   * own `saved` announcement, not an external change — the conflict probe
   * asks before raising its banner. Deliberately short-lived and blind to
   * unmirrored files: an outside tool restoring an older version (git
   * checkout) must still be noticed.
   */
  knows(key: string, text: string): boolean;
  /** Another local tab bound to `key`, for seeding a new mirror. */
  siblingOf(key: string, exceptId?: string): DocSyncPeer | undefined;
}

/** How many recent texts per file {@link DocSyncHub.knows} remembers. */
export const KNOWN_TEXT_LIMIT = 64;
/** …and for how long: the race it covers is milliseconds wide. */
export const KNOWN_TEXT_TTL_MS = 5000;

/** Length + FNV-1a: cheap, and a collision only ever hides a conflict banner
 *  for a text of identical length — the file's content still wins on reload. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${hash >>> 0}`;
}

export function createDocSyncHub(deps: {
  send: (message: DocSyncMessage) => void;
  now?: () => number;
}): DocSyncHub {
  const now = deps.now ?? (() => Date.now());
  const peers = new Map<string, DocSyncPeer>();
  /** Keys another window is known to hold — only those are worth broadcasting. */
  const remoteKeys = new Set<string>();
  const known = new Map<string, Array<{ print: string; at: number }>>();
  /** True while this hub is pushing into models; their change events are echoes. */
  let applying = false;

  const peersFor = (key: string): DocSyncPeer[] => [...peers.values()].filter((p) => p.key === key);

  const remember = (key: string, text: string): void => {
    const print = fingerprint(text);
    const list = (known.get(key) ?? []).filter((k) => k.print !== print);
    list.unshift({ print, at: now() });
    list.length = Math.min(list.length, KNOWN_TEXT_LIMIT);
    known.set(key, list);
  };

  const pushInto = (targets: DocSyncPeer[], text: string): void => {
    applying = true;
    try {
      for (const peer of targets) {
        peer.model.pushText(text, 'programmatic');
      }
    } finally {
      applying = false;
    }
  };

  return {
    attach(peer) {
      peers.set(peer.id, peer);
      const unsubscribe = peer.model.subscribe((change) => {
        if (applying || peers.get(peer.id) !== peer) {
          return;
        }
        const siblings = peersFor(peer.key).filter((p) => p.id !== peer.id);
        if (siblings.length > 0) {
          remember(peer.key, change.text);
        }
        pushInto(siblings, change.text);
        if (remoteKeys.has(peer.key)) {
          deps.send({ type: 'text', key: peer.key, text: change.text });
        }
      });
      deps.send({ type: 'hello', key: peer.key });
      return () => {
        unsubscribe();
        if (peers.get(peer.id) === peer) {
          peers.delete(peer.id);
        }
      };
    },

    receive(message) {
      const local = peersFor(message.key);
      if (local.length === 0) {
        return;
      }
      remoteKeys.add(message.key);
      switch (message.type) {
        case 'hello': {
          deps.send({ type: 'here', key: message.key });
          // Unsaved edits exist only here — the newcomer read the file off disk.
          const dirty = local.find((p) => p.model.isDirty('file'));
          if (dirty) {
            deps.send({ type: 'text', key: message.key, text: dirty.model.getText() });
          }
          break;
        }
        case 'here':
          break;
        case 'text':
          remember(message.key, message.text);
          pushInto(local, message.text);
          break;
        case 'saved':
          remember(message.key, message.text);
          for (const peer of local) {
            peer.onSaved(message.text, message.mtimeMs);
          }
          break;
      }
    },

    notifySaved(id, text, mtimeMs) {
      const origin = peers.get(id);
      if (!origin) {
        return;
      }
      for (const peer of peersFor(origin.key)) {
        if (peer.id !== id) {
          peer.onSaved(text, mtimeMs);
        }
      }
      if (remoteKeys.has(origin.key)) {
        deps.send({ type: 'saved', key: origin.key, text, mtimeMs });
      }
    },

    knows(key, text) {
      const print = fingerprint(text);
      const since = now() - KNOWN_TEXT_TTL_MS;
      return known.get(key)?.some((k) => k.print === print && k.at >= since) ?? false;
    },

    siblingOf(key, exceptId) {
      return peersFor(key).find((p) => p.id !== exceptId);
    },
  };
}
