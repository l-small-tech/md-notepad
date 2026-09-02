# src/core/ — Pure logic (the reference implementations live here)

Everything in this directory is DOM-free, Tauri-free, React-free (invariant
I9, lint-enforced) and fully covered by Vitest. These files are **normative**:
their tests define contracts the rest of the app builds on. Extend them;
do not rewrite them.

## What lives here

| File | Status | Role |
| --- | --- | --- |
| `types.ts` | reference | shared vocabulary (TabState, Settings, EditorMode…) |
| `doc-model.ts` | reference | canonical-text document model (I1) |
| `diff.ts` | reference | pure line diff (Myers) + side-by-side row builder with intra-line ranges — DiffView now, git integration later |
| `mode-sync.ts` | reference | mode-switch state machine + WYSIWYG write-back guard (I2) |
| `title.ts` | reference | `deriveTitle` / `slugifyTitle` |
| `error-text.ts` | reference | `errorDetail` / `withErrorDetail`: the one-line reason behind a failed file operation, for the notice the UI shows (cloud drives fail in ways a bare "Could not rename" hides) |
| `tab-status.ts` | terminal | agent status glyph in a terminal's OSC title (`✳ `, `◐ `) → activity + the remaining label, for the TabBar badge |
| `settings.ts` | reference | defaults + `normalizeSettings` |
| `notes-move.ts` | M6 | pure `planNoteMoves` for the notes-dir change flow |
| `window-drop.ts` | M8 | `pickDropWindow`: which window a tab drag released over (containment + focus-recency for overlap), for the cross-window tab drop |
| `doc-family.ts` | reference | which modes a path's document type may use (`.svg` → Draw/Raw) |
| `external-links.ts` | reference | external-link policy: is an href `http(s)`, what host does it really resolve to, how is it shown in the confirmation prompt |
| `external-links.ts` | reference | link policy: is an href external, what host does it REALLY reach, how to elide it for the confirm prompt |
| `whiteboard/` | feature | the `.svg` whiteboard format — see `whiteboard/README.md` |
| `session/plan-flush.ts` | reference | pure flush planner + executor (I3, I4) |
| `export/doc-source.ts` | feature | shared export vocabulary (`DocSource`, `ExportFormat`) |
| `export/docx.ts` | feature | markdown → .docx (same remark/GFM parse as the preview, mapped onto `docx` objects; images via injected resolver) |
| `export/pdf.ts` | feature | markdown → .pdf via a pure pdfmake doc-definition (same parse/degrades as docx.ts; theme colors via `pdfThemeFromPlugin`; no print dialog) |
| `export/svg-theme.ts` | feature | recolors an embedded .svg onto the export theme's ink/paper (achromatic → theme ramp, chromatic kept) for the HTML and PDF exports; also reads an svg's intrinsic size |
| `session/debounce.ts` | reference | idle+maxWait debouncer with drain semantics |
| `panes.ts` | terminal | the split tree — immutable binary tree of panes, one per terminal tab |
| `smooth-scroll.ts` | terminal | the terminal viewport's scroll physics (renderer/ is the only consumer — DOM surfaces scroll natively, see ui/README): critically damped spring (velocity carries across retargets), the wheel-vs-touchpad classifier, and the notch-unit tracker that makes one notch scroll the same lines on every platform |
| `geometry.ts` | terminal | grid math: pixel size + cell metrics → `{cols, rows}` (never 0×0) |
| `color.ts` | terminal | color math for theming: parse/format hex, mix, adjust, `ensureContrast` (WCAG) |
| `terminal-shells.ts` | terminal | the shells the settings picker offers per desktop OS; `settings.terminalShell` is ONE global choice, not one per profile. `shellKind(program)` names the shell a program is (pwsh / powershell / cmd / bash / zsh / fish / sh) for the two modules below |
| `shell-integration.ts` | terminal | the prompt hook that makes a PLAIN shell report its cwd (OSC 7): per-shell launch extras (`shellIntegrationLaunch`), the bash/zsh script texts the app writes to disk (`SHELL_INTEGRATION_FILES`), and the OSC 7 URL decoder (`pathFromFileUrl`). Never touches a profile naming its own program |
| `shell-commands.ts` | terminal | commands the right-click helpers TYPE into a shell: `cdCommand` / `listCommand` / `quoteCommand` in the shell's own quoting dialect, `relativePath` (Windows: same drive, case-insensitive) and `cdTarget` (relative inside the same workspace, absolute otherwise) |
| `tui-install.ts` | terminal | the install command the Settings dialog's **Install** button types for a missing AI TUI agent: official routes per agent × OS × available package managers (winget/brew/scoop → own installer → npm, with a Node step when npm is absent), spelled for the shell that runs it (POSIX / pwsh / Windows PowerShell / cmd) |
| `terminal-palette.ts` | terminal | `branding` → 16 ANSI + chrome colors, with a measured contrast floor (AA on light surfaces, where a dark-assuming TUI's text lands); an optional `terminal` block in a theme merges over it. Also `terminalEnvHints` — the `COLORFGBG` light/dark hint a pty is spawned with |

## Contracts you must not break

1. **DocModel** — the markdown string is the only truth (I1). Subscription
   dispatch is SYNCHRONOUS; echo suppression therefore uses a reentrancy
   flag (pattern in `doc-model.ts` header + `doc-model.test.ts`). Dirty
   tracking is snapshot-per-persistence-kind (`session` vs `file`).
2. **Write-back guard** (I2) — WYSIWYG serialization is pushed only after a
   user edit since attach. `detach()` must call `flushSync()`. The
   "mount → look → leave is byte-identical" test is the guarantee users
   feel; treat a change that breaks it as data corruption.
3. **Mode-sync** — transitions serialize on one promise chain; raw⇄split
   never detaches the source editor; failures revert with canonical text
   untouched. Adapters must survive re-attach.
4. **planFlush / executeFlushPlan** — the manifest is written LAST (I4).
   Rename failures are tolerated and redirected; any other IO failure
   aborts BEFORE the manifest. `planFlush` stays pure — if you need more
   information in a plan, add it to `AppSessionView` and pass it in (M2 did
   exactly this with the optional `suppressedRenamePaths`, which lets the
   flusher stop planning a rename it has failed ~3× in a row).
5. **Debouncer** — `flushNow()` drains everything requested before the
   call; a failed run stays dirty and retries. maxWait is armed on the
   first unflushed request and never pushed back.

## Session persistence — how the pieces compose (M2)

```
model change / tab op ──▶ flusher.request()
                              │ (idle 1s or maxWait 5s)
                              ▼
        view = assemble AppSessionView from stores
        plan = planFlush(view)                     ← pure, tested
        result = await executeFlushPlan(plan, ipc) ← manifest last
        apply result.assignedNotePaths + renameFailures to store
        markPersisted('session') on flushed models
        refresh cached existingNoteFiles
```

- `existingNoteFiles` exists so a NEW note never clobbers an on-disk file
  no tab owns. Keep the cache fresh: seed from `ipc.listNotes` at startup,
  update after each flush (you know exactly what you wrote/renamed).
- Rename-failure policy: keep old path, retry next flush; after ~3
  consecutive failures for the same rename, stop planning it (track the
  count in the store tombstone) — the file simply keeps its old name.
- `parseManifest`
  here is the only manifest reader — never `JSON.parse` a manifest anywhere
  else.

## Two-tier data placement (why notes ≠ buffers)

- **Notes dir** = user data. Real `.md` files, human-readable names,
  browsable, syncable. The manifest stores only *metadata* about note tabs.
- **Session dir** (`<appDataDir>/session`) = machine state. `session.json`
  + `buffers/<tabId>.md` for FILE tabs' unsaved edits only.
- Consequence: a lost/corrupt manifest costs tab order, modes and cursors —
  never note content. This property is load-bearing; don't move note
  content into the manifest or buffers.
- A note tab's file lives at the notes dir ROOT — `planFlush` never writes
  one anywhere else, and its NAME follows the tab title. So a note file that
  leaves that directory (dragged into another workspace, or into a
  subfolder) can no longer be a note: the ui side converts the tab to a file
  tab (`tabsStore.adoptMovedNoteAsFile`). Anything that relocates a note file
  owes the same conversion, or the next title change will drag the file back.

## Gotchas

- Slugs are lowercase-ASCII and collision checks are CASE-INSENSITIVE
  (Windows/macOS filesystems). `slugifyTitle` also guards Windows reserved
  basenames (`con`, `nul`, …) — don't "simplify" that away.
- `joinPath` uses `/` even on Windows — Rust's `PathBuf` normalizes. Don't
  introduce a platform-path dependency in core.
- Keep `SessionManifest.schema = 1` until a breaking manifest change ships;
  then bump it and make `parseManifest` migrate or reject old schemas
  explicitly.

## Testing expectations

Every exported function has suite coverage in `__tests__/`. When you extend
a reference file, extend its tests in the same commit. Fake timers for
anything time-based; no sleeps.
