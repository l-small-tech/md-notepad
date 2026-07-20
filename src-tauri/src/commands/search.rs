//! Workspace search — the fast path for LOCAL roots.
//!
//! `search_notes` walks a directory tree and returns every case-insensitive
//! substring hit, capped. It deliberately stays as thin as the fs commands
//! (no business logic beyond "which files are searchable"): which roots to
//! search, how to merge/cap across roots, and what to do with a hit are all
//! TypeScript concerns (src/ui/stores/search.ts). Android `saf://` synced
//! roots never reach this command — a Rust fs walk cannot see SAF trees, so
//! the frontend walks those itself (src/ui/search-saf.ts).
//!
//! Matching semantics mirror `findMatchesInText` in src/core/search.ts —
//! non-overlapping occurrences, 1-based line/col, ~200-char clipping window
//! centered on the hit — keep the two in sync.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use super::fs::{is_text_path, FsResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub line_text: String,
}

/// Files larger than this are skipped — a notes search has no business
/// scanning multi-megabyte files, and reading them would stall the walk.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Recursion guard: deeper than this is a pathological tree (or a cycle via
/// junctions); stop descending rather than walking forever.
const MAX_DEPTH: usize = 16;

/// Characters of a line shown around a hit (excluding the `…` markers).
const CLIP_WIDTH: usize = 200;

/// Voice-comment sidecar files (`<name>.comments.md`) are managed alongside
/// their note and hidden from the explorer (src/core/comments.ts); hide them
/// from search results the same way.
fn is_comments_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_lowercase().ends_with(".comments.md"))
}

/// Clip `line` (chars, not bytes — slicing UTF-8 by byte index can panic) to
/// at most `CLIP_WIDTH` characters centered on the hit at char index `hit`,
/// after dropping leading whitespace (unless the hit sits inside it). A cut at
/// either end is marked with `…`; the whitespace trim gets no marker.
fn clip_around_hit(line: &str, hit: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    let trim_start = chars
        .iter()
        .position(|c| !c.is_whitespace())
        .unwrap_or(chars.len())
        .min(hit);
    let body = &chars[trim_start..];
    let hit = hit - trim_start;
    if body.len() <= CLIP_WIDTH {
        return body.iter().collect();
    }
    let mut start = hit.saturating_sub(CLIP_WIDTH / 2);
    let end = (start + CLIP_WIDTH).min(body.len());
    start = end.saturating_sub(CLIP_WIDTH);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&body[start..end]);
    if end < body.len() {
        out.push('…');
    }
    out
}

/// Append every non-overlapping occurrence of `query_lower` in `text` to
/// `hits`, stopping at `max_results` total. Lines and columns are 1-based;
/// columns count characters of the lowercased line.
fn match_text(
    path: &Path,
    text: &str,
    query_lower: &str,
    max_results: usize,
    hits: &mut Vec<SearchHit>,
) {
    for (line_idx, raw_line) in text.split('\n').enumerate() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let lower = line.to_lowercase();
        let mut from = 0;
        while let Some(rel) = lower[from..].find(query_lower) {
            let byte_idx = from + rel;
            let char_idx = lower[..byte_idx].chars().count();
            hits.push(SearchHit {
                path: path.to_string_lossy().into_owned(),
                line: (line_idx + 1) as u32,
                col: (char_idx + 1) as u32,
                line_text: clip_around_hit(line, char_idx),
            });
            if hits.len() >= max_results {
                return;
            }
            from = byte_idx + query_lower.len();
        }
    }
}

/// Depth-first walk in deterministic order (each dir's entries sorted by file
/// name). Skips dot-prefixed entries, comment sidecars, non-text files, and
/// oversized files; unreadable entries are skipped silently (search is
/// best-effort, and a permission error on one file must not kill the walk).
fn walk(
    dir: &Path,
    query_lower: &str,
    max_results: usize,
    depth: usize,
    hits: &mut Vec<SearchHit>,
) {
    if depth > MAX_DEPTH || hits.len() >= max_results {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if hits.len() >= max_results {
            return;
        }
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            walk(&path, query_lower, max_results, depth + 1, hits);
            continue;
        }
        if !file_type.is_file() || !is_text_path(&path) || is_comments_sidecar(&path) {
            continue;
        }
        // Best-effort metadata (may block on cloud placeholders — see
        // `list_dir`); a file whose stat fails is still searched.
        if matches!(entry.metadata(), Ok(m) if m.len() > MAX_FILE_BYTES) {
            continue;
        }
        // Non-UTF-8 (or otherwise unreadable) files are skipped, not errors.
        if let Ok(text) = fs::read_to_string(&path) {
            match_text(&path, &text, query_lower, max_results, hits);
        }
    }
}

/// Search every text note under `dir` (recursively) for a case-insensitive
/// substring, returning at most `max_results` hits in deterministic walk
/// order. A missing dir — like the listing commands — and an empty query both
/// yield an empty result, not an error.
#[tauri::command]
pub async fn search_notes(
    dir: PathBuf,
    query: String,
    max_results: usize,
) -> FsResult<Vec<SearchHit>> {
    let query_lower = query.to_lowercase();
    if query_lower.is_empty() || max_results == 0 {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    walk(&dir, &query_lower, max_results, 0, &mut hits);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    fn block_on<T>(fut: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(fut)
    }

    fn search(dir: &Path, query: &str, cap: usize) -> Vec<SearchHit> {
        block_on(search_notes(dir.to_path_buf(), query.to_string(), cap)).unwrap()
    }

    fn names(hits: &[SearchHit]) -> Vec<String> {
        hits.iter()
            .map(|h| {
                Path::new(&h.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn finds_hits_across_nested_dirs_in_sorted_order() {
        let dir = tmpdir();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("b.md"), "needle here").unwrap();
        fs::write(dir.path().join("a.md"), "no match").unwrap();
        fs::write(dir.path().join("sub").join("deep.md"), "a needle too").unwrap();

        let hits = search(dir.path(), "NEEDLE", 100);
        assert_eq!(names(&hits), vec!["b.md", "deep.md"]);
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[0].col, 1);
        assert_eq!(hits[1].col, 3);
        assert_eq!(hits[1].line_text, "a needle too");
    }

    #[test]
    fn one_hit_per_occurrence_with_1_based_cols() {
        let dir = tmpdir();
        fs::write(dir.path().join("n.md"), "ab xx ab\nab").unwrap();
        let hits = search(dir.path(), "ab", 100);
        let cols: Vec<(u32, u32)> = hits.iter().map(|h| (h.line, h.col)).collect();
        assert_eq!(cols, vec![(1, 1), (1, 7), (2, 1)]);
    }

    #[test]
    fn respects_the_result_cap() {
        let dir = tmpdir();
        fs::write(dir.path().join("n.md"), "x x x x x x").unwrap();
        let hits = search(dir.path(), "x", 4);
        assert_eq!(hits.len(), 4);
    }

    #[test]
    fn skips_dot_dirs_and_dot_files() {
        let dir = tmpdir();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git").join("hidden.md"), "needle").unwrap();
        fs::write(dir.path().join(".dotfile.md"), "needle").unwrap();
        fs::write(dir.path().join("real.md"), "needle").unwrap();
        assert_eq!(names(&search(dir.path(), "needle", 100)), vec!["real.md"]);
    }

    #[test]
    fn skips_comment_sidecars() {
        let dir = tmpdir();
        fs::write(dir.path().join("note.md"), "needle").unwrap();
        fs::write(dir.path().join("note.comments.md"), "needle").unwrap();
        assert_eq!(names(&search(dir.path(), "needle", 100)), vec!["note.md"]);
    }

    #[test]
    fn skips_non_text_files() {
        let dir = tmpdir();
        fs::write(dir.path().join("img.png"), "needle").unwrap();
        fs::write(dir.path().join("doc.pdf"), "needle").unwrap();
        fs::write(dir.path().join("note.txt"), "needle").unwrap();
        assert_eq!(names(&search(dir.path(), "needle", 100)), vec!["note.txt"]);
    }

    #[test]
    fn skips_oversized_files() {
        let dir = tmpdir();
        let big = "needle ".repeat(400_000); // ~2.8 MB
        fs::write(dir.path().join("big.md"), big).unwrap();
        fs::write(dir.path().join("small.md"), "needle").unwrap();
        assert_eq!(names(&search(dir.path(), "needle", 100)), vec!["small.md"]);
    }

    #[test]
    fn crlf_lines_and_case_insensitivity() {
        let dir = tmpdir();
        fs::write(dir.path().join("n.md"), "One\r\nTWO needle\r\n").unwrap();
        let hits = search(dir.path(), "Needle", 100);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].col, 5);
        assert_eq!(hits[0].line_text, "TWO needle");
    }

    #[test]
    fn clips_long_lines_around_the_hit() {
        let dir = tmpdir();
        let line = format!("{}NEEDLE{}", "x".repeat(300), "y".repeat(300));
        fs::write(dir.path().join("n.md"), line).unwrap();
        let hits = search(dir.path(), "needle", 100);
        let text = &hits[0].line_text;
        assert!(text.starts_with('…'));
        assert!(text.ends_with('…'));
        assert!(text.contains("NEEDLE"));
        assert!(text.chars().count() <= CLIP_WIDTH + 2);
    }

    #[test]
    fn trims_leading_whitespace_and_keeps_col_from_line_start() {
        let dir = tmpdir();
        fs::write(dir.path().join("n.md"), "    indented needle").unwrap();
        let hits = search(dir.path(), "needle", 100);
        assert_eq!(hits[0].line_text, "indented needle");
        assert_eq!(hits[0].col, 14);
    }

    #[test]
    fn missing_dir_and_empty_query_are_empty_results() {
        let dir = tmpdir();
        assert!(search(&dir.path().join("nope"), "x", 100).is_empty());
        fs::write(dir.path().join("n.md"), "x").unwrap();
        assert!(search(dir.path(), "", 100).is_empty());
    }

    #[test]
    fn multibyte_lines_clip_without_panicking() {
        let dir = tmpdir();
        let line = format!("{}Straße{}", "ä".repeat(300), "ö".repeat(300));
        fs::write(dir.path().join("n.md"), line).unwrap();
        let hits = search(dir.path(), "STRASSE", 100);
        // ß uppercases to SS but "STRASSE".to_lowercase() is "strasse", which
        // does NOT match "straße" bytewise — assert the defined (substring)
        // semantics: no hit for the expanded form, a hit for the literal one.
        assert!(hits.is_empty());
        let hits = search(dir.path(), "Straße", 100);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].line_text.contains("Straße"));
    }
}
