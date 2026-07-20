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
| `mode-sync.ts` | reference | mode-switch state machine + WYSIWYG write-back guard (I2) |
| `title.ts` | reference | `deriveTitle` / `slugifyTitle` |
| `settings.ts` | reference | defaults + `normalizeSettings` |
| `notes-move.ts` | M6 | pure `planNoteMoves` for the notes-dir change flow |
| `session/plan-flush.ts` | reference | pure flush planner + executor (I3, I4) |
| `export/doc-source.ts` | feature | shared export vocabulary (`DocSource`, `ExportFormat`) |
| `export/docx.ts` | feature | markdown → .docx (same remark/GFM parse as the preview, mapped onto `docx` objects; images via injected resolver) |
| `export/pdf.ts` | feature | markdown → .pdf via a pure pdfmake doc-definition (same parse/degrades as docx.ts; theme colors via `pdfThemeFromPlugin`; no print dialog) |
| `session/debounce.ts` | reference | idle+maxWait debouncer with drain semantics |

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
