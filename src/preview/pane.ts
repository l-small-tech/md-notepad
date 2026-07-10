/**
 * Wires the markdown pipeline + mermaid renderer into one live preview pane
 * (src/preview/README.md "Render loop" / "Link policy"). Mirrors the shape
 * of an `EditorAdapter` (attach once, dispose once) but is not one: the
 * preview pane is a plain DOM projection of the DocModel, never a source of
 * truth, so it needs no write-back guard and no mode-sync integration —
 * EditorHost mounts/unmounts it directly whenever a tab is in `split` mode.
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import type { DocModel } from '../core/doc-model';
import { imageMimeType, localImageToInline } from '../core/images';
import { dirName } from '../core/session/plan-flush';
import { ipc } from '../ipc/commands';
import { renderMermaidBlocks } from './mermaid';
import { createRenderSequence, renderMarkdownToHtml } from './pipeline';

const RENDER_DEBOUNCE_MS = 200;

export interface PreviewPaneOptions {
  dark: boolean;
  /**
   * Path of the document being previewed. Relative image references are
   * resolved against its directory and inlined as data URLs (local files can't
   * load by path under the app CSP). Omit for an unsaved doc — images with a
   * relative path are then left as-is.
   */
  docPath?: string | null;
}

export interface PreviewPane {
  /** Mermaid bakes colors in at render time — a theme flip needs a fresh render. */
  setDark(dark: boolean): void;
  dispose(): void;
}

function isExternalLink(href: string): boolean {
  return /^https?:/i.test(href);
}

export function attachPreviewPane(
  host: HTMLElement,
  model: DocModel,
  options: PreviewPaneOptions,
): PreviewPane {
  let dark = options.dark;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sequence = createRenderSequence();
  const docDir = options.docPath ? dirName(options.docPath) : null;
  // Absolute image path → data URL, cached for the pane's lifetime so typing
  // (which re-renders on every keystroke) re-reads each image at most once.
  const imageCache = new Map<string, string>();

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Swap every relative/local `<img>` src for a data URL read off disk. Runs
   * after each render; bails the moment a newer render supersedes this one so
   * it never mutates stale DOM. External (http/https) and already-inlined
   * (data:) images are left untouched.
   */
  async function inlineLocalImages(token: number): Promise<void> {
    if (!docDir) {
      return;
    }
    for (const img of [...host.querySelectorAll('img')]) {
      const raw = img.getAttribute('src') ?? '';
      const abs = localImageToInline(docDir, raw);
      if (!abs) {
        continue;
      }
      let dataUrl = imageCache.get(abs);
      if (dataUrl === undefined) {
        try {
          dataUrl = `data:${imageMimeType(abs)};base64,${await ipc.readFileBase64(abs)}`;
          imageCache.set(abs, dataUrl);
        } catch {
          continue; // missing/unreadable — leave the broken img as the signal
        }
        if (disposed || !sequence.isCurrent(token)) {
          return; // a newer render replaced the DOM while we were reading
        }
      }
      img.setAttribute('src', dataUrl);
    }
  }

  async function render(): Promise<void> {
    const token = sequence.start();
    const html = await renderMarkdownToHtml(model.getText());
    if (disposed || !sequence.isCurrent(token)) {
      return; // a newer render (text or theme change) already superseded this one
    }
    host.innerHTML = html;
    await renderMermaidBlocks(host, { dark });
    await inlineLocalImages(token);
  }

  function scheduleRender(): void {
    clearTimer();
    timer = setTimeout(() => void render(), RENDER_DEBOUNCE_MS);
  }

  function onClick(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) {
      return;
    }
    // The window must never navigate (README "Link policy") — every link
    // click is prevented; only http(s) additionally opens the system browser.
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (isExternalLink(href)) {
      void openUrl(href);
    }
  }

  host.addEventListener('click', onClick);
  const unsubscribe = model.subscribe(scheduleRender);
  void render(); // first paint, no need to wait out the typing debounce

  return {
    setDark(next) {
      if (disposed || dark === next) {
        return;
      }
      dark = next;
      clearTimer();
      void render();
    },
    dispose() {
      disposed = true;
      clearTimer();
      unsubscribe();
      host.removeEventListener('click', onClick);
    },
  };
}
