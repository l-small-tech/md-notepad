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
import { renderMermaidBlocks } from './mermaid';
import { createRenderSequence, renderMarkdownToHtml } from './pipeline';

const RENDER_DEBOUNCE_MS = 200;

export interface PreviewPaneOptions {
  dark: boolean;
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

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
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
