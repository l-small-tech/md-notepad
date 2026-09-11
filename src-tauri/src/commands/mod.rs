#[cfg(target_os = "android")]
pub mod android;
pub mod fs;
// Git facts for Review mode's "What changed". Desktop-only: it shells out to
// the `git` binary, which no Android device has.
#[cfg(not(target_os = "android"))]
pub mod git;
#[cfg(target_os = "windows")]
pub mod ocr;
// The pty has no meaning on Android (no fork/exec, no shell) and
// `portable-pty` is kept out of the mobile dependency graph in Cargo.toml.
// Which programs are on PATH — asked for the harnesses the Settings dialog
// lists. Desktop-only: it exists to decide what a terminal tab can launch.
#[cfg(desktop)]
pub mod programs;
#[cfg(desktop)]
pub mod pty;
pub mod search;
#[cfg(target_os = "windows")]
pub mod voice_typing;
#[cfg(desktop)]
pub mod watch;
#[cfg(desktop)]
pub mod webview;
// Offline voice-note transcription (whisper.cpp), every platform. On Android
// it sits beside the on-device recognizer (the `androidDictationEngine`
// setting picks); the manage()/register calls in lib.rs are unconditional.
pub mod whisper;
