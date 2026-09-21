/**
 * Lazy Marp rendering — the engine behind every deck surface (the Split
 * column, the Present light table, the full-screen show, the HTML export).
 *
 * Rules this file exists to enforce:
 * - Invariant I8: `@marp-team/marp-core` (with MathJax and highlight.js in
 *   its tree, a multi-megabyte chunk) is imported ONLY when a deck is actually
 *   rendered. Callers gate on `isMarpDocument` first; a document that never
 *   renders as slides never pays for it.
 * - The sanitize exception (src/preview/README.md "Marp decks"): Marp output
 *   is NOT run through rehype-sanitize — it has to carry `<style>` and inline
 *   styles to be a deck at all. The equivalent posture is Marp's own HTML
 *   allowlist (`DECK_HTML_ALLOWLIST`: known-safe elements and attributes, no
 *   scripts, handlers or non-http links) and a shadow root around every slide
 *   so the theme CSS and the app CSS never see each other.
 * - Nothing here touches the network: emoji stay as unicode text (Marp's
 *   default swaps them for CDN images) and the browser helper is bundled.
 * - A render never throws at the caller: a half-written document mid-edit
 *   renders as whatever Marp makes of it, exactly like the mermaid pane's
 *   "never break mid-edit" rule.
 */

import { frontmatterValue, cleanNotes } from '../core/deck';
import { localImageToInline, imageMimeType } from '../core/images';
import { dirName, toAbsolutePath } from '../core/session/plan-flush';
import { ipc } from '../ipc/commands';

type MarpModule = typeof import('@marp-team/marp-core');
type MarpInstance = InstanceType<MarpModule['Marp']>;

let marpLoad: Promise<MarpInstance> | null = null;

/**
 * Author HTML in a deck passes Marp's default allowlist (I6's posture: an
 * allowlist, not a blocklist — `<div class>`, `<span>`, `<img>`, tables…;
 * never `<script>`, `<iframe>`, `on*` handlers, or `javascript:` links) plus
 * the `style` attribute on every allowed element. Slides are layout, and a
 * deck's `<style>` block cannot reach an element it has no hook on; the
 * shadow root's `contain: content` keeps any inline style inside its slide.
 */
function deckHtmlAllowlist(Marp: MarpModule['Marp']): MarpModule['Marp']['html'] {
  const allow: MarpModule['Marp']['html'] = {};
  for (const [tag, attrs] of Object.entries(Marp.html)) {
    allow[tag] = Array.isArray(attrs) ? [...attrs, 'style'] : { ...attrs, style: true };
  }
  return allow;
}

/**
 * True only for the duration of a `stampLines` render (`marp.render` is
 * synchronous, so a module flag is race-free). One engine serves both kinds
 * of render; the rule below is a no-op unless the flag is up.
 */
let stamping = false;

/** The attributes a stamped render carries — the deck editor's click map. */
export const LINE_ATTR = 'data-line';
export const LINE_END_ATTR = 'data-line-end';

/** Strip the stamps again (the editor's filmstrip must not remount on a line shift). */
export function stripLineStamps(html: string): string {
  return html.replace(/ data-line(?:-end)?="\d+"/g, '');
}

/**
 * A markdown-it core rule: every block token that knows its source lines gets
 * them as 1-based inclusive `data-line` / `data-line-end` attributes. Runs
 * after Marpit's own rules, whose `map`s are document-relative (the
 * frontmatter is consumed as a block, not cut off the input).
 */
function lineStampPlugin(md: {
  core: { ruler: { push(name: string, rule: (state: { tokens: MdToken[] }) => void): void } };
}): void {
  md.core.ruler.push('mdn_line_stamp', (state) => {
    if (!stamping) {
      return;
    }
    for (const token of state.tokens) {
      const stampable =
        token.map !== null &&
        !token.hidden &&
        (token.type === 'fence' ||
          token.type === 'code_block' ||
          (token.type.endsWith('_open') && !token.type.startsWith('marpit_')));
      if (stampable) {
        token.attrSet(LINE_ATTR, String(token.map![0] + 1));
        token.attrSet(LINE_END_ATTR, String(token.map![1]));
      }
    }
  });
}

interface MdToken {
  type: string;
  map: [number, number] | null;
  hidden: boolean;
  attrSet(name: string, value: string): void;
}

function loadMarp(): Promise<MarpInstance> {
  marpLoad ??= import('@marp-team/marp-core').then(({ Marp }) =>
    createMarp(Marp).use(lineStampPlugin as never),
  );
  return marpLoad;
}

function createMarp(Marp: MarpModule['Marp']): MarpInstance {
  return new Marp({
    html: deckHtmlAllowlist(Marp),
    // Scales each slide to its container with no JS (the SVG viewBox).
    inlineSVG: true,
    // Never inject Marp's own <script> into the HTML — `applyMarpBrowser`
    // runs the same helper against each slide root instead.
    script: false,
    // Keep emoji as text: the default renders them as images off a CDN.
    emoji: { shortcode: true, unicode: false },
  });
}

/** One rendered slide: its `<svg data-marpit-svg>` markup and speaker notes. */
export interface DeckSlide {
  html: string;
  notes: string[];
}

export interface DeckRender {
  /** The theme stylesheet for the whole deck (scoped to `div.marpit`). */
  css: string;
  slides: DeckSlide[];
  /** The slide size in CSS pixels (the theme's `size` directive, 1280×720 by default). */
  width: number;
  height: number;
}

export interface RenderDeckOptions {
  /**
   * The document's path, so a `theme: ./brand.css` in the frontmatter can be
   * read from disk relative to it. Omit for an unsaved document (a relative
   * theme is then left unresolved and Marp falls back to its default).
   */
  docPath?: string | null;
  /**
   * Stamp every rendered block with its source line range (`LINE_ATTR`). Only
   * the deck editor asks: a stamped slide's markup changes whenever a line is
   * added above it, which would remount — and flash — the read-only surfaces.
   */
  stampLines?: boolean;
}

const THEME_NAME = /\/\*\s*@theme\s+([^\s*]+)\s*\*\//;
const FRONTMATTER_THEME_LINE = /^(theme[ \t]*:[ \t]*)(.*?)[ \t]*$/m;

/** A theme value that names a stylesheet file rather than a built-in theme. */
function isThemeFile(theme: string): boolean {
  return /\.css$/i.test(theme);
}

/**
 * Render `markdown` as a deck. A `theme:` naming a `.css` file is read from
 * beside the document and registered with Marp under the name its
 * `/* @theme name *\/` comment declares (the way Marp CLI's `--theme-set`
 * works), and the frontmatter is rewritten to that name for this render
 * only — the file on disk keeps its relative path.
 */
export async function renderDeck(
  markdown: string,
  options: RenderDeckOptions = {},
): Promise<DeckRender> {
  const marp = await loadMarp();
  let source = markdown;
  const theme = frontmatterValue(markdown, 'theme');
  if (theme && isThemeFile(theme)) {
    const name = await registerThemeFile(marp, options.docPath ?? null, theme);
    if (name) {
      source = markdown.replace(FRONTMATTER_THEME_LINE, `$1${name}`);
    }
  }
  stamping = options.stampLines === true;
  let rendered: ReturnType<MarpInstance['render']>;
  try {
    rendered = marp.render(source);
  } finally {
    stamping = false;
  }
  const { html, css, comments } = rendered;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const svgs = [...doc.querySelectorAll<SVGSVGElement>('div.marpit > svg[data-marpit-svg]')];
  const first = svgs[0]?.getAttribute('viewBox')?.split(/\s+/).map(Number) ?? [];
  const width = first[2] && first[2] > 0 ? first[2] : 1280;
  const height = first[3] && first[3] > 0 ? first[3] : 720;
  return {
    css,
    width,
    height,
    slides: svgs.map((svg, i) => ({
      html: svg.outerHTML,
      notes: cleanNotes(comments[i] ?? []),
    })),
  };
}

/** Theme file path → the name it registered under (avoids re-reading on every keystroke). */
const themeNames = new Map<string, string>();

async function registerThemeFile(
  marp: MarpInstance,
  docPath: string | null,
  theme: string,
): Promise<string | null> {
  if (!docPath) {
    return null; // unsaved: nothing to resolve a relative path against
  }
  const abs = toAbsolutePath(dirName(docPath), theme);
  const known = themeNames.get(abs);
  if (known) {
    return known;
  }
  try {
    const { text } = await ipc.readTextFile(abs);
    const name = THEME_NAME.exec(text)?.[1];
    if (!name) {
      return null; // not a Marp theme (no `@theme` header) — leave the default
    }
    marp.themeSet.add(text);
    themeNames.set(abs, name);
    return name;
  } catch {
    return null; // missing/unreadable — the default theme is the signal
  }
}

/** The theme cache is dropped when a theme file changes on disk. */
export function forgetThemeFile(absPath: string): void {
  themeNames.delete(absPath);
}

/**
 * The rules every slide root needs on top of the theme: the SVG fills its
 * container's width (Marpit only sizes it for print), and the frame does not
 * inherit the app's fonts or colours across the shadow boundary.
 */
export const DECK_ROOT_CSS = `
:host { all: initial; display: block; contain: content; }
div.marpit { display: block; }
div.marpit > svg[data-marpit-svg] { display: block; width: 100%; height: auto; }
`;

/**
 * Put the theme + one slide into `root` (a shadow root), reusing the style
 * element and only touching the slide when its markup changed — a deck that
 * re-renders every second while an agent writes it must not flash. `force`
 * remounts an unchanged slide anyway: the caller's inlined images went stale
 * (a theme change re-bakes whiteboard SVGs) and the markup is the way back to
 * the original `src` attributes.
 */
export function mountSlide(
  root: ShadowRoot,
  css: string,
  slideHtml: string,
  force = false,
): boolean {
  let style: HTMLStyleElement | null = null;
  let stage: HTMLDivElement | null = null;
  for (const child of root.children) {
    if (child instanceof HTMLStyleElement) {
      style = child;
    } else if (child instanceof HTMLDivElement && child.classList.contains('marpit')) {
      stage = child;
    }
  }
  if (!style) {
    style = root.ownerDocument.createElement('style');
    root.appendChild(style);
  }
  const fullCss = `${DECK_ROOT_CSS}\n${css}`;
  if (style.textContent !== fullCss) {
    style.textContent = fullCss;
  }
  if (!stage) {
    stage = root.ownerDocument.createElement('div');
    stage.className = 'marpit';
    root.appendChild(stage);
  }
  if (!force && mountedHtml.get(stage) === slideHtml) {
    return false;
  }
  stage.innerHTML = slideHtml;
  mountedHtml.set(stage, slideHtml);
  return true;
}

/** The markup each stage currently shows, so an unchanged slide is left alone. */
const mountedHtml = new WeakMap<Element, string>();

/**
 * Local images inside a rendered slide (or a whole deck): `<img src>` and
 * `url(...)` in inline styles — Marp's `![bg](./hero.png)` becomes a
 * `<figure style="background-image:url('./hero.png')">`. Each local path is
 * swapped for a data URL via `resolve` (which may cache). External and
 * already-inlined sources are left alone.
 */
export async function inlineDeckImages(
  root: ParentNode,
  docDir: string | null,
  resolve: (absPath: string) => Promise<string | null>,
): Promise<void> {
  if (!docDir) {
    return;
  }
  for (const img of [...root.querySelectorAll('img')]) {
    const abs = localImageToInline(docDir, img.getAttribute('src') ?? '');
    if (!abs) {
      continue;
    }
    const dataUrl = await resolve(abs);
    if (dataUrl) {
      img.setAttribute('src', dataUrl);
    }
  }
  for (const el of [...root.querySelectorAll<HTMLElement>('[style]')]) {
    const style = el.getAttribute('style') ?? '';
    if (!style.includes('url(')) {
      continue;
    }
    const parts: { raw: string; abs: string }[] = [];
    for (const m of style.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
      const abs = localImageToInline(docDir, m[2]!);
      if (abs) {
        parts.push({ raw: m[0], abs });
      }
    }
    let next = style;
    for (const { raw, abs } of parts) {
      const dataUrl = await resolve(abs);
      if (dataUrl) {
        next = next.replace(raw, `url("${dataUrl}")`);
      }
    }
    if (next !== style) {
      el.setAttribute('style', next);
    }
  }
}

/**
 * A data-URL resolver over the file IPC with a per-instance cache.
 * `transformSvg` rewrites an `.svg` file's text before it is encoded — the
 * deck pane bakes the app theme into whiteboard boards with it, the same way
 * the markdown preview does (an SVG inside an `<img>` is sealed; the page's
 * variables never reach it). The cache holds the TRANSFORMED result, so a
 * theme change needs a fresh resolver.
 */
export function createImageResolver(
  transformSvg: (text: string) => string = (text) => text,
): (absPath: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (abs) => {
    const hit = cache.get(abs);
    if (hit !== undefined) {
      return hit;
    }
    let dataUrl: string | null;
    try {
      dataUrl = abs.toLowerCase().endsWith('.svg')
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(transformSvg((await ipc.readTextFile(abs)).text))}`
        : `data:${imageMimeType(abs)};base64,${await ipc.readFileBase64(abs)}`;
    } catch {
      dataUrl = null; // missing/unreadable — the broken image is the signal
    }
    cache.set(abs, dataUrl);
    return dataUrl;
  };
}

type MarpBrowser = typeof import('@marp-team/marp-core/browser').browser;
let browserLoad: Promise<MarpBrowser> | null = null;

/**
 * Marp's browser helper on one slide root: it upgrades the auto-scaling
 * elements (`<pre is="marp-pre">` shrinks code that would overflow) and, on
 * WebKit, applies the foreignObject polyfill. Returns the cleanup. Loaded
 * lazily with the engine; a root whose helper fails is simply unscaled.
 */
export function applyMarpBrowser(root: ParentNode): () => void {
  let cleanup: (() => void) | null = null;
  let cancelled = false;
  browserLoad ??= import('@marp-team/marp-core/browser').then((m) => m.browser);
  void browserLoad
    .then((browser) => {
      if (!cancelled) {
        cleanup = browser(root);
      }
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    cleanup?.();
  };
}

/** Test seam: forget the loaded engine between cases. Not for app code. */
export function resetMarpForTests(): void {
  marpLoad = null;
  browserLoad = null;
  themeNames.clear();
}
