/**
 * Lazy Mermaid rendering for the preview pane.
 *
 * Rules this file exists to enforce:
 * - Invariant I8: the mermaid chunk (~1MB) is imported ONLY when a document
 *   actually contains a mermaid block. Previews without diagrams must never
 *   pay for it — note the early return BEFORE the dynamic import.
 * - Mermaid throws both synchronously and asynchronously depending on the
 *   error, and on parse failure it can leave an orphan temp element in the
 *   DOM (it renders into a detached-ish node it appends itself). Both are
 *   handled here so callers never think about it.
 * - A failed diagram degrades to the fenced source plus the error message —
 *   the preview NEVER breaks because a diagram is mid-edit (in split mode
 *   the user is often typing half-finished mermaid).
 *
 * Contract with the preview pipeline (src/preview/README.md): fenced
 * ```mermaid blocks arrive as <pre><code class="language-mermaid"> — the
 * standard remark-rehype shape; rehype-sanitize must keep that class.
 */

type MermaidModule = typeof import('mermaid').default;

let mermaidLoad: Promise<MermaidModule> | null = null;
let initializedDark: boolean | null = null;
let renderSeq = 0;

function loadMermaid(): Promise<MermaidModule> {
  mermaidLoad ??= import('mermaid').then((m) => m.default);
  return mermaidLoad;
}

export interface RenderMermaidOptions {
  dark: boolean;
}

/**
 * Render every mermaid block inside `container` in place. Call after the
 * (sanitized) preview HTML is committed to the DOM. Idempotent per render:
 * the preview replaces its whole subtree each cycle, so blocks are always
 * fresh <pre><code> nodes.
 */
export async function renderMermaidBlocks(
  container: HTMLElement,
  options: RenderMermaidOptions,
): Promise<void> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre > code.language-mermaid'));
  if (blocks.length === 0) {
    return; // fast path — the chunk is never loaded (invariant I8)
  }

  const mermaid = await loadMermaid();
  if (initializedDark !== options.dark) {
    // Mermaid's theme is global init-state, not per-render.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: options.dark ? 'dark' : 'default',
      // The SVG lives in the document, so the CSS var resolves — diagrams
      // follow the "Editor font" setting like the rest of the content.
      fontFamily: 'var(--font-mono)',
    });
    initializedDark = options.dark;
  }

  // Replacement nodes are created in the container's OWN document: the HTML
  // exporter (src/preview/export.ts) runs this against a detached DOMParser
  // document, and nodes from the live document would need adopting there.
  const doc = container.ownerDocument;
  for (const code of blocks) {
    const host = code.parentElement;
    // "Still part of the subtree we were asked to render?" — checked against
    // `container` rather than `isConnected` so a detached root (the exporter's
    // DOMParser document) renders too. For the live pane the meaning is
    // unchanged: a newer render cycle replaces the pane's whole subtree, so a
    // stale block is no longer under `container` and is skipped.
    if (!host || !container.contains(host)) {
      continue;
    }
    const source = code.textContent ?? '';
    const id = `mermaid-${renderSeq++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      const wrap = doc.createElement('div');
      wrap.className = 'mermaid-diagram';
      wrap.innerHTML = svg; // mermaid output under securityLevel 'strict'
      host.replaceWith(wrap);
    } catch (error) {
      // Mermaid can leave a temp element with the render id behind on parse
      // errors — remove it or they accumulate invisibly. It appends the temp
      // node to the LIVE document regardless of where our container lives.
      document.getElementById(id)?.remove();

      const wrap = doc.createElement('div');
      wrap.className = 'mermaid-error';
      const message = doc.createElement('div');
      message.className = 'mermaid-error-message';
      message.textContent = error instanceof Error ? error.message : String(error);
      const pre = doc.createElement('pre');
      pre.textContent = source;
      wrap.append(message, pre);
      host.replaceWith(wrap);
    }
  }
}

/** Test seam: reset module state between cases. Not for app code. */
export function resetMermaidForTests(): void {
  mermaidLoad = null;
  initializedDark = null;
  renderSeq = 0;
}
