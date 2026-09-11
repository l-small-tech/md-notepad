/**
 * The Whisper model list behind Settings ▸ Voice notes: what is installed,
 * the one download in flight (with progress), the folder it all lives in,
 * what an earlier version left behind, and which accelerator the machine has.
 *
 * A thin projection over the `whisper_*` commands: the manifest and the
 * on-disk truth are Rust's, the download state machine is core's
 * (`downloadReducer`), and this store only sequences the calls so the
 * dialog stays a projection. `refresh()` is fire-and-forget and cheap — the
 * dialog calls it on open and after every download or delete, and the
 * first-launch offer (`whisper-setup.ts`) calls it once at boot.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  downloadReducer,
  IDLE_DOWNLOAD,
  type DownloadAction,
  type DownloadState,
  type WhisperAccelerator,
  type WhisperModelStatus,
} from '../../core/whisper-models';
import { createWhisperChannel, ipc, IpcError } from '../../ipc/commands';
import { openPath } from '@tauri-apps/plugin-opener';
import { uiStore } from './ui';

export interface WhisperModelsState {
  models: WhisperModelStatus[];
  /** The first `refresh()` has answered (the list can say "nothing installed" honestly). */
  loaded: boolean;
  /** `<appData>/whisper`, once asked for. */
  dir: string | null;
  /** Bytes of model files an earlier version downloaded that are no longer offered. */
  strayBytes: number;
  /** What the machine can run the model on; null until the first refresh answers. */
  accelerator: WhisperAccelerator | null;
  download: DownloadState;
  refresh: () => Promise<void>;
  /** Delete the stray files. */
  prune: () => Promise<void>;
  /** Download (or resume) one model. A no-op while another download runs. */
  startDownload: (id: string) => Promise<void>;
  cancelDownload: () => void;
  /** Delete a model file (and any partial download). */
  remove: (id: string) => Promise<void>;
  /** Clear a finished/failed/cancelled download from the list. */
  dismiss: () => void;
  /** Open the model folder in the system file manager. */
  openFolder: () => Promise<void>;
}

export const whisperModelsStore = createStore<WhisperModelsState>()((set, get) => {
  const dispatch = (action: DownloadAction) =>
    set((s) => ({ download: downloadReducer(s.download, action) }));

  return {
    models: [],
    loaded: false,
    dir: null,
    strayBytes: 0,
    accelerator: null,
    download: IDLE_DOWNLOAD,

    async refresh() {
      try {
        const models = await ipc.whisperModelsList();
        set({ models, loaded: true });
      } catch {
        // A transient failure: keep what we have.
        return;
      }
      // Both are informational; a failure leaves the last answer.
      const [stray, accelerator] = await Promise.all([
        ipc.whisperModelsStray().catch(() => get().strayBytes),
        get().accelerator
          ? Promise.resolve(get().accelerator)
          : ipc.whisperAccelerator().catch(() => null),
      ]);
      set({ strayBytes: stray, accelerator });
    },

    async prune() {
      try {
        await ipc.whisperModelsPrune();
      } catch {
        uiStore.getState().showNotice('Could not remove the old model files.');
      }
      await get().refresh();
    },

    async startDownload(id) {
      if (get().download.kind === 'downloading' || get().download.kind === 'verifying') {
        return;
      }
      dispatch({ type: 'start', id });
      const channel = createWhisperChannel();
      channel.onmessage = (event) => {
        // A late event from a download that is no longer the active one is
        // dropped by the reducer (it only accepts progress while downloading
        // the same id — a new download has a fresh channel).
        const now = get().download;
        if (now.kind === 'idle' || now.id !== id) {
          return;
        }
        if (event.kind === 'progress') {
          dispatch({ type: 'progress', received: event.received, total: event.total });
        } else {
          dispatch({ type: 'verifying' });
        }
      };
      try {
        await ipc.whisperModelDownload(id, channel);
        dispatch({ type: 'done' });
      } catch (e) {
        const code = e instanceof IpcError ? e.code : 'WHISPER_DOWNLOAD_FAILED';
        if (code === 'WHISPER_DOWNLOAD_CANCELLED') {
          dispatch({ type: 'cancelled' });
        } else {
          dispatch({ type: 'failed', code });
        }
      }
      await get().refresh();
    },

    cancelDownload() {
      void ipc.whisperModelCancel().catch(() => {});
    },

    async remove(id) {
      try {
        await ipc.whisperModelDelete(id);
      } catch {
        uiStore.getState().showNotice('Could not delete the model file.');
      }
      await get().refresh();
    },

    dismiss() {
      dispatch({ type: 'reset' });
    },

    async openFolder() {
      try {
        const dir = get().dir ?? (await ipc.whisperModelDir());
        set({ dir });
        await openPath(dir);
      } catch {
        uiStore.getState().showNotice('Could not open the model folder.');
      }
    },
  };
});

export const useWhisperModels = <T>(selector: (s: WhisperModelsState) => T): T =>
  useStore(whisperModelsStore, selector);
