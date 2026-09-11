/**
 * The first-launch offer to download the recommended Whisper model, so
 * offline dictation is ready the first time the microphone is tapped — the
 * nearest thing to "install it with the app" that works the same through
 * every installer (NSIS, DMG, deb, AppImage), keeps the resumable, verified
 * downloader in `whisper-models.ts` as the only way a model file arrives,
 * and never touches the network without a click.
 *
 * Shown once per install (`whisperSetupOffered`), never when a model is
 * already there, never on Android (its default engine needs no download —
 * Settings ▸ Voice notes offers Whisper there). The decision itself is
 * `core/whisper-models.ts` `shouldOfferSetup`; the download is the models
 * store's, and this store only projects "is the bar up" and what its buttons
 * do. Settings keeps install / uninstall / pick exactly as before.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { recommendedModel, shouldOfferSetup } from '../../core/whisper-models';
import { isAndroid } from '../platform';
import { settingsStore } from './settings';
import { whisperModelsStore } from './whisper-models';

/** How long the "ready" line stays up before the bar clears itself. */
const DONE_LINGER_MS = 8_000;

export interface WhisperSetupState {
  /** The bar is on screen (offer, download in flight, or its outcome). */
  visible: boolean;
  /**
   * At boot, after settings are loaded: fetch the model list and decide.
   * Idempotent; a second call while visible does nothing.
   */
  consider: () => Promise<void>;
  /** "Download": mark the offer made and start the recommended model. */
  accept: () => Promise<void>;
  /** "Not now" (or Close after an outcome): mark the offer made and hide. */
  decline: () => void;
}

let lingerTimer: ReturnType<typeof setTimeout> | null = null;

function markOffered(): void {
  if (!settingsStore.getState().settings.whisperSetupOffered) {
    settingsStore.getState().update({ whisperSetupOffered: true });
  }
}

export const whisperSetupStore = createStore<WhisperSetupState>()((set, get) => ({
  visible: false,

  async consider() {
    if (get().visible) {
      return;
    }
    const models = whisperModelsStore.getState();
    if (!models.loaded) {
      await models.refresh();
    }
    const { loaded, models: list } = whisperModelsStore.getState();
    const offered = settingsStore.getState().settings.whisperSetupOffered;
    if (shouldOfferSetup({ offered, android: isAndroid(), loaded, models: list })) {
      set({ visible: true });
    }
  },

  async accept() {
    markOffered();
    await whisperModelsStore.getState().startDownload(recommendedModel());
    // startDownload resolves when the download has ended one way or another;
    // a success lingers so the user sees it worked, then the bar goes away.
    if (whisperModelsStore.getState().download.kind === 'done') {
      if (lingerTimer !== null) {
        clearTimeout(lingerTimer);
      }
      lingerTimer = setTimeout(() => {
        lingerTimer = null;
        set({ visible: false });
      }, DONE_LINGER_MS);
    }
  },

  decline() {
    markOffered();
    if (lingerTimer !== null) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
    set({ visible: false });
  },
}));

export const useWhisperSetup = <T>(selector: (s: WhisperSetupState) => T): T =>
  useStore(whisperSetupStore, selector);
