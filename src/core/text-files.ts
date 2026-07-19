/**
 * Which file extensions the app treats as editable text notes. Markdown is the
 * native format; plain `.txt` files are first-class citizens too — they list in
 * the explorer, open in the normal editor tabs, and save through the same
 * atomic-write path. Kept as its own tiny module so the explorer, the storage
 * providers, and the session controller all agree on one definition (the Rust
 * `list_dir` filter mirrors it — see src-tauri/src/commands/fs.rs).
 */

/** True for markdown files (`.md` / `.markdown`). */
export function isMarkdownPath(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** True for any editable text note: markdown or plain `.txt`. */
export function isEditableTextPath(name: string): boolean {
  return isMarkdownPath(name) || name.toLowerCase().endsWith('.txt');
}
