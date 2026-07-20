# src/preview/ — Markdown rendering pipeline (M4)

The preview pane in `split` mode. `mermaid.ts` is already implemented and
tested — build `pipeline.ts` beside it.

## Module map

| File | Role |
| --- | --- |
| `pipeline.ts` | the unified processor (`renderMarkdownToHtml`) + `createRenderSequence`, the pure stale-completion guard |
| `mermaid.ts` | lazy mermaid rendering (reference impl, M1-era) |
| `export.ts` + `export.css` | standalone HTML export (`buildStandaloneHtml`): the same sanitized pipeline rendered into one self-contained file (inline stylesheet, images as data: URLs, mermaid pre-rendered to SVG). `export.css` only **consumes** theme variables (`var(--x, fallback)`, fallbacks = the built-in greens) and never defines one — the exporter (`ui/session/export.ts`) appends a generated `:root { --x: v; … }` block for the chosen theme+mode, which therefore always wins. Keep new rules on that pattern. |
| `pane.ts` | wires the two together into one live pane: debounced re-render on model change, the render-sequence guard, and the link-click policy. `EditorHost` (`src/ui/components/EditorHost.tsx`) calls `attachPreviewPane(host, model, { dark })` when a tab enters `split` mode and `dispose()`s it on the way out — same attach/dispose shape as an `EditorAdapter`, but it is not one: the preview never becomes a source of truth, so it needs no write-back guard and never participates in `ModeSync`. |

## Pipeline (build exactly this)

```ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)          // NO allowDangerousHtml — raw HTML stays out (I6)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);
```

Create the processor ONCE at module scope (it's stateless across runs);
`await processor.process(text)` per render.

## Sanitize schema (I6 — extend `defaultSchema` by exactly this much)

```ts
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // fenced code blocks keep their language for highlighting + mermaid detection
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./]],
    // GFM task lists render as checkboxes
    input: [
      ...(defaultSchema.attributes?.input ?? []),
      ['type', 'checkbox'], ['checked'], ['disabled'],
    ],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'input'],
};
```

Anything beyond this list is a decision-log entry. Never add `script`,
`style`, `iframe`, or event-handler attributes. `javascript:` URLs are
already stripped by the default schema — the QA checklist verifies.

Task-list checkboxes are rendered disabled by GFM; keep them disabled in
preview (toggling belongs to wysiwyg mode).

## Render loop

- Debounce 200ms after the last model change (plain `setTimeout` per
  preview instance — the session debouncer is NOT for this; its drain
  semantics don't apply).
- Render into the pane via `innerHTML = html` (safe: everything passed
  sanitize), then `await renderMermaidBlocks(pane, { dark })`.
- Guard against out-of-order async completions: keep a render sequence
  number per pane; a stale completion (older seq) is discarded without
  touching the DOM.
- Theme: re-render (or at minimum re-run `renderMermaidBlocks`) when the
  theme changes — mermaid diagrams bake their colors at render time.

## Link policy

One delegated `click` listener on the pane. The window must NEVER navigate,
so every link click is `preventDefault()`ed; what happens next depends on the
href:

- `http:`/`https:` → `openUrl(href)` (`@tauri-apps/plugin-opener`) — system browser.
- A **local file** link (`isLocalLinkTarget`, i.e. a relative/absolute path,
  no URL scheme) is FOLLOWED in the pane — see "In-pane reader nav" below.
- Everything else (in-document `#anchors`, `mailto:`, other schemes) → inert.

### In-pane reader nav

A followed local link opens IN the reading pane (help-browser style) rather
than in the tab — the tab's identity (title, its own file, unsaved edits) is
never touched. `pane.ts` keeps a `navStack` of `{ path, text }`:

- Empty stack = "home": renders the tab's live model, re-rendering on edits.
- Following a **markdown/text** link reads it off disk, pushes it, and renders
  it (scrolled to top). Relative destinations resolve against the *current*
  page's directory, so chained relative links keep working. Images (and files
  that won't read as text) hand off to `onOpenFile` — they open in a tab.
- A **Back** affordance appears whenever the stack is non-empty; it pops one
  entry, ending back at home. It lives OUTSIDE the pane (the ribbon toolbar in
  normal mode, the floating cluster in full screen) — the pane surfaces its
  state via `onCanGoBackChange` and exposes `goBack()`, so nothing floats over
  the reading column.
- While browsing (stack non-empty) model edits are ignored — an edit to the
  underlying tab must not yank the reader off the page it's on.

## Styling (`src/styles/preview.css`, new in M4)

GFM look on our variables: tables with `var(--border)` collapsed borders;
blockquote with a left accent bar; code blocks `var(--bg-alt)` +
`var(--font-mono)`; `.mermaid-diagram { display: flex; justify-content:
center; }`; `.mermaid-error` uses `var(--danger)` with the source in a
normal code block. Body text in preview stays monospace — this app renders
markdown in the same voice you write it.

## Testing expectations

Vitest (node env — unified runs fine without a DOM for parse→stringify):

- One snapshot-ish test per GFM construct (table, task list, strikethrough,
  autolink, fenced code with language class surviving sanitize).
- Sanitize policy: `<script>`, inline `onerror`, `javascript:` hrefs, raw
  `<iframe>` — all reduced to inert output.
- Sequence-number staleness logic if you extract it (pure function).

`mermaid.ts` already has its suite (`__tests__/mermaid.test.ts`) — mirror
its style.
