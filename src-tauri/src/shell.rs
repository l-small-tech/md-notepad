//! Login-shell resolution: `pty_spawn` uses this as the default program when
//! a terminal profile names no command. Desktop-only, like the pty itself.

/// Per-OS fallback used when the environment names no shell.
#[cfg(windows)]
const FALLBACK: &str = "powershell.exe";
#[cfg(not(windows))]
const FALLBACK: &str = "/bin/sh";

/// The user's login shell: `$SHELL` on Unix, `%COMSPEC%`-independent
/// PowerShell on Windows, falling back to a shell that is always present.
///
/// Split from the env lookup so the policy is testable without mutating the
/// process environment (which races across parallel test threads).
pub fn default_shell() -> String {
    resolve_shell(std::env::var("SHELL").ok().as_deref())
}

fn resolve_shell(env_shell: Option<&str>) -> String {
    match env_shell {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => FALLBACK.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_shell, FALLBACK};

    #[test]
    fn uses_the_environment_shell_when_set() {
        assert_eq!(resolve_shell(Some("/usr/bin/fish")), "/usr/bin/fish");
    }

    #[test]
    fn falls_back_when_unset_or_blank() {
        assert_eq!(resolve_shell(None), FALLBACK);
        assert_eq!(resolve_shell(Some("   ")), FALLBACK);
    }
}
