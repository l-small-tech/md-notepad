# src/editors/ — Editor adapters

Both editors implement `EditorAdapter` (defined in `src/core/mode-sync.ts`,
re-exported from `./adapter.ts`). The contract and its tests are normative —
read `src/core/__tests__/mode-sync.test.ts` before writing either adapter.

Contract essentials:

- `attach(host, model)` renders `model.getText()` into `host`; may be async.
- `detach()` synchronously flushes any pending write-back, then tears down.
- Must survive `attach → detach → attach` (mode-sync re-attaches on failure).
- Echo suppression via reentrancy flag (pattern in `doc-model.ts` header).

---

## cm6.ts — CodeMirror 6 source editor (M1)

Used by both `raw` and `split` (split adds a preview pane; the editor
instance is identical and is NOT re-created when toggling raw⇄split).

### Recipe

```ts
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
```

- One `EditorView` per adapter instance, created in `attach`, destroyed
  (`view.destroy()`) in `detach`. Keep the adapter reusable: `attach` after
  `detach` creates a fresh view from the current model text.
- Extensions: `markdown({ base: markdownLanguage })` (GFM variant),
  `history()`, `search()`, `lineNumbers()` behind a **Compartment**, OFF by
  default (Notepad feel) — the "Line numbers" setting toggles it live via
  `setLineNumbers`, `EditorView.lineWrapping` behind a **Compartment** (M6
  toggles it), theme + font size each behind their own Compartment.
- Editor → model: `EditorView.updateListener.of((u) => { if (u.docChanged) pushSelf(u.state.doc.toString()) })`
  where `pushSelf` wraps `model.pushText(text, 'cm6')` in the reentrancy
  flag.
- Model → editor (external change: file reload, wysiwyg write-back):
  subscribe in `attach`; unless suppressed by the flag, replace content
  with a single transaction:
  `view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })`.
  Do NOT recreate the view for external changes — that loses scroll/cursor.
- Unsubscribe from the model in `detach` (keep the unsubscribe fn).
- Cursor persistence (M2): expose `getSelection()`/`setSelection(anchor,
  head)` on the adapter (clamp offsets to doc length — a restored cursor
  may exceed a shrunken doc).

### List indentation (Tab / Shift+Tab)

`list-indent.ts` holds the whole rule set as a pure function —
`reindentLists(lines, startLine, endLine, delta)` takes and returns plain
string arrays, so it is Vitest-covered without importing CM6. `cm6.ts` only
splits the doc, calls it, and diffs the result into per-line changes.

Word-like semantics: bullet markers cycle with depth (`*` → `-` → `+`,
repeating), a moved item takes its descendants with it, ordered runs are
renumbered across the surrounding block, and an item that would skip a level
(the first at its depth) does not move. Returning `null` means "not a list
selection" — the keymap then reports not-handled so Tab falls through to focus
navigation. Ordered nesting stays numeric: CommonMark has no `a.`/`i.` lists.

### Syntax highlighting

Define one `HighlightStyle` using CSS variables (not hex values) so themes
switch without touching CM6: headings bold + `var(--accent)`, emphasis
italic, code `var(--fg-muted)` on subtle bg, links underlined. Register via
`syntaxHighlighting(style)` inside the theme compartment so a theme flip
reconfigures it atomically.

### Pitfalls

- Fira Code ligatures: the editor content element must inherit
  `font-variant-ligatures: contextual` — set `.cm-content { font-family:
  var(--font-mono); }` in the theme and DON'T set `font-feature-settings`
  to anything that disables `calt`.
- CM6 packages must not be version-mismatched (all `@codemirror/*` move
  together); they are pinned by the lockfile — don't bump one alone.
- `EditorView.updateListener` fires for selection-only updates too — gate
  on `u.docChanged` before pushing.

---

## milkdown.ts — Crepe/Milkdown WYSIWYG (M5)

Loaded ONLY via dynamic import from the wysiwyg `AdapterFactory` (I8):

```ts
// in the tab wiring (ui), not here:
const wysiwygFactory: AdapterFactory = async () => {
  const { createMilkdownAdapter } = await import('../editors/milkdown');
  return createMilkdownAdapter();
};
```

### Recipe (Crepe first — fall back to @milkdown/kit only if theming fails)

- Instantiate `Crepe` with `defaultValue: model.getText()`, features
  trimmed to the minimal set (disable anything that fights the aesthetic:
  image upload UI etc. — evaluate at M5 against Crepe's current feature
  flags).
- Theme via Crepe's CSS variables mapped onto ours (`--bg`, `--fg`,
  `--accent`, `--font-mono`). Content font stays monospace — that's the
  product's look, even in rich mode.
- **Write-back guard is mandatory** (I2): create
  `createWritebackGuard({ serialize, push, debounceMs: 150 })` in `attach`,
  where `serialize` reads the current editor markdown and `push` wraps
  `model.pushText(text, 'milkdown')` in the reentrancy flag.

### The transaction-tagging pattern (the #1 pitfall)

Do NOT use Milkdown's high-level `markdownUpdated` listener naively — it
fires for programmatic content-setting too, which would defeat the guard
and normalize documents the user only LOOKED at. Instead:

1. Get the ProseMirror `EditorView` from milkdown's ctx (`editorViewCtx`).
2. Wrap `dispatchTransaction`（or use a ProseMirror plugin) so EVERY
   transaction reports
   `guard.noteTransaction({ docChanged: tr.docChanged, programmatic: !!tr.getMeta('md-notepad-programmatic') })`.
3. Any content you set yourself (initial load, external model change) must
   carry that meta flag: `tr.setMeta('md-notepad-programmatic', true)`.
4. `detach()` calls `guard.flushSync()` FIRST, then destroys the editor.

Model → editor: on external model changes (reentrancy-flag filtered),
re-parse the document into the editor with the programmatic meta set.

### Normalization hint (M5)

On attach, compute `serialize(parse(text)) !== text` (both available from
milkdown's ctx once loaded — cheap for note-sized docs). If true and the
tab hasn't shown it before, ask the UI (callback option on the adapter) to
show the one-time status-bar hint.

### Known limitations to verify at M5 (QA has a section)

GFM round-trip: tables, task lists, strikethrough, autolinks survive; check
footnotes and HTML blocks — if Crepe drops them, the no-edit guarantee (I2)
still protects untouched docs; document "editing in rich mode may drop X"
in the root README known-limitations list.

---

## whiteboard.ts — the Draw-mode whiteboard editor

Loaded ONLY via dynamic import from the `draw` `AdapterFactory` (I8), same as
Milkdown. `EditorHost` supplies that factory only when
`docFamilyFor(path) === 'svg'`; a markdown tab has no draw adapter at all, and
`createModeSync`'s `adapters` map is `Partial` precisely so a tab can offer just
the adapters its document family uses.

An `.svg` tab is an ordinary `kind:'file'` tab whose DocModel text IS the SVG
source. That is what buys dirty tracking, session buffering, Ctrl+S/liveSave,
mtime conflict detection and tear-off for free — and it makes Raw mode a free
SVG source editor. Nothing about `TabKind` or the session manifest changed:
`parseManifest` hard-validates `kind` but never validates `mode`, so a
`mode:'draw'` file tab degrades harmlessly to the source editor in an older
build instead of self-healing the session away.

- All logic lives in `src/core/whiteboard/` (read its README first). This file
  and `whiteboard-layers.ts` are the only places in the whiteboard stack that
  touch the DOM.
- Rendering hands **SVG source** to DOMParser and adopts the resulting `<svg>`,
  so the pane shows exactly what the file says — the same pixels a browser or
  the markdown preview would show. Before the first edit that source is the
  file's own bytes; after it, `serializeWhiteboard(scene)`. There is
  deliberately no second rendering path that could drift from the format. A
  parse failure raises the error card, whose "Open as text" button calls
  `setMode('raw')`.
- The in-progress stroke/shape is drawn on a transparent `<svg>` overlay via
  `serializeElement` — the same function that will write the committed element,
  so the drag preview cannot disagree with the result. The board itself is not
  touched until the pointer lifts.
- Pan/zoom reuses `core/diagram-zoom.ts` unchanged. The stage sets
  `touch-action: none` and does its own pointer routing. Phase 2 is **mouse and
  pen only** for tools: a finger pans (one pointer) or pinch-zooms (two), and a
  held space bar or non-primary button pans without leaving the tool. A pen's
  eraser end (`button === 5`) overrides the selected tool while it is down.
  Full touch routing, palm rejection and the finger-draw toggle are phase 3.
- **Write-back is guarded** (I2): nothing is pushed into the DocModel until a
  genuine edit, so mount → look → close is byte-identical and opening a
  hand-authored or Inkscape SVG never normalizes it. Pushes are debounced
  150 ms and flushed synchronously in `detach()`, which is what makes a fast
  Draw→Raw toggle lossless.
- **Echo suppression is a reentrancy flag**, not a version check: our own
  `pushText` re-enters the model subscription synchronously (see
  `doc-model.ts`). Without the flag every stroke would re-parse the board from
  its own output and reset the undo history.
- Undo is a snapshot stack (`core/whiteboard/history.ts`), **per adapter
  instance** — it is lost on a Draw⇄Raw switch, matching the documented
  raw⇄wysiwyg limitation. An external change (raw edit, file reload, conflict
  resolution) resets the timeline to the incoming text.
- The **ribbon is the draw toolbar**: tool, colour and nib live in
  `ui/stores/whiteboard.ts` (global, not per-tab — the marker you picked stays
  picked on the next board) and the adapter reads them at each gesture start.
  Undo depth flows the other way through `onStateChange`. The layers panel and
  zoom cluster stay in the adapter, so neither side subscribes to the other.
  Note `core/whiteboard/tool-settings.ts` is a dependency-free leaf **on
  purpose**: the ribbon is in the eager entry bundle, and importing the palette
  from `tools.ts` would drag smoothing, serialization and the XML reader into
  startup, quietly undoing I8.

## Testing expectations

Adapters are thin DOM glue by design — logic that can be tested (guard
wiring decisions, selection clamping, hint predicate) must live in pure
functions beside them and get Vitest coverage. The adapters themselves are
exercised by the QA checklists (M1/M5).
