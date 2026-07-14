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
import { imageMimeType, isImagePath, localImageToInline } from '../core/images';
import { isLocalLinkTarget } from '../core/link-mentions';
import { dirName, toAbsolutePath } from '../core/session/plan-flush';
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
  /**
   * Open a local file the reader can't display inline (an image, or a file
   * that won't read as text) in a tab. Called when a local link points at such
   * a target; omit and those links become inert. Markdown/text links are
   * followed IN the pane instead (see "Link policy" — in-pane reader nav).
   */
  onOpenFile?: (path: string) => void;
}

/** One followed link in the in-pane navigation history: its path + cached text. */
interface NavEntry {
  path: string;
  text: string;
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
  /**
   * Followed-link history. Empty = showing the tab's own live model ("home").
   * A non-empty stack means we're browsing a linked document read-only; the top
   * entry is what renders and the Back button pops it. Model edits are ignored
   * while browsing (they'd yank the reader off the page they're on).
   */
  const navStack: NavEntry[] = [];
  // Absolute image path → data URL, cached for the pane's lifetime so typing
  // (which re-renders on every keystroke) re-reads each image at most once.
  const imageCache = new Map<string, string>();

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** The markdown to render now: the browsed link's text, or the live model. */
  function currentText(): string {
    const top = navStack[navStack.length - 1];
    return top ? top.text : model.getText();
  }

  /** The directory relative image refs resolve against for the current source. */
  function currentDir(): string | null {
    const top = navStack[navStack.length - 1];
    return top ? dirName(top.path) : docDir;
  }

  /**
   * Swap every relative/local `<img>` src for a data URL read off disk. Runs
   * after each render; bails the moment a newer render supersedes this one so
   * it never mutates stale DOM. External (http/https) and already-inlined
   * (data:) images are left untouched.
   */
  async function inlineLocalImages(token: number): Promise<void> {
    const dir = currentDir();
    if (!dir) {
      return;
    }
    for (const img of [...host.querySelectorAll('img')]) {
      const raw = img.getAttribute('src') ?? '';
      const abs = localImageToInline(dir, raw);
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
    const html = await renderMarkdownToHtml(currentText());
    if (disposed || !sequence.isCurrent(token)) {
      return; // a newer render (text or theme change) already superseded this one
    }
    host.innerHTML = html;
    // A Back button leads the content whenever we're browsing a followed link.
    // Re-created each render (innerHTML wipes it); clicks route through the
    // delegated `onClick` handler, so no per-render listener to clean up.
    if (navStack.length > 0) {
      const bar = document.createElement('div');
      bar.className = 'preview-nav';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'preview-back';
      back.textContent = '← Back';
      bar.appendChild(back);
      host.insertBefore(bar, host.firstChild);
    }
    await renderMermaidBlocks(host, { dark });
    await inlineLocalImages(token);
  }

  function scheduleRender(): void {
    clearTimer();
    timer = setTimeout(() => void render(), RENDER_DEBOUNCE_MS);
  }

  /**
   * Follow a local markdown/text link IN the pane: read it off disk, push it
   * onto the history, and render it (scrolled to the top, like a fresh page).
   * Images — and anything that won't read as text — hand off to `onOpenFile`
   * so they open in a tab (the reader can't show them inline). Relative
   * destinations resolve against the CURRENT page's directory, so chained
   * relative links keep working as you browse.
   */
  async function navigateTo(dest: string): Promise<void> {
    let target = dest;
    try {
      target = decodeURI(dest); // markdown encodes spaces (%20) etc. in hrefs
    } catch {
      // Malformed escape — fall back to the raw href.
    }
    const abs = toAbsolutePath(currentDir() ?? '', target);
    if (isImagePath(abs)) {
      options.onOpenFile?.(abs);
      return;
    }
    let text: string;
    try {
      ({ text } = await ipc.readTextFile(abs));
    } catch {
      // Missing, or binary/unreadable-as-text — let a tab handle (or report) it.
      options.onOpenFile?.(abs);
      return;
    }
    if (disposed) {
      return;
    }
    navStack.push({ path: abs, text });
    clearTimer();
    await render();
    if (!disposed) {
      host.scrollTop = 0;
    }
  }

  /** Back button: drop the current page, revealing the previous one (or home). */
  function goBack(): void {
    if (navStack.length === 0) {
      return;
    }
    navStack.pop();
    clearTimer();
    void render();
  }

  function onClick(event: MouseEvent): void {
    const el = event.target as HTMLElement;
    if (el.closest('.preview-back')) {
      event.preventDefault();
      goBack();
      return;
    }
    const anchor = el.closest('a');
    if (!anchor) {
      return;
    }
    // The window must never navigate (README "Link policy") — every link click
    // is prevented. http(s) opens the system browser; a LOCAL file link is
    // followed inside the pane (markdown/text) or opened in a tab (images).
    // In-document anchors (#…) and other schemes (mailto:, …) stay inert.
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (isExternalLink(href)) {
      void openUrl(href);
    } else if (isLocalLinkTarget(href)) {
      void navigateTo(href);
    }
  }

  // Model edits re-render only at home — while browsing a followed link, an
  // edit to the underlying tab must not yank the reader off the page.
  function onModelChange(): void {
    if (navStack.length === 0) {
      scheduleRender();
    }
  }

  host.addEventListener('click', onClick);
  const unsubscribe = model.subscribe(onModelChange);
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
