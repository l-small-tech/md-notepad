/**
 * ExternalLinkPrompt — the confirmation shown when a clicked link points off
 * the app (`stores/external-link.ts`).
 *
 * Deliberately NOT a modal: it is a small bar at the bottom of the window
 * (`.diagram-viewer-controls` shape), it doesn't dim or block anything behind
 * it, and it clears itself after a few seconds if ignored. It only has to do
 * two things — name the host the URL really resolves to, and make opening it
 * a decision rather than an accident.
 */

import { externalLinkHost, shortenUrl } from '../../core/external-links';
import { externalLinkStore, useExternalLink } from '../stores/external-link';

export function ExternalLinkPrompt() {
  const pending = useExternalLink((s) => s.pending);
  if (pending === null) {
    return null;
  }
  const host = externalLinkHost(pending);
  return (
    <div className="external-link-prompt" role="alertdialog" aria-label="Open external link">
      <div className="external-link-prompt-text">
        <span className="external-link-prompt-warning">
          Opens {host || 'an external site'} in your browser — only open links you trust.
        </span>
        <span className="external-link-prompt-url" title={pending}>
          {shortenUrl(pending)}
        </span>
      </div>
      <button
        className="external-link-prompt-button external-link-prompt-open"
        autoFocus
        onClick={() => externalLinkStore.getState().openPending()}
      >
        Open in browser
      </button>
      <button
        className="external-link-prompt-button"
        title="Cancel (Esc)"
        onClick={() => externalLinkStore.getState().dismiss()}
      >
        Cancel
      </button>
    </div>
  );
}
