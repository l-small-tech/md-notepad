/**
 * App-wide link guard — the last line of the "the window must NEVER navigate"
 * rule (`core/external-links.ts`).
 *
 * The preview pane owns the link policy for its own rendered markdown, but
 * anchors exist elsewhere too — most importantly in wysiwyg mode, where
 * milkdown renders a link mark as a live `<a href>`. A click there used to
 * navigate the webview to the remote page, which replaces the entire app with
 * a chrome-less browser view: no back button, no tabs, no way out short of
 * killing the process.
 *
 * So one delegated listener sits on the document and cancels every anchor
 * click that no closer handler already claimed:
 *
 * - `event.defaultPrevented` → a surface that owns the link (the preview pane)
 *   has already decided; leave it alone.
 * - `http(s)` → prompt for confirmation, then the OS browser (never here).
 * - anything else (local paths outside the preview, `mailto:`, `#anchor`) →
 *   inert. Cancelling is the point: an uncancelled click navigates.
 *
 * `auxclick` is handled the same way — a middle click on an anchor opens a new
 * webview window, which is the same trap with an extra window around it.
 */

import { isExternalHref } from '../core/external-links';
import { externalLinkStore } from './stores/external-link';

export function installLinkGuard(target: Document = document): () => void {
  const onAnchorClick = (event: Event): void => {
    if (event.defaultPrevented) {
      return; // the preview pane (or another owner) already handled this click
    }
    const el = event.target;
    if (!(el instanceof Element)) {
      return;
    }
    const anchor = el.closest('a[href]');
    if (!anchor) {
      return;
    }
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (isExternalHref(href)) {
      externalLinkStore.getState().request(href);
    }
  };

  target.addEventListener('click', onAnchorClick);
  target.addEventListener('auxclick', onAnchorClick);
  return () => {
    target.removeEventListener('click', onAnchorClick);
    target.removeEventListener('auxclick', onAnchorClick);
  };
}
