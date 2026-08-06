#[cfg(target_os = "android")]
pub mod android;
pub mod fs;
#[cfg(target_os = "windows")]
pub mod ocr;
pub mod search;
#[cfg(desktop)]
pub mod watch;
