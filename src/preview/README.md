# src/preview/ — Markdown rendering pipeline (M4)

The preview pane in `split` mode. `mermaid.ts` is already implemented and
tested — build `pipeline.ts` beside it.

## Module map

| File | Role |
| --- | --- |
| `pipeline.ts` | the unified processor (`renderMarkdownToHtml`) + `createRenderSequence`, the pure stale-completion guard |
| `mermaid.ts` | lazy mermaid rendering (reference impl, M1-era) |
| `export.ts` + `export.css` | standalone HTML export (`buildStandaloneHtml`): the same sanitized pipeline rendered into one self-contained file (inline stylesheet, images as data: URLs, mermaid pre-rendered to SVG). `export.css` only **consumes** theme variables (`var(--x, fallback)`, fallbacks = the built-in greens) and never defines one — the exporter (`ui/session/export.ts`) appends a generated `:root { --x: v; … }` block for the chosen theme+mode, which therefore always wins. Keep new rules on that pattern. |
| `code-review.ts` | the Review pane for a code file — see "Code review pane" below |
| `note-marks.ts` | the review-note marker + callout DOM both panes insert — see "Review-note markers" below |
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

A second processor, identical but with a `rehypeSourceLines` step before the
sanitizer, stamps every element with `data-line` = the 1-based source line it
starts on (from the `position` remark keeps through remark-rehype).
`renderMarkdownToHtml(text, { sourceLines: true })` selects it. Only the live
pane asks for it, and only when a host wires `onHoldLine` — the export and
markup-comparing tests render without stamps. It exists for one consumer: the
Review-mode voice-note gesture, which maps a press-and-hold on rendered text back
to a source line (`closest('[data-line]')`, innermost wins, so a wrapped
paragraph's inline elements give the more precise line).

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
    // the source-line stamp (a number; carries no script or URL)
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataLine'],
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
- Local images inline as data URLs (`inlineLocalImages`). A whiteboard `.svg`
  additionally gets the app theme's resolved `--wb-*` values baked into its
  root tag (`core/whiteboard/theme-inject.ts`) — an SVG inside an `<img>` is
  sealed off from page CSS, so this is the only way it can follow the app
  theme. Cache keys carry a theme fingerprint; `refreshTheme()` (called by
  EditorHost on a same-darkness theme switch) re-renders so open previews
  recolor.
- A board image is tagged (`data-wb-path` / `data-wb-mode`, read via
  `core/whiteboard/color-mode.ts`) so a right-click on it reports
  `onBoardContextMenu({ path, mode, x, y })` — the host opens the "theme
  colours / true colours" menu outside the pane (`ui/components/BoardColorMenu`),
  which rewrites the `.svg`'s `colorMode` and then calls `refreshImages(paths)`
  on every live view so the new bytes show. Foreign SVGs never fire it.

## Link policy

One delegated `click` listener on the pane. The window must NEVER navigate,
so every link click is `preventDefault()`ed; what happens next depends on the
href:

- A click anywhere on a rendered `.mermaid-diagram` (checked BEFORE the
  anchor branch — mermaid SVGs can contain `<a>`) hands the diagram's SVG
  markup to `onOpenDiagram` — the host opens the fullscreen zoomable viewer
  (`ui/components/DiagramViewer`). Same surface-state-outward shape as Back:
  nothing is injected into the pane. Omit the callback and diagram clicks
  are inert.
- `http:`/`https:` (`isExternalHref`, `core/external-links.ts`) → `onOpenExternal`.
  The pane never opens it itself: the host raises a confirm prompt naming the
  real host first (`ui/stores/external-link`), and only that opens the system
  browser. Omit the callback and external links are inert.
- A **local file** link (`isLocalLinkTarget`, i.e. a relative/absolute path,
  no URL scheme) is FOLLOWED in the pane — see "In-pane reader nav" below.
- Everything else (in-document `#anchors`, `mailto:`, other schemes) → inert.

`ui/link-guard.ts` is the app-wide backstop for anchors OUTSIDE this pane
(wysiwyg's live `<a href>`, above all). It defers to this listener, because
this one has already called `preventDefault()`.

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

## Press-and-hold line gesture (voice notes)

`attachPreviewPane(host, model, { onHoldLine })` + `pane.setLineHold(on)`.
While armed, a pointer held ~500 ms (≤10 px drift) on the tab's own document
reports the source line under it: the innermost `[data-line]` ancestor of the
pressed target, else the nearest stamped top-level block above the press (a
hold in the margin beside a paragraph means that paragraph). Never fires on a
followed link (that page isn't the tab's document). Armed, the pane also
swallows `contextmenu` and marks itself `data-line-hold` (preview.css /
voice-comments.css turn off selection + touch callout) so Android's long-press
selection handles don't fight the gesture. `EditorHost` arms it from the
review-notes store in Review mode only.

## Review-note markers (`note-marks.ts`)

`pane.setNotes(notes)` marks every top-level block that already has a note,
the way a word processor marks commented lines. `core/note-marks
notesByBlock` decides ownership (a block owns the notes from its first line
up to the next block's; a note above the first block is the first block's).
Each owning block gets a zero-height `div.vn-mark-row[data-vn-line]` before
it holding `button.vn-mark` (count + icon; absolutely positioned into the
right gutter by voice-comments.css, so the text never moves). A tap on the
marker toggles a read-only `div.vn-callout` after the block — one `.vn-note`
(meta + transcript, `textContent`, never HTML) per note and an
`button[data-vn-open]` that fires `onOpenNotes(line)` (omit the option and
there is no Open button). The set of open callouts is keyed by block line and
survives re-renders; markers are re-applied after every render and never
drawn on a followed link. `EditorHost` feeds `setNotes` from the review-notes
store's `marks[tabId]` while armed in Review mode, and an empty list clears
everything. `note-marks.ts` builds the marker and callout DOM for both panes.

## Code review pane (`code-review.ts`)

`attachCodeReviewPane(host, docModel, { dark, path, state?, onAction?,
onOpenDiagram?, onHoldUnit? })` — the `read` mode of the **code** doc family
(review_plan.md §5; the status bar calls it *Review*, `core/doc-family
modeLabel`). Same attach/dispose shape as `pane.ts`, same host element
(`.preview.reader-preview`, so text zoom and reading margins apply), same 200
ms debounce on model change, same render-sequence guard. It parses the text
with `core/code/parse` and renders:

- the header row — file name, segmented **Cards / Calls / Changes** buttons
  (`button.cr-view[data-view]`; *Changes* is disabled until a baseline is
  chosen), and an empty `span#cr-baseline-slot` the What-changed step fills;
- the filter chip row (`button.cr-chip[data-filter]`: All · Exported ·
  Changed · Functions · Types; *Changed* disabled without a baseline);
- the imports summary card (`.cr-imports`), then the deck (`.cr-deck`): one
  `article.cr-card[data-unit-id][data-line=signatureLine][data-kind]` per
  unit, nested `.cr-card-sub` for methods. Its 48 px `button.cr-card-head`
  (kind glyph, name, an empty `span.cr-badges[data-badges=unitId]` for the
  change badges, the *exported* tag, size dots) toggles the doc comment;
  the body holds the plain-English sentence (`describeUnit`), the raw
  signature, the doc rendered through `renderMarkdownToHtml`, a `.cr-form`
  table for fields, the facts row (`calls a, b · used by c` from
  `resolveCalls`, each name a `.cr-fact-link[data-goto]`) and the expander
  pills (`[data-expander=code|flow]`);
- the **Code** expander: the depth-1 x-ray (`xrayLines`) for units of 12+
  lines, `button.cr-xray-fold[data-fold-line]` opening one run one level,
  `[data-xray-all]` unfolding everything; shorter units open to full code.
  Highlighted with `@lezer/highlight`'s `highlightTree` over the same
  grammars the model is parsed with — the tag → class table mirrors
  `editors/code-highlight.ts` (which the preview layer must not import) and
  `styles/code-review.css` maps `.cr-tok-*` onto the same `--md-*` vars;
- the **Flow** expander (only when `flowHasBranches`): `flowMermaid(flowGraph
  (unit))` rendered by `renderMermaidBlocks`, with a note when truncated;
- the **Calls** view: `callGraphMermaid` (focus mode above 40 nodes with a
  *Show all* button); after mermaid renders, a tap on a `g.node` (matched by
  its `flowchart-<id>-n` element id) switches back to Cards and
  `scrollToUnit`s; a tap on the diagram background hands the SVG to
  `onOpenDiagram` exactly like `pane.ts`.
- notes: a `.cr-warn` line when `parseErrors > 0`; above 5 000 lines a
  "large file" note and an exported-only outline; for a file `parseCode`
  cannot read (`.json`, `Makefile`…) a single note and nothing else.

State is NOT the pane's: it renders a `ReviewState` (`core/code/review-state
.ts` — view, filter, expanded cards, x-ray depths, baseline) and reports
every tap as a `ReviewAction` through `onAction`; the host reduces it into
`ui/stores/code-review.ts` and calls `pane.setState(next)`, which re-renders
only what changed (a view/filter/baseline change re-renders the pane; an
expander or fold change re-renders that card's body). Without `onAction`
the pane reduces the state itself.

### What changed (review_plan.md §6)

Git is the host's business (`ui/code-review-git.ts`); the pane only renders
what it is handed:

- `setGitInfo({ available, hint?, branch?, baseBranch?, baseRef? })` fills
  `#cr-baseline-slot` in place: a `select.cr-baseline-select` with *this
  branch* (only when `baseRef` exists; the branch, base branch and merge
  base are the label's tooltip) · *uncommitted* · *last commit*, or —
  `available: false` — the hint text (`.cr-git-hint`:
  "Git not found" / "Not a git repository"). Picking an option reports a
  plain `{ type: 'baseline' }` action like every other tap; the host turns
  the baseline into a revision.
- `setChanges(changeMap, radar)` re-renders the deck with the `ChangeMap`
  from `core/code/changes`: an `added` / `changed` badge in each card's
  `.cr-badges` (`data-status` on the card; a `signature-changed` unit shows
  the note — "now also takes hiddenDirs" — as `.cr-change-note` under its
  signature), ghost cards (`.cr-card-ghost[data-ghost-id]`, "Removed:
  `oldHelper`") at the end of the deck, the *Changed* chip's count, the amber
  ring in the Calls view (`callGraphMermaid({ changed })`) and, on a changed
  card, the worktree radar line `.cr-radar` ("also changed on: feat/x") from
  `radar: { branch }[]`. `null` clears all of it. The *Changed* chip floats
  changed cards first; the **Changes** view is that deck without the chip
  row. Both are disabled (with the hint as their title) until a change map
  exists, so a machine without git loses exactly those two controls.
- `onModelChange(model, text)` fires once per re-parse (never on a theme or
  state render) so the host recomputes the map on the same 200 ms debounce.

Voice notes: `onHoldUnit(unit, model)` fires from the same 500 ms / 10 px
press-and-hold gesture as `pane.ts`, resolved to the card under the pointer
(`[data-unit-id]`), while `setLineHold(true)`; armed, the host carries
`data-line-hold` (selection + touch callout off) and swallows `contextmenu`.
`setDark` re-renders (mermaid bakes colours in). `currentModel()` exposes the
last parse.

Review-note markers: `setNotes(notes)` gives every card whose declaration
owns a note (`core/note-marks notesForUnit` — the note's `unit` label, or a
label-less note on the signature line) a `span.vn-mark[role=button]` in its
head after the badges (a span: the head is itself a button). A tap on it —
caught before the head's own doc toggle — expands a `div.vn-callout` between
the head and the body (so `refreshCard`, which only replaces the body,
leaves it alone); its `[data-vn-open]` fires `onOpenUnitNotes(unit)`. Open
callouts are keyed by unit id and survive re-renders.

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

`code-review.ts` is covered in `__tests__/code-review.test.ts` (jsdom, mermaid
mocked): DOM shape per fixture, chips, expanders, x-ray folds, the Calls
view's node taps, the hold gesture, the debounce, and `highlightLines`.

`mermaid.ts` already has its suite (`__tests__/mermaid.test.ts`) — mirror
its style.
