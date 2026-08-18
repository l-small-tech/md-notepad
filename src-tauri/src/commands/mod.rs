#[cfg(target_os = "android")]
pub mod android;
pub mod fs;
#[cfg(target_os = "windows")]
pub mod ocr;
// The pty has no meaning on Android (no fork/exec, no shell) and
// `portable-pty` is kept out of the mobile dependency graph in Cargo.toml.
#[cfg(desktop)]
pub mod pty;
pub mod search;
#[cfg(desktop)]
pub mod watch;
