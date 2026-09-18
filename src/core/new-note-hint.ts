/**
 * The ghost text an EMPTY markdown note shows until the first keystroke: a
 * one-screen primer on how notes save and what markdown is. Pure data, shared
 * by the raw (CodeMirror) and Edit (Milkdown) editors so both modes tell the
 * same story. Newlines and runs of spaces are significant — the editors render it `pre-wrap`.
 */

export const NEW_NOTE_HINT = [
  'Start typing. This note saves itself as you go.',
  '',
  'Saving: notes live in your Notes folder as real .md files, named after their',
  'first line. Ctrl+S (Save As) copies one out to a file anywhere you choose.',
  'Closing a note tab deletes its note - export first if you want to keep it.',
  '',
  'Markdown is plain text with light markup:',
  '  # Heading        **bold**  *italic*  `code`',
  '  - bullet item    1. numbered item     > quote',
  '  [link](url)      ![image](path)      ---  (a rule)',
  '',
  'Ctrl+1 raw   Ctrl+2 split   Ctrl+3 edit   Ctrl+4 review',
].join('\n');
