//! `git_status`: `status --porcelain=v2 -z --branch --untracked-files=normal`
//! plus the in-progress-operation state git keeps as files in its dir.
//!
//! `-z` because paths may hold anything; `--untracked-files=normal` (never
//! `-uall`) so an untracked directory is one record, not one per file — the
//! difference between a 3 s status and a hung one in a repo with a fresh
//! `node_modules`. What the letters MEAN (which group a file lands in, whether
//! the tree counts as clean) is `src/core/git/status.ts`'s; this file only
//! transcribes.

use super::run::{checked, GitMode};
use super::{blocking, GitResult};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitStatusEntryKind {
    Ordinary,
    Renamed,
    Unmerged,
    Untracked,
}

/// One record of `git status --porcelain=v2 -z`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    /// Relative to the checkout root, forward slashes (git's own spelling).
    pub path: String,
    /// A rename/copy's source path; `None` otherwise.
    pub orig_path: Option<String>,
    /// Index status letter (`.` = unchanged; `?` for an untracked entry).
    pub index: String,
    /// Working-tree status letter (`.` = unchanged; `?` for an untracked entry).
    pub worktree: String,
    pub kind: GitStatusEntryKind,
}

/// Which multi-step operation the checkout is in the middle of, from the
/// marker files git leaves in its dir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRepoState {
    Clean,
    Merging,
    Rebasing,
    CherryPicking,
    Reverting,
    Bisecting,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// HEAD's sha; `""` in a repo with no commits yet.
    pub head: String,
    /// Short branch name; `None` on a detached HEAD.
    pub branch: Option<String>,
    /// `origin/main`-style; `None` when nothing is tracked.
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub unborn: bool,
    pub state: GitRepoState,
    /// `MERGE_HEAD`'s sha while merging.
    pub merge_head: Option<String>,
    pub entries: Vec<GitStatusEntry>,
}

/* --------------------------------- parsing -------------------------------- */

/// The porcelain's headers and records, before the state files are consulted.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ParsedStatus {
    pub head: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub unborn: bool,
    pub entries: Vec<GitStatusEntry>,
}

/// Parse `status --porcelain=v2 -z --branch` output. Every record is
/// NUL-terminated; a rename (`2`) record is followed by one more NUL-terminated
/// field, its source path.
pub(super) fn parse_status(raw: &[u8]) -> ParsedStatus {
    let mut st = ParsedStatus::default();
    let mut fields = raw
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned());
    while let Some(rec) = fields.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(header) = rec.strip_prefix("# ") {
            parse_header(header, &mut st);
            continue;
        }
        let mut parts = rec.splitn(2, ' ');
        let tag = parts.next().unwrap_or_default();
        let rest = parts.next().unwrap_or_default();
        match tag {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            "1" => {
                if let Some((xy, path)) = split_fields(rest, 7) {
                    st.entries
                        .push(entry(path, None, xy, GitStatusEntryKind::Ordinary));
                }
            }
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <orig>
            "2" => {
                let orig = fields.next().unwrap_or_default();
                if let Some((xy, path)) = split_fields(rest, 8) {
                    st.entries
                        .push(entry(path, Some(orig), xy, GitStatusEntryKind::Renamed));
                }
            }
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            "u" => {
                if let Some((xy, path)) = split_fields(rest, 9) {
                    st.entries
                        .push(entry(path, None, xy, GitStatusEntryKind::Unmerged));
                }
            }
            // ? <path>
            "?" => st.entries.push(entry(
                rest.to_string(),
                None,
                "??",
                GitStatusEntryKind::Untracked,
            )),
            // `!` (ignored) never appears without --ignored; anything else is a
            // future record type we do not understand — skip it.
            _ => {}
        }
    }
    st
}

fn parse_header(header: &str, st: &mut ParsedStatus) {
    let Some((key, value)) = header.split_once(' ') else {
        return;
    };
    match key {
        "branch.oid" => {
            if value == "(initial)" {
                st.unborn = true;
                st.head = String::new();
            } else {
                st.head = value.to_string();
            }
        }
        "branch.head" => {
            st.branch = (value != "(detached)").then(|| value.to_string());
        }
        "branch.upstream" => st.upstream = Some(value.to_string()),
        "branch.ab" => {
            // `+N -M`
            let mut ahead = None;
            let mut behind = None;
            for tok in value.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    ahead = n.parse().ok();
                } else if let Some(n) = tok.strip_prefix('-') {
                    behind = n.parse().ok();
                }
            }
            st.ahead = ahead;
            st.behind = behind;
        }
        _ => {}
    }
}

/// `rest` is `<XY> <f2> … <fN> <path>`: `n` space-separated fields precede
/// the path, which may itself contain spaces. Returns `(XY, path)`.
fn split_fields(rest: &str, n: usize) -> Option<(&str, String)> {
    let mut xy = None;
    let mut remaining = rest;
    for i in 0..n {
        let (field, tail) = remaining.split_once(' ')?;
        if i == 0 {
            xy = Some(field);
        }
        remaining = tail;
    }
    Some((xy?, remaining.to_string()))
}

fn entry(path: String, orig: Option<String>, xy: &str, kind: GitStatusEntryKind) -> GitStatusEntry {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.').to_string();
    let worktree = chars.next().unwrap_or('.').to_string();
    GitStatusEntry {
        path,
        orig_path: orig,
        index,
        worktree,
        kind,
    }
}

/* ------------------------------- state files ------------------------------ */

/// The marker files, in the order they are asked for and checked.
const STATE_FILES: [&str; 6] = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
];

/// `(state, MERGE_HEAD sha)` for the checkout at `root`, from one
/// `rev-parse --git-path …` per marker file (all in a single call — rev-parse
/// answers each `--git-path` in turn, so a linked worktree's private dir is
/// resolved for us).
pub(super) fn repo_state(root: &Path) -> GitResult<(GitRepoState, Option<String>)> {
    let mut args: Vec<&str> = Vec::with_capacity(STATE_FILES.len() * 2 + 1);
    args.push("rev-parse");
    for f in STATE_FILES {
        args.push("--git-path");
        args.push(f);
    }
    let out = checked(root, GitMode::Read, &args)?;
    let paths: Vec<std::path::PathBuf> = out
        .stdout
        .lines()
        .map(|l| root.join(l.trim_end()))
        .collect();
    let exists = |i: usize| paths.get(i).is_some_and(|p| p.exists());
    let state = if exists(0) || exists(1) {
        GitRepoState::Rebasing
    } else if exists(2) {
        GitRepoState::Merging
    } else if exists(3) {
        GitRepoState::CherryPicking
    } else if exists(4) {
        GitRepoState::Reverting
    } else if exists(5) {
        GitRepoState::Bisecting
    } else {
        GitRepoState::Clean
    };
    let merge_head = if state == GitRepoState::Merging {
        paths
            .get(2)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    Ok((state, merge_head))
}

/* --------------------------------- the work ------------------------------- */

pub(super) const STATUS_ARGS: [&str; 5] = [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=normal",
];

/// The parsed porcelain for `root` — shared with the worktree dashboard,
/// which needs the counts but not the state.
pub(super) fn read_status(root: &Path) -> GitResult<ParsedStatus> {
    let out = checked(root, GitMode::Read, &STATUS_ARGS)?;
    Ok(parse_status(out.stdout.as_bytes()))
}

pub(super) fn status(root: &Path) -> GitResult<GitStatus> {
    let parsed = read_status(root)?;
    let (state, merge_head) = repo_state(root)?;
    Ok(GitStatus {
        head: parsed.head,
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        unborn: parsed.unborn,
        state,
        merge_head,
        entries: parsed.entries,
    })
}

/// `git status --porcelain=v2` plus the in-progress-operation state.
#[tauri::command]
pub async fn git_status(root: String) -> GitResult<GitStatus> {
    blocking(move || status(Path::new(&root))).await
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{git_ok, have_git, make_conflict, temp_repo, write};
    use super::*;

    fn e(
        path: &str,
        orig: Option<&str>,
        index: &str,
        worktree: &str,
        kind: GitStatusEntryKind,
    ) -> GitStatusEntry {
        GitStatusEntry {
            path: path.into(),
            orig_path: orig.map(str::to_string),
            index: index.into(),
            worktree: worktree.into(),
            kind,
        }
    }

    #[test]
    fn porcelain_v2_fixture_covers_every_record_type() {
        let raw = concat!(
            "# branch.oid 1111111111111111111111111111111111111111\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +3 -1\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/edited.ts\0",
            "1 A. N... 000000 100644 100644 0000 cccc new file.ts\0",
            "1 MD N... 100644 100644 000000 aaaa bbbb gone.ts\0",
            "2 R. N... 100644 100644 100644 aaaa aaaa R100 new/name.ts\0old/name.ts\0",
            "u UU N... 100644 100644 100644 100644 a b c conflict.ts\0",
            "? notes/\0",
            "? loose.md\0",
        );
        let st = parse_status(raw.as_bytes());
        assert_eq!(st.head, "1111111111111111111111111111111111111111");
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (Some(3), Some(1)));
        assert!(!st.unborn);
        assert_eq!(
            st.entries,
            vec![
                e(
                    "src/edited.ts",
                    None,
                    ".",
                    "M",
                    GitStatusEntryKind::Ordinary
                ),
                e("new file.ts", None, "A", ".", GitStatusEntryKind::Ordinary),
                e("gone.ts", None, "M", "D", GitStatusEntryKind::Ordinary),
                e(
                    "new/name.ts",
                    Some("old/name.ts"),
                    "R",
                    ".",
                    GitStatusEntryKind::Renamed
                ),
                e("conflict.ts", None, "U", "U", GitStatusEntryKind::Unmerged),
                e("notes/", None, "?", "?", GitStatusEntryKind::Untracked),
                e("loose.md", None, "?", "?", GitStatusEntryKind::Untracked),
            ]
        );
    }

    #[test]
    fn porcelain_v2_headers_for_unborn_detached_and_untracked_upstream() {
        let unborn = parse_status(b"# branch.oid (initial)\0# branch.head main\0? a.ts\0");
        assert!(unborn.unborn);
        assert_eq!(unborn.head, "");
        assert_eq!(unborn.branch.as_deref(), Some("main"));
        assert_eq!(unborn.upstream, None);
        assert_eq!((unborn.ahead, unborn.behind), (None, None));

        let detached = parse_status(b"# branch.oid abc\0# branch.head (detached)\0");
        assert_eq!(detached.branch, None);
        assert_eq!(detached.head, "abc");
        assert!(detached.entries.is_empty());

        assert_eq!(parse_status(b""), ParsedStatus::default());
    }

    #[test]
    fn real_status_reports_index_tree_untracked_dir_and_clean_state() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        write(&root, "a.ts", "changed\n");
        write(&root, "b.ts", "new\n");
        git_ok(&root, &["add", "b.ts"]);
        write(&root, "dir/inner.md", "x\n");
        write(&root, "loose.md", "x\n");

        let st = status(&root).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.head.len(), 40);
        assert!(!st.unborn);
        assert_eq!(st.state, GitRepoState::Clean);
        assert_eq!(st.merge_head, None);
        assert_eq!(st.upstream, None);
        let by_path = |p: &str| st.entries.iter().find(|e| e.path == p).cloned();
        let a = by_path("a.ts").expect("a.ts listed");
        assert_eq!((a.index.as_str(), a.worktree.as_str()), (".", "M"));
        let b = by_path("b.ts").expect("b.ts listed");
        assert_eq!((b.index.as_str(), b.worktree.as_str()), ("A", "."));
        // `--untracked-files=normal`: the directory, not its contents.
        assert!(
            by_path("dir/").is_some(),
            "untracked dir as one entry: {:?}",
            st.entries
        );
        assert!(by_path("dir/inner.md").is_none());
        assert_eq!(
            by_path("loose.md").unwrap().kind,
            GitStatusEntryKind::Untracked
        );
    }

    #[test]
    fn real_status_sees_a_merge_in_progress_and_its_conflicts() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let (_g, root) = temp_repo();
        let other = make_conflict(&root);
        let out = super::super::run::run_git_with(
            Some(&root),
            GitMode::Mutate,
            &["merge", "--no-edit", other],
        )
        .unwrap();
        assert!(!out.ok, "the merge conflicts");

        let st = status(&root).unwrap();
        assert_eq!(st.state, GitRepoState::Merging);
        assert_eq!(st.merge_head.as_deref().map(str::len), Some(40));
        let u: Vec<_> = st
            .entries
            .iter()
            .filter(|e| e.kind == GitStatusEntryKind::Unmerged)
            .collect();
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].path, "a.ts");
        assert_eq!((u[0].index.as_str(), u[0].worktree.as_str()), ("U", "U"));

        git_ok(&root, &["merge", "--abort"]);
        assert_eq!(status(&root).unwrap().state, GitRepoState::Clean);
    }

    #[test]
    fn real_status_of_an_unborn_repo() {
        if !have_git() {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        super::super::testutil::init_repo(dir.path());
        write(dir.path(), "x.md", "x\n");
        let st = status(dir.path()).unwrap();
        assert!(st.unborn);
        assert_eq!(st.head, "");
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0].kind, GitStatusEntryKind::Untracked);
    }
}
