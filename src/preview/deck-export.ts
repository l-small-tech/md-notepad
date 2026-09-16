/**
 * Standalone HTML export for a Marp deck — one self-contained file: the
 * theme stylesheet, every slide as inline SVG, local images inlined as data
 * URLs, and a few lines of keyboard navigation so it presents in any
 * browser. Follows the shape of `export.ts` (`buildStandaloneHtml`), but
 * through `renderDeck` rather than the sanitized pipeline — the sanitize
 * exception in README "Marp decks" applies here too.
 */

import { dirName } from '../core/session/plan-flush';
import { escapeHtml } from './export';
import { inlineDeckImages, renderDeck } from './marp';

export interface DeckExportOptions {
  title: string;
  /** The document's path (relative images and a `theme: ./x.css`); null when unsaved. */
  docPath: string | null;
  /** Absolute image path → data URL, or null to leave the source alone. */
  resolveImage: (absPath: string) => Promise<string | null>;
}

/**
 * The exported page: slides stacked one per screen with scroll snapping;
 * arrows / Space / PgUp / PgDn / Home / End move between them and `f` asks
 * for the browser's fullscreen. No framework, no network.
 */
const DECK_PAGE_CSS = `
html, body { margin: 0; background: #000; }
body { scroll-snap-type: y mandatory; overflow-y: scroll; height: 100vh; }
div.marpit { display: block; }
div.marpit > svg[data-marpit-svg] {
  display: block; width: 100vw; height: 100vh; scroll-snap-align: start;
}
@media print {
  body { scroll-snap-type: none; overflow: visible; height: auto; }
  div.marpit > svg[data-marpit-svg] { page-break-after: always; }
}
`;

const DECK_PAGE_SCRIPT = `
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('svg[data-marpit-svg]'));
  function current() {
    var y = window.scrollY + window.innerHeight / 2;
    for (var i = 0; i < slides.length; i++) {
      var r = slides[i].getBoundingClientRect();
      if (r.top + window.scrollY <= y && r.bottom + window.scrollY > y) return i;
    }
    return 0;
  }
  function go(i) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    slides[i].scrollIntoView({ block: 'start' });
  }
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter':
        go(current() + 1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
        go(current() - 1); break;
      case 'Home': go(0); break;
      case 'End': go(slides.length - 1); break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        break;
      default: return;
    }
    e.preventDefault();
  });
})();
`;

export async function buildDeckHtml(markdown: string, opts: DeckExportOptions): Promise<string> {
  const deck = await renderDeck(markdown, { docPath: opts.docPath });
  const doc = new DOMParser().parseFromString(
    `<div class="marpit">${deck.slides.map((s) => s.html).join('')}</div>`,
    'text/html',
  );
  const root = doc.body;
  await inlineDeckImages(root, opts.docPath ? dirName(opts.docPath) : null, opts.resolveImage);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(opts.title)}</title>`,
    '<style>',
    DECK_PAGE_CSS,
    deck.css,
    '</style>',
    '</head>',
    '<body>',
    root.innerHTML,
    '<script>',
    DECK_PAGE_SCRIPT,
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
