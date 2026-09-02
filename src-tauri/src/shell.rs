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

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

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
fn on_path(program: &str) -> bool {
    find_program(program).is_some()
}

/// Where a program name resolves to on this machine, or `None`.
///
/// A hand-rolled scan rather than a `which` crate: this is one directory walk
/// at terminal-open (or settings-open) time, and the pty spawns the NAME (not
/// this path) so the child still gets the resolution the OS would have done
/// anyway. What this answers is the frontend's "is it installed?" — the
/// Settings dialog dims an AI agent the user cannot launch and offers to
/// install it (`commands/programs.rs`).
pub fn find_program(program: &str) -> Option<PathBuf> {
    let pathext = std::env::var_os("PATHEXT");
    find_program_in(program, &search_path(), pathext.as_deref())
}

/// The `PATH` a lookup — and a new terminal — should use: the process's own,
/// followed by directories it did not inherit.
///
/// A process's environment is a snapshot from launch. On Windows an installer
/// that adds its directory to the user's `PATH` writes the registry, which no
/// running process sees — so an agent installed from a terminal tab would look
/// missing (and fail to launch from a new tab) until the app restarts. On
/// macOS and Linux a GUI launch starts with the system's bare `PATH`; the
/// user-space installers this app offers land in a handful of well-known
/// directories that rc files normally add. Both are folded in here, AFTER
/// the inherited entries so nothing the user deliberately put first is
/// shadowed.
pub fn search_path() -> OsString {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&inherited).collect();
    for extra in extra_path_dirs() {
        if !extra.as_os_str().is_empty() && !dirs.iter().any(|d| same_dir(d, &extra)) {
            dirs.push(extra);
        }
    }
    // A directory containing the separator cannot be joined; keep the
    // inherited PATH rather than fail the lookup.
    std::env::join_paths(dirs).unwrap_or(inherited)
}

/// Same directory, allowing for the ways a PATH entry is spelled: a trailing
/// separator, and case on Windows (where the filesystem does not care).
fn same_dir(a: &Path, b: &Path) -> bool {
    fn key(p: &Path) -> String {
        let s = p.to_string_lossy();
        let trimmed = s.trim_end_matches(['\\', '/']);
        if cfg!(windows) {
            trimmed.to_lowercase()
        } else {
            trimmed.to_string()
        }
    }
    key(a) == key(b)
}

/// Windows: the persistent user and machine `PATH` from the registry — what a
/// freshly opened console would have. Read on demand, never cached, so the
/// scan after an install sees the installer's addition.
#[cfg(windows)]
fn extra_path_dirs() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let read = |root, key: &str| -> Option<String> {
        RegKey::predef(root)
            .open_subkey_with_flags(key, KEY_READ)
            .ok()?
            .get_value::<String, _>("Path")
            .ok()
    };
    let user = read(HKEY_CURRENT_USER, "Environment");
    let machine = read(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    );
    // User entries first: that is the order Windows itself builds a new
    // process's PATH from these two values.
    [user, machine]
        .into_iter()
        .flatten()
        .flat_map(|value| {
            std::env::split_paths(&expand_env(&value, |name| std::env::var(name).ok()))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// `%NAME%` references in a `REG_EXPAND_SZ` value, resolved through `lookup`.
/// An unknown name is left as written (what `ExpandEnvironmentStrings` does).
#[cfg(any(windows, test))]
fn expand_env(value: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match lookup(name) {
                    Some(v) if !name.is_empty() => out.push_str(&v),
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// macOS/Linux: where the user-space installers this app offers put their
/// binaries (`~/.local/bin` for Claude Code and Grok Build, `~/.opencode/bin`
/// and `~/bin` for opencode, Homebrew's prefixes), which a login shell's rc
/// files add but a desktop-launched process never sees.
#[cfg(not(windows))]
fn extra_path_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs = Vec::new();
    if let Some(home) = home {
        for rel in [".local/bin", "bin", ".opencode/bin", ".grok/bin"] {
            dirs.push(home.join(rel));
        }
    }
    for abs in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/home/linuxbrew/.linuxbrew/bin",
    ] {
        dirs.push(PathBuf::from(abs));
    }
    dirs
}

/// The lookup itself, with the environment passed in so tests can build a
/// `PATH` of temp dirs without mutating the process (which races across test
/// threads).
///
/// Mirrors what `CreateProcess`/`execvp` do: a name with a directory component
/// is checked where it points; a bare name is tried in each `PATH` entry in
/// order. On Windows a bare `npm` is `npm.cmd` — every extension in `PATHEXT`
/// is tried (`.exe`/`.cmd`/`.bat`/`.com` when the variable is absent), and a
/// name that already carries an extension is tried as written first.
pub fn find_program_in(program: &str, path: &OsStr, pathext: Option<&OsStr>) -> Option<PathBuf> {
    let program = program.trim();
    if program.is_empty() {
        return None;
    }
    let candidate = Path::new(program);
    let exts = extensions(pathext);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return first_file(candidate, &exts);
    }
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| first_file(&dir.join(program), &exts))
}

/// `candidate` as written, else with each extension appended. On unix the
/// extension list is empty and only the bare name is tried.
fn first_file(candidate: &Path, exts: &[String]) -> Option<PathBuf> {
    if is_file(candidate) {
        return Some(candidate.to_path_buf());
    }
    let base = candidate.as_os_str().to_owned();
    exts.iter()
        .map(|ext| {
            let mut with_ext = base.clone();
            with_ext.push(ext);
            PathBuf::from(with_ext)
        })
        .find(|p| is_file(p))
}

/// The executable extensions to try, in `PATHEXT` order. Windows without a
/// `PATHEXT` still knows the classic four; the npm shims that put most agent
/// CLIs on `PATH` are `.cmd`, so that one is never optional.
#[cfg(windows)]
fn extensions(pathext: Option<&OsStr>) -> Vec<String> {
    let from_env: Vec<String> = pathext
        .and_then(|v| v.to_str())
        .map(|v| {
            v.split(';')
                .map(str::trim)
                .filter(|e| e.starts_with('.'))
                .map(str::to_lowercase)
                .collect()
        })
        .unwrap_or_default();
    if from_env.is_empty() {
        return [".exe", ".cmd", ".bat", ".com"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    from_env
}

#[cfg(not(windows))]
fn extensions(_pathext: Option<&OsStr>) -> Vec<String> {
    Vec::new()
}

fn is_file(candidate: &Path) -> bool {
    candidate.is_file()
}

#[cfg(test)]
mod tests {
    use super::{find_program_in, resolve_shell, FALLBACK, PREFERRED};
    use std::ffi::OsString;

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

    /// A `PATH` of exactly these directories, in order.
    fn path_of(dirs: &[&std::path::Path]) -> OsString {
        std::env::join_paths(dirs.iter().map(|d| d.as_os_str())).unwrap()
    }

    /// What a bare program file is called on this OS (`tool` / `tool.exe`).
    fn exe(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    }

    #[test]
    fn finds_a_program_in_a_path_dir_and_reports_where() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(exe("agent"));
        std::fs::write(&file, b"").unwrap();

        let found = find_program_in("agent", &path_of(&[dir.path()]), None);
        assert_eq!(found, Some(file));
    }

    #[test]
    fn missing_programs_and_blank_names_are_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = path_of(&[dir.path()]);
        assert_eq!(find_program_in("nothing-here", &path, None), None);
        assert_eq!(find_program_in("", &path, None), None);
        assert_eq!(find_program_in("   ", &path, None), None);
        // A directory of the right name is not a program.
        std::fs::create_dir(dir.path().join("agent")).unwrap();
        assert_eq!(find_program_in("agent", &path, None), None);
    }

    #[test]
    fn earlier_path_entries_win_and_blank_entries_are_skipped() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let name = exe("tool");
        std::fs::write(first.path().join(&name), b"").unwrap();
        std::fs::write(second.path().join(&name), b"").unwrap();

        let path = path_of(&[first.path(), second.path()]);
        assert_eq!(
            find_program_in("tool", &path, None),
            Some(first.path().join(&name))
        );
        // An empty entry (a stray `;;` / `::` in PATH) is skipped, not treated
        // as the current directory.
        let mut with_blank = OsString::from(if cfg!(windows) { ";" } else { ":" });
        with_blank.push(&path);
        assert_eq!(
            find_program_in("tool", &with_blank, None),
            Some(first.path().join(&name))
        );
    }

    #[test]
    fn a_name_with_directories_is_checked_where_it_points() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(exe("here"));
        std::fs::write(&file, b"").unwrap();
        let elsewhere = tempfile::tempdir().unwrap();

        // Absolute: found regardless of PATH.
        let abs = file.to_str().unwrap();
        assert_eq!(
            find_program_in(abs, &path_of(&[elsewhere.path()]), None),
            Some(file.clone())
        );
        // Absolute to nothing: None, even though PATH could resolve the name.
        let missing = dir.path().join("gone");
        assert_eq!(
            find_program_in(missing.to_str().unwrap(), &path_of(&[dir.path()]), None),
            None
        );
    }

    #[test]
    fn expand_env_resolves_known_names_and_leaves_the_rest() {
        let lookup = |name: &str| match name {
            "USERPROFILE" => Some(r"C:\Users\me".to_string()),
            "APPDATA" => Some(r"C:\Users\me\AppData\Roaming".to_string()),
            _ => None,
        };
        assert_eq!(
            super::expand_env(r"%USERPROFILE%\.local\bin;%APPDATA%\npm", lookup),
            r"C:\Users\me\.local\bin;C:\Users\me\AppData\Roaming\npm"
        );
        // Unknown names, an empty name, and a stray `%` are left as written.
        assert_eq!(
            super::expand_env(r"%NOPE%\x;%%;50%", lookup),
            r"%NOPE%\x;%%;50%"
        );
        assert_eq!(super::expand_env("plain", lookup), "plain");
    }

    #[test]
    fn search_path_starts_with_the_inherited_path() {
        // The process PATH comes first, verbatim, so nothing the user put
        // ahead of a system directory is reordered.
        let inherited: Vec<_> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        let searched: Vec<_> = std::env::split_paths(&super::search_path()).collect();
        assert!(searched.len() >= inherited.len());
        assert_eq!(&searched[..inherited.len()], &inherited[..]);
        // And no appended directory repeats one already there (the inherited
        // part is kept verbatim, duplicates and all).
        for (i, dir) in searched.iter().enumerate().skip(inherited.len()) {
            assert!(
                !searched[..i].iter().any(|d| super::same_dir(d, dir)),
                "{} listed twice",
                dir.display()
            );
        }
    }

    #[test]
    fn same_dir_ignores_trailing_separators() {
        use std::path::Path;
        assert!(super::same_dir(Path::new("/opt/x/"), Path::new("/opt/x")));
        assert!(!super::same_dir(Path::new("/opt/x"), Path::new("/opt/y")));
        if cfg!(windows) {
            assert!(super::same_dir(
                Path::new(r"C:\Tools\"),
                Path::new(r"c:\tools")
            ));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_tries_every_pathext_so_npm_cmd_shims_count() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("copilot.cmd");
        std::fs::write(&shim, b"@echo off").unwrap();
        let path = path_of(&[dir.path()]);

        // Explicit PATHEXT, upper case, as Windows ships it.
        let pathext = OsString::from(".COM;.EXE;.BAT;.CMD;.PS1");
        assert_eq!(
            find_program_in("copilot", &path, Some(&pathext)),
            Some(shim.clone())
        );
        // No PATHEXT at all: the built-in fallback still knows `.cmd`.
        assert_eq!(find_program_in("copilot", &path, None), Some(shim.clone()));
        // A name that already carries the extension is tried as written.
        assert_eq!(find_program_in("copilot.cmd", &path, None), Some(shim));
        // An extension outside PATHEXT is not executable by name.
        std::fs::write(dir.path().join("notes.txt"), b"").unwrap();
        assert_eq!(find_program_in("notes", &path, Some(&pathext)), None);
    }
}
