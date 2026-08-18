/**
 * The pending external link — one clicked `http(s)` URL waiting for the user
 * to confirm it should open in the system browser. Transient, never persisted
 * (same contract as uiStore's overlays).
 *
 * A confirmation step exists because the destination of a markdown link is
 * invisible until you click it: the label can say anything, and the app itself
 * can never show the page (the webview must not navigate — see
 * `core/external-links.ts`). The prompt is the one moment the real host is on
 * screen before anything leaves the app.
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { uiStore } from './ui';

/** A prompt nobody answers clears itself rather than sitting there forever. */
const AUTO_DISMISS_MS = 15_000;

export interface ExternalLinkState {
  /** The URL awaiting confirmation, or null when no prompt is showing. */
  pending: string | null;
  /** A link was clicked: show the prompt. Replaces any prompt already up. */
  request: (url: string) => void;
  /** Confirmed — hand the URL to the OS browser and dismiss the prompt. */
  openPending: () => void;
  dismiss: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearDismissTimer(): void {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

export const externalLinkStore = createStore<ExternalLinkState>()((set, get) => ({
  pending: null,

  request(url) {
    clearDismissTimer();
    set({ pending: url });
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      set({ pending: null });
    }, AUTO_DISMISS_MS);
  },

  openPending() {
    const url = get().pending;
    clearDismissTimer();
    set({ pending: null });
    if (url === null) {
      return;
    }
    void openUrl(url).catch(() => {
      uiStore.getState().showNotice(`Could not open ${url}`);
    });
  },

  dismiss() {
    clearDismissTimer();
    set({ pending: null });
  },
}));

export const useExternalLink = <T>(selector: (s: ExternalLinkState) => T): T =>
  useStore(externalLinkStore, selector);
