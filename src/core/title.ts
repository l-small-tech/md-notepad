/**
 * Tab titles and note-file slugs.
 *
 * Naming rule: a note's `title` is `customTitle ?? deriveTitle(text)`, and
 * that title drives its on-disk slug (see plan-flush). The label SHOWN on a
 * tab, however, mirrors the file the tab maps to, minus the extension —
 * `tabDisplayTitle` in the tabs store owns that (a note shows its slug, a
 * file tab shows its basename). So the tab and its filename always match.
 */

const MAX_TITLE_LEN = 60;
const MAX_SLUG_LEN = 50;

/**
 * First non-blank line, stripped of leading markdown syntax (heading, list,
 * quote markers) and inline emphasis characters, truncated with an ellipsis.
 */
export function deriveTitle(text: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:>\s*)+/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/[*_`~]/g, '')
      .trim();
    // Skip blank lines and syntax-only leftovers (thematic breaks '---',
    // setext underlines '===', table rules) that survive the strips above.
    if (!line || /^[-=+|:\s]+$/.test(line)) {
      continue;
    }
    if (line.length > MAX_TITLE_LEN) {
      return `${line.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;
    }
    return line;
  }
  return 'Untitled';
}

/**
 * Windows refuses these as file basenames regardless of extension —
 * `con.md` is unwritable. Checked AFTER slugging, so it can't be bypassed
 * by casing or punctuation.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** Drop a single trailing file extension (`report.md` → `report`). A
 *  leading-dot name with no other dot (`.gitignore`) is left as-is. */
export function stripExtension(basename: string): string {
  const match = /^(.+)\.[^.\s]+$/.exec(basename);
  return match ? match[1]! : basename;
}

/**
 * Drop a trailing extension from a user-typed name ONLY when it duplicates the
 * `ext` we're about to re-append — so renaming a file to "notes.md" yields
 * "notes.md", not "notes.md.md". Case-insensitive; `ext` includes the dot
 * (".md"), and an empty `ext` (folders) is a no-op. Unlike {@link stripExtension}
 * this removes just the one matching extension: typing "cheatsheet.md" for a
 * ".txt" file keeps the ".md" as part of the base.
 */
export function dropTrailingExtension(name: string, ext: string): string {
  if (ext && name.toLowerCase().endsWith(ext.toLowerCase())) {
    return name.slice(0, name.length - ext.length);
  }
  return name;
}

/** Characters no mainstream filesystem allows in a file basename. */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*]/g;

/**
 * Make a user-typed name safe to use as a file basename WITHOUT slugging it —
 * casing and spaces are preserved (a file tab renamed to "Budget Q3" becomes
 * `Budget Q3.md`, not `budget-q3.md`). Illegal path characters are dropped,
 * trailing dots/spaces trimmed (Windows rejects them), reserved device names
 * suffixed. Returns '' when nothing usable remains (caller shows an error).
 */
export function sanitizeFileBaseName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, MAX_SLUG_LEN)
    .replace(/[. ]+$/, '');
  if (!cleaned) {
    return '';
  }
  if (WINDOWS_RESERVED.test(cleaned.toLowerCase())) {
    return `${cleaned}-note`;
  }
  return cleaned;
}

/**
 * Turn a title into a safe, portable file basename (no extension).
 *
 * Lossy on purpose: lowercased ASCII kebab-case. Non-latin titles collapse
 * to 'untitled' and rely on collision suffixes (transliteration is in the
 * backlog). Collision handling against sibling files is the caller's job —
 * see core/session/plan-flush.ts.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    // The invisible char class below is U+0300–U+036F: combining diacritics
    // left over after NFKD ("Café" → "Cafe" + U+0301).
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/, '');
  if (!slug) {
    return 'untitled';
  }
  if (WINDOWS_RESERVED.test(slug)) {
    return `${slug}-note`;
  }
  return slug;
}
