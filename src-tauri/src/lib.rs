mod commands;

use std::sync::Mutex;
// Only the single-instance closure below uses these traits (emit_to /
// get_webview_window), and that closure is release-desktop-only: gated out on
// mobile (no second process) and in debug builds (so a dev instance can coexist
// with an installed release instead of folding into it).
#[cfg(all(desktop, not(debug_assertions)))]
use tauri::{Emitter, Manager};

/// File paths passed on the command line at first launch.
///
/// These CANNOT be delivered as an event from `setup` — the webview has not
/// loaded the frontend yet at that point, so the event would fire before any
/// listener exists and be silently lost. Instead they sit in managed state
/// until the frontend boots and calls `drain_startup_files`.
///
/// Second-instance argv (user double-clicks a .md while the app runs) has no
/// such problem: the frontend is already listening, so the single-instance
/// callback below delivers those live via the `open-files` event.
pub struct StartupFiles(pub Mutex<Vec<String>>);

#[tauri::command]
fn drain_startup_files(state: tauri::State<'_, StartupFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Extract candidate file paths from an argv slice: everything after the
/// executable path that isn't a flag. Validation (does it exist, is it
/// openable) is frontend business.
fn file_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_files = file_args(&std::env::args().collect::<Vec<_>>());

    let builder = tauri::Builder::default();

    // Desktop-only plugins. On mobile there is no second process to fold in, no
    // native window geometry to persist, no self-updater (the store handles
    // updates), and no process restart/exit — and single-instance does not even
    // compile for Android/iOS. See the target-gated deps in Cargo.toml.
    #[cfg(desktop)]
    let builder = {
        // single-instance is release-only. Debug builds share the release's app
        // identifier, so the plugin's lock is shared too: launching `tauri dev`
        // while an installed release runs would fold the dev instance into the
        // release (focus it, forward args) and immediately exit the dev process —
        // no window. Skipping it in debug lets a dev build coexist with release.
        #[cfg(not(debug_assertions))]
        let builder = builder
            // single-instance must be the FIRST plugin registered (its docs) so it
            // can bail out before any other plugin does work in a doomed instance.
            .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
                // Windows close independently, so "main" may be gone while the app
                // still runs — fall back to any surviving window. Target the event
                // at that one window only (every window listens on its own label),
                // so the files open exactly once.
                let target = app
                    .get_webview_window("main")
                    .or_else(|| app.webview_windows().into_values().next());
                if let Some(window) = target {
                    let _ = window.set_focus();
                    let files = file_args(&args);
                    if !files.is_empty() {
                        let _ = app.emit_to(window.label(), "open-files", files);
                    }
                }
            }));

        builder
            // Restore only geometry. The default flags also restore DECORATIONS /
            // FULLSCREEN / VISIBLE, and a state file saved by an older (decorated)
            // build resurrects the native titlebar over the config's
            // decorations: false (the TabBar is the titlebar now).
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::SIZE
                            | tauri_plugin_window_state::StateFlags::POSITION
                            | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                    )
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
    };

    // Desktop-only: workspace file-watcher state (explorer auto-refresh).
    #[cfg(desktop)]
    let builder = builder.manage(commands::watch::WatchState::default());

    // Android-only: native Context APIs (external files dir now; content:// reads
    // and incoming intents later) that pure-Rust JNI can't reach in Tauri.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_androidfs::init());

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(StartupFiles(Mutex::new(startup_files)))
        .invoke_handler(tauri::generate_handler![
            drain_startup_files,
            commands::fs::read_text_file,
            commands::fs::atomic_write_text,
            commands::fs::list_notes,
            commands::fs::list_dir,
            commands::fs::list_session_manifests,
            commands::fs::list_theme_files,
            commands::fs::read_file_base64,
            commands::fs::write_file_base64,
            commands::fs::copy_path,
            commands::fs::create_dir,
            commands::fs::rename_path,
            commands::fs::delete_path,
            commands::fs::stat_path,
            commands::search::search_notes,
            #[cfg(desktop)]
            commands::watch::watch_dirs,
            #[cfg(target_os = "android")]
            commands::android::extract_docs_dir,
            #[cfg(target_os = "android")]
            commands::android::external_files_dir,
            #[cfg(target_os = "android")]
            commands::android::read_content_uri,
            #[cfg(target_os = "android")]
            commands::android::take_incoming_uris,
            #[cfg(target_os = "android")]
            commands::android::pick_synced_tree,
            #[cfg(target_os = "android")]
            commands::android::saf_list,
            #[cfg(target_os = "android")]
            commands::android::saf_refresh,
            #[cfg(target_os = "android")]
            commands::android::saf_read,
            #[cfg(target_os = "android")]
            commands::android::saf_write,
            #[cfg(target_os = "android")]
            commands::android::saf_create_dir,
            #[cfg(target_os = "android")]
            commands::android::saf_rename,
            #[cfg(target_os = "android")]
            commands::android::saf_delete,
            #[cfg(target_os = "android")]
            commands::android::saf_stat,
            #[cfg(target_os = "android")]
            commands::android::release_synced_tree,
            #[cfg(target_os = "android")]
            commands::android::stt_available,
            #[cfg(target_os = "android")]
            commands::android::stt_permission,
            #[cfg(target_os = "android")]
            commands::android::stt_request_permission,
            #[cfg(target_os = "android")]
            commands::android::stt_start,
            #[cfg(target_os = "android")]
            commands::android::stt_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::file_args;

    #[test]
    fn file_args_skips_exe_and_flags() {
        let args = vec![
            "C:\\apps\\md-notepad.exe".to_string(),
            "--flag".to_string(),
            "-v".to_string(),
            "C:\\notes\\a.md".to_string(),
        ];
        assert_eq!(file_args(&args), vec!["C:\\notes\\a.md".to_string()]);
    }

    #[test]
    fn file_args_empty_argv() {
        assert!(file_args(&[]).is_empty());
        assert!(file_args(&["exe".to_string()]).is_empty());
    }
}
