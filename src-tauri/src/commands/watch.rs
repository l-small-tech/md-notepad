//! Workspace file-watching (desktop only) — powers the explorer's
//! auto-refresh. OS-native events (ReadDirectoryChangesW / inotify /
//! FSEvents via `notify`), no polling.
//!
//! Rule I5: Rust only reports "something changed under a watched root" as a
//! debounced `fs-changed` event; deciding what to re-list is TypeScript's
//! job (the listener in src/main.tsx bumps the explorer's refresh counter).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager};

use super::fs::{FsError, FsResult};

/// The one live debouncer+watcher, replaced wholesale on every `watch_dirs`.
#[derive(Default)]
pub struct WatchState(pub Mutex<Option<Debouncer<RecommendedWatcher>>>);

/// Map debounced event paths to the watched roots they fall under. Events
/// touching only dot-files/dirs (`.git`, editor lockfiles, …) are ignored —
/// the explorer skips dot entries anyway, so re-listing for them is churn.
fn changed_roots(paths: &[PathBuf], roots: &[PathBuf]) -> Vec<String> {
    roots
        .iter()
        .filter(|root| {
            paths.iter().any(|p| {
                p.strip_prefix(root).is_ok_and(|rel| {
                    !rel.components()
                        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
                })
            })
        })
        .map(|r| r.to_string_lossy().into_owned())
        .collect()
}

/// Replace the watched set of workspace roots (recursive). Non-existent dirs
/// are skipped silently — a workspace folder may be on a disconnected drive.
/// Emits `fs-changed` (payload: affected root paths) app-wide, debounced.
#[tauri::command]
pub async fn watch_dirs(app: AppHandle, dirs: Vec<String>) -> FsResult<()> {
    let roots: Vec<PathBuf> = dirs
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect();

    let emit_app = app.clone();
    let event_roots = roots.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(800),
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
                let changed = changed_roots(&paths, &event_roots);
                if !changed.is_empty() {
                    let _ = emit_app.emit("fs-changed", changed);
                }
            }
        },
    )
    .map_err(|e| FsError::Io(std::io::Error::other(e)))?;

    for root in &roots {
        debouncer
            .watcher()
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| FsError::Io(std::io::Error::other(e)))?;
    }

    // Swap in the new watcher; dropping the old one releases its OS handles.
    *app.state::<WatchState>().0.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::changed_roots;
    use std::path::PathBuf;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn maps_paths_to_their_root() {
        let roots = [p("/ws/a"), p("/ws/b")];
        let paths = [p("/ws/a/note.md")];
        assert_eq!(changed_roots(&paths, &roots), vec!["/ws/a".to_string()]);
    }

    #[test]
    fn dedupes_and_skips_unrelated_roots() {
        let roots = [p("/ws/a"), p("/ws/b")];
        let paths = [p("/ws/a/x.md"), p("/ws/a/sub/y.md"), p("/elsewhere/z.md")];
        assert_eq!(changed_roots(&paths, &roots), vec!["/ws/a".to_string()]);
    }

    #[test]
    fn ignores_dot_components() {
        let roots = [p("/ws/a")];
        let paths = [p("/ws/a/.git/index"), p("/ws/a/sub/.lock")];
        assert!(changed_roots(&paths, &roots).is_empty());
    }

    #[test]
    fn dot_in_root_itself_is_fine() {
        // Only components BELOW the root are dot-filtered.
        let roots = [p("/home/.config/notes")];
        let paths = [p("/home/.config/notes/a.md")];
        assert_eq!(
            changed_roots(&paths, &roots),
            vec!["/home/.config/notes".to_string()]
        );
    }
}
