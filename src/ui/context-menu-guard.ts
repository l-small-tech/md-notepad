/**
 * App-wide context-menu guard — the webview's own menu (Back / Reload /
 * Inspect Element) is a browser artifact, not part of this app, and it must
 * never surface over app chrome. Right-clicking the window controls, the tab
 * bar's empty space, a sidebar gutter or anything else that has no menu of its
 * own used to hand the user a devtools menu from a window that is supposed to
 * look like a native app.
 *
 * One delegated listener on the document cancels it, with two exemptions:
 *
 * - `event.defaultPrevented` → a surface that owns the right-click (the file
 *   explorer, the tab bar, the ribbon, the terminal) has already decided.
 *   Cancelling again is harmless, so this is only a readability guard.
 * - text-editing targets (`input`, `textarea`, `contenteditable` — CodeMirror
 *   and milkdown are the latter) → the native menu is the only right-click
 *   copy/paste the editors have. Suppressing it there would remove a real
 *   feature to hide a devtools entry that release builds don't show anyway.
 *
 * Read-only text elsewhere (preview, status bar) is deliberately not exempt:
 * selection copy there goes through the keyboard and the app's own menus.
 */

/** Does the right-click land in something the user can type into? */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  // The attribute rather than `isContentEditable`: the event target is often
  // deep inside the editable subtree, and matching only the truthy values lets
  // `contenteditable="false"` islands (widgets, embeds) fall through to their
  // editable ancestor instead of reading as chrome.
  return target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') !== null;
}

export function installContextMenuGuard(target: Document = document): () => void {
  const onContextMenu = (event: Event): void => {
    if (event.defaultPrevented || isTextEntry(event.target)) {
      return;
    }
    event.preventDefault();
  };

  target.addEventListener('contextmenu', onContextMenu);
  return () => {
    target.removeEventListener('contextmenu', onContextMenu);
  };
}
