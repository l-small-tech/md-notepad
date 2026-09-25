//! The three network operations — `git_fetch`, `git_pull`, `git_push` — and
//! their bookkeeping: `GitOps` (managed state) holds one cancel flag per
//! running op and allows one op per repository at a time; `git_op_cancel`
//! flips the flag and the runner kills git.
//!
//! Output streams over a `Channel<GitOutputEvent>` line by line (git's
//! progress lives on stderr). A push git rejected or a fetch that could not
//! reach its remote is a RESULT (`ok: false`, exit code, stderr) — something
//! to show, with a hint — never a rejection; the rejections here are the
//! runner's own (`GIT_BUSY`, `GIT_CANCELLED`, `GIT_TIMEOUT`, `GIT_NOT_FOUND`).

use super::ops::{merge_outcome, GitMergeOutcome};
use super::run::{run_git_streaming, safe_arg, GitOutput, GitOutputEvent};
use super::{blocking, path_key, GitError, GitResult};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitNetResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stderr: String,
    /// `git_pull` only: how the merge half ended (`conflicts` is an outcome,
    /// and then `ok` is still true — the pull ran; the tree needs the user).
    pub merge: Option<GitMergeOutcome>,
}

/* --------------------------------- GitOps --------------------------------- */

struct Op {
    repo: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    running: HashMap<u64, Op>,
    /// Cancels that arrived before their op began (the frontend allocates the
    /// id before it invokes, so this window exists). Bounded: an id that never
    /// starts must not pin memory.
    precancelled: VecDeque<u64>,
}

const PRECANCEL_MEMORY: usize = 64;

/// One network op per repository, each with its cancel flag. Managed app-wide
/// (`.manage(GitOps::default())` in lib.rs) so a cancel from any window finds
/// the op.
#[derive(Default)]
pub struct GitOps(Arc<Mutex<Inner>>);

/// A running op's registration; dropping it (the op ended, however it ended)
/// frees the repository for the next one.
pub struct OpTicket {
    ops: Arc<Mutex<Inner>>,
    op_id: u64,
    pub cancel: Arc<AtomicBool>,
}

impl Drop for OpTicket {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.ops.lock() {
            inner.running.remove(&self.op_id);
        }
    }
}

impl GitOps {
    /// Register `op_id` for `root`, or `Busy` when that repository already
    /// has one running. A cancel that arrived first is honoured: the ticket's
    /// flag starts set and the runner stops before spawning git.
    pub fn begin(&self, op_id: u64, root: &str) -> GitResult<OpTicket> {
        let repo = path_key(root);
        let mut inner = self
            .0
            .lock()
            .map_err(|_| GitError::failed("GitOps poisoned"))?;
        if inner.running.values().any(|op| op.repo == repo) {
            return Err(GitError::Busy);
        }
        let pre = inner.precancelled.iter().position(|id| *id == op_id);
        if let Some(i) = pre {
            inner.precancelled.remove(i);
        }
        let cancel = Arc::new(AtomicBool::new(pre.is_some()));
        inner.running.insert(
            op_id,
            Op {
                repo,
                cancel: cancel.clone(),
            },
        );
        Ok(OpTicket {
            ops: self.0.clone(),
            op_id,
            cancel,
        })
    }

    /// Set the op's flag; remembered when the op has not begun yet.
    pub fn cancel(&self, op_id: u64) {
        let Ok(mut inner) = self.0.lock() else {
            return;
        };
        match inner.running.get(&op_id) {
            Some(op) => op.cancel.store(true, Ordering::SeqCst),
            None => {
                if !inner.precancelled.contains(&op_id) {
                    inner.precancelled.push_back(op_id);
                    while inner.precancelled.len() > PRECANCEL_MEMORY {
                        inner.precancelled.pop_front();
                    }
                }
            }
        }
    }
}

/* -------------------------------- the work -------------------------------- */

fn net_result(out: GitOutput, merge: Option<GitMergeOutcome>) -> GitNetResult {
    GitNetResult {
        ok: out.ok || merge.is_some(),
        exit_code: out.code,
        stderr: out.stderr,
        merge,
    }
}

pub(super) fn fetch(
    root: &Path,
    remote: Option<&str>,
    prune: bool,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(GitOutputEvent),
) -> GitResult<GitNetResult> {
    let mut args = vec!["fetch", "--progress"];
    if prune {
        args.push("--prune");
    }
    match remote {
        Some(r) => args.push(safe_arg(r)?),
        None => args.push("--all"),
    }
    let out = run_git_streaming(root, &args, cancel, sink)?;
    Ok(net_result(out, None))
}

pub(super) fn pull(
    root: &Path,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(GitOutputEvent),
) -> GitResult<GitNetResult> {
    let out = run_git_streaming(
        root,
        &["pull", "--progress", "--no-rebase", "--no-edit"],
        cancel,
        sink,
    )?;
    // A pull that never reached the merge (no upstream, unreachable remote)
    // has no `u` entries and a refusal-shaped stderr → `merge: None, ok: false`.
    let merge = merge_outcome(root, &out)?;
    Ok(net_result(out, merge))
}

pub(super) fn push(
    root: &Path,
    remote: Option<&str>,
    set_upstream: bool,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(GitOutputEvent),
) -> GitResult<GitNetResult> {
    let mut args = vec!["push", "--progress"];
    let remote = remote.map(safe_arg).transpose()?;
    if set_upstream {
        args.extend(["-u", remote.unwrap_or("origin"), "HEAD"]);
    } else if let Some(r) = remote {
        args.push(r);
    }
    let out = run_git_streaming(root, &args, cancel, sink)?;
    Ok(net_result(out, None))
}

fn channel_sink(on_output: Channel<GitOutputEvent>) -> impl FnMut(GitOutputEvent) {
    move |event| {
        // A closed channel (the window went away) is not the op's problem.
        let _ = on_output.send(event);
    }
}

/* -------------------------------- commands -------------------------------- */

/// `fetch --progress [--prune] (<remote> | --all)`.
#[tauri::command]
pub async fn git_fetch(
    root: String,
    remote: Option<String>,
    prune: bool,
    op_id: u64,
    on_output: Channel<GitOutputEvent>,
    state: State<'_, GitOps>,
) -> GitResult<GitNetResult> {
    let ticket = state.begin(op_id, &root)?;
    blocking(move || {
        let mut sink = channel_sink(on_output);
        let result = fetch(
            Path::new(&root),
            remote.as_deref(),
            prune,
            &ticket.cancel,
            &mut sink,
        );
        drop(ticket);
        result
    })
    .await
}

/// `pull --progress --no-rebase --no-edit`; `merge` on the result says how
/// the merge half ended.
#[tauri::command]
pub async fn git_pull(
    root: String,
    op_id: u64,
    on_output: Channel<GitOutputEvent>,
    state: State<'_, GitOps>,
) -> GitResult<GitNetResult> {
    let ticket = state.begin(op_id, &root)?;
    blocking(move || {
        let mut sink = channel_sink(on_output);
        let result = pull(Path::new(&root), &ticket.cancel, &mut sink);
        drop(ticket);
        result
    })
    .await
}

/// `push --progress [<remote>]`, or `push --progress -u <remote> HEAD` with
/// `set_upstream` (publishing a branch; `remote` defaults to `origin`).
#[tauri::command]
pub async fn git_push(
    root: String,
    remote: Option<String>,
    set_upstream: bool,
    op_id: u64,
    on_output: Channel<GitOutputEvent>,
    state: State<'_, GitOps>,
) -> GitResult<GitNetResult> {
    let ticket = state.begin(op_id, &root)?;
    blocking(move || {
        let mut sink = channel_sink(on_output);
        let result = push(
            Path::new(&root),
            remote.as_deref(),
            set_upstream,
            &ticket.cancel,
            &mut sink,
        );
        drop(ticket);
        result
    })
    .await
}

/// Cancel a running (or about-to-run) fetch / pull / push: the runner kills
/// git and the op rejects `GIT_CANCELLED`. Unknown ids are remembered briefly
/// so a cancel racing the op's start still lands.
#[tauri::command]
pub async fn git_op_cancel(op_id: u64, state: State<'_, GitOps>) -> GitResult<()> {
    state.cancel(op_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::ops::GitMergeResult;
    use super::super::status::{status, GitRepoState};
    use super::super::testutil::{
        clone_of, git_ok, git_out, have_git, head_of, temp_repo_with_remote, write,
    };
    use super::*;

    fn collect() -> (Vec<GitOutputEvent>, impl FnMut(GitOutputEvent)) {
        (Vec::new(), |_e| {})
    }

    #[test]
    fn git_ops_allows_one_op_per_repo_and_frees_it_on_drop() {
        let ops = GitOps::default();
        let t1 = ops.begin(1, "C:/repo").unwrap();
        assert!(matches!(ops.begin(2, "c:\\repo\\"), Err(GitError::Busy)) || !cfg!(windows));
        assert!(matches!(ops.begin(2, "C:/repo"), Err(GitError::Busy)));
        let _t3 = ops.begin(3, "C:/other").expect("a different repo is free");
        drop(t1);
        let _t4 = ops
            .begin(4, "C:/repo")
            .expect("free again once the ticket drops");
    }

    #[test]
    fn git_ops_cancel_sets_a_running_flag_and_remembers_an_early_one() {
        let ops = GitOps::default();
        let t = ops.begin(7, "/r").unwrap();
        assert!(!t.cancel.load(Ordering::SeqCst));
        ops.cancel(7);
        assert!(t.cancel.load(Ordering::SeqCst));
        drop(t);

        ops.cancel(8);
        let early = ops.begin(8, "/r").unwrap();
        assert!(
            early.cancel.load(Ordering::SeqCst),
            "a cancel before begin is honoured"
        );
        drop(early);
        let fresh = ops.begin(8, "/r").unwrap();
        assert!(!fresh.cancel.load(Ordering::SeqCst), "and consumed");

        for id in 100..200 {
            ops.cancel(id);
        }
        assert!(
            !ops.begin(100, "/a").unwrap().cancel.load(Ordering::SeqCst),
            "old ids age out"
        );
        assert!(ops.begin(199, "/b").unwrap().cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn real_fetch_push_with_upstream_and_pull_fast_forward_against_a_bare_remote() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (guard, root, remote) = temp_repo_with_remote();
        let (mut events, _) = collect();
        let cancel = AtomicBool::new(false);

        let f = fetch(&root, None, false, &cancel, &mut |e| events.push(e)).unwrap();
        assert!(f.ok, "{}", f.stderr);
        assert_eq!(f.exit_code, Some(0));
        assert!(f.merge.is_none());
        assert_eq!(events.last(), Some(&GitOutputEvent::Done));
        let f2 = fetch(&root, Some("origin"), true, &cancel, &mut |_| {}).unwrap();
        assert!(f2.ok);
        assert!(matches!(
            fetch(&root, Some("-x"), false, &cancel, &mut |_| {}),
            Err(GitError::InvalidArg(_))
        ));
        // An unknown remote is a result, not a rejection.
        let bad = fetch(&root, Some("nowhere"), false, &cancel, &mut |_| {}).unwrap();
        assert!(!bad.ok);
        assert!(bad.exit_code.is_some_and(|c| c != 0));
        assert!(!bad.stderr.is_empty());

        // Publish a branch with -u.
        git_ok(&root, &["switch", "-c", "feat/p"]);
        write(&root, "p.ts", "p\n");
        git_ok(&root, &["add", "p.ts"]);
        git_ok(&root, &["commit", "-m", "p"]);
        let mut push_events = Vec::new();
        let p = push(&root, None, true, &cancel, &mut |e| push_events.push(e)).unwrap();
        assert!(p.ok, "{}", p.stderr);
        assert_eq!(
            git_out(&root, &["rev-parse", "--abbrev-ref", "feat/p@{upstream}"]),
            "origin/feat/p"
        );
        assert_eq!(push_events.last(), Some(&GitOutputEvent::Done));
        assert!(push_events
            .iter()
            .any(|e| matches!(e, GitOutputEvent::Line { .. })));
        assert_eq!(
            git_out(&remote, &["rev-parse", "refs/heads/feat/p"]),
            head_of(&root)
        );

        // Up to date pull, then a fast-forward from a commit made elsewhere.
        git_ok(&root, &["switch", "main"]);
        let up = pull(&root, &cancel, &mut |_| {}).unwrap();
        assert!(up.ok);
        assert_eq!(
            up.merge.as_ref().map(|m| m.outcome),
            Some(GitMergeResult::UpToDate)
        );

        let other = guard.path().join("other");
        clone_of(&remote, &other);
        write(&other, "o.ts", "o\n");
        git_ok(&other, &["add", "o.ts"]);
        git_ok(&other, &["commit", "-m", "from other"]);
        git_ok(&other, &["push", "origin", "main"]);
        let ff = pull(&root, &cancel, &mut |_| {}).unwrap();
        assert!(ff.ok, "{}", ff.stderr);
        let m = ff.merge.expect("merge half reported");
        assert_eq!(m.outcome, GitMergeResult::FastForward);
        assert_eq!(m.head, head_of(&other));
        assert!(root.join("o.ts").exists());

        // A rejected push is a result.
        write(&other, "o.ts", "o2\n");
        git_ok(&other, &["commit", "-am", "other again"]);
        git_ok(&other, &["push", "origin", "main"]);
        write(&root, "r.ts", "r\n");
        git_ok(&root, &["add", "r.ts"]);
        git_ok(&root, &["commit", "-m", "local"]);
        let rejected = push(&root, None, false, &cancel, &mut |_| {}).unwrap();
        assert!(!rejected.ok);
        assert!(rejected.stderr.contains("rejected"), "{}", rejected.stderr);
    }

    #[test]
    fn real_pull_with_a_conflicting_upstream_is_the_conflicts_outcome() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (guard, root, remote) = temp_repo_with_remote();
        let other = guard.path().join("other");
        clone_of(&remote, &other);
        write(&other, "a.ts", "export const a = 'theirs';\n");
        git_ok(&other, &["commit", "-am", "theirs"]);
        git_ok(&other, &["push", "origin", "main"]);
        write(&root, "a.ts", "export const a = 'ours';\n");
        git_ok(&root, &["commit", "-am", "ours"]);
        let before = head_of(&root);

        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let r = pull(&root, &cancel, &mut |e| events.push(e)).unwrap();
        assert!(r.ok, "a conflict is an outcome: {}", r.stderr);
        assert_ne!(r.exit_code, Some(0));
        let m = r.merge.expect("merge half reported");
        assert_eq!(m.outcome, GitMergeResult::Conflicts);
        assert_eq!(m.conflicted, vec!["a.ts".to_string()]);
        assert_eq!(m.head, before);
        assert_eq!(events.last(), Some(&GitOutputEvent::Done));
        let st = status(&root).unwrap();
        assert_eq!(st.state, GitRepoState::Merging);
        assert_eq!(st.merge_head.as_deref(), Some(head_of(&other).as_str()));

        // A pull that never reaches the merge (no upstream) is ok:false, merge:None.
        git_ok(&root, &["merge", "--abort"]);
        git_ok(&root, &["switch", "-c", "feat/orphan"]);
        let no_up = pull(&root, &cancel, &mut |_| {}).unwrap();
        assert!(!no_up.ok);
        assert!(no_up.merge.is_none());
        assert!(!no_up.stderr.is_empty());
    }

    #[test]
    fn real_cancel_with_a_preset_flag_rejects_cancelled() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root, _remote) = temp_repo_with_remote();
        let ops = GitOps::default();
        ops.cancel(42);
        let ticket = ops.begin(42, &root.to_string_lossy()).unwrap();
        let mut events = Vec::new();
        match fetch(&root, None, false, &ticket.cancel, &mut |e| events.push(e)) {
            Err(GitError::Cancelled) => {}
            other => panic!("expected Cancelled, got {other:?}"),
        }
        assert_eq!(events.last(), Some(&GitOutputEvent::Done));
        drop(ticket);
        // The repo is free again afterwards.
        ops.begin(43, &root.to_string_lossy()).unwrap();
    }
}
