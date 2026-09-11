/**
 * whisper-models.ts — the pure side of offline (Whisper) voice-note
 * transcription.
 *
 * The model manifest itself (files, sizes, SHA-256 digests) is Rust's
 * (src-tauri/src/commands/whisper/models.rs): it is what downloads and
 * verifies, so it owns the truth. This module holds what the UI needs around
 * that list — the recommended default, size formatting, the download state
 * machine the Settings dialog projects, and the capture limits the controller
 * enforces — with no DOM, Tauri or React (I9).
 */

/** Sample rate Whisper models expect. The capture asks the audio graph for it. */
export const WHISPER_SAMPLE_RATE = 16_000;

/**
 * Longest capture, in seconds. 10 minutes of 16 kHz f32 PCM is ≈ 38 MB in
 * memory and over the IPC — at the cap the capture stops itself and what was
 * said is transcribed, rather than the buffer growing without bound.
 */
export const MAX_CAPTURE_SECONDS = 600;

/**
 * The model a fresh install is pointed at: Small, quantized — 190 MB, the
 * accuracy/speed sweet spot on a CPU and near-instant on a GPU. Every
 * offered model is the q5 quantized file: 2.5-3x smaller than full precision
 * for an accuracy difference no dictation user will notice, so the choice is
 * not offered.
 */
export const RECOMMENDED_WHISPER_MODEL = 'small.en-q5_1';

export function recommendedModel(): string {
  return RECOMMENDED_WHISPER_MODEL;
}

/**
 * Ids an earlier version offered that the manifest no longer has (the
 * full-precision files, and Medium — Large v3 Turbo is the same size,
 * faster and better), mapped to what a setting pointing at one now means.
 * The old files themselves become "stray" (`whisper_models_stray`) and the
 * Settings dialog offers to remove them.
 */
export const LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
  'tiny.en': 'tiny.en-q5_1',
  'base.en': 'base.en-q5_1',
  'small.en': 'small.en-q5_1',
  'medium.en': 'large-v3-turbo-q5_0',
  'medium.en-q5_0': 'large-v3-turbo-q5_0',
  'large-v3-turbo': 'large-v3-turbo-q5_0',
};

/** The current id for a persisted `whisperModel` (an unknown id is left alone). */
export function migrateModelId(id: string): string {
  return LEGACY_MODEL_IDS[id] ?? id;
}

/** One manifest entry joined with its on-disk state (mirrors `ModelStatus` in Rust). */
export interface WhisperModelStatus {
  /** Manifest id, e.g. `small.en` or `medium.en-q5_0`. */
  id: string;
  /** File name under the model folder (`ggml-<id>.bin`). */
  file: string;
  /** Human label, e.g. "Small (English)". */
  label: string;
  /** Download size in bytes. */
  bytes: number;
  /** Detects the spoken language itself; `.en` models are English-only. */
  multilingual: boolean;
  /** The verified file is present. */
  installed: boolean;
  /** Bytes of a partial download waiting to be resumed, or 0. */
  partialBytes: number;
}

/** Is this id installed, per a `whisper_models_list` answer? */
export function isInstalled(models: readonly WhisperModelStatus[], id: string): boolean {
  return models.some((m) => m.id === id && m.installed);
}

/** "466 MB", "1.5 GB", "32 MB" — one decimal only when it changes the reading. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) {
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  }
  const mb = bytes / 1_000_000;
  if (mb >= 1) {
    return `${Math.round(mb)} MB`;
  }
  const kb = bytes / 1000;
  if (kb >= 1) {
    return `${Math.round(kb)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

/**
 * A rough speed hint per model family: how long a 30-second note takes on a
 * 4-core CPU with no GPU, and on an ordinary laptop GPU when one is in use.
 * Informational only — it sets expectations before a 570 MB download,
 * nothing depends on the numbers.
 */
export function speedHint(id: string, gpu = false): string {
  const family = id.split('-q')[0] ?? id;
  switch (family) {
    case 'tiny.en':
      return gpu ? '~1 s per 30 s of speech' : '~2 s per 30 s of speech';
    case 'base.en':
      return gpu ? '~1 s per 30 s of speech' : '~4 s per 30 s of speech';
    case 'small.en':
      return gpu ? '~2 s per 30 s of speech' : '~10 s per 30 s of speech';
    case 'medium.en':
      return gpu ? '~6 s per 30 s of speech' : '~40 s per 30 s of speech';
    case 'large-v3-turbo':
      return gpu ? '~5 s per 30 s of speech' : '~30 s per 30 s of speech';
    default:
      return '';
  }
}

/**
 * The accelerator names `whisper_accelerator` answers with. "none" is a
 * build without a GPU backend (Android) or a Windows machine without a
 * Vulkan driver.
 */
export type WhisperAccelerator = 'vulkan' | 'metal' | 'none';

/** "GPU (Vulkan)", "GPU (Metal)" or "CPU only" — what the Settings row says. */
export function acceleratorLabel(accelerator: WhisperAccelerator, useGpu: boolean): string {
  if (accelerator === 'none') {
    return 'CPU only (no GPU driver found)';
  }
  const name = accelerator === 'vulkan' ? 'Vulkan' : 'Metal';
  return useGpu ? `GPU (${name})` : `CPU (GPU off — ${name} available)`;
}

/* ---- first-launch offer ------------------------------------------------ */

/**
 * Should the first-launch bar offer to download the recommended model? Once
 * only (`offered` is the persisted flag, set whatever the answer), never
 * while anything is already installed (an upgrade from a version that had
 * models, or a folder restored from a backup), and never on Android — its
 * default engine needs no download.
 */
export function shouldOfferSetup(input: {
  offered: boolean;
  android: boolean;
  loaded: boolean;
  models: readonly WhisperModelStatus[];
}): boolean {
  if (input.offered || input.android || !input.loaded) {
    return false;
  }
  return !input.models.some((m) => m.installed);
}

/* ---- download state machine ------------------------------------------- */

/**
 * What the Settings dialog's model list shows for the one download in flight
 * (only one at a time — the backend refuses a second).
 */
export type DownloadState =
  | { kind: 'idle' }
  | { kind: 'downloading'; id: string; received: number; total: number }
  | { kind: 'verifying'; id: string }
  | { kind: 'done'; id: string }
  | { kind: 'failed'; id: string; code: string }
  | { kind: 'cancelled'; id: string };

export type DownloadAction =
  | { type: 'start'; id: string }
  | { type: 'progress'; received: number; total: number }
  | { type: 'verifying' }
  | { type: 'done' }
  | { type: 'failed'; code: string }
  | { type: 'cancelled' }
  | { type: 'reset' };

export const IDLE_DOWNLOAD: DownloadState = { kind: 'idle' };

/** Which download an in-flight state is about, or null when none is. */
function idOf(state: DownloadState): string | null {
  return state.kind === 'idle' ? null : state.id;
}

/**
 * idle → downloading(received, total) → verifying → done | failed(code) |
 * cancelled. `start` is accepted from any terminal state (done/failed/
 * cancelled/idle) and ignored while one is active; the progress-family
 * actions are ignored unless a download is active, so a late event from a
 * cancelled download cannot revive the bar.
 */
export function downloadReducer(state: DownloadState, action: DownloadAction): DownloadState {
  const active = state.kind === 'downloading' || state.kind === 'verifying';
  switch (action.type) {
    case 'start':
      return active ? state : { kind: 'downloading', id: action.id, received: 0, total: 0 };
    case 'progress':
      return state.kind === 'downloading'
        ? { ...state, received: action.received, total: action.total }
        : state;
    case 'verifying':
      return state.kind === 'downloading' ? { kind: 'verifying', id: state.id } : state;
    case 'done':
      return active ? { kind: 'done', id: idOf(state) ?? '' } : state;
    case 'failed':
      return active ? { kind: 'failed', id: idOf(state) ?? '', code: action.code } : state;
    case 'cancelled':
      return active ? { kind: 'cancelled', id: idOf(state) ?? '' } : state;
    case 'reset':
      return active ? state : IDLE_DOWNLOAD;
  }
}

/** 0–100 for the progress bar while downloading; null when the total is unknown or idle. */
export function downloadPercent(state: DownloadState): number | null {
  if (state.kind === 'verifying') {
    return 100;
  }
  if (state.kind !== 'downloading' || state.total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.floor((state.received / state.total) * 100)));
}

/* ---- capture limits --------------------------------------------------- */

/** Seconds of audio `samples` PCM frames hold at `sampleRate`. */
export function pcmSeconds(samples: number, sampleRate: number): number {
  return sampleRate > 0 ? samples / sampleRate : 0;
}

/** Has a capture reached the hard cap? Checked after every appended frame. */
export function captureLimitReached(samples: number, sampleRate: number): boolean {
  return pcmSeconds(samples, sampleRate) >= MAX_CAPTURE_SECONDS;
}

/** One buffer out of the worklet's frames, in arrival order. */
export function concatPcm(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
