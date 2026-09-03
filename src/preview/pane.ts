/**
 * Wires the markdown pipeline + mermaid renderer into one live preview pane
 * (src/preview/README.md "Render loop" / "Link policy"). Mirrors the shape
 * of an `EditorAdapter` (attach once, dispose once) but is not one: the
 * preview pane is a plain DOM projection of the DocModel, never a source of
 * truth, so it needs no write-back guard and no mode-sync integration —
 * EditorHost mounts/unmounts it directly whenever a tab is in `split` mode.
 */

import type { DocModel } from '../core/doc-model';
import { isExternalHref } from '../core/external-links';
import { imageMimeType, isImagePath, localImageToInline } from '../core/images';
import { isLocalLinkTarget } from '../core/link-mentions';
import { dirName, toAbsolutePath } from '../core/session/plan-flush';
import { boardColorModeOf } from '../core/whiteboard/color-mode';
import type { BoardColorMode } from '../core/whiteboard/scene';
import {
  boardThemeFingerprint,
  injectBoardThemeVars,
  isThemableBoardSvg,
  WB_THEME_VAR_NAMES,
  type BoardThemeVars,
} from '../core/whiteboard/theme-inject';
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
  /**
   * Notified whenever the followed-link history goes empty↔non-empty, i.e. when
   * the Back affordance appears or disappears. Lets a host surface Back outside
   * the pane (the fullscreen control cluster) instead of the in-pane bar.
   */
  onCanGoBackChange?: (canGoBack: boolean) => void;
  /**
   * A rendered mermaid diagram was clicked; receives the diagram's SVG markup
   * as rendered (theme colors baked in). Lets the host open a fullscreen
   * zoomable viewer OUTSIDE the pane (same surface-state-outward shape as
   * `onCanGoBackChange`). Omit and diagram clicks stay inert.
   */
  onOpenDiagram?: (svgMarkup: string) => void;
  /**
   * An `http(s)` link was clicked. The pane never opens it itself: the host
   * confirms the destination with the reader first (`ui/stores/external-link`)
   * because the window can never show a remote page and the link's label can
   * say anything. Omit and external links are inert.
   */
  onOpenExternal?: (url: string) => void;
  /**
   * A whiteboard image (a `.svg` with the dual colour representation, see
   * `core/whiteboard/color-mode.ts`) was right-clicked. Receives the board's
   * absolute path, the mode it currently renders in, and the pointer position
   * — the host opens its "theme colours / true colours" menu OUTSIDE the pane
   * (same outward shape as `onOpenDiagram`). Foreign SVGs and other images
   * never fire this. Omit and board right-clicks stay inert.
   */
  onBoardContextMenu?: (info: BoardContextMenuInfo) => void;
}

export interface BoardContextMenuInfo {
  path: string;
  mode: BoardColorMode;
  x: number;
  y: number;
}

/** One followed link in the in-pane navigation history: its path + cached text. */
interface NavEntry {
  path: string;
  text: string;
}

export interface PreviewPane {
  /** Mermaid bakes colors in at render time — a theme flip needs a fresh render. */
  setDark(dark: boolean): void;
  /**
   * The selected theme changed WITHOUT flipping light/dark (one light theme to
   * another). Whiteboard images bake the theme's `--wb-*` palette into their
   * data URLs, so they need a re-render even though mermaid's boolean didn't
   * move. Deferred a frame so the new theme's CSS is applied before the vars
   * are read.
   */
  refreshTheme(): void;
  /**
   * Update the previewed document's path (e.g. an untitled note just got saved
   * to disk). Relative link/image resolution starts using the new directory. A
   * no-op when the directory is unchanged, so it's safe to call on every store
   * tick without churning renders.
   */
  setDocPath(docPath: string | null | undefined): void;
  /** Pop the current followed-link page (same as the in-pane Back button). */
  goBack(): void;
  /**
   * Scroll the nth rendered heading (0-based, document order across h1–h6)
   * into view — the outline panel's read-mode jump. No-op when the index is
   * out of range or the last render hasn't landed in the DOM yet.
   */
  scrollToHeading(index: number): void;
  /**
   * The files at these absolute paths changed on disk (the colour-mode toggle
   * just rewrote a board). Their cached data URLs are dropped and the pane
   * re-renders so the new bytes show; paths not on screen cost nothing.
   */
  refreshImages(paths: readonly string[]): void;
  dispose(): void;
}

/**
 * The app theme's resolved `--wb-*` palette, read off `<html>` — the same
 * source the draw adapter themes the live board from (base.css derives these
 * from the current theme's brand trio, so I9 stays intact: no ui import).
 */
export function readBoardThemeVars(): BoardThemeVars {
  const resolved = getComputedStyle(document.documentElement);
  const vars = new Map<string, string>();
  for (const name of WB_THEME_VAR_NAMES) {
    const value = resolved.getPropertyValue(name).trim();
    if (value.length > 0) {
      vars.set(name, value);
    }
  }
  return vars;
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
  // The directory relative refs resolve against for the tab's own document.
  // Mutable: a freshly-created untitled note starts with no path (docDir=null)
  // and is assigned one later by the flusher — `setDocPath` pushes that in so
  // in-pane relative links/images start resolving without a remount.
  let docDir = options.docPath ? dirName(options.docPath) : null;
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
  // Absolute svg path → its colour mode (null = not a board), filled alongside
  // the data URL so a cache hit can still tag the element for right-click.
  const boardModeCache = new Map<string, BoardColorMode | null>();

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
   *
   * A whiteboard `.svg` gets the app theme BAKED IN on the way past: an SVG
   * inside an `<img>` is a sealed document the page's `--wb-*` variables can
   * never reach, so the resolved values are injected as an inline `style` on
   * its root (inline beats the file's embedded palette block — the same trick
   * the draw adapter plays on the live board). The cache key carries the theme
   * fingerprint, so a theme change re-inlines while typing stays one read.
   */
  async function inlineLocalImages(token: number): Promise<void> {
    const dir = currentDir();
    if (!dir) {
      return;
    }
    const themeVars = readBoardThemeVars();
    const fingerprint = boardThemeFingerprint(themeVars);
    for (const img of [...host.querySelectorAll('img')]) {
      const raw = img.getAttribute('src') ?? '';
      const abs = localImageToInline(dir, raw);
      if (!abs) {
        continue;
      }
      const svg = abs.toLowerCase().endsWith('.svg');
      const key = svg ? `${abs}|${fingerprint}` : abs;
      let dataUrl = imageCache.get(key);
      if (dataUrl === undefined) {
        try {
          if (svg) {
            const { text } = await ipc.readTextFile(abs);
            const themed = isThemableBoardSvg(text) ? injectBoardThemeVars(text, themeVars) : text;
            dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed)}`;
            boardModeCache.set(abs, boardColorModeOf(text));
          } else {
            dataUrl = `data:${imageMimeType(abs)};base64,${await ipc.readFileBase64(abs)}`;
          }
          imageCache.set(key, dataUrl);
        } catch {
          continue; // missing/unreadable — leave the broken img as the signal
        }
        if (disposed || !sequence.isCurrent(token)) {
          return; // a newer render replaced the DOM while we were reading
        }
      }
      img.setAttribute('src', dataUrl);
      // Tag boards so the right-click handler can answer synchronously.
      const mode = svg ? boardModeCache.get(abs) : undefined;
      if (mode) {
        img.dataset.wbPath = abs;
        img.dataset.wbMode = mode;
      }
    }
  }

  async function render(): Promise<void> {
    const token = sequence.start();
    const html = await renderMarkdownToHtml(currentText());
    if (disposed || !sequence.isCurrent(token)) {
      return; // a newer render (text or theme change) already superseded this one
    }
    host.innerHTML = html;
    // The Back affordance for followed links lives OUTSIDE the pane (the ribbon
    // toolbar in normal mode, the fullscreen cluster in full screen) — surfaced
    // via `onCanGoBackChange` — so nothing is injected into the content here.
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
    notifyCanGoBack();
    clearTimer();
    await render();
    if (!disposed) {
      host.scrollTop = 0;
    }
  }

  /** Report whether Back is now available, but only when it actually flips. */
  let lastCanGoBack = false;
  function notifyCanGoBack(): void {
    const canGoBack = navStack.length > 0;
    if (canGoBack !== lastCanGoBack) {
      lastCanGoBack = canGoBack;
      options.onCanGoBackChange?.(canGoBack);
    }
  }

  /** Back button: drop the current page, revealing the previous one (or home). */
  function goBack(): void {
    if (navStack.length === 0) {
      return;
    }
    navStack.pop();
    notifyCanGoBack();
    clearTimer();
    void render();
  }

  function onClick(event: MouseEvent): void {
    const el = event.target as HTMLElement;
    // A click anywhere on a rendered diagram opens the fullscreen viewer.
    // Checked BEFORE the anchor branch: mermaid SVGs can contain <a> elements,
    // and the viewer takes priority over following a link baked into one.
    const diagram = el.closest('.mermaid-diagram');
    if (diagram) {
      event.preventDefault();
      options.onOpenDiagram?.(diagram.innerHTML);
      return;
    }
    const anchor = el.closest('a');
    if (!anchor) {
      return;
    }
    // The window must never navigate (README "Link policy") — every link click
    // is prevented. http(s) goes out to the host for confirmation before the
    // system browser sees it; a LOCAL file link is followed inside the pane
    // (markdown/text) or opened in a tab (images). In-document anchors (#…)
    // and other schemes (mailto:, …) stay inert.
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (isExternalHref(href)) {
      options.onOpenExternal?.(href);
    } else if (isLocalLinkTarget(href)) {
      void navigateTo(href);
    }
  }

  function onContextMenu(event: MouseEvent): void {
    const img = (event.target as HTMLElement).closest('img');
    const path = img?.dataset.wbPath;
    const mode = img?.dataset.wbMode;
    if (!path || (mode !== 'themed' && mode !== 'fixed') || !options.onBoardContextMenu) {
      return;
    }
    event.preventDefault();
    options.onBoardContextMenu({ path, mode, x: event.clientX, y: event.clientY });
  }

  // Model edits re-render only at home — while browsing a followed link, an
  // edit to the underlying tab must not yank the reader off the page.
  function onModelChange(): void {
    if (navStack.length === 0) {
      scheduleRender();
    }
  }

  host.addEventListener('click', onClick);
  host.addEventListener('contextmenu', onContextMenu);
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
    refreshTheme() {
      if (disposed) {
        return;
      }
      // Next frame: the caller reacts to the same store tick that swaps the
      // theme's stylesheet, and the vars must be READ after they are applied.
      requestAnimationFrame(() => {
        if (!disposed) {
          clearTimer();
          void render();
        }
      });
    },
    setDocPath(next) {
      if (disposed) {
        return;
      }
      const nextDir = next ? dirName(next) : null;
      if (nextDir === docDir) {
        return; // unchanged — no work, no needless re-render
      }
      docDir = nextDir;
      // While browsing a followed link the current dir comes from the nav stack,
      // so the tab's docDir change can't affect what's on screen — skip the
      // render. At home, re-render so relative images inline against the new
      // path (the same text, so an empty new note stays scrolled at the top).
      if (navStack.length === 0) {
        clearTimer();
        void render();
      }
    },
    goBack,
    scrollToHeading(index) {
      if (disposed || index < 0) {
        return;
      }
      const heading = host.querySelectorAll('h1,h2,h3,h4,h5,h6')[index];
      heading?.scrollIntoView({ block: 'center', behavior: 'auto' });
    },
    refreshImages(paths) {
      if (disposed || paths.length === 0) {
        return;
      }
      let hit = false;
      for (const abs of paths) {
        for (const key of [...imageCache.keys()]) {
          if (key === abs || key.startsWith(`${abs}|`)) {
            imageCache.delete(key);
            hit = true;
          }
        }
        if (boardModeCache.delete(abs)) {
          hit = true;
        }
      }
      if (hit) {
        clearTimer();
        void render();
      }
    },
    dispose() {
      disposed = true;
      clearTimer();
      unsubscribe();
      host.removeEventListener('click', onClick);
      host.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
