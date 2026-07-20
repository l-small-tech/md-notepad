/**
 * Export — "Export as HTML" (all platforms) and "Print / Save as PDF"
 * (desktop only; Tauri 2 has no print API, so printing goes through the
 * WebView's own print dialog — on Windows/WebView2 that dialog includes
 * "Save as PDF").
 *
 * Lives in src/ui/session (ui layer) so importing src/preview/export is legal
 * (ui → preview). Both actions build the same standalone document via
 * `buildStandaloneHtml`: the preview pipeline's sanitized render, the
 * standalone stylesheet (export.css inlined via `?raw`), mermaid diagrams
 * rendered to SVG, and local images inlined as data: URLs using the same
 * path-resolution rules as the preview pane (relative to the note's dir).
 */

import { imageMimeType, localImageToInline } from '../../core/images';
import { baseName, dirName } from '../../core/session/plan-flush';
import { slugifyTitle, stripExtension } from '../../core/title';
import { buildStandaloneHtml } from '../../preview/export';
import exportCss from '../../preview/export.css?raw';
import { isAndroid } from '../platform';
import { tabsStore, type TabEntry } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';

const HTML_FILTERS = [{ name: 'HTML', extensions: ['html'] }];

/** How long a rendered print iframe may linger if `afterprint` never fires. */
const PRINT_CLEANUP_FALLBACK_MS = 60_000;
/** Post-load settle so mermaid SVGs/layout are final before the dialog opens. */
const PRINT_SETTLE_MS = 300;

export function createExport(ctx: SessionCtx) {
  /** The active tab if it holds markdown text; otherwise notice + null. */
  function activeTextTab(): TabEntry | null {
    const tab = tabsStore.getState().activeTab();
    if (!tab || tab.kind === 'image' || tab.kind === 'import') {
      uiStore.getState().showNotice('Open a note or markdown file to export it.');
      return null;
    }
    return tab;
  }

  /** Is the app currently rendering its dark palette? (data-theme on <html>.) */
  function isDarkTheme(): boolean {
    return document.documentElement.dataset.theme === 'dark';
  }

  /**
   * The standalone document for `tab`: its markdown, title, the current
   * light/dark palette, and an image resolver reading local files through the
   * session's ipc — same relative-path rules as the preview pane, resolved
   * against the note's own directory. An unsaved doc (no path) leaves
   * relative image refs as-is, exactly like the pane.
   */
  function buildTabHtml(tab: TabEntry): Promise<string> {
    const docPath = tab.filePath ?? tab.notePath;
    const docDir = docPath ? dirName(docPath) : null;
    const cache = new Map<string, string>();
    return buildStandaloneHtml(tab.model.getText(), {
      title: tab.title,
      css: exportCss,
      dark: isDarkTheme(),
      async resolveImage(src) {
        const abs = localImageToInline(docDir, src);
        if (!abs) {
          return null; // external / data: / unresolvable — leave the src alone
        }
        const cached = cache.get(abs);
        if (cached !== undefined) {
          return cached;
        }
        try {
          const dataUrl = `data:${imageMimeType(abs)};base64,${await ctx.ipc.readFileBase64(abs)}`;
          cache.set(abs, dataUrl);
          return dataUrl;
        } catch {
          return null; // missing/unreadable — the exported file keeps the raw src
        }
      },
    });
  }

  /** Suggested `.html` filename: the file's own basename, or the title slug. */
  function suggestedName(tab: TabEntry): string {
    const base =
      tab.kind === 'file' && tab.filePath
        ? stripExtension(baseName(tab.filePath))
        : slugifyTitle(tab.title);
    return `${base}.html`;
  }

  async function exportActiveTabHtml(): Promise<void> {
    const tab = activeTextTab();
    if (!tab) {
      return;
    }
    const target = await ctx.saveDialog(suggestedName(tab), HTML_FILTERS);
    if (!target) {
      return; // user cancelled
    }
    try {
      const html = await buildTabHtml(tab);
      await ctx.ipc.atomicWriteText(target, html);
      uiStore.getState().showNotice(`Exported to ${target}`);
    } catch (error) {
      ctx.deps.onError?.(error);
      uiStore.getState().showNotice('Could not export the document.');
    }
  }

  async function printActiveTab(): Promise<void> {
    if (isAndroid()) {
      uiStore.getState().showNotice('Use Export as HTML on Android.');
      return;
    }
    const tab = activeTextTab();
    if (!tab) {
      return;
    }
    let html: string;
    try {
      html = await buildTabHtml(tab);
    } catch (error) {
      ctx.deps.onError?.(error);
      uiStore.getState().showNotice('Could not prepare the document for printing.');
      return;
    }
    // A hidden same-origin iframe (srcdoc) renders the export, then its OWN
    // window prints — so the print dialog shows the standalone document, not
    // the app UI. The app CSP allows this: styles are inline-allowed and
    // images arrive as data: URLs.
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.setAttribute('aria-hidden', 'true');

    let done = false;
    function cleanup(): void {
      if (!done) {
        done = true;
        iframe.remove();
      }
    }

    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        return;
      }
      // `afterprint` fires when the dialog closes (printed OR cancelled); the
      // timeout is a belt-and-suspenders fallback so a browser that never
      // fires it can't leak iframes forever.
      win.addEventListener('afterprint', () => setTimeout(cleanup, 0));
      setTimeout(cleanup, PRINT_CLEANUP_FALLBACK_MS);
      // Give mermaid SVGs / fonts a beat to settle before the dialog snapshots.
      setTimeout(() => win.print(), PRINT_SETTLE_MS);
    });
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  }

  return { exportActiveTabHtml, printActiveTab };
}
