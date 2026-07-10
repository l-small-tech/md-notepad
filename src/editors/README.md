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
  `history()`, `search()`, `lineNumbers()` OFF by default (Notepad feel),
  `EditorView.lineWrapping` behind a **Compartment** (M6 toggles it),
  theme + font size each behind their own Compartment.
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
show the one-time status-bar hint (plan.md §5-M5 wording).

### Known limitations to verify at M5 (QA has a section)

GFM round-trip: tables, task lists, strikethrough, autolinks survive; check
footnotes and HTML blocks — if Crepe drops them, the no-edit guarantee (I2)
still protects untouched docs; document "editing in rich mode may drop X"
in the root README known-limitations list.

## Testing expectations

Adapters are thin DOM glue by design — logic that can be tested (guard
wiring decisions, selection clamping, hint predicate) must live in pure
functions beside them and get Vitest coverage. The adapters themselves are
exercised by the QA checklists (M1/M5).
