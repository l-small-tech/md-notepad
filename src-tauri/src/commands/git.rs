//! Git facts for Review mode's "What changed" — desktop only.
//!
//! Three questions, answered by shelling out to the `git` binary: where am I
//! (`git_repo_info`), what did this file look like at a revision
//! (`git_show_file`), and does this file differ on the other worktrees'
//! branches (`git_file_changes`). No `git2`/libgit2: this feature only runs
//! where a developer already has git installed, and a large native build is a
//! poor trade for three `rev-parse` calls.
//!
//! Policy stays in TypeScript (rule I5): which revision is "the baseline",
//! when to refresh, and what a badge means are `src/core/code/changes.ts` and
//! the pane's concerns. This module only reports.
//!
//! Every command runs on the blocking pool (spawning a process and waiting for
//! it is blocking work) with a hard 3 s timeout — a git call that hangs on a
//! network mount must never freeze the review pane, which renders first and
//! takes badges when they arrive. Android compiles none of this: the module is
//! `#[cfg(not(target_os = "android"))]` in `commands/mod.rs` and the handler
//! entries are `#[cfg(desktop)]`, so "What changed" simply hides there.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long any single git invocation may take before it is killed. Local git
/// answers these in tens of milliseconds; anything near this is a hung mount.
const GIT_TIMEOUT: Duration = Duration::from_secs(3);

/// Branches tried, in order, when the caller names no baseline branch. Matches
/// this repo's own convention (`development` is where work lands) and then the
/// two common defaults.
const BASE_BRANCH_CANDIDATES: [&str; 3] = ["development", "main", "master"];

/// Mirrors the `{code, message}` wire shape of `FsError` (see
/// src-tauri/README.md's error table). `Failed` carries git's own stderr,
/// which is for logs and a status line — never for branching.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git was not found on PATH")]
    NoGit,
    #[error("not a git repository: {0}")]
    NotARepo(String),
    #[error("git timed out after {}s", GIT_TIMEOUT.as_secs())]
    Timeout,
    #[error("git failed: {stderr}")]
    Failed { stderr: String },
}

impl GitError {
    pub fn code(&self) -> &'static str {
        match self {
            GitError::NoGit => "GIT_NOT_FOUND",
            GitError::NotARepo(_) => "GIT_NOT_A_REPO",
            GitError::Timeout => "GIT_TIMEOUT",
            GitError::Failed { .. } => "GIT_FAILED",
        }
    }

    fn failed(stderr: impl Into<String>) -> Self {
        GitError::Failed {
            stderr: stderr.into(),
        }
    }
}

impl Serialize for GitError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("GitError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type GitResult<T> = Result<T, GitError>;

/// One entry of `git worktree list --porcelain`. `branch` is the short name
/// (`feat/x`), `None` for a detached HEAD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
}

/// Everything the review pane needs to describe "where am I" for one file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    /// Absolute repository root, forward slashes (git's own spelling).
    pub root: String,
    /// The asked-about path relative to `root`, forward slashes, no leading `/`.
    pub rel: String,
    /// Short branch name, or `None` on a detached HEAD.
    pub branch: Option<String>,
    /// HEAD's commit sha; empty string in a repo with no commits yet.
    pub head: String,
    /// True when `root` is a linked worktree rather than the main checkout.
    pub is_worktree: bool,
    /// The baseline branch that exists locally, or `None` when none does.
    pub base_branch: Option<String>,
    /// `merge-base(HEAD, base_branch)`; `None` when HEAD *is* the base branch
    /// (compare against HEAD instead) or no merge base is computable.
    pub base_ref: Option<String>,
    /// Every checkout of this repository, the main one included.
    pub worktrees: Vec<GitWorktree>,
}

/// Whether one branch's blob for a path differs from the baseline's — the
/// "also changed on: feat/other" radar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub branch: String,
    pub differs: bool,
}

/* ------------------------------- running git ------------------------------ */

struct GitOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Read one of the child's pipes on its own thread. Both pipes need one: git
/// writes stdout and stderr independently, and waiting on the child while a
/// full pipe blocks it would deadlock.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    })
}

/// Run `git [-C root] <args>` to completion, or kill it at `GIT_TIMEOUT`.
///
/// `stdin` is null so nothing can ever prompt (a credential
/// helper on a misconfigured remote would otherwise wait forever), and on
/// Windows `CREATE_NO_WINDOW` keeps a console from flashing over the app.
///
/// A non-zero exit is NOT an error here — `rev-parse --verify` and `show` use
/// it to mean "no", so the caller decides.
fn run_git(root: Option<&Path>, args: &[&str]) -> GitResult<GitOutput> {
    let mut cmd = Command::new("git");
    // Never take the index lock: this is a read-only observer, and it may run
    // while the user's own git command holds it.
    cmd.arg("--no-optional-locks");
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

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitError::NoGit
        } else {
            GitError::failed(e.to_string())
        }
    })?;

    let out_reader = drain(child.stdout.take());
    let err_reader = drain(child.stderr.take());

    let deadline = Instant::now() + GIT_TIMEOUT;
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
        return Err(GitError::Timeout);
    };
    Ok(GitOutput {
        ok: status.success(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
    })
}

/// `run_git` for the common "one line of output, failure is an error" case.
fn git_line(root: &Path, args: &[&str]) -> GitResult<String> {
    let out = run_git(Some(root), args)?;
    if !out.ok {
        return Err(classify(&out.stderr, root));
    }
    Ok(out.stdout.trim().to_string())
}

/// The same, but a non-zero exit means "no such thing" rather than an error —
/// what `rev-parse --verify --quiet` and `symbolic-ref --quiet` are for.
fn git_line_opt(root: &Path, args: &[&str]) -> GitResult<Option<String>> {
    let out = run_git(Some(root), args)?;
    if !out.ok {
        // A repo-level failure is still a failure; only a plain "no" is None.
        if is_not_a_repo(&out.stderr) {
            return Err(GitError::NotARepo(display(root)));
        }
        return Ok(None);
    }
    let line = out.stdout.trim().to_string();
    Ok((!line.is_empty()).then_some(line))
}

fn is_not_a_repo(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("not a git repository") || lower.contains("not a working tree")
}

fn classify(stderr: &str, path: &Path) -> GitError {
    if is_not_a_repo(stderr) {
        GitError::NotARepo(display(path))
    } else {
        GitError::failed(stderr)
    }
}

fn display(path: &Path) -> String {
    to_slashes(&path.to_string_lossy())
}

/* ----------------------------- pure path logic ---------------------------- */

/// Windows separators → forward slashes, and any trailing slash dropped (a
/// drive root like `C:/` keeps its slash so it stays a valid path).
fn to_slashes(path: &str) -> String {
    let s = path.replace('\\', "/");
    match s.strip_suffix('/') {
        Some(trimmed) if !trimmed.is_empty() && !trimmed.ends_with(':') => trimmed.to_string(),
        _ => s,
    }
}

/// Comparison key for two paths naming the same place: forward slashes, and on
/// Windows (and macOS, whose default filesystem is also case-insensitive)
/// ASCII-folded case. ASCII-only folding on purpose — it preserves length, so
/// byte offsets taken on the key are valid in the normalized path.
fn path_key(path: &str) -> String {
    let slashed = to_slashes(path);
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        slashed.to_ascii_lowercase()
    } else {
        slashed
    }
}

/// `path` expressed relative to `root`, forward slashes, no leading slash.
/// `Some("")` when they name the same place, `None` when `path` is not under
/// `root` (a symlinked ancestor, say — the caller then asks git itself).
fn relative_path(root: &str, path: &str) -> Option<String> {
    let root_key = path_key(root);
    let target = path_key(path);
    if root_key == target {
        return Some(String::new());
    }
    let root_prefix = if root_key.ends_with('/') {
        root_key.clone()
    } else {
        format!("{root_key}/")
    };
    if !target.starts_with(&root_prefix) {
        return None;
    }
    let normalized = to_slashes(path);
    Some(normalized[root_prefix.len()..].to_string())
}

/// Parse `git worktree list --porcelain`. Records are separated by blank
/// lines; each opens with `worktree <path>` and carries `HEAD <sha>` plus
/// either `branch refs/heads/<name>` or `detached`. Bare records (no HEAD)
/// are dropped — there is no blob to compare against in one.
fn parse_worktrees(out: &str) -> Vec<GitWorktree> {
    let mut found = Vec::new();
    let mut path: Option<String> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;
    // A record is only reported once it has both a path and a HEAD; a bare or
    // malformed one is dropped, fields and all.
    let mut flush =
        |path: &mut Option<String>, head: &mut Option<String>, branch: &mut Option<String>| {
            let (p, h, b) = (path.take(), head.take(), branch.take());
            if let (Some(p), Some(h)) = (p, h) {
                found.push(GitWorktree {
                    path: to_slashes(&p),
                    branch: b,
                    head: h,
                });
            }
        };
    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut path, &mut head, &mut branch);
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut head, &mut branch);
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = Some(short_branch(rest));
        } else if line == "detached" {
            branch = None;
        }
        // `bare`, `locked …`, `prunable …` carry nothing we report.
    }
    flush(&mut path, &mut head, &mut branch);
    found
}

fn short_branch(refname: &str) -> String {
    refname
        .strip_prefix("refs/heads/")
        .unwrap_or(refname)
        .to_string()
}

/* -------------------------------- the work -------------------------------- */

/// The directory to run git in: `path` itself if it is a directory, else its
/// parent (git needs a directory for `-C`, and the review pane asks about a
/// file).
fn work_dir(path: &Path) -> &Path {
    if path.is_dir() {
        return path;
    }
    path.parent().unwrap_or(path)
}

fn repo_info(path: &str, base_branch: Option<&str>) -> GitResult<GitRepoInfo> {
    let raw = Path::new(path);
    let dir = work_dir(raw);
    let root = to_slashes(&git_line(dir, &["rev-parse", "--show-toplevel"])?);
    if root.is_empty() {
        return Err(GitError::NotARepo(display(raw)));
    }

    // Prefer the pure computation; fall back to git's own answer when the
    // path reaches the root through a symlink (`--show-prefix` is the dir's
    // path under the root, so the file name is appended back on).
    let rel = match relative_path(&root, path) {
        Some(rel) => rel,
        None => {
            let prefix = git_line(dir, &["rev-parse", "--show-prefix"])?;
            let name = if raw.is_dir() {
                String::new()
            } else {
                raw.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            };
            format!("{prefix}{name}")
        }
    };

    let branch = git_line_opt(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    // An unborn HEAD (a repo with no commits) is not an error — the pane just
    // has nothing to compare against.
    let head =
        git_line_opt(dir, &["rev-parse", "--verify", "--quiet", "HEAD"])?.unwrap_or_default();

    // `--git-dir` is THIS checkout's git dir, `--git-common-dir` the main
    // one's. They are the same directory in the main checkout and differ in a
    // linked worktree (`<main>/.git/worktrees/<name>` vs `<main>/.git`) — a
    // comparison that needs no path arithmetic and works on every git version.
    let git_dir = git_line(dir, &["rev-parse", "--git-dir"])?;
    let common_dir = git_line(dir, &["rev-parse", "--git-common-dir"])?;
    let is_worktree = path_key(&git_dir) != path_key(&common_dir);

    let root_path = Path::new(&root);
    let base_branch = resolve_base_branch(root_path, base_branch)?;
    let base_ref = match (&base_branch, &branch) {
        // HEAD already IS the baseline: there is no merge-base to compare
        // against, so the caller falls back to HEAD (uncommitted changes).
        (Some(base), Some(current)) if base == current => None,
        (Some(base), _) if !head.is_empty() => git_line_opt(
            root_path,
            &["merge-base", "HEAD", &format!("refs/heads/{base}")],
        )?,
        _ => None,
    };

    let worktrees = parse_worktrees(&git_line(root_path, &["worktree", "list", "--porcelain"])?);

    Ok(GitRepoInfo {
        root,
        rel,
        branch,
        head,
        is_worktree,
        base_branch,
        base_ref,
        worktrees,
    })
}

/// The caller's choice when it names a local branch, else the first of
/// `development` / `main` / `master` that exists.
fn resolve_base_branch(root: &Path, requested: Option<&str>) -> GitResult<Option<String>> {
    let asked = requested.map(str::trim).filter(|b| !b.is_empty());
    if let Some(name) = asked {
        if branch_exists(root, name)? {
            return Ok(Some(name.to_string()));
        }
        // A setting naming a branch this checkout doesn't have degrades to the
        // auto-detected one rather than disabling the whole view.
    }
    for candidate in BASE_BRANCH_CANDIDATES {
        if branch_exists(root, candidate)? {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

fn branch_exists(root: &Path, branch: &str) -> GitResult<bool> {
    let refname = format!("refs/heads/{branch}");
    Ok(git_line_opt(root, &["rev-parse", "--verify", "--quiet", &refname])?.is_some())
}

/// `git show <rev>:<rel>`. `None` means the path does not exist at that
/// revision (a new file), which is a fact, not a failure.
fn show_file(root: &str, rev: &str, rel: &str) -> GitResult<Option<String>> {
    let spec = format!("{rev}:{rel}");
    let out = run_git(Some(Path::new(root)), &["show", &spec])?;
    if out.ok {
        return Ok(Some(out.stdout));
    }
    if is_not_a_repo(&out.stderr) {
        return Err(GitError::NotARepo(root.to_string()));
    }
    if is_missing_at_rev(&out.stderr) {
        return Ok(None);
    }
    Err(GitError::failed(out.stderr))
}

/// git's several ways of saying "that path isn't in that revision":
/// `path 'x' does not exist in 'rev'`, `path 'x' exists on disk, but not in
/// 'rev'`, and `invalid object name` for a revision with no such tree entry.
fn is_missing_at_rev(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("does not exist in")
        || lower.contains("exists on disk, but not in")
        || lower.contains("does not exist in the given revision")
        || lower.contains("invalid object name")
}

/// The blob sha of `rev:rel`, or `None` when the path is absent there.
fn blob_at(root: &Path, rev: &str, rel: &str) -> GitResult<Option<String>> {
    let spec = format!("{rev}:{rel}");
    git_line_opt(root, &["rev-parse", "--verify", "--quiet", &spec])
}

fn file_changes(
    root: &str,
    rel: &str,
    base_ref: &str,
    branches: Vec<String>,
) -> GitResult<Vec<GitFileChange>> {
    let root = Path::new(root);
    let base = blob_at(root, base_ref, rel)?;
    let mut out = Vec::with_capacity(branches.len());
    for branch in branches {
        let blob = blob_at(root, &branch, rel)?;
        // Missing on exactly one side counts as a difference; missing on both
        // (the file exists on neither branch) does not.
        let differs = blob != base;
        out.push(GitFileChange { branch, differs });
    }
    Ok(out)
}

/* -------------------------------- commands -------------------------------- */

/// Where this path sits in git: root, branch, HEAD, the baseline branch and
/// its merge-base, and every worktree of the repository. `base_branch` is the
/// `reviewBaseBranch` setting (empty = auto-detect).
#[tauri::command]
pub async fn git_repo_info(path: String, base_branch: Option<String>) -> GitResult<GitRepoInfo> {
    tauri::async_runtime::spawn_blocking(move || repo_info(&path, base_branch.as_deref()))
        .await
        .map_err(|e| GitError::failed(e.to_string()))?
}

/// One file's contents at a revision, or `None` when it did not exist there.
#[tauri::command]
pub async fn git_show_file(root: String, rev: String, rel: String) -> GitResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || show_file(&root, &rev, &rel))
        .await
        .map_err(|e| GitError::failed(e.to_string()))?
}

/// Per branch: does its blob for `rel` differ from `base_ref`'s? One
/// `rev-parse` per branch — no checkouts, no working-tree churn.
#[tauri::command]
pub async fn git_file_changes(
    root: String,
    rel: String,
    base_ref: String,
    branches: Vec<String>,
) -> GitResult<Vec<GitFileChange>> {
    tauri::async_runtime::spawn_blocking(move || file_changes(&root, &rel, &base_ref, branches))
        .await
        .map_err(|e| GitError::failed(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slashes_normalize_and_drop_a_trailing_separator() {
        assert_eq!(to_slashes(r"C:\work\proj\"), "C:/work/proj");
        assert_eq!(to_slashes("/home/u/proj/"), "/home/u/proj");
        // A drive root keeps its slash — `C:` alone is not the same path.
        assert_eq!(to_slashes(r"C:\"), "C:/");
        assert_eq!(to_slashes("/"), "/");
    }

    #[test]
    fn rel_path_is_root_relative_with_forward_slashes() {
        assert_eq!(
            relative_path("C:/work/proj", r"C:\work\proj\src\core\a.ts").as_deref(),
            Some("src/core/a.ts"),
        );
        assert_eq!(relative_path("/r", "/r/a/b.rs").as_deref(), Some("a/b.rs"));
        // The root itself is the empty relative path, not None.
        assert_eq!(relative_path("/r", "/r").as_deref(), Some(""));
        assert_eq!(relative_path("/r", "/r/").as_deref(), Some(""));
        // A sibling whose name merely starts with the root is not under it.
        assert_eq!(relative_path("/r", "/rr/a.ts"), None);
        assert_eq!(relative_path("/r", "/other/a.ts"), None);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn rel_path_folds_case_on_case_insensitive_filesystems() {
        // The tab's path and git's toplevel routinely disagree on drive case.
        assert_eq!(
            relative_path("c:/Work/Proj", r"C:\work\proj\src\A.ts").as_deref(),
            Some("src/A.ts"),
        );
    }

    #[test]
    fn porcelain_parses_branches_detached_heads_and_bare_records() {
        let out = concat!(
            "worktree C:/Users/x/repo\n",
            "HEAD 1111111111111111111111111111111111111111\n",
            "branch refs/heads/development\n",
            "\n",
            "worktree C:/Users/x/repo/worktrees/cr-git\n",
            "HEAD 2222222222222222222222222222222222222222\n",
            "branch refs/heads/feat/cr-git\n",
            "\n",
            "worktree C:/Users/x/repo/worktrees/spike\n",
            "HEAD 3333333333333333333333333333333333333333\n",
            "detached\n",
            "locked\n",
            "\n",
        );
        let found = parse_worktrees(out);
        assert_eq!(
            found,
            vec![
                GitWorktree {
                    path: "C:/Users/x/repo".into(),
                    branch: Some("development".into()),
                    head: "1111111111111111111111111111111111111111".into(),
                },
                GitWorktree {
                    path: "C:/Users/x/repo/worktrees/cr-git".into(),
                    branch: Some("feat/cr-git".into()),
                    head: "2222222222222222222222222222222222222222".into(),
                },
                GitWorktree {
                    path: "C:/Users/x/repo/worktrees/spike".into(),
                    branch: None,
                    head: "3333333333333333333333333333333333333333".into(),
                },
            ],
        );
    }

    #[test]
    fn porcelain_drops_a_bare_record_and_survives_a_missing_trailing_blank_line() {
        let out = concat!(
            "worktree /repo.git\n",
            "bare\n",
            "\n",
            "worktree /repo/wt\n",
            "HEAD 4444444444444444444444444444444444444444\n",
            "branch refs/heads/main",
        );
        let found = parse_worktrees(out);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "/repo/wt");
        assert_eq!(found[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn porcelain_of_nothing_is_no_worktrees() {
        assert!(parse_worktrees("").is_empty());
        assert!(parse_worktrees("\n\n").is_empty());
    }

    #[test]
    fn backslashed_worktree_paths_come_back_with_forward_slashes() {
        let out = "worktree C:\\repo\\wt\nHEAD abc\nbranch refs/heads/feat/x\n";
        assert_eq!(parse_worktrees(out)[0].path, "C:/repo/wt");
    }

    #[test]
    fn error_codes_and_wire_shape_match_the_readme_table() {
        let cases = [
            (GitError::NoGit, "GIT_NOT_FOUND"),
            (GitError::NotARepo("/x".into()), "GIT_NOT_A_REPO"),
            (GitError::Timeout, "GIT_TIMEOUT"),
            (GitError::failed("boom"), "GIT_FAILED"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["code"], code);
            assert!(json["message"].is_string());
        }
    }

    #[test]
    fn missing_at_rev_is_told_apart_from_a_real_failure() {
        assert!(is_missing_at_rev(
            "fatal: path 'src/new.ts' does not exist in 'HEAD'"
        ));
        assert!(is_missing_at_rev(
            "fatal: path 'src/new.ts' exists on disk, but not in 'abc123'"
        ));
        assert!(!is_missing_at_rev("fatal: bad revision 'nope'"));
        assert!(is_not_a_repo(
            "fatal: not a git repository (or any of the parent directories): .git"
        ));
    }

    /* ---------------------- against a real git binary ---------------------- */

    /// Whether this machine has git at all; without it the integration tests
    /// below skip rather than fail (CI images have git, a minimal one may not).
    fn have_git() -> bool {
        !matches!(run_git(None, &["--version"]), Err(GitError::NoGit))
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let out = run_git(Some(dir), args).expect("git ran");
        assert!(out.ok, "git {args:?} failed: {}", out.stderr);
    }

    /// A throwaway repo with one commit, deterministic identity and no reliance
    /// on the machine's `init.defaultBranch`.
    fn temp_repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().to_path_buf();
        git_ok(&root, &["init", "--initial-branch=main"]);
        git_ok(&root, &["config", "user.email", "t@example.com"]);
        git_ok(&root, &["config", "user.name", "Test"]);
        git_ok(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("a.ts"), "export const a = 1;\n").unwrap();
        git_ok(&root, &["add", "a.ts"]);
        git_ok(&root, &["commit", "-m", "first"]);
        (dir, root)
    }

    #[test]
    fn repo_info_and_show_file_round_trip_in_a_real_repo() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_guard, root) = temp_repo();
        let file = root.join("a.ts");

        let info = repo_info(&file.to_string_lossy(), None).expect("repo info");
        assert_eq!(info.rel, "a.ts");
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.head.len(), 40);
        assert!(!info.is_worktree, "the main checkout is not a worktree");
        assert_eq!(info.base_branch.as_deref(), Some("main"));
        // HEAD is the baseline, so there is no merge-base to compare against.
        assert_eq!(info.base_ref, None);
        assert_eq!(info.worktrees.len(), 1);
        assert_eq!(info.worktrees[0].branch.as_deref(), Some("main"));
        assert_eq!(
            path_key(&info.worktrees[0].path),
            path_key(&info.root),
            "the single worktree is the root itself",
        );

        // The committed text comes back; an uncommitted edit does not change it.
        std::fs::write(&file, "export const a = 2;\n").unwrap();
        let shown = show_file(&info.root, "HEAD", "a.ts").expect("show");
        assert_eq!(shown.as_deref(), Some("export const a = 1;\n"));

        // A path that never existed at that revision is None, not an error.
        assert_eq!(
            show_file(&info.root, "HEAD", "nope.ts").expect("show"),
            None
        );
    }

    #[test]
    fn a_branch_off_the_baseline_gets_a_merge_base_and_a_changed_radar() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_guard, root) = temp_repo();
        let base_head = repo_info(&root.to_string_lossy(), None).unwrap().head;

        git_ok(&root, &["checkout", "-b", "feat/x"]);
        std::fs::write(root.join("a.ts"), "export const a = 2;\n").unwrap();
        git_ok(&root, &["commit", "-am", "second"]);

        let info = repo_info(&root.join("a.ts").to_string_lossy(), None).expect("repo info");
        assert_eq!(info.branch.as_deref(), Some("feat/x"));
        assert_eq!(info.base_branch.as_deref(), Some("main"));
        assert_eq!(info.base_ref.as_deref(), Some(base_head.as_str()));

        let changes = file_changes(
            &info.root,
            "a.ts",
            &base_head,
            vec!["feat/x".into(), "main".into()],
        )
        .expect("file changes");
        assert_eq!(changes[0].branch, "feat/x");
        assert!(changes[0].differs, "the feature branch rewrote the file");
        assert_eq!(changes[1].branch, "main");
        assert!(!changes[1].differs, "main IS the baseline");

        // A file that exists on neither side is not a difference.
        let none = file_changes(&info.root, "ghost.ts", &base_head, vec!["feat/x".into()]).unwrap();
        assert!(!none[0].differs);
    }

    #[test]
    fn a_linked_worktree_knows_it_is_one_and_lists_its_sibling() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_guard, root) = temp_repo();
        let wt = root.join("worktrees").join("feat-x");
        git_ok(
            &root,
            &["worktree", "add", "-b", "feat/x", &wt.to_string_lossy()],
        );

        let info = repo_info(&wt.join("a.ts").to_string_lossy(), None).expect("repo info");
        assert!(info.is_worktree, "a linked worktree reports itself as one");
        assert_eq!(info.branch.as_deref(), Some("feat/x"));
        assert_eq!(info.rel, "a.ts");
        assert_eq!(info.base_branch.as_deref(), Some("main"));
        // A fresh branch off main: the merge-base is main's tip.
        assert_eq!(info.base_ref.as_deref(), Some(info.head.as_str()));
        assert_eq!(info.worktrees.len(), 2);
        assert!(info
            .worktrees
            .iter()
            .any(|w| w.branch.as_deref() == Some("feat/x")));

        // The main checkout, asked the same question, says it is not a worktree.
        let main = repo_info(&root.join("a.ts").to_string_lossy(), None).expect("repo info");
        assert!(!main.is_worktree);
    }

    #[test]
    fn a_path_outside_any_repo_reports_not_a_repo() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        // A temp dir is not inside a repository on any of the CI runners.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "x\n").unwrap();
        match repo_info(&dir.path().join("a.ts").to_string_lossy(), None) {
            Err(GitError::NotARepo(_)) => {}
            other => panic!("expected NotARepo, got {other:?}"),
        }
    }
}
