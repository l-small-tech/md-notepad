//! Default-shell resolution: `pty_spawn` uses this as the default program when
//! the terminal profile names no command. Desktop-only, like the pty itself.
//!
//! The frontend's "Shell" setting (`settings.terminalShell`) is what usually
//! decides — it writes a `program` into the profile and this file never runs.
//! What is implemented here is the *automatic* choice, i.e. what the app picks
//! on a machine nobody has configured: the shell a user of that OS expects a
//! terminal to open, not whatever `chsh` happens to say.
//!
//!   Windows  PowerShell 7 (`pwsh.exe`), falling back to Windows PowerShell 5
//!   macOS    zsh — the login shell since Catalina
//!   Linux    bash
//!
//! Each choice is probed before it is returned, so a system without it
//! degrades to `$SHELL` and finally to a shell that is always present, rather
//! than failing to spawn.

use std::path::Path;

/// Last resort: present on every install of the platform.
#[cfg(windows)]
const FALLBACK: &str = "powershell.exe";
#[cfg(not(windows))]
const FALLBACK: &str = "/bin/sh";

/// The preferred shell for this OS, tried first and only used if it exists.
#[cfg(windows)]
const PREFERRED: &str = "pwsh.exe";
#[cfg(target_os = "macos")]
const PREFERRED: &str = "zsh";
#[cfg(all(unix, not(target_os = "macos")))]
const PREFERRED: &str = "bash";

/// The shell a new terminal runs when nothing names one.
///
/// Split from the environment and filesystem lookups so the policy is testable
/// without mutating the process environment (which races across parallel test
/// threads) or depending on what is installed on the build machine.
pub fn default_shell() -> String {
    resolve_shell(env_shell().as_deref(), on_path)
}

/// `$SHELL` names a *unix* shell, so it is only consulted on unix — a Windows
/// app launched from Git Bash inherits `SHELL=/usr/bin/bash`, a path no
/// `CreateProcess` can spawn.
#[cfg(windows)]
fn env_shell() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn env_shell() -> Option<String> {
    std::env::var("SHELL").ok()
}

fn resolve_shell(env_shell: Option<&str>, exists: impl Fn(&str) -> bool) -> String {
    if exists(PREFERRED) {
        return PREFERRED.to_string();
    }
    match env_shell {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => FALLBACK.to_string(),
    }
}

/// Whether a bare program name resolves against `PATH`.
///
/// A hand-rolled scan rather than a `which` crate: this is one directory walk
/// at terminal-open time, and the pty spawns the name (not this path) so the
/// child still gets the resolution the OS would have done anyway.
fn on_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| is_file(&dir.join(program)))
}

fn is_file(candidate: &Path) -> bool {
    candidate.is_file()
}

#[cfg(test)]
mod tests {
    use super::{resolve_shell, FALLBACK, PREFERRED};

    /// Nothing is installed: every candidate probe says no.
    fn nothing(_: &str) -> bool {
        false
    }

    /// The platform's preferred shell is installed.
    fn preferred_only(program: &str) -> bool {
        program == PREFERRED
    }

    #[test]
    fn prefers_the_platform_shell_when_it_is_installed() {
        assert_eq!(
            resolve_shell(Some("/usr/bin/fish"), preferred_only),
            PREFERRED
        );
        assert_eq!(resolve_shell(None, preferred_only), PREFERRED);
    }

    #[test]
    fn falls_back_to_the_environment_shell_when_it_is_not() {
        assert_eq!(
            resolve_shell(Some("/usr/bin/fish"), nothing),
            "/usr/bin/fish"
        );
    }

    #[test]
    fn falls_back_to_a_shell_that_always_exists() {
        assert_eq!(resolve_shell(None, nothing), FALLBACK);
        assert_eq!(resolve_shell(Some("   "), nothing), FALLBACK);
    }
}
