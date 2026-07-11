# src-tauri/ — Rust backend (keep it thin)

Rule I5: Rust has **no business logic**. It offers primitive, generic
filesystem operations plus plugin wiring; every decision about *which* file
to touch and *when* is TypeScript's. If you find yourself encoding tab or
session concepts in Rust, stop and move it to `src/core`.

## What lives here

- `src/lib.rs` — builder: plugin registration (single-instance FIRST),
  managed `StartupFiles` state, `drain_startup_files` command, `open-files`
  event for second-instance argv. Read its doc comments — the
  "why not emit from setup" note matters.
- `src/commands/fs.rs` — the entire custom IPC surface (reference
  implementation, tested): `read_text_file`, `atomic_write_text`,
  `list_notes`, `list_dir`, `read_file_base64`, `write_file_base64`,
  `copy_path`, `create_dir`, `rename_path`, `delete_path`, `stat_path`.
- `capabilities/default.json` — plugin/core permissions for the main
  window. Custom commands need NO capability entries.
- `tauri.conf.json` — app config. `createUpdaterArtifacts` stays `false`
  until M7's key ceremony.

## Error contract (mirrored in src/ipc/commands.ts — keep in sync)

| Rust `FsError` | wire `code` | TS meaning |
| --- | --- | --- |
| `NotFound(path)` | `NOT_FOUND` | subject missing; often expected (stat, restore) |
| `Exists(path)` | `EXISTS` | rename refused to clobber; caller resolves collisions |
| `InvalidPath(msg)` | `INVALID_PATH` | caller bug — surface loudly in dev |
| `InvalidData(msg)` | `INVALID_DATA` | malformed payload (e.g. bad base64) — caller bug |
| `Io(err)` | `IO` | everything else; message is for logs only |

Adding a variant = adding it to `IpcErrorCode` in `src/ipc/commands.ts` and
to this table, same commit.

## Checklist: adding a Tauri command

1. Write the `#[tauri::command]` fn in `src/commands/<area>.rs` (new module
   → add to `commands/mod.rs`). Return `Result<T, FsError>` (or a new
   error enum following the same serialize pattern).
2. Register it in `lib.rs` → `tauri::generate_handler![...]`.
3. Add the typed wrapper to `src/ipc/commands.ts` (camelCase args — Tauri
   maps them onto snake_case params).
4. `#[cfg(test)]` tests beside the command (tempfile-based, no mocks).
5. `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`.

Plugin permissions (only when adding a PLUGIN, not a custom command): add
the permission string to `capabilities/default.json`.

## Atomicity (I3) — why atomic_write_text looks the way it does

Temp file in the target's own directory (rename is atomic only within a
filesystem) → write → `sync_all` (fsync BEFORE rename, or a crash can leave
a renamed-but-empty file) → `NamedTempFile::persist`, which is `rename(2)`
on Unix and `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows — plain
`std::fs::rename` fails on Windows when the target exists. The cargo tests
pin all of this; they run on the 3-OS CI matrix because this is exactly the
code that behaves differently per OS.

## Build notes

- `tauri::generate_context!` embeds `../dist` at compile time — run
  `npm run build` once before any `cargo test`/`clippy` on a fresh clone
  (CI does this; the error otherwise is a confusing "frontendDist path
  doesn't exist").
- Dev loop: `npm run tauri dev` (spawns vite + cargo). Rust-only iteration:
  `cargo test` in `src-tauri/` is fast after the first build.
- Windows needs MSVC Build Tools; Linux needs the webkit2gtk-4.1 stack
  (exact apt list in `.github/workflows/ci.yml`).
