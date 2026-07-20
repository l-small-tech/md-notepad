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
import { themeModeDeclarations, type ThemePlugin } from '../../core/theme-plugins';
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

/** The theme applied to an export: a plugin (or none = default palette) + mode. */
interface ExportTheme {
  plugin: ThemePlugin | null;
  dark: boolean;
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
  /** The active tab if it holds markdown text; otherwise notice + null. */
  function activeTextTab(): TabEntry | null {
    const tab = tabsStore.getState().activeTab();
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
    const declarations = theme.plugin
      ? themeModeDeclarations(theme.plugin, theme.dark ? 'dark' : 'light')
      : '';
    const css = declarations.length > 0 ? `${exportCss}\n:root {\n${declarations}\n}` : exportCss;
    return buildStandaloneHtml(src.markdown, {
      title: src.title,
      css,
      dark: theme.dark,
      async resolveImage(imgSrc) {
        const abs = localImageToInline(docDir, imgSrc);
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
      const { markdownToPdfBase64, pdfImageType, pdfThemeFromPlugin } =
        await import('../../core/export/pdf');
      const base64 = await markdownToPdfBase64(src.markdown, {
        title: src.title,
        theme: pdfThemeFromPlugin(theme.plugin, theme.dark ? 'dark' : 'light'),
        async resolveImage(imgSrc) {
          const abs = localImageToInline(docDir, imgSrc);
          if (!abs || !pdfImageType(abs)) {
            return null; // external / non-PNG-JPEG — degrade to alt text
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

  /** ☰ menu / palette: open the export preview on the active tab. */
  function openExportPreview(): void {
    const tab = activeTextTab();
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
  function buildPreviewHtml(source: DocSource, themeId: string, dark: boolean): Promise<string> {
    return buildDocHtml(source, { plugin: resolveTheme(themeId), dark });
  }

  /**
   * The dialog's Export button: run the store's current selection. Closes the
   * dialog when the export finished or the user cancelled the save dialog;
   * stays open on failure so the selection isn't lost.
   */
  async function runExportFromPreview(): Promise<void> {
    const { source, format, themeId, dark } = exportPreviewStore.getState();
    if (!source) {
      return;
    }
    const theme: ExportTheme = { plugin: resolveTheme(themeId), dark };
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
