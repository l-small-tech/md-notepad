//! The one way this module runs git: an explicit argv, a mode, and nothing
//! that could ever prompt or hang unnoticed.
//!
//! Every invocation is `git -c color.ui=never -c core.quotepath=false
//! [--no-optional-locks] [-C root] <args>` with `GIT_TERMINAL_PROMPT=0`,
//! `LC_ALL=C` and `LANG=C` in its environment (so the phrases the callers
//! match on are git's English ones and a credential prompt fails fast instead
//! of waiting), `stdin` null, both pipes drained by their own threads (a full
//! pipe would otherwise deadlock the wait), and `CREATE_NO_WINDOW` on
//! Windows. The mode picks the rest:
//!
//! | mode      | flag                  | limit | shape                             |
//! |-----------|-----------------------|-------|-----------------------------------|
//! | `Read`    | `--no-optional-locks` | 3 s   | collected                         |
//! | `Mutate`  | —                     | 30 s  | collected                         |
//! | `Network` | —                     | 120 s | streamed line by line, cancellable |
//!
//! `safe_arg` / `safe_rel` are the gate every user-supplied string passes
//! before it becomes an argv element; there is no generic "run these args"
//! command anywhere above this file.

use super::{GitError, GitResult};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// What a command is allowed to do, and therefore how long it may take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitMode {
    /// Observes only. `--no-optional-locks` so it never contends with the
    /// user's own git for the index lock; local git answers in tens of
    /// milliseconds, anything near the limit is a hung mount.
    Read,
    /// Touches the index, the tree or refs. Hooks run, so it gets longer.
    Mutate,
    /// Talks to a remote: streamed, cancellable, and patient.
    Network,
}

impl GitMode {
    pub fn timeout_secs(self) -> u64 {
        match self {
            GitMode::Read => 3,
            GitMode::Mutate => 30,
            GitMode::Network => 120,
        }
    }

    fn timeout(self) -> Duration {
        Duration::from_secs(self.timeout_secs())
    }
}

/// What git said. `ok` is a zero exit; `code` is `None` when a signal ended
/// it. `stderr` is trimmed (git's messages end in a newline), `stdout` is not
/// (a `show` must come back byte-exact).
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Which pipe a streamed line came from — lowercase on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitStream {
    Out,
    Err,
}

/// What a network operation streams: one `Line` per output line (git's
/// progress arrives on stderr, carriage-return separated) and a single `Done`
/// last, on every path out — success, failure, timeout or cancel.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitOutputEvent {
    Line { stream: GitStream, text: String },
    Done,
}

/* ------------------------------- validation ------------------------------- */

/// Refuse what must never become an argv element: nothing, something git
/// would read as an option, or a string with a control character in it (a
/// NUL cannot even be passed; a newline would split a ref file). Returns the
/// input so calls compose: `args.push(safe_arg(name)?)`.
pub fn safe_arg(s: &str) -> GitResult<&str> {
    if s.is_empty() {
        return Err(GitError::InvalidArg("empty argument".into()));
    }
    if s.starts_with('-') {
        return Err(GitError::InvalidArg(format!(
            "argument may not start with '-': {s}"
        )));
    }
    if s.chars().any(char::is_control) {
        return Err(GitError::InvalidArg(
            "argument contains a control character".into(),
        ));
    }
    Ok(s)
}

/// `safe_arg`, plus: a path handed to a `--`-terminated path list must be
/// relative to the checkout and stay inside it (no absolute path, no `..`
/// segment). A trailing `/` (an untracked directory as status lists it) is
/// fine.
pub fn safe_rel(s: &str) -> GitResult<&str> {
    let s = safe_arg(s)?;
    if is_absolute_like(s) {
        return Err(GitError::InvalidArg(format!(
            "path must be relative to the checkout: {s}"
        )));
    }
    if s.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(GitError::InvalidArg(format!(
            "path may not contain '..': {s}"
        )));
    }
    Ok(s)
}

/// Rooted on either OS's terms: `/x`, `\x`, or a `C:` drive prefix.
fn is_absolute_like(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with('/')
        || s.starts_with('\\')
        || (b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic())
}

/* -------------------------------- spawning -------------------------------- */

fn command(root: Option<&Path>, mode: GitMode, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .arg("-c")
        .arg("color.ui=never")
        .arg("-c")
        .arg("core.quotepath=false");
    if mode == GitMode::Read {
        // Never take the index lock: a read is an observer, and it may run
        // while the user's own git command holds it.
        cmd.arg("--no-optional-locks");
    }
    if let Some(root) = root {
        cmd.arg("-C").arg(root);
    }
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW` — no console window for the child.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn spawn(cmd: &mut Command) -> GitResult<std::process::Child> {
    cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitError::NoGit
        } else {
            GitError::failed(e.to_string())
        }
    })
}

/// Read one of the child's pipes to the end on its own thread.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    })
}

fn finish(status: std::process::ExitStatus, stdout: Vec<u8>, stderr: Vec<u8>) -> GitOutput {
    GitOutput {
        ok: status.success(),
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
    }
}

/// Run `git [-C root] <args>` to completion in `mode`, or kill it at the
/// mode's limit. A non-zero exit is NOT an error here — `rev-parse --verify`
/// and `show` use it to mean "no", `check-ignore` to mean "false" — so the
/// caller decides (`checked` is the "failure is an error" wrapper).
pub fn run_git_with(root: Option<&Path>, mode: GitMode, args: &[&str]) -> GitResult<GitOutput> {
    let mut child = spawn(&mut command(root, mode, args))?;
    let out_reader = drain(child.stdout.take());
    let err_reader = drain(child.stderr.take());

    let deadline = Instant::now() + mode.timeout();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(GitError::failed(e.to_string())),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    let Some(status) = status else {
        return Err(GitError::Timeout(mode.timeout_secs()));
    };
    Ok(finish(status, stdout, stderr))
}

/// `run_git_with` in a checkout where a non-zero exit IS a failure: git's
/// stderr comes back as `GIT_FAILED` (or `GIT_NOT_A_REPO` when that is what it
/// says).
pub fn checked(root: &Path, mode: GitMode, args: &[&str]) -> GitResult<GitOutput> {
    let out = run_git_with(Some(root), mode, args)?;
    if !out.ok {
        return Err(super::classify(&out.stderr, root));
    }
    Ok(out)
}

/* -------------------------------- streaming ------------------------------- */

/// Read a pipe on its own thread, handing each complete line to `tx` as it
/// arrives. Lines end at `\n` OR `\r` — git's progress meters redraw with a
/// bare carriage return, and each redraw is worth a line to a viewer. Empty
/// lines (the gap in `\r\n`) are dropped. The thread also keeps every byte so
/// the caller gets the full text at the end, exactly like `drain`.
fn stream_pipe<R: Read + Send + 'static>(
    pipe: Option<R>,
    stream: GitStream,
    tx: mpsc::Sender<(GitStream, String)>,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut all = Vec::new();
        let Some(mut pipe) = pipe else {
            return all;
        };
        let mut chunk = [0u8; 4096];
        let mut line = Vec::new();
        loop {
            let n = match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            all.extend_from_slice(&chunk[..n]);
            for &b in &chunk[..n] {
                if b == b'\n' || b == b'\r' {
                    if !line.is_empty() {
                        let _ = tx.send((stream, String::from_utf8_lossy(&line).into_owned()));
                        line.clear();
                    }
                } else {
                    line.push(b);
                }
            }
        }
        if !line.is_empty() {
            let _ = tx.send((stream, String::from_utf8_lossy(&line).into_owned()));
        }
        all
    })
}

enum Ended {
    Exited(std::process::ExitStatus),
    Cancelled,
    TimedOut,
}

/// The network-mode runner: `git -C root <args>` with every output line
/// handed to `sink` as it arrives, a `Done` event last no matter how it ends,
/// `cancel` polled every 20 ms (set → the child is killed → `Cancelled`), and
/// the 120 s limit (→ `Timeout`). A non-zero exit is a result, not an error:
/// a rejected push is something to show, and its full stderr is in the output.
pub fn run_git_streaming(
    root: &Path,
    args: &[&str],
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(GitOutputEvent),
) -> GitResult<GitOutput> {
    let mode = GitMode::Network;
    let mut child = spawn(&mut command(Some(root), mode, args))?;
    let (tx, rx) = mpsc::channel();
    let out_reader = stream_pipe(child.stdout.take(), GitStream::Out, tx.clone());
    let err_reader = stream_pipe(child.stderr.take(), GitStream::Err, tx);

    let deadline = Instant::now() + mode.timeout();
    let ended = loop {
        while let Ok((stream, text)) = rx.try_recv() {
            sink(GitOutputEvent::Line { stream, text });
        }
        // The flag first: a cancel that landed before the child even started
        // must still win, and a fast exit must not race past it.
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            break Ended::Cancelled;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ended::Exited(status),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                sink(GitOutputEvent::Done);
                return Err(GitError::failed(e.to_string()));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break Ended::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    // Both senders are gone once the readers have joined, so this drains what
    // arrived between the last poll and the exit and then stops.
    while let Ok((stream, text)) = rx.try_recv() {
        sink(GitOutputEvent::Line { stream, text });
    }
    sink(GitOutputEvent::Done);

    match ended {
        Ended::Exited(status) => Ok(finish(status, stdout, stderr)),
        Ended::Cancelled => Err(GitError::Cancelled),
        Ended::TimedOut => Err(GitError::Timeout(mode.timeout_secs())),
    }
}

/* ----------------------------- message transport -------------------------- */

/// A commit message on its way to `commit -F`: a temp file, never `-m`
/// (multi-line text, a first line starting with `-`, and Windows' command
/// line length all argue against an argument). The handle is closed before
/// git opens it; the file is deleted when the returned path drops.
pub fn message_file(message: &str) -> GitResult<tempfile::TempPath> {
    let mut file = tempfile::Builder::new()
        .prefix("mdn-commit-")
        .suffix(".txt")
        .tempfile()
        .map_err(|e| GitError::failed(format!("commit message file: {e}")))?;
    file.write_all(message.as_bytes())
        .and_then(|()| {
            if message.ends_with('\n') {
                Ok(())
            } else {
                file.write_all(b"\n")
            }
        })
        .and_then(|()| file.flush())
        .map_err(|e| GitError::failed(format!("commit message file: {e}")))?;
    Ok(file.into_temp_path())
}

#[cfg(test)]
mod tests {
    use super::super::testutil::have_git;
    use super::*;

    #[test]
    fn safe_arg_table() {
        assert_eq!(safe_arg("feat/x").unwrap(), "feat/x");
        assert_eq!(safe_arg("origin").unwrap(), "origin");
        assert_eq!(
            safe_arg("a b").unwrap(),
            "a b",
            "spaces are one argv element"
        );
        assert_eq!(safe_arg("ünïcode").unwrap(), "ünïcode");
        for bad in ["", "-", "--force", "-x", "a\nb", "a\0b", "a\tb", "\u{7f}"] {
            match safe_arg(bad) {
                Err(GitError::InvalidArg(_)) => {}
                other => panic!("expected InvalidArg for {bad:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn safe_rel_also_refuses_escaping_the_checkout() {
        assert_eq!(safe_rel("src/a.ts").unwrap(), "src/a.ts");
        assert_eq!(
            safe_rel("dir/").unwrap(),
            "dir/",
            "status lists untracked dirs so"
        );
        assert_eq!(
            safe_rel("..a/b..").unwrap(),
            "..a/b..",
            "only a whole `..` segment"
        );
        for bad in [
            "/etc/passwd",
            "\\windows",
            "C:/x",
            "c:\\x",
            "../x",
            "a/../b",
            "a/..",
            "a\\..\\b",
            "-rf",
            "",
        ] {
            match safe_rel(bad) {
                Err(GitError::InvalidArg(_)) => {}
                other => panic!("expected InvalidArg for {bad:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn modes_have_the_documented_limits() {
        assert_eq!(GitMode::Read.timeout_secs(), 3);
        assert_eq!(GitMode::Mutate.timeout_secs(), 30);
        assert_eq!(GitMode::Network.timeout_secs(), 120);
    }

    #[test]
    fn output_events_serialize_as_the_ts_union_expects() {
        let line = GitOutputEvent::Line {
            stream: GitStream::Err,
            text: "Counting objects: 50%".into(),
        };
        assert_eq!(
            serde_json::to_value(&line).unwrap(),
            serde_json::json!({"kind": "line", "stream": "err", "text": "Counting objects: 50%"})
        );
        assert_eq!(
            serde_json::to_value(GitOutputEvent::Line {
                stream: GitStream::Out,
                text: "x".into()
            })
            .unwrap()["stream"],
            "out"
        );
        assert_eq!(
            serde_json::to_value(GitOutputEvent::Done).unwrap(),
            serde_json::json!({"kind": "done"})
        );
    }

    #[test]
    fn message_file_holds_the_text_with_one_trailing_newline() {
        let path = message_file("- first\n\nbody").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "- first\n\nbody\n");
        let path2 = message_file("already\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path2).unwrap(), "already\n");
        let kept = path.to_path_buf();
        drop(path);
        assert!(!kept.exists(), "deleted on drop");
    }

    #[test]
    fn streaming_splits_lines_and_ends_with_done() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut events = Vec::new();
        let cancel = AtomicBool::new(false);
        let out = run_git_streaming(dir.path(), &["--version"], &cancel, &mut |e| events.push(e))
            .expect("git --version streams");
        assert!(out.ok);
        assert!(out.stdout.starts_with("git version"));
        assert!(matches!(
            events.first(),
            Some(GitOutputEvent::Line { stream: GitStream::Out, text }) if text.starts_with("git version")
        ));
        assert_eq!(events.last(), Some(&GitOutputEvent::Done));
        assert_eq!(
            events
                .iter()
                .filter(|e| **e == GitOutputEvent::Done)
                .count(),
            1
        );
    }

    #[test]
    fn a_failed_stream_is_a_result_and_stderr_lines_are_tagged() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut events = Vec::new();
        let cancel = AtomicBool::new(false);
        // Not a repo: git fails, but that is a result with an exit code.
        let out = run_git_streaming(dir.path(), &["fetch"], &cancel, &mut |e| events.push(e))
            .expect("a failing git is still a result");
        assert!(!out.ok);
        assert!(out.code.is_some());
        assert!(events.iter().any(|e| matches!(
            e,
            GitOutputEvent::Line {
                stream: GitStream::Err,
                ..
            }
        )));
        assert_eq!(events.last(), Some(&GitOutputEvent::Done));
    }

    #[test]
    fn a_preset_cancel_flag_cancels_before_anything_runs() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut events = Vec::new();
        let cancel = AtomicBool::new(true);
        match run_git_streaming(dir.path(), &["--version"], &cancel, &mut |e| events.push(e)) {
            Err(GitError::Cancelled) => {}
            other => panic!("expected Cancelled, got {other:?}"),
        }
        assert_eq!(
            events.last(),
            Some(&GitOutputEvent::Done),
            "done even when cancelled"
        );
    }

    #[test]
    fn a_non_zero_exit_is_a_result_for_the_plain_runner_and_an_error_for_checked() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let out = run_git_with(Some(dir.path()), GitMode::Read, &["rev-parse", "HEAD"]).unwrap();
        assert!(!out.ok);
        match checked(dir.path(), GitMode::Read, &["rev-parse", "HEAD"]) {
            Err(GitError::NotARepo(_)) => {}
            other => panic!("expected NotARepo, got {other:?}"),
        }
    }
}
