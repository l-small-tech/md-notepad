/**
 * dictation-insert.ts — how a dictated phrase joins the text at the caret.
 *
 * Voice typing (the ribbon's microphone) drops a transcript into the document
 * wherever the caret is. Engines hand back a bare phrase ("hello world"), so
 * this decides the glue: a leading space when the caret sits right after a
 * word or punctuation, and a trailing one when it sits right before a word —
 * so dictating mid-sentence never fuses words together.
 */

/** Characters after which a phrase needs no leading space. */
const OPENS = /[\s([{"'`]$/;
/** A word character right after the caret needs a trailing space. */
const WORD_START = /^[\p{L}\p{N}]/u;

/**
 * The text to insert for a dictated `phrase`, given the character(s) just
 * `before` the caret and just `after` it. '' when there is nothing to insert.
 */
export function joinDictation(before: string, phrase: string, after = ''): string {
  const text = phrase.trim();
  if (!text) {
    return '';
  }
  const lead = before !== '' && !OPENS.test(before) ? ' ' : '';
  const trail = WORD_START.test(after) ? ' ' : '';
  return lead + text + trail;
}
