//! Filesystem commands — the entire custom IPC surface of the app.
//!
//! Design rules (see ../../README.md):
//! - Rust stays thin: no business logic, no knowledge of tabs or sessions.
//!   Which file to write, when, and what to do on conflict is TS logic.
//! - Every write of user content is atomic: tempfile in the target's own
//!   directory → write → fsync → rename over the target.
//! - Errors cross IPC as `{ code, message }`. The TS mirror of the `code`
//!   union lives in `src/ipc/commands.ts` — keep both sides in sync.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Error contract. `code` is a closed union the frontend switches on;
/// `message` is for logging/status-bar display only, never for logic.
#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("path not found: {0}")]
    NotFound(PathBuf),
    #[error("destination already exists: {0}")]
    Exists(PathBuf),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("invalid data: {0}")]
    InvalidData(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl FsError {
    pub fn code(&self) -> &'static str {
        match self {
            FsError::NotFound(_) => "NOT_FOUND",
            FsError::Exists(_) => "EXISTS",
            FsError::InvalidPath(_) => "INVALID_PATH",
            FsError::InvalidData(_) => "INVALID_DATA",
            FsError::Io(_) => "IO",
        }
    }
}

impl Serialize for FsError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("FsError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

type FsResult<T> = Result<T, FsError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStat {
    pub exists: bool,
    pub mtime_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryMeta {
    pub path: String,
    pub is_dir: bool,
    pub mtime_ms: u64,
    pub size: u64,
}

/// Extensions the explorer shows besides `.md`. Kept in sync with the TS
/// mirror in `src/core/images.ts` (both sides filter; Rust is the gatekeeper).
const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

fn has_extension(path: &Path, wanted: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(wanted))
}

fn is_image_path(path: &Path) -> bool {
    IMAGE_EXTENSIONS.iter().any(|ext| has_extension(path, ext))
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn not_found_or_io(e: std::io::Error, path: &Path) -> FsError {
    if e.kind() == std::io::ErrorKind::NotFound {
        FsError::NotFound(path.to_path_buf())
    } else {
        FsError::Io(e)
    }
}

/// Read a UTF-8 text file plus its mtime in one IPC round trip.
/// The mtime is the baseline for external-change conflict detection (M3).
#[tauri::command]
pub fn read_text_file(path: PathBuf) -> FsResult<FileText> {
    let meta = fs::metadata(&path).map_err(|e| not_found_or_io(e, &path))?;
    let text = fs::read_to_string(&path).map_err(|e| not_found_or_io(e, &path))?;
    Ok(FileText {
        text,
        mtime_ms: mtime_ms(&meta),
    })
}

/// Atomically replace `path` with `text` (creating parent dirs if needed).
///
/// The temp file MUST live in the same directory as the target: rename is
/// only atomic within one filesystem. `NamedTempFile::persist` uses
/// rename(2) on Unix and MoveFileExW(MOVEFILE_REPLACE_EXISTING) on Windows —
/// plain `std::fs::rename` would fail on Windows when the target exists,
/// which is the classic cross-platform trap this function exists to bury.
/// `sync_all` before the rename ensures a crash can't leave a renamed-but-
/// empty file.
#[tauri::command]
pub fn atomic_write_text(path: PathBuf, text: String) -> FsResult<()> {
    atomic_write_bytes(&path, text.as_bytes())
}

/// Shared atomic-write core for text and binary payloads.
fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> FsResult<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            FsError::InvalidPath(format!("{} has no parent directory", path.display()))
        })?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| FsError::Io(e.error))?;
    Ok(())
}

/// Atomically write base64-decoded bytes (pasted clipboard images). Same
/// guarantees as `atomic_write_text`; bad base64 is INVALID_DATA.
#[tauri::command]
pub fn write_file_base64(path: PathBuf, data: String) -> FsResult<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| FsError::InvalidData(format!("bad base64: {e}")))?;
    atomic_write_bytes(&path, &bytes)
}

/// Create a directory (explorer "New folder"). Refuses to clobber (EXISTS) —
/// collision suffixes are frontend logic, mirroring `rename_path`'s contract.
#[tauri::command]
pub fn create_dir(path: PathBuf) -> FsResult<()> {
    if path.exists() {
        return Err(FsError::Exists(path));
    }
    fs::create_dir_all(&path)?;
    Ok(())
}

/// Copy a file. Refuses to clobber (EXISTS) — collision suffixes are frontend
/// logic, mirroring `rename_path`'s contract.
#[tauri::command]
pub fn copy_path(from: PathBuf, to: PathBuf) -> FsResult<()> {
    if !from.exists() {
        return Err(FsError::NotFound(from));
    }
    if to.exists() {
        return Err(FsError::Exists(to));
    }
    if let Some(dir) = to.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    fs::copy(&from, &to)?;
    Ok(())
}

/// List `.md` files directly inside `dir` (no recursion), newest first.
/// A missing dir is an empty list, not an error — first launch has no notes.
#[tauri::command]
pub fn list_notes(dir: PathBuf) -> FsResult<Vec<NoteMeta>> {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut notes = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let is_md = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
        if !is_md {
            continue;
        }
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        notes.push(NoteMeta {
            path: path.to_string_lossy().into_owned(),
            mtime_ms: mtime_ms(&meta),
            size: meta.len(),
        });
    }
    notes.sort_by_key(|note| std::cmp::Reverse(note.mtime_ms));
    Ok(notes)
}

/// List one directory level for the file explorer: subdirectories plus `.md`
/// and image files (no recursion — the frontend expands folders lazily).
/// Hidden (dot-prefixed) entries are skipped. Order: directories A→Z, then
/// files newest first (matching `list_notes`). Missing dir = empty list.
#[tauri::command]
pub fn list_dir(dir: PathBuf) -> FsResult<Vec<DirEntryMeta>> {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let meta = entry.metadata()?;
        let item = DirEntryMeta {
            path: path.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            mtime_ms: mtime_ms(&meta),
            size: meta.len(),
        };
        if meta.is_dir() {
            dirs.push(item);
        } else if meta.is_file() && (has_extension(&path, "md") || is_image_path(&path)) {
            files.push(item);
        }
    }
    dirs.sort_by_key(|d| d.path.to_lowercase());
    files.sort_by_key(|f| std::cmp::Reverse(f.mtime_ms));
    dirs.extend(files);
    Ok(dirs)
}

/// Read a binary file as base64 (image tabs). The frontend builds a data URL;
/// this avoids widening the asset-protocol scope to arbitrary workspace dirs.
#[tauri::command]
pub fn read_file_base64(path: PathBuf) -> FsResult<String> {
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| not_found_or_io(e, &path))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Rename/move a file. Fails with EXISTS if the destination is taken —
/// slug collision resolution is frontend logic (src/core/session), so this
/// command must never clobber. (There is an inherent check-then-rename race;
/// acceptable for a notes dir owned by this app.)
#[tauri::command]
pub fn rename_path(from: PathBuf, to: PathBuf) -> FsResult<()> {
    if !from.exists() {
        return Err(FsError::NotFound(from));
    }
    if to.exists() {
        return Err(FsError::Exists(to));
    }
    fs::rename(&from, &to)?;
    Ok(())
}

/// Delete a file. Idempotent: deleting a missing file succeeds, because the
/// session flusher may retry a plan whose delete already happened.
#[tauri::command]
pub fn delete_path(path: PathBuf) -> FsResult<()> {
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Existence + mtime without reading content (conflict checks on focus).
#[tauri::command]
pub fn stat_path(path: PathBuf) -> FsResult<PathStat> {
    match fs::metadata(&path) {
        Ok(meta) => Ok(PathStat {
            exists: true,
            mtime_ms: Some(mtime_ms(&meta)),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PathStat {
            exists: false,
            mtime_ms: None,
        }),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn atomic_write_creates_new_file() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        atomic_write_text(target.clone(), "hello".into()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        // The Windows trap: rename over an existing file must succeed.
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        atomic_write_text(target.clone(), "first".into()).unwrap();
        atomic_write_text(target.clone(), "second".into()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        atomic_write_text(target.clone(), "a".into()).unwrap();
        atomic_write_text(target.clone(), "b".into()).unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("note.md")]);
    }

    #[test]
    fn atomic_write_creates_parent_dirs() {
        let dir = tmpdir();
        let target = dir.path().join("nested").join("deep").join("note.md");
        atomic_write_text(target.clone(), "x".into()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "x");
    }

    #[test]
    fn read_text_file_returns_text_and_mtime() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        fs::write(&target, "content").unwrap();
        let out = read_text_file(target).unwrap();
        assert_eq!(out.text, "content");
        assert!(out.mtime_ms > 0);
    }

    #[test]
    fn read_text_file_missing_is_not_found() {
        let dir = tmpdir();
        let err = read_text_file(dir.path().join("nope.md")).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn list_notes_filters_non_md_and_sorts_newest_first() {
        let dir = tmpdir();
        fs::write(dir.path().join("older.md"), "1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(dir.path().join("newer.md"), "2").unwrap();
        fs::write(dir.path().join("ignored.txt"), "3").unwrap();
        fs::create_dir(dir.path().join("subdir.md")).unwrap(); // dir with .md name

        let notes = list_notes(dir.path().to_path_buf()).unwrap();
        let names: Vec<_> = notes
            .iter()
            .map(|n| Path::new(&n.path).file_name().unwrap().to_os_string())
            .collect();
        assert_eq!(
            names,
            vec![
                std::ffi::OsString::from("newer.md"),
                std::ffi::OsString::from("older.md")
            ]
        );
    }

    #[test]
    fn list_notes_missing_dir_is_empty() {
        let dir = tmpdir();
        let notes = list_notes(dir.path().join("does-not-exist")).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn write_file_base64_round_trips_bytes() {
        let dir = tmpdir();
        let target = dir.path().join("img.png");
        write_file_base64(target.clone(), "iVBORw==".into()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), vec![0x89u8, 0x50, 0x4e, 0x47]);
    }

    #[test]
    fn write_file_base64_rejects_bad_data() {
        let dir = tmpdir();
        let err =
            write_file_base64(dir.path().join("img.png"), "!!!not base64!!!".into()).unwrap_err();
        assert_eq!(err.code(), "INVALID_DATA");
    }

    #[test]
    fn create_dir_creates_and_refuses_to_clobber() {
        let dir = tmpdir();
        let target = dir.path().join("sub");
        create_dir(target.clone()).unwrap();
        assert!(target.is_dir());
        let err = create_dir(target).unwrap_err();
        assert_eq!(err.code(), "EXISTS");
    }

    #[test]
    fn copy_path_copies_and_keeps_source() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("sub").join("b.md");
        fs::write(&a, "hello").unwrap();
        copy_path(a.clone(), b.clone()).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "hello");
        assert_eq!(fs::read_to_string(&b).unwrap(), "hello");
    }

    #[test]
    fn copy_path_refuses_to_clobber() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let err = copy_path(a, b.clone()).unwrap_err();
        assert_eq!(err.code(), "EXISTS");
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
    }

    #[test]
    fn list_dir_returns_dirs_then_md_and_images_only() {
        let dir = tmpdir();
        fs::create_dir(dir.path().join("zeta")).unwrap();
        fs::create_dir(dir.path().join("Alpha")).unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join("note.md"), "1").unwrap();
        fs::write(dir.path().join("photo.PNG"), "2").unwrap();
        fs::write(dir.path().join("ignored.txt"), "3").unwrap();
        fs::write(dir.path().join(".dotfile.md"), "4").unwrap();

        let entries = list_dir(dir.path().to_path_buf()).unwrap();
        let names: Vec<_> = entries
            .iter()
            .map(|e| {
                Path::new(&e.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(entries[0].is_dir);
        assert!(entries[1].is_dir);
        assert_eq!(&names[..2], &["Alpha", "zeta"]);
        let mut file_names = names[2..].to_vec();
        file_names.sort();
        assert_eq!(file_names, vec!["note.md", "photo.PNG"]);
    }

    #[test]
    fn list_dir_missing_dir_is_empty() {
        let dir = tmpdir();
        assert!(list_dir(dir.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn read_file_base64_round_trips() {
        let dir = tmpdir();
        let target = dir.path().join("img.png");
        fs::write(&target, [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
        assert_eq!(read_file_base64(target).unwrap(), "iVBORw==");
    }

    #[test]
    fn read_file_base64_missing_is_not_found() {
        let dir = tmpdir();
        let err = read_file_base64(dir.path().join("nope.png")).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn rename_refuses_to_clobber() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let err = rename_path(a.clone(), b.clone()).unwrap_err();
        assert_eq!(err.code(), "EXISTS");
        // Neither file was touched.
        assert_eq!(fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
    }

    #[test]
    fn rename_moves_file() {
        let dir = tmpdir();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "a").unwrap();
        rename_path(a.clone(), b.clone()).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read_to_string(&b).unwrap(), "a");
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        fs::write(&target, "x").unwrap();
        delete_path(target.clone()).unwrap();
        assert!(!target.exists());
        delete_path(target).unwrap(); // second delete: still Ok
    }

    #[test]
    fn stat_path_reports_existence() {
        let dir = tmpdir();
        let target = dir.path().join("note.md");
        assert!(!stat_path(target.clone()).unwrap().exists);
        fs::write(&target, "x").unwrap();
        let stat = stat_path(target).unwrap();
        assert!(stat.exists);
        assert!(stat.mtime_ms.unwrap() > 0);
    }

    #[test]
    fn error_serializes_as_code_and_message() {
        let err = FsError::NotFound(PathBuf::from("x.md"));
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "NOT_FOUND");
        assert!(json["message"].as_str().unwrap().contains("x.md"));
    }
}
