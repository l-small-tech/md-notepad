/**
 * Pure helpers for the Milkdown/Crepe adapter (milkdown.ts).
 *
 * The adapter itself is thin DOM glue behind a lazy import (invariant I8), so
 * anything decidable without the editor lives here where Vitest can reach it
 * WITHOUT pulling the @milkdown/* chunk into the test (or the entry) bundle.
 * The wording constant lives here too so EditorHost can show the hint without
 * importing the lazy adapter module (src/editors/README.md — normalization hint).
 */

/** Status-bar wording for the one-time-per-tab rich-mode reformatting hint. */
export const NORMALIZATION_HINT = 'Rich mode may reformat markdown syntax (content is preserved)';

/**
 * True when round-tripping markdown through the WYSIWYG parser+serializer
 * would change the source bytes. Content is always preserved (I2 guarantees
 * merely viewing never writes back); only syntax spelling may shift, which is
 * what the hint warns about.
 */
export function markdownNormalizes(original: string, roundTripped: string): boolean {
  return original !== roundTripped;
}

/**
 * The one-time-per-tab gate: show the hint only when rich mode WOULD reformat
 * and we have not already shown it for this tab (the adapter instance lives
 * for the tab's lifetime, so a per-instance flag is "per tab").
 */
export function shouldShowNormalizationHint(normalizes: boolean, alreadyShown: boolean): boolean {
  return normalizes && !alreadyShown;
}
