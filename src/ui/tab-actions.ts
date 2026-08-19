/**
 * Actions a tab's own context menu runs — the ones that act on THAT document
 * rather than on the app.
 *
 * They live here, not in a component, because the tab menu is the only caller
 * that knows which tab was right-clicked: right-clicking a tab does not
 * activate it, so every action takes an explicit id instead of reading the
 * active one.
 */

import { appendMentions } from '../core/link-mentions';
import { dirName } from '../core/session/plan-flush';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';

/**
 * Copy a tab's whole raw source to the clipboard, with an `@path` mention
 * appended for every file it links to — the shape an agentic CLI reads.
 */
export function copyRawText(tabId: string): void {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) {
    return;
  }
  const baseDir = dirName(tab.filePath ?? tab.notePath ?? '');
  const { text, count } = appendMentions(tab.model.getText(), baseDir);
  const done =
    count > 0
      ? `Copied raw text + ${count} file ${count === 1 ? 'mention' : 'mentions'} (@paths).`
      : 'Copied raw text to clipboard.';
  void navigator.clipboard
    .writeText(text)
    .then(() => uiStore.getState().showNotice(done))
    .catch(() => uiStore.getState().showNotice('Could not access the clipboard.'));
}

/** The absolute path behind a tab, or null (a terminal, or an unsaved note). */
export function tabPath(tabId: string): string | null {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  return tab ? (tab.filePath ?? tab.notePath) : null;
}

/** Copy a tab's absolute path to the clipboard. */
export function copyTabPath(tabId: string): void {
  const path = tabPath(tabId);
  if (path === null) {
    return;
  }
  void navigator.clipboard
    .writeText(path)
    .then(() => uiStore.getState().showNotice('Path copied.'))
    .catch(() => uiStore.getState().showNotice('Could not access the clipboard.'));
}
