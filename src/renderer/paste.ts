/**
 * Paste handling.
 *
 * Two jobs: make the text safe to hand a shell, and get it there in pieces the
 * pty will accept. Pasting is the one path where the terminal writes text the
 * user did not type key by key, so it is also the one path where a crafted
 * clipboard could run a command on its own — hence the sanitizing below.
 */

/** Bytes per write to the pty. Comfortably under a pipe buffer. */
export const PASTE_CHUNK = 4096;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Normalize line endings and drop control characters.
 *
 * Newlines become CR because that is what the Enter key sends — a shell reading
 * LF would see an incomplete line. Every other C0 control and DEL is removed:
 * an ESC in a paste can drive the terminal itself, and inside a bracketed paste
 * a literal `CSI 201~` would end the bracket early and turn the remainder into
 * keystrokes. Tab survives, because tabs are ordinary text in a paste.
 */
export function sanitizePaste(text: string): string {
  let out = '';
  for (const char of text.replace(/\r\n?/g, '\n')) {
    const code = char.codePointAt(0)!;
    if (char === '\n') out += '\r';
    else if (char === '\t') out += char;
    else if (code < 0x20 || code === 0x7f) continue;
    else out += char;
  }
  return out;
}

/** True when the payload would submit more than one line to a shell. */
export function isMultiline(text: string): boolean {
  return /[\r\n]/.test(text);
}

/**
 * The payload to write. With bracketed paste (mode 2004) the application knows
 * the text was pasted and will not act on the newlines; without it, the shell
 * cannot tell paste from typing, which is what the multi-line paste warning is
 * for.
 */
export function bracketPaste(text: string, bracketed: boolean): string {
  return bracketed ? PASTE_START + text + PASTE_END : text;
}

/**
 * Split a payload into pty-sized writes without ever cutting a surrogate pair
 * (a split there would send two replacement characters instead of one emoji).
 */
export function pasteChunks(payload: string, size = PASTE_CHUNK): string[] {
  if (payload.length <= size) return payload === '' ? [] : [payload];
  const chunks: string[] = [];
  let index = 0;
  while (index < payload.length) {
    let end = Math.min(index + size, payload.length);
    const code = payload.charCodeAt(end - 1);
    // A high surrogate at the boundary belongs with the low one that follows.
    if (end < payload.length && code >= 0xd800 && code <= 0xdbff) end--;
    chunks.push(payload.slice(index, end));
    index = end;
  }
  return chunks;
}

/** Sanitize, bracket and split in one step — what the input layer calls. */
export function preparePaste(
  text: string,
  bracketed: boolean,
  size = PASTE_CHUNK,
): { chunks: string[]; text: string } {
  const clean = sanitizePaste(text);
  // Text that sanitizes away entirely is not a paste — not even an empty pair
  // of brackets, which some applications treat as a submitted empty line.
  if (clean === '') return { chunks: [], text: clean };
  return { chunks: pasteChunks(bracketPaste(clean, bracketed), size), text: clean };
}
