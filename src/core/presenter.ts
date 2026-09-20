/**
 * Presenter view — the pure half: what travels between the window running a
 * deck and the presenter window beside it, and the small arithmetic both
 * sides share. The windows, events and rendering live in src/ui/presenter.ts
 * and src/ui/components/PresenterView.tsx.
 */

/** Everything the presenter window needs to render a deck by itself. */
export interface PresenterDeck {
  /** Identity of the deck across windows: its path key, else its tab id. */
  key: string;
  /** Tab label, for the presenter's title bar. */
  title: string;
  text: string;
  /** Where relative images resolve from; null for an unsaved note. */
  docPath: string | null;
  /** The slide showing right now (0-based). */
  index: number;
}

/** "Go to this slide", broadcast by whichever window the user drove. */
export interface SlideMessage {
  from: string;
  key: string;
  index: number;
}

/** Keep a slide index inside a deck of `total` slides (0 for an empty deck). */
export function clampSlide(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(total - 1, Math.trunc(index)));
}

/** Elapsed time as m:ss, or h:mm:ss once a talk passes the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A stopwatch as data: accumulated time plus the moment it last started. */
export interface Stopwatch {
  elapsedMs: number;
  /** Wall-clock ms when it was last started, or null while paused. */
  startedAt: number | null;
}

export function stopwatchElapsed(watch: Stopwatch, now: number): number {
  return watch.elapsedMs + (watch.startedAt === null ? 0 : Math.max(0, now - watch.startedAt));
}

export function toggleStopwatch(watch: Stopwatch, now: number): Stopwatch {
  return watch.startedAt === null
    ? { elapsedMs: watch.elapsedMs, startedAt: now }
    : { elapsedMs: stopwatchElapsed(watch, now), startedAt: null };
}
