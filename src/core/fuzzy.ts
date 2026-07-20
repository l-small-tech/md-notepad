/**
 * Fuzzy matching for the command palette (and any future pickers).
 *
 * `fuzzyScore` is a case-insensitive SUBSEQUENCE matcher: every query
 * character must appear in the candidate, in order, but not necessarily
 * adjacent. It returns `null` for a non-match, otherwise a score where
 * higher = better:
 *
 *   +1 per matched character (base)
 *   +2 when a match directly follows the previous match (contiguous run)
 *   +3 when a match sits at a word start (offset 0, or after a separator)
 *
 * The scan is greedy left-to-right (each query char takes the earliest
 * remaining occurrence). That is not globally optimal, but it is fast,
 * deterministic, and ranks well for palette-sized candidate lists.
 *
 * An empty query matches everything with score 0, so an empty palette input
 * lists all commands in their original (stable) order.
 */

/** Characters treated as word separators for the word-start bonus. */
const WORD_SEPARATOR = /[\s\-_./:,()[\]]/;

export function fuzzyScore(query: string, candidate: string): number | null {
  if (query.length === 0) {
    return 0;
  }
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let score = 0;
  let searchFrom = 0;
  let prevMatch = -2; // never adjacent to the first match
  for (const ch of q) {
    const idx = c.indexOf(ch, searchFrom);
    if (idx === -1) {
      return null;
    }
    score += 1;
    if (idx === prevMatch + 1) {
      score += 2;
    }
    if (idx === 0 || WORD_SEPARATOR.test(c[idx - 1]!)) {
      score += 3;
    }
    prevMatch = idx;
    searchFrom = idx + 1;
  }
  return score;
}

/**
 * Filter `items` to those matching `query` (per `fuzzyScore` over `text`),
 * sorted by score descending; ties keep the original item order (stable).
 */
export function rankCandidates<T>(query: string, items: T[], text: (t: T) => string): T[] {
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, text(item));
    if (score !== null) {
      scored.push({ item, score, index });
    }
  });
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
  return scored.map((s) => s.item);
}
