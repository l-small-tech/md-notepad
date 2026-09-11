# Whisper voice-note transcription — implementation plan

Status: DONE (implemented 2026-09-10 on branch `feat/whisper`, worktree `worktrees/whisper`; see the notes at the end). Written 2026-09-10 for execution by Claude Code.

## 0. Decisions already made

- **On-demand model download, nothing bundled.** Weights come from
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>` and are
  verified against SHA-256 digests pinned in the app. Installer growth is the
  whisper.cpp engine only (a few MB).
- **Default model: `small.en`** (466 MB, ~0.9 GB RAM, ~12 s per 30 s clip on a
  4-core CPU). Picker also offers `tiny.en`, `base.en`, `medium.en`,
  `large-v3-turbo`, plus q5 quantized variants of each where published.
- **Engine: whisper.cpp via the `whisper-rs` crate**, CPU-only in v1. GPU
  features (Vulkan / Metal / CoreML) are a follow-up, not in scope.
- **Desktop-only** (Windows, macOS, Linux). Android keeps its native
  SpeechRecognizer. The Windows voice-typing engine stays and remains the
  Windows default until a model is downloaded.
- **No audio ever touches disk.** PCM lives in memory for one capture and is
  dropped after transcription. This preserves the existing "no audio files"
  rule (commit 1fec483).
- **Batch transcription** on the second tap (no streaming). The sheet gains a
  `transcribing` phase.

## 1. Definition of done

1. Settings ▸ Voice notes shows a **Transcription engine** choice on desktop:
   *Windows voice typing* (Windows only) / *Whisper (offline)*, and a
   **Whisper model** section listing models with size, download / delete
   buttons, a progress bar, and the active model marked.
2. With Whisper selected and a model present, a voice note on Windows, macOS
   and Linux produces a transcript in `<name>.comments.md` exactly as the
   Android path does today.
3. Every failure (no mic, permission denied, model missing / corrupt, download
   interrupted, transcription error) shows in the sheet through the existing
   `CaptureError` shape with steps.
4. `pnpm run check`, `pnpm test`, `cargo fmt --check`, `cargo clippy
   --all-targets -- -D warnings`, `cargo test`, and `cargo check --target
   aarch64-linux-android` are all green. CI on all three desktop runners
   builds with the new native dependency.
5. `pnpm run tauri:dev` starts, a real dictation round-trips end to end on
   this Windows 11 machine, and the dev server is stopped afterwards.
6. Docs updated: `docs/settings.md`, `src/README.md` / `src-tauri/README.md`
   contracts, `src/ipc/README.md`, and this file's status flipped to DONE.

## 2. Architecture

```
webview (React)                      Rust (Tauri)
───────────────────────────────      ─────────────────────────────────────────
VoiceComments.tsx  (projection)      commands/whisper/
voice-comments.ts  (controller) ──►    mod.rs        command registration
  dictationEngine() → 'whisper'        models.rs     manifest, paths, download, verify, delete
  startCapture → pcm-capture.ts        engine.rs     whisper-rs context cache + transcribe
  stopCapture  → ipc.whisperTranscribe
core/whisper-models.ts (pure)        Model dir: <app_data_dir>/whisper/<file>.bin
  manifest types, size formatting,   Download temp: <file>.bin.part → rename on verified digest
  state machine for download UI
```

Layering (invariant I9) is unchanged: `core` gains pure model-manifest logic,
`ipc` gains typed wrappers, `ui` wires them. Audio capture is DOM-only and
therefore lives in `ui/` (`src/ui/pcm-capture.ts`), not `core/`.

### 2.1 Audio path

- `AudioContext({ sampleRate: 16000 })` + `getUserMedia({ audio: true })` +
  an `AudioWorkletNode` whose processor posts `Float32Array` frames (128
  samples each) to the main thread. Main thread appends to a growing buffer.
  Worklet source is an inline `Blob` URL so Vite needs no special config.
- On stop: concatenate to one `Float32Array`, send to Rust as the raw request
  body of `invoke('whisper_transcribe', ...)` using Tauri 2's binary IPC
  (`tauri::ipc::Request` with `Body::Raw` on the Rust side). No base64.
- Hard cap: 10 minutes of audio (≈ 38 MB f32). Past that, auto-stop with a
  `WHISPER_TOO_LONG` error.
- Fallback if the context refuses 16 kHz (some Linux backends): capture at the
  device rate and resample in Rust with a simple linear resampler (or the
  `rubato` crate). The request carries `sample_rate` in its headers.

### 2.2 Rust engine

- `whisper-rs = "0.14"` (or newest; check crates.io at implementation time) in
  the desktop-only dependency table in `src-tauri/Cargo.toml`, next to
  `portable-pty`. Module gated `#[cfg(desktop)]` in `commands/mod.rs` and
  `lib.rs`, same pattern as `pty`.
- `engine.rs`: a `Mutex<Option<(PathBuf, WhisperContext)>>` cache so the model
  loads once per session and reloads only when the chosen file changes.
  `transcribe(pcm: &[f32], language: Option<&str>) -> Result<String>` runs
  `FullParams` with `SamplingStrategy::Greedy { best_of: 1 }`, `n_threads =
  min(available_parallelism, 8)`, `language` = `"en"` for `.en` models else
  `None` (auto), `suppress_blank`, `no_context`, timestamps off. Segments are
  joined with single spaces and trimmed.
- Transcription runs inside `tauri::async_runtime::spawn_blocking` so the IPC
  thread is never blocked; the command awaits it.
- Whisper log callback routed to `log::debug!` via `whisper_rs::install_logging_hooks()`.

### 2.3 Model management

- `models.rs` holds a `const MANIFEST: &[ModelSpec]`:
  `{ id, file, bytes, sha256, label, multilingual }`. Digests are copied from
  the Hugging Face LFS pointers at implementation time and unit-tested for
  well-formedness (64 hex chars, unique ids).
- Commands:
  - `whisper_models_list() -> Vec<ModelStatus>` — manifest joined with on-disk
    state (`installed`, `bytes_on_disk`, `downloading`).
  - `whisper_model_download(id, channel: Channel<DownloadEvent>)` — streams
    with `reqwest` (`stream` feature, `rustls-tls`), writes `<file>.part`,
    hashes with `sha2` as it goes, emits `{ received, total }` every ≥ 200 ms,
    renames on digest match, deletes `.part` and returns
    `WHISPER_DOWNLOAD_CORRUPT` on mismatch. Supports `Range` resume of an
    existing `.part`. One download at a time (a `Mutex<Option<ModelId>>`).
  - `whisper_model_cancel()` — flips an `AtomicBool` checked between chunks;
    keeps the `.part` for resume.
  - `whisper_model_delete(id)` — removes the file, clears the engine cache if
    it was loaded.
- Model dir: `app.path().app_data_dir()?.join("whisper")`. Reported in the
  settings UI with an "Open folder" button (uses `tauri-plugin-opener`, already
  a dependency).
- Network calls happen only when the user clicks Download. No background
  fetches, no telemetry.

### 2.4 Settings

Add to `Settings` (`src/core/types.ts`) with defaults and migration in
`src/core/settings.ts`:

```ts
/** Desktop dictation engine. 'auto' = Windows voice typing on Windows, else Whisper. */
desktopDictationEngine: 'auto' | 'windowsVoiceTyping' | 'whisper';   // default 'auto'
/** Manifest id of the Whisper model to use. */
whisperModel: string;                                                // default 'small.en'
```

`dictationEngine()` in `voice-comments.ts` becomes:

```
android                      → 'android'
setting 'whisper'            → 'whisper'
setting 'windowsVoiceTyping' → isWindows() ? 'windows' : null
'auto'                       → isWindows() ? 'windows' : 'whisper'
```

`DictationEngine` in `core/dictation-errors.ts` gains `'whisper'`, and
`captureErrorFor` gains `whisperError(code)` covering:
`WHISPER_NO_MODEL` (steps: open Settings, download small.en),
`WHISPER_MODEL_CORRUPT`, `WHISPER_MIC_DENIED`, `WHISPER_NO_MIC`,
`WHISPER_TOO_LONG`, `WHISPER_LOAD_FAILED`, `WHISPER_FAILED`, and the shared
`STT_NO_MATCH` when the transcript is empty.

The ribbon's Read-mode voice-notes button shows whenever `dictationEngine()`
is non-null, which now includes macOS and Linux.

## 3. Work breakdown (each step ends green)

Work in a worktree: `git worktree add worktrees/whisper -b feat/whisper development`,
then `pnpm install` inside it. Read the README of every directory before
editing files in it.

### Step 1 — Toolchain and a compiling dependency
- Add `whisper-rs` to the desktop-only table; add `reqwest` (features
  `stream`, `rustls-tls`, no default features), `sha2`, `futures-util`.
- Install prerequisites on this machine if missing: CMake and LLVM
  (`winget install Kitware.CMake LLVM.LLVM`), set `LIBCLANG_PATH` to
  `C:\Program Files\LLVM\bin`. Document in `src-tauri/README.md`.
- CI: in `ci.yml` and `release.yml`, add a step for the desktop matrix:
  Windows `choco install llvm` (cmake is preinstalled) and export
  `LIBCLANG_PATH`; Ubuntu `apt-get install -y cmake libclang-dev`; macOS has
  both via Xcode CLT + Homebrew (`brew install cmake llvm` if the runner lacks
  them). Verify `cargo check --target aarch64-linux-android` still passes
  (the crate must be absent from that target's graph).
- Gate: `pnpm run build && cargo check` on Windows.

### Step 2 — Pure core: `src/core/whisper-models.ts`
- Types `WhisperModelSpec`, `WhisperModelStatus`, `DownloadProgress`.
- `formatBytes`, `isInstalled`, `recommendedModel()` (returns `small.en`),
  `downloadReducer` (idle → downloading(received,total) → verifying → done |
  failed(code) | cancelled) used by the settings UI.
- Tests in `src/core/__tests__/whisper-models.test.ts`.

### Step 3 — Rust model management (`commands/whisper/models.rs`)
- Manifest, paths, list/download/cancel/delete commands, `Channel` progress.
- Unit tests: manifest well-formedness, `.part` → final rename on matching
  digest using a temp dir and a fake payload (hash computed in the test),
  mismatch deletes `.part`, resume sends a `Range` header (test via a tiny
  local `std::net::TcpListener` responder or by factoring the writer so it is
  testable without HTTP).
- Register in `lib.rs` under `#[cfg(desktop)]`; add `ipc` wrappers in
  `src/ipc/commands.ts` (`whisperModelsList`, `whisperModelDownload(id,
  onProgress)`, `whisperModelCancel`, `whisperModelDelete`) and document them
  in `src/ipc/README.md`.
- Gate: `cargo test`, `cargo clippy -D warnings`.

### Step 4 — Rust engine (`commands/whisper/engine.rs`)
- Context cache, `whisper_transcribe` command taking a raw body + headers
  `sample-rate`, `model-id`. Resample if rate ≠ 16000.
- Unit test with a 1 s silent buffer returns `Ok("")` when a model is present,
  and `WHISPER_NO_MODEL` when not; the real-model test is `#[ignore]` and run
  manually with `MD_NOTEPAD_WHISPER_MODEL=<path>`. Add a fixture-based test
  using `scripts/record-fixture.sh` output if a short WAV is checked in
  (≤ 200 KB, 16 kHz mono).
- `ipc.whisperTranscribe(pcm: Float32Array, sampleRate)` wrapper.

### Step 5 — Audio capture (`src/ui/pcm-capture.ts`)
- `startPcmCapture(): Promise<PcmCapture>` with `stop(): Float32Array`,
  `sampleRate`, `cancel()`. Maps `NotAllowedError` → `WHISPER_MIC_DENIED`,
  `NotFoundError` → `WHISPER_NO_MIC`. Enforces the 10-minute cap through a
  callback so the controller can auto-stop.
- Not unit-tested (DOM); its logic is kept to plumbing. Any thresholds or
  buffer math go in `core/whisper-models.ts` or a small pure helper with tests.

### Step 6 — Controller and sheet
- `voice-comments.ts`: new engine branch in `startCapture` / `toggleMic`;
  new `transcribing` phase; on stop → `ipc.whisperTranscribe` → transcript →
  existing append path. Errors through `captureErrorFor(raw, 'whisper')`.
- `VoiceComments.tsx`: render `transcribing` as a spinner with "Transcribing…"
  and no tap handling; `WHISPER_NO_MODEL` error gets the existing Settings
  button (`openCaptureSettings`) pointed at the Voice notes tab.
- `Ribbon.tsx`: show the button when `dictationEngine() !== null`.
- Tests: extend `src/ui/__tests__/voice-comments.test.ts` with the whisper
  branch (mock `ipc` and `pcm-capture`), and `dictation-errors.test.ts` with
  every new code.

### Step 7 — Settings UI
- `SettingsDialog.tsx`, Voice notes tab: engine select (hidden on Android;
  "Windows voice typing" option only on Windows), model list with
  Download / Cancel / Delete / "Use this model", progress bar, installed size,
  disk location + Open folder. Recommended model tagged "Recommended".
- A small `src/ui/stores/whisper-models.ts` Zustand store holds list +
  download state, driven by the reducer from Step 2, so the component stays a
  projection. Test the store.
- `docs/settings.md` entries for both settings.

### Step 8 — End-to-end verification and docs
- `pnpm run format && pnpm run check && pnpm test`.
- `pnpm run build`, `cargo fmt --check`, `cargo clippy --all-targets -- -D
  warnings`, `cargo test`, `cargo check --target aarch64-linux-android`.
- `pnpm run tauri:dev`: download small.en from Settings, take a voice note in
  Read mode, confirm the transcript lands in the sidecar, confirm no file
  appears anywhere except `<app_data>/whisper/`. Stop the dev server (kill
  the orphan vite on 1420 if needed).
- Update READMEs, flip this file's status, commit, report the worktree path.
  Do not merge without explicit confirmation.

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `whisper-rs` build needs CMake + libclang on dev box and CI | Step 1 installs and documents; fail fast before any feature code |
| Windows build with MSVC picks up wrong CMake generator | Set `CMAKE_GENERATOR=Ninja` or let whisper-rs default; verify in Step 1 |
| Android `cargo check` pulls whisper-rs in | Keep it strictly in the `not(any(android, ios))` table; verify in Step 1 |
| Large IPC body (up to ~38 MB) | Raw binary body, no JSON; cap at 10 min; measured in Step 4 |
| Hugging Face URL or digest drift | Pinned digests; corrupt download is detected and deleted; manifest is one const to update |
| CPU too slow for medium/turbo | UI shows estimated speed hints; default is small.en; transcription is off-thread |
| Release binary size | whisper.cpp adds ~3–5 MB; acceptable |
| Linux `AudioContext` refuses 16 kHz | Resample in Rust (Step 4) |

## 5. Out of scope (follow-ups)

- GPU acceleration features (Vulkan on Windows/Linux, Metal/CoreML on macOS).
- Streaming partial transcripts while speaking.
- Non-English UI for language selection (turbo auto-detects; a language
  dropdown can come later).
- Whisper on Android.

## 6. Implementation notes (2026-09-10)

- The 10-minute cap does not fail the note: the capture stops itself, what
  was said is transcribed and saved, and the status bar says why it ended.
  `WHISPER_TOO_LONG` stays defined in `dictation-errors.ts` for the sheet.
- reqwest is built with `rustls-no-provider` to match the updater, so
  `models.rs` installs the `ring` provider before the first client (the
  updater only does so when it runs). Found in the live test: without it the
  download task panicked and left the one-download slot "busy".
- The Settings dialog gained a **Voice notes** tab (the location fields moved
  there from Files); the tab strip wraps instead of scrolling.
- The sidecar's agent-facing disclaimer now names Whisper as an engine.
- Verified on this Windows 11 machine: small.en download (with a cancel and
  a resume mid-way) → pinned digest matched; a spoken sentence went
  microphone → Whisper → `<name>.comments.md` verbatim; the missing-model
  error shows in the sheet with the Settings button; no audio file anywhere.
