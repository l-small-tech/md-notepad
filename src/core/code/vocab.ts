/**
 * vocab.ts — the voice vocabulary of a code file (pure; no parser needed).
 *
 * Dictating a code review means saying identifiers out loud, and speech
 * recognition has never heard of `showAllFilesState`. Two cheap fixes, both
 * driven by nothing but a list of identifier strings (so this module works
 * whether the names came from the Lezer parse, a grep, or a test fixture):
 *
 *  - `identifierHint` builds whisper.cpp's *initial prompt* — the identifiers
 *    split into the words a person actually says ("show all files state"), so
 *    the decoder is biased toward them before it hears a syllable.
 *  - `snapIdentifiers` repairs the transcript afterwards: a run of spoken
 *    words that matches a split identifier becomes the real, backticked name,
 *    so the agent reading the sidecar gets `` `showAllFilesState` `` instead of
 *    "show all files state".
 *
 * Snapping is deliberately timid. A false snap puts a word in the reviewer's
 * mouth, which is worse than leaving a name spelled out, so: whole-word runs
 * only, at least `MIN_SNAP_LETTERS` letters, a strict `core/fuzzy` score, the
 * longest run wins, and a single-word identifier that is also an ordinary
 * English word (`name`, `path`, `run`…) is never snapped. Every snap is
 * reported with the text it replaced and where, so the sheet can undo one.
 */

import { fuzzyScore } from '../fuzzy';

/** One replacement `snapIdentifiers` made, and where it landed in the result. */
export interface Snap {
  /** The spoken words that were replaced, verbatim. */
  from: string;
  /** What replaced them: the real identifier, backticked. */
  to: string;
  /** Index of `to` in the returned text (so an undo is exact). */
  index: number;
}

/** Below this many letters a run is too short to be anything but noise. */
export const MIN_SNAP_LETTERS = 3;

/** How close a run must score against an identifier, as a fraction of perfect. */
const SNAP_THRESHOLD = 0.8;

/** The most words one identifier can span (`is at or below` is four). */
const MAX_RUN_WORDS = 8;

/**
 * Single words that are ordinary English before they are identifiers. An
 * identifier that splits to exactly one of these is never snapped: "read the
 * next line" must stay English even in a file that exports `read`, `next` and
 * `line`. Multi-word identifiers are safe (nobody says "show all files state"
 * by accident), so the list only needs the common single words.
 */
export const SNAP_STOP_WORDS = new Set([
  'add',
  'all',
  'and',
  'any',
  'call',
  'close',
  'code',
  'copy',
  'count',
  'data',
  'dir',
  'done',
  'end',
  'file',
  'find',
  'for',
  'get',
  'has',
  'index',
  'info',
  'item',
  'key',
  'kind',
  'line',
  'list',
  'load',
  'log',
  'map',
  'mode',
  'move',
  'name',
  'new',
  'next',
  'not',
  'note',
  'now',
  'one',
  'open',
  'out',
  'page',
  'part',
  'path',
  'read',
  'run',
  'save',
  'set',
  'show',
  'size',
  'sort',
  'start',
  'state',
  'stop',
  'text',
  'the',
  'time',
  'type',
  'up',
  'use',
  'value',
  'view',
  'wait',
  'word',
  'work',
  'write',
]);

/**
 * An identifier split into the words a person says, lowercased:
 * `showAllFilesState` → `['show','all','files','state']`, `HTTPServer` →
 * `['http','server']`, `is_markdown_path` → `['is','markdown','path']`,
 * `SCREAMING_CASE` → `['screaming','case']`, `utf8Text` → `['utf','8','text']`.
 * Separators (`_`, `-`, `.`, `::`, spaces) are boundaries and vanish.
 */
export function splitIdentifier(id: string): string[] {
  const out: string[] = [];
  for (const chunk of id.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) {
      continue;
    }
    // camelCase / PascalCase / acronym runs / digit runs, in one pass.
    const words = chunk.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z]+|[0-9]+/g);
    for (const w of words ?? []) {
      out.push(w.toLowerCase());
    }
  }
  return out;
}

/**
 * The whisper initial prompt for a file's identifiers: each name as its spoken
 * words, deduped (case-insensitively, and skipping names that say the same
 * words), joined with ", " and capped at `maxChars` on a phrase boundary —
 * whisper.cpp only keeps a prompt's tail anyway, and a huge prompt costs
 * decode time. Empty when there is nothing worth saying.
 */
export function identifierHint(identifiers: string[], maxChars = 800): string {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const id of identifiers) {
    const phrase = splitIdentifier(id).join(' ');
    if (!phrase || seen.has(phrase)) {
      continue;
    }
    seen.add(phrase);
    phrases.push(phrase);
  }
  let out = '';
  for (const phrase of phrases) {
    const next = out ? `${out}, ${phrase}` : phrase;
    if (next.length > maxChars) {
      break;
    }
    out = next;
  }
  return out;
}

/** A candidate identifier, pre-split once per call. */
interface Candidate {
  id: string;
  words: string[];
  /** The words with nothing between them — what a run is compared against. */
  joined: string;
}

/** A word of the transcript, with where it sits in the source text. */
interface Token {
  text: string;
  start: number;
  end: number;
  /**
   * Only spaces (or a hyphen/underscore) separate this word from the previous
   * one — so a run may include it. False across punctuation and line breaks,
   * which keeps a snap inside one sentence.
   */
  joinable: boolean;
}

/**
 * Replace runs of spoken words in `text` that match one of `identifiers` with
 * the real name in backticks, left to right, longest run first. Returns the
 * new text and one `Snap` per replacement (in text order).
 *
 * Nothing inside an existing `` `code span` `` is touched, so running this
 * twice over the same text is a no-op.
 */
export function snapIdentifiers(
  text: string,
  identifiers: string[],
): { text: string; snaps: Snap[] } {
  const candidates = snapCandidates(identifiers);
  if (candidates.length === 0 || !text) {
    return { text, snaps: [] };
  }
  const longest = Math.min(
    MAX_RUN_WORDS,
    candidates.reduce((n, c) => Math.max(n, c.words.length), 1) + 1,
  );
  const tokens = wordTokens(text);
  const snaps: Snap[] = [];
  let out = '';
  let copied = 0; // how much of `text` is already in `out`
  let i = 0;
  while (i < tokens.length) {
    let hit: { candidate: Candidate; words: number } | null = null;
    // Longest run first, so `isAtOrBelow` wins over a shorter name inside it.
    for (let n = Math.min(longest, runLength(tokens, i, longest)); n >= 1 && !hit; n--) {
      const joined = tokens
        .slice(i, i + n)
        .map((t) => t.text.toLowerCase())
        .join('');
      if (joined.length < MIN_SNAP_LETTERS) {
        continue;
      }
      const candidate = bestCandidate(joined, candidates);
      hit = candidate ? { candidate, words: n } : null;
    }
    if (!hit) {
      i += 1;
      continue;
    }
    const first = tokens[i]!;
    const last = tokens[i + hit.words - 1]!;
    const to = `\`${hit.candidate.id}\``;
    out += text.slice(copied, first.start);
    snaps.push({ from: text.slice(first.start, last.end), to, index: out.length });
    out += to;
    copied = last.end;
    i += hit.words;
  }
  return { text: out + text.slice(copied), snaps };
}

/**
 * Undo the snap at position `at` of `snaps`: the identifier goes back to the
 * words that were spoken, and the remaining snaps keep pointing at their own
 * text. Out-of-range leaves everything alone.
 */
export function undoSnap(text: string, snaps: Snap[], at: number): { text: string; snaps: Snap[] } {
  const snap = snaps[at];
  if (!snap || text.slice(snap.index, snap.index + snap.to.length) !== snap.to) {
    return { text, snaps };
  }
  const next = text.slice(0, snap.index) + snap.from + text.slice(snap.index + snap.to.length);
  const shift = snap.from.length - snap.to.length;
  const remaining = snaps
    .filter((_, i) => i !== at)
    .map((s) => (s.index > snap.index ? { ...s, index: s.index + shift } : s));
  return { text: next, snaps: remaining };
}

/* ---- internals --------------------------------------------------------- */

/** The identifiers worth snapping to, split once and guarded (see the header). */
function snapCandidates(identifiers: string[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const id of identifiers) {
    const words = splitIdentifier(id);
    if (words.length === 0 || words.length > MAX_RUN_WORDS || seen.has(id)) {
      continue;
    }
    const joined = words.join('');
    if (joined.length < MIN_SNAP_LETTERS) {
      continue;
    }
    // A one-word identifier that is also an ordinary English word: leave the
    // reviewer's sentence alone.
    if (words.length === 1 && SNAP_STOP_WORDS.has(words[0]!)) {
      continue;
    }
    seen.add(id);
    out.push({ id, words, joined });
  }
  return out;
}

/**
 * The best-scoring candidate for a run's letters, or null when none is close
 * enough. `fuzzyScore` is a subsequence matcher, so the run must be spellable
 * out of the identifier in order; the threshold is a fraction of the score a
 * character-for-character match would get, which rejects a run that only
 * shares a skeleton of letters.
 */
function bestCandidate(joinedRun: string, candidates: Candidate[]): Candidate | null {
  let best: { candidate: Candidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = fuzzyScore(joinedRun, candidate.joined);
    if (score === null) {
      continue;
    }
    // Perfect = every char matched, contiguous, starting at the word start.
    const perfect = 3 * candidate.joined.length + 1;
    if (score / perfect < SNAP_THRESHOLD) {
      continue;
    }
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}

/** How many consecutive words start at `i` without punctuation between them. */
function runLength(tokens: Token[], i: number, cap: number): number {
  let n = 1;
  while (n < cap && i + n < tokens.length && tokens[i + n]!.joinable) {
    n += 1;
  }
  return n;
}

/**
 * The transcript's words with their offsets. Anything inside a backtick span
 * is skipped, so an already-snapped name is never re-read as spoken words.
 */
function wordTokens(text: string): Token[] {
  const masked = maskCodeSpans(text);
  const out: Token[] = [];
  const re = /[A-Za-z0-9]+/g;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const prev = out[out.length - 1];
    const gap = prev ? masked.slice(prev.end, m.index) : '';
    out.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      joinable: prev !== undefined && /^[ \t\-_]*$/.test(gap),
    });
  }
  return out;
}

/** The same text with every `…` span blanked out (offsets preserved). */
function maskCodeSpans(text: string): string {
  return text.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}
