# MD Notepad — Implementation Plan

You are implementing **MD Notepad**: a minimal, fast, cross-platform markdown
notepad in the spirit of Windows 11 Notepad. This file is your entry point
for every working session. The scaffold you are standing on already contains
working, tested reference implementations of the hardest patterns — your job
is to build the app around them, one milestone per session.

---

## 1. What this is

A desktop app (Tauri 2 + React/TypeScript) that feels like Windows Notepad
but speaks markdown:

- **Tabs** hold either *notes* (ephemeral, auto-persisted, no save button —
  like modern Notepad's unsaved tabs) or *files* (explicitly opened/saved
  `.md` documents anywhere on disk).
- Notes live as real `.md` files in a configurable **notes directory**
  (default: `<appDataDir>/notes`). Closing the app and reopening restores
  every tab exactly — including unsaved work.
- **Three edit modes**, switchable per tab: `raw` (CodeMirror 6 source with
  syntax highlighting), `split` (source + live GFM preview), `wysiwyg`
  (Milkdown/Crepe rich editing).
- Full **GitHub-Flavored Markdown** in preview, with **Mermaid** diagrams.
- **Fira Code** everywhere with ligatures (`->` renders as one glyph).
- Minimal, sleek, quiet UI. Light/dark/system themes.
- Performance is a feature: cold start under ~1.5s, idle RAM well under
  100MB, no jank while typing. Mermaid and Milkdown load lazily.

**Non-goals for v1** (do not build these): cloud sync, note search UI,
plugin system, mermaid rendering inside WYSIWYG mode, multi-window, mobile,
printing/export, collaborative editing.

## 2. How to work in this repo

1. **Read order for a session on milestone N**: this file top to bottom →
   the README of every directory that milestone touches → the reference
   implementations and their tests in those directories. The demo code is
   normative: its tests define contracts you must not break.
2. **One milestone per session.** Finish it, verify it, stop. Do not start
   the next milestone "while you're at it".
3. **Definition of done for every milestone** (in addition to its own
   acceptance criteria):
   - `npm run check` (tsc, eslint, prettier) — clean
   - `npm test` (Vitest) — green, including NEW tests for the milestone's logic
   - `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` — clean
   - `npm run tauri dev` launches and the milestone's QA checklist in
     [docs/qa-checklists.md](docs/qa-checklists.md) passes manually
   - Any contract you changed is reflected in the relevant README
4. **Extend, never rewrite, the reference implementations**
   (`src/core/doc-model.ts`, `src/core/mode-sync.ts`, `src/core/session/*`,
   `src/ipc/commands.ts`, `src/preview/mermaid.ts`,
   `src-tauri/src/commands/fs.rs`). If one of them genuinely blocks you,
   change it minimally, keep its tests passing (update them only with a
   written justification in the decision log, §9).
5. **Dependencies are frozen** to what `package.json` and `Cargo.toml`
   already list. Adding a dependency requires a decision-log entry
   explaining why the existing set cannot do the job.
6. **Honesty rule**: no placeholder code that pretends to work, no stubbed
   features that silently do nothing. If something is incomplete, it is
   absent, and the milestone is not done.

## 3. Architecture overview

```
┌─────────────────────────── src/ui (React) ────────────────────────────┐
│  TabBar · EditorHost · StatusBar · SettingsDialog · ConflictBanner    │
│  React renders CHROME ONLY — editors are never re-mounted by React    │
└──────┬─────────────────────────────────────────────────────┬──────────┘
       │ zustand stores (vanilla, defined outside React)     │
┌──────▼──────────┐  ┌──────────────┐  ┌─────────────────────▼─────────┐
│  src/editors    │  │ src/preview  │  │  src/core  (pure, no DOM/Tauri)│
│  cm6.ts (M1)    │  │ pipeline (M4)│  │  doc-model · mode-sync · title │
│  milkdown (M5)  │  │ mermaid.ts   │  │  settings · session/*          │
└──────┬──────────┘  └──────┬───────┘  └─────────────────────┬─────────┘
       └────────────────────┴───────────┬────────────────────┘
                                 ┌──────▼───────┐
                                 │   src/ipc    │  typed invoke wrappers
                                 └──────┬───────┘
                                 ┌──────▼───────────────────────────────┐
                                 │  src-tauri (Rust, THIN)              │
                                 │  commands/fs.rs · plugins · events   │
                                 └──────────────────────────────────────┘
```

One keystroke, end to end: CM6 fires its update listener → the adapter
pushes the exact text into the tab's `DocModel` → subscribers react (title
recompute in the tab store; `flusher.request()` on the app-wide debounced
flusher) → ~1s later the flusher builds a `FlushPlan` via `planFlush(view)`
→ `executeFlushPlan` writes the note file (and any buffers) through
`ipc.atomicWriteText`, then the session manifest last → Rust's
`atomic_write_text` does tempfile + fsync + rename.

## 4. Invariants

Numbered so reviews can cite them. Each is enforced by tests, lint rules, or
both — keep it that way.

- **I1** The canonical representation of a document is the markdown string in
  its `DocModel`. Editors and previews are projections; none of them holds
  authoritative state.
- **I2** Milkdown's serialization is written back to the DocModel **only
  after a genuine user edit since attach**. Merely viewing a note in WYSIWYG
  must leave it byte-identical (pinned by mode-sync tests).
- **I3** Every write of user content goes through `atomic_write_text`. No
  direct writes, ever.
- **I4** The session manifest is written **last**, after every file it
  references (pinned by plan-flush tests).
- **I5** Rust contains no business logic. If a change makes Rust decide
  *which* file to write or *when*, it belongs in TypeScript instead.
- **I6** All rendered preview HTML passes `rehype-sanitize`. Raw HTML in
  markdown is sanitized away, not rendered.
- **I7** Editors are attached exactly once per (tab, editor-kind) and never
  re-mounted by React reconciliation (see src/ui/README.md — EditorHost).
- **I8** Startup never imports `mermaid` or `@milkdown/*`. Both load via
  dynamic `import()` on first use (verify: `npm run build`, then check the
  entry chunk in `dist/assets/`).
- **I9** `src/core` imports nothing from DOM, Tauri, React, or sibling
  layers (mechanically enforced in `eslint.config.js`).

## 5. Milestones

Each milestone ends with: all checks green (§2.3), its QA checklist section
executed, and READMEs updated if contracts changed.

### M1 — Shell: tabs + raw editor

**Goal**: a usable single-mode notepad without persistence.

In scope:
- Tabs store (`src/ui/stores/tabs.ts`, zustand **vanilla** store + `useStore`
  hook): create/close/activate/reorder/rename tabs; each tab owns a
  `DocModel` (`createDocModel`) and a `ModeSync` (`createModeSync`) even
  though only `raw` works yet.
- CM6 adapter (`src/editors/cm6.ts`) per the recipe in src/editors/README.md,
  including the search panel (`@codemirror/search`) and word-wrap/font-size
  hooks (compartments) for M6.
- `TabBar` (new-tab button, close buttons, middle-click close, double-click
  or F2 to rename inline), `EditorHost` (the never-remount pattern —
  README), `StatusBar` (mode name, cursor line:col, word count).
- Title pipeline: tab title = `customTitle ?? deriveTitle(text)`,
  recomputed on model change; window title = `<active tab title> — MD Notepad`.
- Themes: `data-theme` on `<html>` driven by a settings store default
  (`system` until M6's UI exists), `matchMedia('(prefers-color-scheme)')`
  listener; CM6 theme switches via compartment.
- Keyboard shortcuts (table in src/ui/README.md): Ctrl/Cmd+N, Ctrl/Cmd+W,
  Ctrl/Cmd+Tab, Ctrl/Cmd+F, F2.
- Mode selector UI (three-segment control in the status bar) that switches
  raw ⇄ split ⇄ wysiwyg via `ModeSync.setMode`; split/wysiwyg show a
  "coming in M4/M5" empty pane for now (an honest placeholder label, not a
  broken feature).

Out of scope: persistence of any kind, file open/save, preview, WYSIWYG.

Acceptance criteria (user-observable):
- Launch → one empty tab titled "Untitled". Typing `# Grocery list` retitles
  the tab "Grocery list" live and the window title follows.
- `->` in the editor renders as a single solid arrow glyph (Fira Code
  ligature); `Ctrl+F` opens CM6 search; markdown syntax is highlighted.
- 10 tabs, rapid switching: no editor state bleed (cursor, selection,
  scroll position are per-tab), no visible jank.
- Renaming a tab via F2 sticks; the title no longer follows the first line.
- OS in dark mode → app launches dark; flipping OS theme live-switches.

Verification: `npm run tauri dev` + QA checklist M1; new Vitest suites for
the tabs store (creation/close/active bookkeeping, rename override).

### M2 — Session persistence

**Goal**: kill the app any time; nothing is lost.

In scope:
- Paths module (`src/ipc/paths.ts`): resolve `notesDir` (settings override
  or `appDataDir()/notes`) and `sessionDir` (`appDataDir()/session`) via
  `@tauri-apps/api/path`; note tabs' text changes call `flusher.request()`.
- App-wide flusher: `createDebouncedFlusher({ idleMs: 1000, maxWaitMs: 5000,
  run: flushSession })` where `flushSession` assembles `AppSessionView` from
  the stores (including `existingNoteFiles` — keep a cached listing, refresh
  from `ipc.listNotes` at startup and after each flush result), calls
  `planFlush` → `executeFlushPlan(plan, ipc)`, applies `assignedNotePaths`
  and rename results back to the store, then `markPersisted('session')` on
  each flushed model.
- Flush triggers: model changes, tab create/close/reorder/rename, mode
  change, window blur (`flushNow`), and close: `getCurrentWindow()
  .onCloseRequested` → `preventDefault()` → `await flusher.flushNow()` →
  `destroy()`. **Never prompt in the close path.**
- Restore on launch: read manifest (`ipc.readTextFile` on
  `sessionDir/session.json`) → `parseManifest` → rebuild tabs (note tabs
  read their note file; missing note file → skip tab + status-bar notice).
  Corrupt/missing manifest → rename it to `session.json.bad-<timestamp>`
  (if present) and self-heal: `ipc.listNotes(notesDir)`, open the 20 most
  recent as tabs.
- Close-tab semantics (**deliberate, user-visible**): closing a note tab
  discards the note — confirm dialog (plugin-dialog `confirm`) when the note
  is non-empty, then the store records its `notePath` in `closedNotePaths`
  for the next flush to delete. Closing a clean file tab is silent; a dirty
  file tab prompts save/discard/cancel (M3 wires the save half fully).
- Cursor persistence: store `{anchor, head}` per tab in the manifest,
  restore selection on first attach.

Acceptance criteria:
- Type, wait ≤5s, kill the process (Task Manager / `taskkill /f`), relaunch:
  every tab back (order, active tab, cursor), at most ~5s of typing lost.
- Create a note "Shopping"; `<notesDir>/shopping.md` appears within ~5s and
  its content tracks the tab. Retitle the first line → file is renamed
  lazily on the next flush.
- Two tabs titled "Idea" coexist (`idea.md`, `idea-2.md`).
- Corrupt `session.json` with garbage bytes → relaunch self-heals (recent
  notes reopen; `.bad-*` file left beside; no crash, no data deleted).
- Closing a non-empty note tab asks for confirmation and deletes its file.
- Notes dir is deleted while app closed → relaunch starts fresh without
  crashing, recreates the dir on next flush.

Verification: QA checklist M2 (includes the kill-mid-typing drill); Vitest
for `flushSession` orchestration with a mocked `ipc` (`mockIPC` pattern —
see `src/ipc/__tests__/commands.test.ts`).

### M3 — Files: open, save, conflicts

**Goal**: Notepad-grade `.md` file handling.

In scope:
- Open (Ctrl+O, plugin-dialog `open` filtered to md/markdown/txt) →
  file tab: `ipc.readTextFile`, remember `savedMtimeMs`,
  `markPersisted('file')`.
- Save (Ctrl+S) / Save As (Ctrl+Shift+S, dialog `save`): write via
  `ipc.atomicWriteText`, refresh `savedMtimeMs` from `ipc.statPath`,
  `markPersisted('file')`. Save on a *note* tab behaves as Save As; on
  success the tab converts to a file tab and the old note file is queued
  for deletion (the note graduated — see core/session docs).
- Dirty marker (`•`) on file tabs via `isDirty('file')`; dirty file tabs
  buffer to the session dir (already handled by `planFlush` — verify
  end-to-end here).
- Startup/second-instance file opening: on boot call
  `ipc.drainStartupFiles()`; listen for the `open-files` event
  (`@tauri-apps/api/event`). Both feed the same "open these paths" routine
  (dedupe: focus the existing tab if the path is already open).
- External-change detection: on window focus and before every save,
  `ipc.statPath(filePath)`; mtime ≠ `savedMtimeMs` → non-blocking
  `ConflictBanner` on that tab: "File changed on disk — Reload / Keep mine".
  Reload replaces the model text (`file-load` source); Keep-mine dismisses
  and the next save overwrites.
- File tab restore honors `hasBuffer` buffers (read buffer, mark file-dirty,
  stat the file, banner if it changed while app was closed).

Acceptance criteria:
- Round-trip: open a `.md`, edit (dirty dot appears), Ctrl+S (dot clears),
  content correct on disk with LF endings preserved as read.
- Double-click a `.md` in Explorer while the app runs → existing window
  focuses and opens the file as a tab (no second instance).
- Edit file tab, do NOT save, kill app, relaunch → tab restores with
  unsaved edits and shows the dirty dot; the on-disk file is untouched.
- Modify the file in another editor while it's open → banner appears on
  focus; Reload shows the external content; Keep-mine + Ctrl+S overwrites.
- Save As an open note → notes dir no longer contains its note file; tab
  now tracks the chosen path.

Verification: QA checklist M3; Vitest for the open/save orchestration and
conflict decision logic with mocked ipc.

### M4 — Split mode: GFM preview + Mermaid

**Goal**: live rendered preview worthy of "full GitHub markdown support".

In scope:
- `src/preview/pipeline.ts` per src/preview/README.md: unified processor
  `remark-parse → remark-gfm → remark-rehype → rehype-sanitize →
  rehype-stringify`, sanitize schema extended ONLY as the README specifies
  (task-list checkboxes, `language-*` code classes). Process on model
  change, debounced 200ms, into the preview pane's `innerHTML`, then
  `await renderMermaidBlocks(pane, { dark })`.
- Split layout in EditorHost: editor left, preview right, draggable divider
  (CSS `resize` or a 10-line drag handler — no dependency), preview pane
  styling (`src/styles/preview.css`) for GFM: tables, task lists, quotes,
  code blocks (monospace, subtle bg), headings.
- Link handling: intercept clicks in the preview; `http(s):` URLs go to
  `openUrl` from `@tauri-apps/plugin-opener`; everything else is inert.
- Mermaid: already implemented (`src/preview/mermaid.ts`) — wire it and
  style `.mermaid-diagram` / `.mermaid-error`.
- Raw-mode CM6 markdown niceties if not already: heading/emphasis syntax
  highlighting via `@codemirror/lang-markdown` + `@lezer/highlight` tags.

Acceptance criteria:
- The GFM kitchen sink (tables, task lists, strikethrough, autolinks,
  fenced code, footnotes if remark-gfm emits them) renders correctly and
  updates live ≤300ms after typing stops.
- A ```mermaid block renders a diagram; while half-typed it shows the
  source + error box, never a blank pane or console spam; finishing the
  diagram heals it. Theme flip re-renders diagrams in the matching theme.
- A doc with no mermaid: network tab / chunk check confirms mermaid chunk
  never loads (I8).
- `<script>alert(1)</script>` in the document renders as nothing dangerous
  (sanitized), `javascript:` links are inert (I6).
- Clicking an `https://` link opens the system browser; the app window
  never navigates.

Verification: QA checklist M4; Vitest for the pipeline (input markdown →
sanitized HTML snapshots for the GFM constructs; sanitize policy tests for
script/js-URL stripping).

### M5 — WYSIWYG (Milkdown/Crepe)

**Goal**: rich editing that round-trips markdown honestly.

In scope:
- `src/editors/milkdown.ts` implementing `EditorAdapter` with
  `@milkdown/crepe`, loaded via dynamic import from the `wysiwyg` adapter
  factory (I8). Recipe + pitfalls in src/editors/README.md — the
  write-back guard (`createWritebackGuard`) is mandatory: listen at the
  ProseMirror transaction level, tag programmatic setContent with
  transaction meta, `flushSync` in `detach()`.
- First evaluate Crepe's fit (theming to our minimal monospace look via its
  CSS variables; unneeded features off). If Crepe cannot be themed
  acceptably, fall back to `@milkdown/kit` core + commonmark/gfm presets —
  same adapter contract, decision-log entry either way.
- Normalization hint: on entering wysiwyg, if `serialize(parse(text)) !==
  text`, show a one-time-per-tab status-bar hint: "Rich mode may reformat
  markdown syntax (content is preserved)". No modal.
- Mermaid blocks in wysiwyg render as plain fenced code (non-goal to render
  them here).
- GFM round-trip audit (QA): tables, task lists, strikethrough, autolinks,
  code fences with language, footnotes. Anything Crepe drops or mangles is
  either protected by the no-edit guarantee (I2) or documented as a known
  limitation in the root README.

Acceptance criteria:
- Open a heavily-formatted note in wysiwyg, click around, DON'T edit,
  switch back to raw: byte-identical text (verify with the QA checklist's
  diff drill), no dirty flag on file tabs.
- Type in wysiwyg → switch to raw ≤150ms later: the last keystrokes are
  present (flush-on-detach), formatting normalized but content complete.
- Tables are editable with Crepe's UI; task-list checkboxes toggle and
  serialize as `- [x]`.
- The milkdown/crepe chunk loads only on first wysiwyg use (I8).
- Mode switches under fast toggling (mash Ctrl+1/2/3) never lose text or
  crash (the mode-sync chain serializes them).

Verification: QA checklist M5 (includes the byte-identity diff drill);
Vitest additions only where logic is pure (e.g. normalization-hint
predicate); editor behavior itself is manual QA.

### M6 — Settings + polish

**Goal**: the app is configurable and feels finished.

In scope:
- Settings store backed by `tauri-plugin-store` (`settings.json` in
  appDataDir, `normalizeSettings` on load, debounced save). Wire the
  existing settings: theme, fontSize, defaultMode (for NEW tabs), wordWrap,
  ligatures (toggles the `no-ligatures` class), notesDir.
- Settings UI: minimal dialog (Ctrl+,) — native-feeling form, no new deps.
- Notes-dir change flow: pick dir (plugin-dialog) → offer "Move N existing
  notes?" (default yes) → move via `ipc.renamePath` per file with progress
  in the status bar → update store, refresh `existingNoteFiles`, next flush
  writes there. Rename failures: keep the file in the old dir, list what
  was left behind in a dismissible notice.
- Font size Ctrl+= / Ctrl+- / Ctrl+0 (reset), applied via CM6 compartment +
  CSS var for preview/wysiwyg.
- Shortcut audit per the table in src/ui/README.md; macOS Cmd equivalents.
- Performance pass: cold-start timing, typing latency in a 1MB doc, idle
  RAM; fix regressions found (targets in §1).

Acceptance criteria:
- Every setting takes effect immediately, persists across restart, and
  survives a corrupted settings.json (defaults, no crash).
- Changing notes dir moves notes (or reports what it couldn't move) and new
  flushes land in the new dir; the old manifest still restores everything.
- Ligatures toggle visibly works; font size affects all three modes.

Verification: QA checklist M6; Vitest for the move-notes planning logic.

### M7 — Packaging + release

**Goal**: installable, updatable, verifiable releases from a tag push.

In scope:
- Replace placeholder icons (`src-tauri/icons`, generated from a proper
  1024px source via `npm run tauri icon`) — keep it minimal/flat.
- Updater key ceremony (maintainer does this once, document it happened):
  `npm run tauri signer generate -- -w <path>` OFFLINE → private key +
  password into GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; public key into
  `tauri.conf.json > plugins.updater.pubkey`; set
  `bundle.createUpdaterArtifacts: true`. **Losing the private key orphans
  the update channel** — say so in the release docs.
- Update-check UI: on launch (and a Help menu item), `check()` from
  `@tauri-apps/plugin-updater`; if available, unobtrusive status-bar chip →
  download+install → `relaunch()` from plugin-process. Errors are silent
  (log only) — never block startup on the updater.
- File associations for `.md`/`.markdown` (tauri.conf `fileAssociations`) —
  verify argv/single-instance opening end-to-end on Windows + Linux.
- Verify `release.yml` by tagging `v0.1.0-rc.1` on a fork/branch: draft
  release appears with NSIS exe, dmg (universal), deb/rpm/AppImage,
  `latest.json`, `.sig` files, `SHA256SUMS`, and attestations verify via
  `gh attestation verify <asset> --repo <owner>/md-notepad`.
- Root README final pass: install instructions per OS incl. SmartScreen/
  Gatekeeper first-run notes, verification instructions, screenshots.

Acceptance criteria:
- A tag push produces a draft release whose Windows installer installs and
  launches on a clean Windows 11 VM (SmartScreen "More info → Run anyway"),
  AppImage runs on stock Ubuntu LTS, dmg opens on macOS (right-click →
  Open).
- An install of version N sees a published N+1 release and self-updates.
- `sha256sum -c SHA256SUMS` and `gh attestation verify` pass on every asset.

Verification: QA checklist M7 + the release-drill above.

## 6. Testing strategy

- **Vitest** (`npm test`) — all pure logic. Conventions: suites live in
  `__tests__/` beside the code; fake timers for anything debounced (see
  `debounce.test.ts`); `@tauri-apps/api/mocks`' `mockIPC` +
  `@vitest-environment jsdom` docblock for code that calls `ipc.*` (see
  `src/ipc/__tests__/commands.test.ts` — copy that pattern). Test the
  CONTRACT, not the implementation.
- **cargo test** — Rust commands stay thin enough that their tests are
  mostly filesystem semantics (`src-tauri/src/commands/fs.rs`). Run on all
  3 OSes in CI; atomic-rename behavior is exactly the thing that differs.
- **Manual QA** — [docs/qa-checklists.md](docs/qa-checklists.md), one
  section per milestone, executed on your dev OS before calling a milestone
  done; the full sweep across Windows/macOS/Linux happens at M7.
- **No scaffolded E2E.** tauri-driver/WebdriverIO lacks macOS support and
  the cost/benefit is poor here. If E2E ever lands it's the backlog item
  "Playwright against `vite dev` + mockIPC", not a Tauri harness.
- **CI is the gate** (.github/workflows/ci.yml): frontend checks on ubuntu;
  fmt/clippy/test + debug build on the 3-OS matrix. A milestone is not done
  with a red matrix.

## 7. Release & versioning

- Semver, `v`-prefixed tags. Versions live in THREE files that must agree:
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- Cut a release: bump versions on `main` → `git tag v0.2.0` → `git push
  --tags` → release.yml builds the matrix into a **draft** GitHub release
  with updater manifest, signatures, SHA256SUMS, attestations → manually
  review the draft (install at least one asset) → Publish. Publishing is
  what makes `latest.json` visible to updaters.
- Secrets inventory: `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (created in M7). No other secrets;
  attestations use the workflow's OIDC token.
- Trust story (no paid certs): SHA256SUMS + Sigstore attestations + minisign
  updater signatures. SmartScreen/Gatekeeper warnings are expected and
  documented for users in the root README.

## 8. Directory guide

| Path | Read when | Contents |
| --- | --- | --- |
| [src/README.md](src/README.md) | any frontend work | layering rules, store conventions, event flow |
| [src/core/README.md](src/core/README.md) | M1, M2, M5 | doc-model/mode-sync/session contracts + invariants |
| [src/editors/README.md](src/editors/README.md) | M1, M5 | CM6 + Milkdown adapter recipes and pitfalls |
| [src/preview/README.md](src/preview/README.md) | M4 | unified pipeline, sanitize schema, mermaid wiring |
| [src/ui/README.md](src/ui/README.md) | M1, M3, M6 | component specs, EditorHost never-remount, shortcuts |
| [src-tauri/README.md](src-tauri/README.md) | M2, M3, M7 | Rust conventions, error contract, add-a-command checklist |
| [docs/qa-checklists.md](docs/qa-checklists.md) | end of every milestone | manual QA scripts |

## 9. Decision log

Settled — do not relitigate. Append new entries (date + rationale) when a
milestone forces a decision.

| Decision | Rationale |
| --- | --- |
| Tauri 2, not Electron | perf requirement (10× smaller install, ~3× less idle RAM); system webview is acceptable for a notepad |
| React + Zustand, editors as DOM islands | React only renders chrome; zustand vanilla stores keep core logic framework-free and testable |
| No React StrictMode | dev double-invoked effects fight the mount-once editor architecture; core logic is covered by Vitest instead |
| CodeMirror 6 for raw/split | best-in-class perf, first-party markdown language |
| Milkdown (Crepe build) for WYSIWYG | remark-based = markdown-first round-trip; Crepe ships table UI/slash menu we'd otherwise build |
| Canonical-text doc model + write-back guard | prevents WYSIWYG normalization drift (I1/I2); diff-based partial write-back rejected as fragile |
| Notes are real .md files; manifest is machine-local | notes dir stays the single source of user data; losing the manifest costs only tab order/cursors |
| No tauri-plugin-fs; own thin command set | user-configurable notes dir fights static capability scoping; atomicity needs a custom command anyway |
| tauri-plugin-store for settings only | session data needs explicit write ordering (I4) the store plugin can't promise |
| Close note tab = discard (delete file), confirm if non-empty | Notepad semantics; the tab IS the note |
| Save-As converts note→file and deletes the note file | one source of truth per document |
| Empty new tabs create no file | matches Notepad; zero disk noise |
| Per-tab edit mode, persisted | comparing a rendered note against a raw one is a real workflow |
| Undo history lost across raw⇄wysiwyg | industry norm; revisit only on real user pain (backlog) |
| Fira Code via @fontsource, ligatures default-on | user requirement; OFL license is GPL-compatible |
| GPL-3.0-only | project owner's choice; all deps MIT/Apache-2/OFL/ISC |
| Free signing (checksums + attestations + minisign updater) | zero cost; OS trust warnings documented; paid certs can layer on later |
| jsdom only for tests that need a DOM | node env is faster and keeps core tests honest (I9) |
| M2: `AppSessionView.suppressedRenamePaths` added (optional) | additive, backward-compatible extension of the planFlush reference; lets the flusher stop planning a rename after ~3 consecutive failures (core/README policy) without the planner losing purity. Existing tests unchanged; new coverage added |
| M3: close-tab save/discard/cancel uses `@tauri-apps/plugin-dialog`'s `message()` with custom `buttons: {yes,no,cancel}` (not a custom DOM modal) | the installed plugin-dialog version supports arbitrary button labels on `message()` since 2.4.0, so the native OS dialog can present three choices; keeps the "native dialogs via plugin-dialog" rule from src/ui/README.md intact instead of carving out an exception |
| M3: `dirty`/`conflict` live only on `TabEntry` (src/ui/stores/tabs.ts), not on core `TabState` | both are UI-only derived/ephemeral signals (a cached read of `model.isDirty('file')`, and a transient ConflictBanner flag) — neither is part of the persisted manifest shape session/plan-flush.ts defines, so core stays untouched |
| M5: WYSIWYG uses `@milkdown/crepe` (kept — the fallback to `@milkdown/kit` was not needed) | Crepe themes cleanly to our minimal monospace look by mapping its `--crepe-*` CSS variables onto ours (src/styles/wysiwyg.css), so light⇄dark flips for free with no per-theme import and the Crepe table/slash/toolbar UI comes for free. Features `image-block`/`latex`/`ai`/`top-bar` disabled as off-aesthetic or v1 non-goals |
| M5: transaction tagging via `editorViewOptionsCtx.dispatchTransaction` (not the `markdownUpdated` listener) | Milkdown spreads `editorViewOptionsCtx` into the ProseMirror view and sets no `dispatchTransaction` of its own, so overriding it is safe: we `updateState` exactly as PM's default would, then feed the write-back guard `{docChanged, programmatic}` per transaction. Programmatic content (initial load, model→editor sync) carries a `md-notepad-programmatic` tr meta so merely viewing a note never writes back (I2) |
| M6: font size is driven entirely by the `--editor-font-size` CSS variable, not per-editor `setFontSize` | CM6's font compartment, preview.css, and wysiwyg.css already all reference the var, so setting it on `<html>` (via `applyDomSettings`) resizes all three modes live with zero editor plumbing. `mod+=/-/0` and the dialog just update `settings.fontSize`. CM6's `setFontSize` compartment hook is kept but unused. Word wrap is the only setting needing an editor call (`Cm6Adapter.setWordWrap`), applied without re-mount (I7); the adapter stores wrap state in a mutable var so a detach→re-attach cycle honors the latest value |
| M6: settings persisted via `tauri-plugin-store` behind `src/ipc/settings-store.ts`, loaded before paths/mount, debounced save armed only AFTER the initial load | keeps the store plugin as the only `@tauri-apps/plugin-store` touchpoint (layering); loading first means a saved `notesDir`/theme wins the first paint; arming the save subscription after the load avoids echoing the just-loaded value back to disk. Corrupt/missing store → `normalizeSettings` defaults, no crash |
| M6: notes-dir change lives on the session controller with `notesDir` made mutable; moved-note tabs are retargeted by reusing M2's `applyFlushResult(renamedPaths)` | the controller already owns `ipc`, the flush cache, and notices, and every flush reads `notesDir` through one closure var — flipping it repoints writes with no other change. Rather than add a bespoke "retarget notePath" action, the successful moves are fed to `applyFlushResult` (which already remaps `notePath` by old→new path), so restore and the next flush stay consistent. The pure move set (`core/notes-move.ts`, `planNoteMoves`) is the unit-tested piece |

| M7 (2026-07-10): app identifier is `tech.l-small.mdnotepad`; releases published under the `l-small-tech` GitHub handle | project is published pseudonymously; the identifier is user-visible (app-data path) and must not leak the owner's identity. Pre-release, so no shipped installs to migrate |
| M7: update check lives in Settings (an "Updates" row + on-launch check), chip in the status bar | the app has no menu bar, so plan §5-M7's "Help menu item" maps to the Settings dialog; the chip follows the existing notice-area, never-modal convention |
| M7: release/CI workflow actions pinned to commit SHAs; CI token scoped `contents: read`; tag name env-quoted in finalize | release.yml holds the updater signing key — a retargeted upstream action tag must not be able to exfiltrate it (security review L1–L3) |
| M7: `THIRD-PARTY-NOTICES.txt` generated (license-checker-rseidelsohn) and bundled with LICENSE via `bundle.resources` | license audit: OFL-1.1 (Fira Code) and MIT/BSD/Apache deps require their notices to accompany distributed binaries; no license conflicts found with GPL-3.0-only |
| M7: unscoped Rust fs command surface accepted as-is, documented as threat-model decision | commands take arbitrary paths by design (user-configurable notes dir, open/save anywhere). Exploitation requires webview script execution first, which the layered sanitizer + strict CSP prevent; scoping to an allowlist stays on the backlog |

## 10. Backlog (explicitly deferred)

Note search UI · Playwright E2E (vite dev + mockIPC) · mermaid inside
WYSIWYG · export/print (PDF/HTML) · slug transliteration for non-latin
titles · warn when notesDir is inside a cloud-sync root · persist CM6 undo
history in the session · split-pane scroll sync · multi-window · Windows
code signing / Apple notarization · MSI target · winget/homebrew/AUR
manifests · scope Rust fs commands to a notes-dir + opened-paths allowlist
(defense-in-depth; see M7 decision).
