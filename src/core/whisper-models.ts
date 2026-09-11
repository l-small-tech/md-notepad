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

/** The model a fresh install is pointed at: the accuracy/speed sweet spot on a CPU. */
export const RECOMMENDED_WHISPER_MODEL = 'small.en';

export function recommendedModel(): string {
  return RECOMMENDED_WHISPER_MODEL;
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
  /** A q5 quantized variant: smaller and a little faster, slightly less accurate. */
  quantized: boolean;
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
 * A rough speed hint per model family, for a 4-core CPU with no GPU: how long
 * a 30-second note takes. Informational only — it sets expectations before a
 * 1.5 GB download, nothing depends on the numbers.
 */
export function speedHint(id: string): string {
  const family = id.split('-q')[0] ?? id;
  switch (family) {
    case 'tiny.en':
      return '~2 s per 30 s of speech';
    case 'base.en':
      return '~4 s per 30 s of speech';
    case 'small.en':
      return '~12 s per 30 s of speech';
    case 'medium.en':
      return '~40 s per 30 s of speech';
    case 'large-v3-turbo':
      return '~30 s per 30 s of speech';
    default:
      return '';
  }
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
