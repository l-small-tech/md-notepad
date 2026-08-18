/**
 * External-link policy — what a clicked href IS, never what to do about it.
 *
 * Shared by the preview pane's own link handler and the app-wide link guard
 * (`ui/link-guard.ts`). The webview must NEVER navigate: an `http(s)` link
 * that reaches the window replaces the whole app with the remote page, and
 * with no browser chrome there is no way back — so every clicked link is
 * intercepted and an external one is handed to the OS browser instead, after
 * the user confirms it.
 *
 * Pure and DOM-free: this module classifies and formats strings only.
 */

/**
 * `http:`/`https:` with an authority — the only shape we offer to open in the
 * system browser. Schemeless (local file) destinations are `isLocalLinkTarget`
 * in `link-mentions.ts`; everything else (`mailto:`, `#anchor`, …) is inert.
 */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

/**
 * The host the URL actually resolves to, lowercased (`github.com`), or '' when
 * it can't be read. Userinfo is stripped deliberately: `https://github.com@evil.example`
 * points at `evil.example`, and the warning must name the site that will really
 * be reached, not the one the URL is dressed up as.
 */
export function externalLinkHost(url: string): string {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url.trim())?.[1] ?? '';
  const hostPort = authority.split('@').pop() ?? '';
  return hostPort.toLowerCase();
}

/**
 * The URL middle-elided to at most `max` characters so it fits the one-line
 * prompt. The head and tail are both kept — the tail is where a look-alike URL
 * usually hides its real destination, so truncating only the end would hide
 * exactly what the reader needs to see.
 */
export function shortenUrl(url: string, max = 72): string {
  const trimmed = url.trim();
  if (trimmed.length <= max || max < 5) {
    return trimmed;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${trimmed.slice(0, head)}…${trimmed.slice(trimmed.length - tail)}`;
}
