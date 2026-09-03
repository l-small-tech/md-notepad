#[cfg(target_os = "android")]
pub mod android;
pub mod fs;
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
#[cfg(desktop)]
pub mod watch;
#[cfg(desktop)]
pub mod webview;
