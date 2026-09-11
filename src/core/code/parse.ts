/**
 * Entry point of the code model: which language a path is, and the parse.
 * Dispatches on the file extension to the one extractor that knows the
 * grammar (`ts.ts`, `rust.ts`); everything else gets `null` rather than a
 * guess — Review only exists for languages it can actually read.
 */

import type { CodeLanguage, CodeModel } from './model';
import { extractRust } from './rust';
import { extractTs } from './ts';

const TS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

/** The extension (lowercase, no dot) of a path, `.ext` or bare `ext`. */
function extensionOf(pathOrExt: string): string {
  const base = pathOrExt.split(/[\\/]/).pop() ?? pathOrExt;
  if (!base.includes('.')) {
    return base.toLowerCase();
  }
  return base.slice(base.lastIndexOf('.') + 1).toLowerCase();
}

/** `'ts'` for TypeScript/JavaScript files, `'rust'` for `.rs`, else null. */
export function codeLanguageFor(path: string | null | undefined): CodeLanguage | null {
  if (!path) {
    return null;
  }
  const ext = extensionOf(path);
  if (TS_EXTENSIONS.has(ext)) {
    return 'ts';
  }
  if (ext === 'rs') {
    return 'rust';
  }
  return null;
}

/**
 * Parse `text` as the language `pathOrExt` names (a full path, `.rs`, or
 * `ts`). Null for a language Review does not read. Never throws: Lezer
 * recovers from any input and reports errors in `parseErrors`.
 */
export function parseCode(text: string, pathOrExt: string): CodeModel | null {
  const language = codeLanguageFor(pathOrExt);
  if (language === 'ts') {
    const ext = extensionOf(pathOrExt);
    return extractTs(text, {
      ts: ext.startsWith('ts') || ext === 'mts' || ext === 'cts',
      jsx: ext.endsWith('sx'),
    });
  }
  if (language === 'rust') {
    return extractRust(text);
  }
  return null;
}
