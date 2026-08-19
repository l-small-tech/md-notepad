/**
 * Export — the "Export…" preview dialog's engine. One entry point per surface
 * (the ☰ menu / palette exports the active tab; the explorer's right-click
 * menu exports any .md file by path, open or not), both landing in the same
 * preview dialog where the user picks a format (HTML / PDF / DOCX) and a
 * theme, sees the themed render, and confirms.
 *
 * - HTML: `buildStandaloneHtml` — the preview pipeline's sanitized render,
 *   export.css inlined, mermaid rendered to SVG, local images inlined as
 *   data: URLs. The chosen theme is injected as a `:root { --x: v; … }` block
 *   appended to the stylesheet (export.css only CONSUMES variables).
 * - PDF: `markdownToPdfBase64` (core, pure) — pdfmake generates the bytes
 *   directly; no print dialog, works on Android too. The theme maps onto
 *   `PdfTheme` colors via `pdfThemeFromPlugin`.
 * Embedded .svg images are the one thing CSS can't reach — an <img> is opaque
 * to the page's stylesheet — so when "Theme SVG" is on, the svg's own markup
 * is recolored onto the theme's ink/paper (`core/export/svg-theme`) before it
 * is inlined: HTML re-encodes it as a data: URL, PDF hands the markup to
 * pdfmake's native SVG block. DOCX has no SVG path either way (Word styles).
 *
 * - DOCX: `markdownToDocxBase64` (core, pure) — standard Word styles (Word's
 *   own style gallery restyles documents; hard-coding theme hex would fight
 *   it). This layer supplies the image resolver for both converters (bytes
 *   via ipc + dimensions via a DOM Image, which core must not touch).
 *
 * Both generators load lazily (dynamic import) so their weight stays out of
 * the startup bundle, mirroring how mammoth (DOCX import) is loaded.
 *
 * Lives in src/ui/session (ui layer) so importing src/preview/export is legal
 * (ui → preview).
 */

import type { DocSource } from '../../core/export/doc-source';
import { imageMimeType, localImageToInline } from '../../core/images';
import { baseName, dirName } from '../../core/session/plan-flush';
import { themeDeclarations, type ThemePlugin } from '../../core/theme-plugins';
import { svgThemeFromPlugin, themeSvg } from '../../core/export/svg-theme';
import { slugifyTitle, stripExtension } from '../../core/title';
import { buildStandaloneHtml } from '../../preview/export';
import exportCss from '../../preview/export.css?raw';
import { exportPreviewStore } from '../stores/export-preview';
import { tabsStore, type TabEntry } from '../stores/tabs';
import { themeRegistryStore } from '../stores/theme-registry';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { pathKey } from './facade';

const HTML_FILTERS = [{ name: 'HTML', extensions: ['html'] }];
const PDF_FILTERS = [{ name: 'PDF', extensions: ['pdf'] }];
const DOCX_FILTERS = [{ name: 'Word document', extensions: ['docx'] }];

/** The theme applied to an export: a plugin (or none = default palette). The
 *  `dark` seed only matters for the default palette — a chosen plugin's own
 *  declared `mode` decides the export's darkness. */
interface ExportTheme {
  plugin: ThemePlugin | null;
  dark: boolean;
  /** Recolor embedded .svg images onto this theme's ink/paper. */
  svg: boolean;
}

/** The effective darkness of an export theme (see ExportTheme). */
function isDarkTheme(theme: ExportTheme): boolean {
  return theme.plugin ? theme.plugin.mode === 'dark' : theme.dark;
}

/** Intrinsic pixel size of an image data: URL, or null if it won't decode. */
function measureImage(dataUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** True for a path the SVG recolorer can work on. */
function isSvgPath(path: string): boolean {
  return path.toLowerCase().endsWith('.svg');
}

/** An svg data: URL for an <img> src — percent-encoded rather than base64 so
 *  the markup stays readable in the exported file (and stays UTF-8 safe). */
function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/** The loaded plugin for `themeId`, or null (unknown id → default palette). */
function resolveTheme(themeId: string): ThemePlugin | null {
  return themeRegistryStore.getState().plugins.find((p) => p.id === themeId) ?? null;
}

/** Theme seed for a fresh dialog: whatever the app is currently rendering. */
function seedFromDom(): { themeId: string; dark: boolean } {
  const root = document.documentElement;
  return {
    themeId: root.dataset.colorScheme ?? 'light-green',
    dark: root.dataset.theme === 'dark',
  };
}

export function createExport(ctx: SessionCtx) {
  /**
   * The tab to export — the one named, else the active one — if it holds
   * markdown text; otherwise notice + null. A tab's own context menu names
   * its id, because right-clicking a tab does not activate it.
   */
  function textTabFor(tabId?: string): TabEntry | null {
    const tabs = tabsStore.getState();
    const tab = tabId === undefined ? tabs.activeTab() : tabs.tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind === 'image' || tab.kind === 'import') {
      uiStore.getState().showNotice('Open a note or markdown file to export it.');
      return null;
    }
    return tab;
  }

  function sourceFromTab(tab: TabEntry): DocSource {
    const docPath = tab.filePath ?? tab.notePath;
    return {
      markdown: tab.model.getText(),
      title: tab.title,
      docPath: docPath ?? null,
      suggestedBase:
        tab.kind === 'file' && tab.filePath
          ? stripExtension(baseName(tab.filePath))
          : slugifyTitle(tab.title),
    };
  }

  /**
   * A file on disk as an export source — but if a tab already owns the path,
   * its live (possibly unsaved) text wins, so what exports is what you see.
   */
  async function sourceFromPath(path: string): Promise<DocSource | null> {
    const owner = ctx.tabOwning(pathKey(path));
    if (owner) {
      return sourceFromTab(owner);
    }
    try {
      const { text } = await ctx.ipc.readTextFile(path);
      const base = stripExtension(baseName(path));
      return { markdown: text, title: base, docPath: path, suggestedBase: base };
    } catch (error) {
      ctx.deps.onError?.(error);
      uiStore.getState().showNotice('Could not read the file to export.');
      return null;
    }
  }

  /**
   * The standalone document for `src`, styled by `theme`: export.css plus an
   * appended `:root` block of the chosen plugin+mode's variables (nothing
   * appended for the default palette — export.css's fallbacks ARE the default
   * greens). Images resolve through the session's ipc with the preview pane's
   * relative-path rules, against the note's own directory; an unsaved doc (no
   * path) leaves relative refs as-is, exactly like the pane.
   */
  function buildDocHtml(src: DocSource, theme: ExportTheme): Promise<string> {
    const docDir = src.docPath ? dirName(src.docPath) : null;
    const cache = new Map<string, string>();
    const declarations = theme.plugin ? themeDeclarations(theme.plugin) : '';
    const css = declarations.length > 0 ? `${exportCss}\n:root {\n${declarations}\n}` : exportCss;
    return buildStandaloneHtml(src.markdown, {
      title: src.title,
      css,
      dark: isDarkTheme(theme),
      async resolveImage(imgSrc) {
        const abs = localImageToInline(docDir, imgSrc);
        if (!abs) {
          return null; // external / data: / unresolvable — leave the src alone
        }
        const cached = cache.get(abs);
        if (cached !== undefined) {
          return cached;
        }
        if (theme.svg && isSvgPath(abs)) {
          try {
            const { text } = await ctx.ipc.readTextFile(abs);
            const url = svgDataUrl(themeSvg(text, svgThemeFromPlugin(theme.plugin)));
            cache.set(abs, url);
            return url;
          } catch {
            return null; // unreadable — fall through to the raw src
          }
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

  /** Shared error tail: report, notice, and keep the dialog open. */
  function exportFailed(error: unknown): false {
    ctx.deps.onError?.(error);
    uiStore.getState().showNotice('Could not export the document.');
    return false;
  }

  /** Each exporter resolves true when finished (saved OR user-cancelled) and
   *  false on error — the dialog closes on true, stays open to retry on false. */
  async function exportHtmlFrom(src: DocSource, theme: ExportTheme): Promise<boolean> {
    const target = await ctx.saveDialog(`${src.suggestedBase}.html`, HTML_FILTERS);
    if (!target) {
      return true; // user cancelled
    }
    try {
      const html = await buildDocHtml(src, theme);
      await ctx.ipc.atomicWriteText(target, html);
      uiStore.getState().showNotice(`Exported to ${target}`);
      return true;
    } catch (error) {
      return exportFailed(error);
    }
  }

  async function exportPdfFrom(src: DocSource, theme: ExportTheme): Promise<boolean> {
    const target = await ctx.saveDialog(`${src.suggestedBase}.pdf`, PDF_FILTERS);
    if (!target) {
      return true; // user cancelled
    }
    const docDir = src.docPath ? dirName(src.docPath) : null;
    try {
      // Dynamic import: pdfmake + its font bundle stay out of the startup
      // bundle, mirroring how mammoth (DOCX import) is loaded.
      const { markdownToPdfBase64, isPdfSvg, pdfImageType, pdfThemeFromPlugin } =
        await import('../../core/export/pdf');
      const { svgIntrinsicSize } = await import('../../core/export/svg-theme');
      const base64 = await markdownToPdfBase64(src.markdown, {
        title: src.title,
        theme: pdfThemeFromPlugin(theme.plugin),
        async resolveImage(imgSrc) {
          const abs = localImageToInline(docDir, imgSrc);
          if (!abs) {
            return null; // external / data: URLs — degrade to alt text
          }
          if (isPdfSvg(abs)) {
            try {
              const { text } = await ctx.ipc.readTextFile(abs);
              const svgTheme = svgThemeFromPlugin(theme.plugin);
              const markup = theme.svg ? themeSvg(text, svgTheme) : text;
              // No intrinsic size (a `100%`-sized svg with no viewBox): fall
              // back to a full-width box — the converter clamps it to the
              // content width, which is what such an svg asks for anyway.
              const size = svgIntrinsicSize(markup) ?? { width: 1000, height: 1000 };
              return { svg: markup, ...size };
            } catch {
              return null; // unreadable — degrade to alt text
            }
          }
          if (!pdfImageType(abs)) {
            return null; // gif/webp/… — no pdfkit decoder, degrade to alt text
          }
          try {
            const dataUrl = `data:${imageMimeType(abs)};base64,${await ctx.ipc.readFileBase64(abs)}`;
            const dims = await measureImage(dataUrl);
            return dims ? { dataUrl, ...dims } : null;
          } catch {
            return null; // missing/unreadable
          }
        },
      });
      await ctx.ipc.writeFileBase64(target, base64);
      uiStore.getState().showNotice(`Exported to ${target}`);
      return true;
    } catch (error) {
      return exportFailed(error);
    }
  }

  async function exportDocxFrom(src: DocSource): Promise<boolean> {
    const target = await ctx.saveDialog(`${src.suggestedBase}.docx`, DOCX_FILTERS);
    if (!target) {
      return true; // user cancelled
    }
    const docDir = src.docPath ? dirName(src.docPath) : null;
    try {
      const { markdownToDocxBase64, docxImageType } = await import('../../core/export/docx');
      const base64 = await markdownToDocxBase64(src.markdown, {
        async resolveImage(imgSrc) {
          const abs = localImageToInline(docDir, imgSrc);
          if (!abs) {
            return null; // external / data: URLs — degrade to alt text
          }
          const type = docxImageType(abs);
          if (!type) {
            return null; // webp/svg/… — no docx raster type
          }
          try {
            const data = await ctx.ipc.readFileBase64(abs);
            const dims = await measureImage(`data:${imageMimeType(abs)};base64,${data}`);
            return dims ? { data, type, ...dims } : null;
          } catch {
            return null; // missing/unreadable
          }
        },
      });
      await ctx.ipc.writeFileBase64(target, base64);
      uiStore.getState().showNotice(`Exported to ${target}`);
      return true;
    } catch (error) {
      return exportFailed(error);
    }
  }

  /** Palette / tab context menu: open the export preview on a tab. */
  function openExportPreview(tabId?: string): void {
    const tab = textTabFor(tabId);
    if (tab) {
      exportPreviewStore.getState().openWith(sourceFromTab(tab), seedFromDom());
    }
  }

  /** Explorer context menu: open the export preview on a .md file by path. */
  async function openExportPreviewForFile(path: string): Promise<void> {
    const src = await sourceFromPath(path);
    if (src) {
      exportPreviewStore.getState().openWith(src, seedFromDom());
    }
  }

  /** The dialog's preview iframe content for the current theme selection. */
  function buildPreviewHtml(
    source: DocSource,
    themeId: string,
    dark: boolean,
    svg: boolean,
  ): Promise<string> {
    return buildDocHtml(source, { plugin: resolveTheme(themeId), dark, svg });
  }

  /**
   * The dialog's Export button: run the store's current selection. Closes the
   * dialog when the export finished or the user cancelled the save dialog;
   * stays open on failure so the selection isn't lost.
   */
  async function runExportFromPreview(): Promise<void> {
    const { source, format, themeId, dark, themeSvg: svg } = exportPreviewStore.getState();
    if (!source) {
      return;
    }
    const theme: ExportTheme = { plugin: resolveTheme(themeId), dark, svg };
    const done =
      format === 'html'
        ? await exportHtmlFrom(source, theme)
        : format === 'pdf'
          ? await exportPdfFrom(source, theme)
          : await exportDocxFrom(source);
    if (done) {
      exportPreviewStore.getState().close();
    }
  }

  return {
    openExportPreview,
    openExportPreviewForFile,
    runExportFromPreview,
    buildPreviewHtml,
  };
}
