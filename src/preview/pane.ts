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
import { stampedLineFor } from '../core/mode-scroll';
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
import type { VoiceComment } from '../core/comments';
import { blockLineFor, notesByBlock } from '../core/note-marks';
import { ipc } from '../ipc/commands';
import { renderMermaidBlocks } from './mermaid';
import {
  buildCallout,
  buildMark,
  CALLOUT_CLASS,
  COMPOSER_CLASS,
  confirmDelete,
  fitNoteBoxes,
  MARK_CLASS,
  noteEditFromEvent,
} from './note-marks';
import { createRenderSequence, renderMarkdownToHtml } from './pipeline';

const RENDER_DEBOUNCE_MS = 200;
/**
 * How long a `scrollToLine` keeps re-pinning its block to the top. The first
 * render lands text immediately but mermaid diagrams and inlined images
 * arrive later and change every height below them, so the anchor is re-applied
 * as each stage settles — until the window closes, or the reader scrolls and
 * takes over.
 */
const SCROLL_SETTLE_MS = 1500;

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
  /**
   * The reader pressed and held on a line of the tab's own document (touch or
   * mouse) — the voice-note gesture. Receives the 1-based SOURCE line under the
   * pointer, resolved from the `data-line` stamps the pipeline puts on every
   * element (so the pane renders with `sourceLines` whenever this is set). Only
   * fires while `setLineHold(true)` is in effect, and never on a followed link
   * (that page isn't the tab's document, so a line number would mislead).
   */
  onHoldLine?: (line: number) => void;
  /**
   * The reader changed a note's text in a marker's callout (see `setNotes`):
   * the note's id and its new text. Fires on commit (the box loses focus or
   * Ctrl+Enter), not per keystroke. Omit and the callout's text is read-only.
   */
  onEditNote?: (id: string, text: string) => void;
  /** The reader confirmed Delete on a callout note. Omit and there is no Delete. */
  onDeleteNote?: (id: string) => void;
  /**
   * The reader tapped "All notes" in a callout: the host opens its overview
   * of every review note. Omit and the callout has no such button.
   */
  onOpenAllNotes?: () => void;
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
  /**
   * Arm/disarm the press-and-hold line gesture (`onHoldLine`). While armed the
   * pane also suppresses the browser's own long-press behaviours — the context
   * menu and text-selection handles on Android — which would otherwise fire on
   * top of the gesture, and marks itself `data-line-hold` for styling.
   */
  setLineHold(on: boolean): void;
  /**
   * The review notes on the tab's document. Every top-level block that owns
   * one (`core/note-marks notesByBlock`) gets a marker in its margin
   * (`button.vn-mark`); a tap on the marker expands a callout of those notes
   * under the block — each editable (`onEditNote`), deletable
   * (`onDeleteNote`), with an "All notes" button (`onOpenAllNotes`). An
   * empty list removes every marker. Markers are re-applied after each
   * render and never shown on a followed link (not the tab's document).
   */
  setNotes(notes: readonly VoiceComment[]): void;
  /**
   * Put the host's inline note composer under the block that owns source
   * `line` (`core/note-marks blockLineFor`). `slot` is the host's element —
   * it renders the composer into it (a React portal) and the pane only
   * places it, again after every render, until `unmountComposer`. Calling
   * it for the same line again is a no-op; a new line moves the slot.
   */
  mountComposer(line: number, slot: HTMLElement): void;
  /** Take the composer out of the document (the note was saved or cancelled). */
  unmountComposer(): void;
  /**
   * Bring the notes on source `line` into view: the owning block scrolls to
   * the centre and its callout opens (and stays open; other open callouts
   * are untouched). Before the first render lands, the reveal waits for it.
   */
  revealNotes(target: { line: number }): void;
  /**
   * The 1-based source line of the block at the top of the pane, for the
   * mode-switch scroll anchor (`core/mode-scroll`). Null before the first
   * render lands, while browsing a followed link (those lines are not the
   * document's), and for a pane laid out at zero height.
   */
  getTopLine(): number | null;
  /**
   * Scroll the block owning that source line to the top. The anchor is held
   * for a moment so late-arriving diagrams and images can't drift it away
   * (`SCROLL_SETTLE_MS`), and is dropped the instant the reader scrolls.
   */
  scrollToLine(line: number): void;
  dispose(): void;
}

/** Hold duration before `onHoldLine` fires, and the drift that cancels it. */
const HOLD_MS = 500;
const HOLD_SLOP_PX = 10;

/**
 * The app theme's resolved `--wb-*` palette, read off `<html>` — the same
 * source the draw adapter themes the live board from (base.css derives these
 * from the current theme's brand trio, so I9 stays intact: no ui import).
 */
export function readBoardThemeVars(surface: Element | null = null): BoardThemeVars {
  const resolved = getComputedStyle(document.documentElement);
  const vars = new Map<string, string>();
  for (const name of WB_THEME_VAR_NAMES) {
    const value = resolved.getPropertyValue(name).trim();
    if (value.length > 0) {
      vars.set(name, value);
    }
  }
  // A board should vanish into the surface it sits on, which is not always
  // the palette's default (`--editor-bg`): swap `--wb-bg` for the nearest
  // painted ancestor's colour when a surface is given.
  const bg = surfaceBackground(surface);
  if (bg) {
    vars.set('--wb-bg', bg);
  }
  return vars;
}

/** The first non-transparent computed background colour at or above `el`. */
function surfaceBackground(el: Element | null): string | null {
  for (let node = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/.test(color)) {
      return color;
    }
  }
  return null;
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
    const themeVars = readBoardThemeVars(host);
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
    const html = await renderMarkdownToHtml(currentText(), { sourceLines: true });
    if (disposed || !sequence.isCurrent(token)) {
      return; // a newer render (text or theme change) already superseded this one
    }
    host.innerHTML = html;
    // The Back affordance for followed links lives OUTSIDE the pane (the ribbon
    // toolbar in normal mode, the fullscreen cluster in full screen) — surfaced
    // via `onCanGoBackChange` — so nothing is injected into the content here.
    applyNotes();
    // A mode-switch anchor is re-pinned as each stage settles: the text is
    // laid out now, the diagrams and images move everything below them later.
    applyPendingScroll();
    await renderMermaidBlocks(host, { dark });
    applyPendingScroll();
    await inlineLocalImages(token);
    applyPendingScroll();
  }

  /* ---- review-note markers ------------------------------------------- */
  let notes: readonly VoiceComment[] = [];
  /** Blocks (by first source line) whose callout is open; survives re-renders. */
  const expandedBlocks = new Set<number>();
  /** The block whose callout gets the arrival highlight on its next build. */
  let flashBlock: number | null = null;
  /** A `revealNotes` that arrived before the first render put blocks on screen. */
  let pendingReveal: number | null = null;
  /** The host's inline composer and the source line it was mounted for. */
  let composerSlot: HTMLElement | null = null;
  let composerLine: number | null = null;

  /** The top-level blocks' first source lines, in document order. */
  function blockLines(): number[] {
    return [...host.querySelectorAll<HTMLElement>(':scope > [data-line]')].map((b) =>
      Number(b.dataset.line),
    );
  }

  function blockAt(line: number): HTMLElement | null {
    return host.querySelector<HTMLElement>(`:scope > [data-line="${line}"]`);
  }

  /**
   * Rebuild the markers from `notes` over the current DOM: a zero-height
   * `.vn-mark-row` before each owning block holds the marker in the margin
   * without moving the text; the callout goes after the block. Nothing is
   * drawn while browsing a followed link (its lines are not the document's).
   * The composer slot, when mounted, is placed after its block the same way.
   */
  function applyNotes(): void {
    for (const el of host.querySelectorAll(`.vn-mark-row, .${CALLOUT_CLASS}`)) {
      el.remove();
    }
    if (navStack.length > 0) {
      composerSlot?.remove();
      return;
    }
    const blocks = [...host.querySelectorAll<HTMLElement>(':scope > [data-line]')];
    const lines = blocks.map((b) => Number(b.dataset.line));
    const grouped = notesByBlock(notes, lines);
    const doc = host.ownerDocument;
    const actions = {
      edit: options.onEditNote !== undefined,
      remove: options.onDeleteNote !== undefined,
      all: options.onOpenAllNotes !== undefined,
    };
    for (const block of blocks) {
      const line = Number(block.dataset.line);
      const own = grouped.get(line);
      if (!own) {
        continue;
      }
      // Duplicate first-lines (rare — a list item's paragraph) mark once.
      grouped.delete(line);
      const expanded = expandedBlocks.has(line);
      const row = doc.createElement('div');
      row.className = 'vn-mark-row';
      row.dataset.vnLine = String(line);
      row.appendChild(buildMark(doc, own.length, expanded));
      block.before(row);
      if (expanded) {
        const callout = buildCallout(doc, own, actions);
        if (flashBlock === line) {
          callout.classList.add('vn-flash');
          flashBlock = null;
        }
        // Under the composer when it is already in place: the new note first.
        (composerSlot?.previousElementSibling === block ? composerSlot : block).after(callout);
        fitNoteBoxes(callout);
      }
    }
    if (composerSlot && composerLine !== null) {
      // Moved only when it is not already where it belongs: a move would
      // take the keyboard focus out of the box being typed in.
      const owner = blockLineFor(composerLine, lines);
      const block = owner === undefined ? null : blockAt(owner);
      if (block) {
        if (composerSlot.previousElementSibling !== block) {
          block.after(composerSlot);
        }
      } else if (composerSlot.parentElement !== host) {
        host.appendChild(composerSlot); // an empty document: the slot is all there is
      }
    }
    if (pendingReveal !== null && lines.length > 0) {
      const line = pendingReveal;
      pendingReveal = null;
      revealNotes(line);
    }
  }

  function revealNotes(line: number): void {
    const lines = blockLines();
    const owner = blockLineFor(line, lines);
    if (owner === undefined) {
      pendingReveal = line; // nothing rendered yet — after the render, then
      return;
    }
    expandedBlocks.add(owner);
    flashBlock = owner;
    applyNotes();
    blockAt(owner)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---- mode-switch scroll anchor -------------------------------------- */

  /** The line to pin to the top, and the moment that claim expires. */
  let pendingScroll: number | null = null;
  let pendingScrollUntil = 0;

  /** The first block still showing at the pane's top edge — where the eye is. */
  function topLine(): number | null {
    if (navStack.length > 0) {
      return null; // a followed link: its lines aren't the document's
    }
    const box = host.getBoundingClientRect();
    if (box.height === 0) {
      return null;
    }
    let first: number | null = null;
    for (const el of host.querySelectorAll<HTMLElement>(':scope > [data-line]')) {
      const line = Number(el.dataset.line);
      if (first === null) {
        first = line;
      }
      if (el.getBoundingClientRect().bottom > box.top + 1) {
        return line;
      }
    }
    return first; // scrolled past the end, or nothing rendered
  }

  function applyPendingScroll(): void {
    if (pendingScroll === null) {
      return;
    }
    if (Date.now() > pendingScrollUntil) {
      pendingScroll = null;
      return;
    }
    const target = stampedLineFor(blockLines(), pendingScroll);
    const block = target === null ? null : blockAt(target);
    if (!block) {
      return; // nothing rendered yet — the render that lands blocks retries
    }
    // 'instant' beats 'auto', which would inherit `.reader-preview`'s smooth
    // scrolling: restoring a position should not be a visible ride, and an
    // animation would still be running when the next render stage lands.
    host.scrollTo({
      top: host.scrollTop + block.getBoundingClientRect().top - host.getBoundingClientRect().top,
      behavior: 'instant',
    });
  }

  /** The reader took over — stop re-pinning the anchor under them. */
  function dropPendingScroll(): void {
    pendingScroll = null;
  }

  /** A tap on a marker or one of its callout's buttons; true when it was one. */
  function onNoteClick(el: Element): boolean {
    const mark = el.closest<HTMLElement>(`.${MARK_CLASS}`);
    if (mark) {
      const line = Number(mark.parentElement?.dataset.vnLine);
      if (!Number.isNaN(line)) {
        if (expandedBlocks.has(line)) {
          expandedBlocks.delete(line);
        } else {
          expandedBlocks.add(line);
        }
        applyNotes();
      }
      return true;
    }
    const del = el.closest<HTMLElement>('[data-vn-delete]');
    if (del) {
      if (confirmDelete(del, window) && del.dataset.vnDelete) {
        options.onDeleteNote?.(del.dataset.vnDelete);
      }
      return true;
    }
    if (el.closest('[data-vn-all]')) {
      options.onOpenAllNotes?.();
      return true;
    }
    return false;
  }

  /** A callout text box committed an edit. */
  function onChange(event: Event): void {
    const edit = noteEditFromEvent(event);
    if (edit) {
      options.onEditNote?.(edit.id, edit.text);
    }
  }

  /** Ctrl/Cmd+Enter in a callout box commits it (blur fires `change`). */
  function onKeyDown(event: KeyboardEvent): void {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      event.target instanceof HTMLTextAreaElement &&
      event.target.classList.contains('vn-note-text')
    ) {
      event.preventDefault();
      event.target.blur();
    }
  }

  /** Inside the composer or a callout: the pane's own gestures stay out. */
  function inNoteUi(target: EventTarget | null): boolean {
    return (
      target instanceof Element && target.closest(`.${COMPOSER_CLASS}, .${CALLOUT_CLASS}`) !== null
    );
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
    if (onNoteClick(el)) {
      event.preventDefault();
      return;
    }
    if (inNoteUi(el)) {
      return; // the composer's and callouts' own controls
    }
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
    if (holdArmed) {
      // A long-press on Android surfaces the context menu / selection handles
      // right where the hold gesture is happening — keep the surface quiet.
      event.preventDefault();
      return;
    }
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

  /* ---- press-and-hold line gesture (voice notes) ---------------------- */
  let holdArmed = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdX = 0;
  let holdY = 0;
  let holdTarget: Element | null = null;

  function clearHold(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (!holdArmed || !options.onHoldLine || navStack.length > 0 || inNoteUi(event.target)) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    holdX = event.clientX;
    holdY = event.clientY;
    holdTarget = event.target instanceof Element ? event.target : null;
    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (disposed) {
        return;
      }
      const line = lineAtPoint(holdTarget, holdY);
      if (line !== null) {
        options.onHoldLine?.(line);
      }
    }, HOLD_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    if (
      holdTimer !== null &&
      (Math.abs(event.clientX - holdX) > HOLD_SLOP_PX ||
        Math.abs(event.clientY - holdY) > HOLD_SLOP_PX)
    ) {
      clearHold();
    }
  }

  /**
   * The source line for a press: the innermost stamped element at the pressed
   * target, else — for a press in the margin or in the gap between blocks — the
   * nearest stamped block above the press (a reader holding "beside" a
   * paragraph means that paragraph).
   */
  function lineAtPoint(target: Element | null, y: number): number | null {
    const stamped = target?.closest<HTMLElement>('[data-line]');
    if (stamped && host.contains(stamped)) {
      return Number(stamped.dataset.line);
    }
    let best: HTMLElement | null = null;
    for (const el of host.querySelectorAll<HTMLElement>(':scope > [data-line]')) {
      if (el.getBoundingClientRect().top <= y) {
        best = el;
      } else {
        break;
      }
    }
    return best ? Number(best.dataset.line) : null;
  }

  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', clearHold);
  host.addEventListener('pointercancel', clearHold);
  host.addEventListener('pointerleave', clearHold);
  host.addEventListener('wheel', dropPendingScroll, { passive: true });
  host.addEventListener('touchmove', dropPendingScroll, { passive: true });
  host.addEventListener('keydown', dropPendingScroll);
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
    setLineHold(on) {
      holdArmed = on;
      clearHold();
      if (on) {
        host.dataset.lineHold = '';
      } else {
        delete host.dataset.lineHold;
      }
    },
    setNotes(next) {
      if (disposed || next === notes) {
        return;
      }
      notes = next;
      applyNotes();
    },
    mountComposer(line, slot) {
      if (disposed || (slot === composerSlot && line === composerLine)) {
        return;
      }
      composerSlot?.remove();
      composerSlot = slot;
      composerLine = line;
      slot.classList.add(COMPOSER_CLASS);
      applyNotes();
    },
    unmountComposer() {
      if (!composerSlot) {
        return;
      }
      composerSlot.remove();
      composerSlot = null;
      composerLine = null;
    },
    revealNotes(target) {
      if (!disposed && navStack.length === 0) {
        revealNotes(target.line);
      }
    },
    getTopLine() {
      return disposed ? null : topLine();
    },
    scrollToLine(line) {
      if (disposed || navStack.length > 0) {
        return;
      }
      pendingScroll = line;
      pendingScrollUntil = Date.now() + SCROLL_SETTLE_MS;
      applyPendingScroll();
    },
    dispose() {
      disposed = true;
      clearTimer();
      clearHold();
      unsubscribe();
      composerSlot?.remove();
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onChange);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', clearHold);
      host.removeEventListener('pointercancel', clearHold);
      host.removeEventListener('pointerleave', clearHold);
      host.removeEventListener('wheel', dropPendingScroll);
      host.removeEventListener('touchmove', dropPendingScroll);
      host.removeEventListener('keydown', dropPendingScroll);
    },
  };
}
