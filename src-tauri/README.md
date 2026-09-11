# src-tauri/ — Rust backend (keep it thin)

Rule I5: Rust has **no business logic**. It offers primitive, generic
filesystem operations plus plugin wiring; every decision about *which* file
to touch and *when* is TypeScript's. If you find yourself encoding tab or
session concepts in Rust, stop and move it to `src/core`.

## What lives here

- `src/lib.rs` — builder: plugin registration (single-instance FIRST),
  managed `StartupFiles` state, `drain_startup_files` command, `open-files`
  event for second-instance argv. Read its doc comments — the
  "why not emit from setup" note matters. `handle_second_instance` reuses a
  live window only when the user can SEE it (`vdesk`), else builds a new
  `w-<millis>` one carrying the argv files in its `?open=` URL param.
- `src/vdesk.rs` — **Windows only**: `IVirtualDesktopManager`, the one
  documented virtual-desktop interface (never reach for the undocumented
  `…Internal` one — its vtable shifts between OS builds). Answers "is this
  window on the desktop the user is looking at?"; `None` (any COM failure)
  means "assume yes", degrading to the old always-focus behaviour.
- `src/commands/fs.rs` — the entire custom IPC surface (reference
  implementation, tested): `read_text_file`, `atomic_write_text`,
  `list_notes`, `list_dir`, `list_session_manifests`, `read_file_base64`,
  `write_file_base64`, `copy_path`, `create_dir`, `rename_path`,
  `delete_path`, `stat_path`.
- `src/commands/git.rs` — git facts for Review mode's "What changed"
  (**desktop only**, `#[cfg(not(target_os = "android"))]` on the module).
  Shells out to the `git` binary — no `git2`/libgit2, because the feature only
  runs where a developer already has git and a large native build buys three
  `rev-parse` calls nothing. `git_repo_info` (root, `rel`, branch, HEAD,
  `is_worktree`, the baseline branch + its merge-base, and every worktree from
  `git worktree list --porcelain`), `git_show_file` (`git show <rev>:<rel>`;
  `None` — not an error — when the path did not exist at that revision), and
  `git_file_changes` (per branch, does its blob for one path differ from the
  baseline's? the worktree radar, one `rev-parse` per branch, no checkouts).
  Every invocation runs on the blocking pool with a hard 3 s timeout (killed
  after it), `stdin` null so nothing can prompt, both pipes drained by their
  own thread so a full pipe can't deadlock the wait, and `CREATE_NO_WINDOW` on
  Windows. The baseline branch is auto-detected — `development`, then `main`,
  then `master` — and overridden by the frontend's `reviewBaseBranch` setting.
  Policy-free (rule I5): which revision is "the baseline" and what a badge
  means are `src/core/code/changes.ts`'s.
- `src/pty.rs` — the pty engine behind terminal tabs (**desktop only**):
  spawn a child on a pseudo-terminal, four threads per session
  (reader → bounded channel → emitter, a waiter, and a writer fed by a
  bounded queue so `write()` never blocks the caller), output coalesced
  into ≤64 KB chunks every 4 ms. Deliberately Tauri-free so its tests run a real
  shell. A session's sink is SWAPPABLE (`Relay`): a pty outlives the webview
  that spawned it, so `detach` / `attach` move the listener between windows
  when a terminal tab is dragged out, and the last ≤1 MB of output (plus an
  exit code the old window never saw) is replayed to whoever attaches, which
  is what repaints the screen there. `attach` resizes to the new window's grid
  FIRST (the shell's redraw then belongs to the replay instead of landing on
  top of it) and closes the replay with `PtyEvent::ReplayEnd` — the frontend
  must not answer the queries a replay contains, so it needs to know when the
  stream goes live. `src/shell.rs` resolves the default shell when the frontend's
  profile names no program: PowerShell 7 (else Windows PowerShell) on
  Windows, zsh on macOS, bash on Linux — each probed on `PATH` first, then
  `$SHELL`, then a shell that always exists. It also owns `search_path`
  (the inherited `PATH` plus what a running process never sees: the
  registry's user/machine `PATH` on Windows, the user-space bin dirs a
  desktop launch lacks on unix) and `find_program` (a `which` honoring
  `PATHEXT`) — used by the pty spawn and by `commands/programs.rs`.
- `src/commands/programs.rs` — `find_programs(names)` (**desktop only**):
  each name → its resolved path or null, so the Settings dialog can dim the
  harnesses that are not installed and offer to install them. Policy-free:
  which names to ask about lives in `src/ui/stores/harness-availability.ts`.
- `src/commands/voice_typing.rs` — **Windows only**: `voice_typing_toggle`
  presses Win+H, which opens or closes Windows voice typing in the focused
  text field (the voice-note sheet's draft box). Voice notes don't use
  `Windows.Media.SpeechRecognition`: for an app without package identity,
  Windows hands that recognizer silence. No audio is touched.
- `src/commands/whisper/` — every platform: offline voice-note
  transcription with whisper.cpp (`whisper-rs`). The GPU backend is chosen
  per target in Cargo.toml — Vulkan on Windows/Linux, Metal on macOS, CPU
  only on Android — and whisper.cpp falls back to the CPU on its own when
  no device works. On Windows `vulkan-1.dll` is delay-loaded (build.rs +
  `src/vulkan_delayload.cpp`): the failure hook turns a missing DLL into the
  C++ exception ggml's Vulkan registration catches, so a driverless machine
  starts and transcribes on the CPU; `MD_NOTEPAD_NO_VULKAN=1` forces the
  same path. `models.rs` owns the pinned manifest (four q5 quantized Hugging
  Face `ggerganov/whisper.cpp` files with sizes and SHA-256 digests), the
  model folder (`<app_data_dir>/whisper`), and the download commands:
  `whisper_models_list`, `whisper_models_stray` / `whisper_models_prune`
  (files an earlier manifest downloaded — reported as a total, deleted on
  request), `whisper_model_dir`, `whisper_model_download` (streams to
  `<file>.part` while hashing, resumes with `Range`, renames into place only
  on a matching digest, reports progress on a `Channel`),
  `whisper_model_cancel`, `whisper_model_delete`. `engine.rs` caches one
  loaded `WhisperContext` per session (keyed by file and GPU flag) and runs
  `whisper_accelerator` ("vulkan" / "metal" / "none"), `whisper_prepare`
  (warm the model; `use_gpu` mirrors the setting) and `whisper_transcribe` —
  raw f32 PCM as the request body (`tauri::ipc::Request`, no JSON/base64)
  with `sample-rate`, `model-id` and `use-gpu` headers, resampled to 16 kHz
  if needed, on the blocking pool. An optional `hint` header is whisper.cpp's initial
  prompt (`FullParams::set_initial_prompt`): words the decoder should expect,
  which Review mode fills with the reviewed file's identifiers as spoken
  words (`src/core/code/vocab.ts` `identifierHint`) — without it the decode
  is unchanged. Audio only ever lives in memory. The network is touched
  only by `whisper_model_download`, only when the user clicks Download.
- `src/commands/pty.rs` — the thin Tauri skin (**desktop only**): the
  `PtyRegistry` and the wire format. Output crosses as
  `InvokeResponseBody::Raw` on a `Channel`, so bytes stay bytes; `exit` and
  `closed` travel down the same channel as JSON so they stay ordered against
  the output they follow. The registry is APP-wide, not per-window — that is
  what lets `pty_attach` hand a running shell to another window (and
  `pty_detach` let go of one without killing it). Commands: `default_shell`,
  `find_programs`, `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`,
  `pty_attach`, `pty_detach`.
- `capabilities/default.json` — plugin/core permissions for every app
  window: `main` plus torn-off tab windows (`w-*`, M8). Custom commands
  need NO capability entries.
- `tauri.conf.json` — app config. `createUpdaterArtifacts` stays `false`
  until M7's key ceremony.

## Error contract (mirrored in src/ipc/commands.ts — keep in sync)

| Rust `FsError` | wire `code` | TS meaning |
| --- | --- | --- |
| `NotFound(path)` | `NOT_FOUND` | subject missing; often expected (stat, restore) |
| `Exists(path)` | `EXISTS` | rename refused to clobber a DIFFERENT entry; caller resolves collisions |
| `InvalidPath(msg)` | `INVALID_PATH` | caller bug — surface loudly in dev |
| `InvalidData(msg)` | `INVALID_DATA` | malformed payload (e.g. bad base64) — caller bug |
| `Io(err)` | `IO` | everything else; message is for logs only |

`PtyError` (`src/pty.rs`) serializes the same `{code, message}` shape and
shares `NOT_FOUND` (no such session — a kill/resize that raced the child's
own exit; callers treat it as success) and `IO`, plus one code of its own:

| Rust `PtyError` | wire `code` | TS meaning |
| --- | --- | --- |
| `Spawn(msg)` | `SPAWN` | the child could not be started (bad program or cwd) |

`WhisperError` (`src/commands/whisper/mod.rs`) serializes the same shape,
shares `INVALID_DATA` / `IO`, and adds its own codes — the sheet's
`core/dictation-errors.ts` turns the first four into steps:

| Rust `WhisperError` | wire `code` | TS meaning |
| --- | --- | --- |
| `NoModel(path)` | `WHISPER_NO_MODEL` | the chosen model isn't downloaded — Settings ▸ Voice notes |
| `ModelCorrupt(msg)` | `WHISPER_MODEL_CORRUPT` | file length ≠ manifest; delete + re-download |
| `LoadFailed(msg)` | `WHISPER_LOAD_FAILED` | whisper.cpp refused the file (bad file, or out of memory) |
| `Failed(msg)` | `WHISPER_FAILED` | transcription itself failed |
| `UnknownModel(id)` | `WHISPER_UNKNOWN_MODEL` | caller bug: id not in the manifest |
| `DownloadFailed(msg)` | `WHISPER_DOWNLOAD_FAILED` | network / HTTP error; the `.part` stays for a resume |
| `DownloadCorrupt` | `WHISPER_DOWNLOAD_CORRUPT` | digest mismatch; the `.part` was deleted |
| `DownloadCancelled` | `WHISPER_DOWNLOAD_CANCELLED` | `whisper_model_cancel` landed; the `.part` stays |
| `DownloadBusy` | `WHISPER_DOWNLOAD_BUSY` | one download at a time |

`GitError` (`src/commands/git.rs`) serializes the same shape with four codes of
its own; `isGitUnavailable` in `src/ipc/commands.ts` treats the first two as
"hide the baseline picker", not as failures:

| Rust `GitError` | wire `code` | TS meaning |
| --- | --- | --- |
| `NoGit` | `GIT_NOT_FOUND` | no `git` binary on `PATH` |
| `NotARepo(path)` | `GIT_NOT_A_REPO` | the path is outside any repository |
| `Timeout` | `GIT_TIMEOUT` | git was killed at 3 s (a hung mount) |
| `Failed { stderr }` | `GIT_FAILED` | git ran and failed; message is its stderr |

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

Desktop-only commands (the pty is the example): gate the `pub mod` in
`commands/mod.rs` with `#[cfg(desktop)]`, gate each `generate_handler!`
entry and the `.manage(...)` the same way, and put the crate in the
`cfg(not(any(target_os = "android", target_os = "ios")))` dependency table
so it never enters the mobile graph. CI's
`cargo check --target aarch64-linux-android` is what catches a miss.

## Atomicity (I3) — why atomic_write_text looks the way it does

Temp file in the target's own directory (rename is atomic only within a
filesystem) → write → `sync_all` (fsync BEFORE rename, or a crash can leave
a renamed-but-empty file) → `NamedTempFile::persist`, which is `rename(2)`
on Unix and `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows — plain
`std::fs::rename` fails on Windows when the target exists. The cargo tests
pin all of this; they run on the 3-OS CI matrix because this is exactly the
code that behaves differently per OS.

`rename_path` carries the other two per-OS traps:

- A **case-only rename** (`notes` → `Notes`) hits a destination that already
  "exists" on Windows/macOS because it IS the source. `is_same_entry`
  (device+inode on Unix, canonical path on Windows) separates that from a real
  collision; the same-entry case renames directly, falling back to a two-step
  rename through a `.…rename<n>.tmp` sibling when a filesystem refuses it.
- A **move across filesystems** (a workspace on another drive) has no rename
  primitive: `EXDEV` / `ERROR_NOT_SAME_DEVICE` falls back to the same atomic
  copy `copy_path` uses, then removes the source. Files only — no recursive
  directory copy.

## Build notes

- `tauri::generate_context!` embeds `../dist` at compile time — run
  `pnpm run build` once before any `cargo test`/`clippy` on a fresh clone
  (CI does this; the error otherwise is a confusing "frontendDist path
  doesn't exist").
- Dev loop: `pnpm run tauri dev` (spawns vite + cargo). Rust-only iteration:
  `cargo test` in `src-tauri/` is fast after the first build.
- Logging: `tauri_plugin_log` defaults to TRACE, and no code in this crate
  logs — so that level is pure dependency noise (the explorer's `notify`
  watcher alone emitted ~700k lines in a 90-second dev run). `run()` caps it
  at INFO. `pnpm run tauri:dev:verbose` passes `--verbose` for DEBUG, and
  `MDN_LOG=off|error|warn|info|debug|trace` overrides both.
- Windows needs MSVC Build Tools; Linux needs the webkit2gtk-4.1 stack
  (exact apt list in `.github/workflows/ci.yml`).
- `whisper-rs` builds whisper.cpp from source, which needs **CMake** on
  `PATH` and **libclang** for bindgen. Windows: `winget install
  Kitware.CMake LLVM.LLVM`, then set `LIBCLANG_PATH` to
  `C:\Program Files\LLVM\bin` (the CMake installer adds itself to `PATH`;
  open a new shell). Linux: `apt-get install cmake libclang-dev`. macOS:
  `brew install cmake llvm` and `LIBCLANG_PATH=$(brew --prefix llvm)/lib`.
  Without them cargo fails inside `whisper-rs-sys`'s build script (a
  "could not find cmake" / "Unable to find libclang" message). The first
  build compiles whisper.cpp (~1–2 min); later builds are cached.
  A real-model engine test exists behind `#[ignore]`:
  `MD_NOTEPAD_WHISPER_MODEL=<path to ggml-*.bin> cargo test -- --ignored real_model`.
