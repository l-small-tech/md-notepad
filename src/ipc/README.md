# src/ipc/ — the Tauri boundary

This directory is the ONLY place `invoke()` and `@tauri-apps/api/*` are
allowed (invariant I9, lint-enforced). Everything above it calls `ipc.*`
wrappers, so the Rust↔TS contract lives in exactly two files that must be
edited together: `commands.ts` here and `src-tauri/src/commands/<area>.rs`
there. The checklist for adding a command is in `src-tauri/README.md`.

## Contracts

- **One wrapper per Rust command, same name.** `read_text_file` →
  `readTextFile`. Argument keys are camelCase in TS and snake_case in Rust;
  Tauri maps between them, so `baseBranch` fills `base_branch`. Wire structs
  carry `#[serde(rename_all = "camelCase")]`, and the TS `interface` beside the
  wrapper mirrors it field for field.
- **`ipc` imports nothing app-local.** Types the rest of the app also needs are
  declared here and re-declared (or structurally matched) in `core` — never
  imported from it.
- **Errors are `{ code, message }`.** `call<T>` turns a rejection into a typed
  `IpcError`; logic switches on `.code`, and `.message` is for logs and the
  status bar only. An unknown or unshaped rejection degrades to `IO`. Adding a
  Rust error variant means adding its code to `IpcErrorCode` *and* to the table
  in `src-tauri/README.md`, same commit.
- **Platform-only commands reject rather than exist.** A command registered
  behind `#[cfg(desktop)]` or `#[cfg(target_os = "android")]` is not in the
  handler on the other platform, so calling it there rejects with a
  "command not found" message (an `IO` `IpcError`). Every such wrapper's doc
  comment names its platform; callers go behind a platform check
  (`isAndroid()`, `dictationEngine()`, …), never a try/catch.
- **Big payloads skip JSON.** Raw bytes travel as the request body
  (`whisperTranscribe`) or as `InvokeResponseBody::Raw` on a `Channel`
  (`ptySpawn`), not as arrays in JSON.

## What else lives here

`provider.ts` (the storage router's local/SAF providers), `paths.ts`
(notes/session dirs per platform), `pty.ts` (the terminal's channel plumbing),
`settings-store.ts`, `clipboard.ts`, `dialog.ts`, `theme-loader.ts`,
`theme-seed-images.ts`.

## Git facts (desktop only) — Review mode's "What changed"

`gitRepoInfo`, `gitShowFile` and `gitFileChanges` wrap
`src-tauri/src/commands/git.rs`, which shells out to the `git` binary (3 s
timeout per call, on Rust's blocking pool). They are NOT registered on Android.

| Wrapper | Answers |
| --- | --- |
| `gitRepoInfo(path, baseBranch?)` | root, `rel`, branch, HEAD, `isWorktree`, the baseline branch and its `merge-base` (`baseRef`), and every worktree |
| `gitShowFile(root, rev, rel)` | the file's text at `rev`, or `null` when it did not exist there (a new file) |
| `gitFileChanges(root, rel, baseRef, branches)` | per branch, whether its blob for `rel` differs from `baseRef`'s (the worktree radar) |

`baseBranch` is the `reviewBaseBranch` setting; pass it only when non-empty.
A branch the checkout does not have falls back to auto-detection
(`development`, then `main`, then `master`).

| `code` | Meaning |
| --- | --- |
| `GIT_NOT_FOUND` | no `git` on `PATH` |
| `GIT_NOT_A_REPO` | the path is outside any repository |
| `GIT_TIMEOUT` | git was killed at 3 s (a hung network mount) |
| `GIT_FAILED` | git ran and failed; `message` carries its stderr |

`isGitUnavailable(err)` is true for the first two: both mean "hide the
baseline picker behind a one-line hint and render every other view", while a
timeout or failure is worth surfacing.
