mod commands;
// Desktop-only: the pty engine and login-shell resolution behind the terminal
// tabs. Android has no pty (see commands/mod.rs).
#[cfg(desktop)]
mod pty;
#[cfg(desktop)]
mod shell;

use std::sync::Mutex;

use tauri_plugin_log::log::LevelFilter;
// Only the single-instance closure below uses these traits (emit_to /
// get_webview_window), and that closure is release-desktop-only: gated out on
// mobile (no second process) and in debug builds (so a dev instance can coexist
// with an installed release instead of folding into it).
#[cfg(all(desktop, not(debug_assertions)))]
use tauri::{Emitter, Manager};

/// The shell a terminal profile spawns when it names no program. The frontend
/// shows it in Settings and passes it back on spawn.
#[cfg(desktop)]
#[tauri::command]
fn default_shell() -> String {
    shell::default_shell()
}

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

/// Max log level for `tauri_plugin_log`, from `MDN_LOG` or argv.
///
/// The plugin's own default is TRACE, and nothing in this crate logs at all —
/// so every TRACE line came from a dependency. The explorer's `notify` watcher
/// is the worst of them: one line per inotify event under every watched folder,
/// which on a dev run with this repo open buried cargo errors and vite HMR
/// messages under ~700k lines in 90 seconds. INFO costs us nothing and keeps
/// `tauri dev` readable.
///
/// `--verbose` (what `pnpm run tauri:dev:verbose` passes) opens it to DEBUG;
/// `MDN_LOG` takes an explicit off/error/warn/info/debug/trace and wins over
/// the flag. TRACE is the old firehose — reach for it deliberately.
fn log_level_from(env: Option<&str>, args: &[String]) -> LevelFilter {
    if let Some(level) = env.and_then(|v| v.trim().parse::<LevelFilter>().ok()) {
        return level;
    }
    if args.iter().any(|a| a == "--verbose" || a == "-v") {
        return LevelFilter::Debug;
    }
    LevelFilter::Info
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args = std::env::args().collect::<Vec<_>>();
    let startup_files = file_args(&args);
    let log_level = log_level_from(std::env::var("MDN_LOG").ok().as_deref(), &args);

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
                    // Tab-drag ghost windows (label "ghost-*") are transient
                    // cursor-followers: never save their throwaway geometry,
                    // never restore stale geometry onto one.
                    .with_filter(|label| !label.starts_with("ghost-"))
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
    };

    // Desktop-only: workspace file-watcher state (explorer auto-refresh) and
    // the live-pty registry behind terminal tabs.
    #[cfg(desktop)]
    let builder = builder
        .manage(commands::watch::WatchState::default())
        .manage(commands::pty::PtyRegistry::default());

    // Android-only: native Context APIs (external files dir now; content:// reads
    // and incoming intents later) that pure-Rust JNI can't reach in Tauri.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_androidfs::init());

    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log_level)
                .build(),
        )
        .manage(StartupFiles(Mutex::new(startup_files)))
        .invoke_handler(tauri::generate_handler![
            drain_startup_files,
            commands::fs::read_text_file,
            commands::fs::atomic_write_text,
            commands::fs::list_notes,
            commands::fs::list_dir,
            commands::fs::dir_has_relevant_files,
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
            #[cfg(desktop)]
            commands::webview::set_smooth_scrolling,
            #[cfg(desktop)]
            default_shell,
            #[cfg(desktop)]
            commands::pty::pty_spawn,
            #[cfg(desktop)]
            commands::pty::pty_write,
            #[cfg(desktop)]
            commands::pty::pty_resize,
            #[cfg(desktop)]
            commands::pty::pty_kill,
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
            #[cfg(target_os = "android")]
            commands::android::capture_photo,
            #[cfg(target_os = "android")]
            commands::android::ink_recognize,
            #[cfg(target_os = "android")]
            commands::android::text_recognize,
            #[cfg(target_os = "windows")]
            commands::ocr::ocr_image_available,
            #[cfg(target_os = "windows")]
            commands::ocr::ocr_image_recognize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{file_args, log_level_from, LevelFilter};

    fn argv(flags: &[&str]) -> Vec<String> {
        std::iter::once("md-notepad")
            .chain(flags.iter().copied())
            .map(str::to_string)
            .collect()
    }

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

    #[test]
    fn log_level_defaults_to_info() {
        assert_eq!(log_level_from(None, &argv(&[])), LevelFilter::Info);
        assert_eq!(log_level_from(None, &argv(&["a.md"])), LevelFilter::Info);
    }

    #[test]
    fn log_level_verbose_flag_opens_debug() {
        assert_eq!(
            log_level_from(None, &argv(&["--verbose"])),
            LevelFilter::Debug
        );
        assert_eq!(log_level_from(None, &argv(&["-v"])), LevelFilter::Debug);
    }

    #[test]
    fn log_level_env_wins_over_flag_and_ignores_junk() {
        let verbose = argv(&["--verbose"]);
        assert_eq!(log_level_from(Some("trace"), &verbose), LevelFilter::Trace);
        assert_eq!(log_level_from(Some("OFF"), &verbose), LevelFilter::Off);
        assert_eq!(
            log_level_from(Some(" warn\n"), &argv(&[])),
            LevelFilter::Warn
        );
        // Unparseable MDN_LOG falls through to the flag rather than panicking.
        assert_eq!(log_level_from(Some("loud"), &verbose), LevelFilter::Debug);
        assert_eq!(log_level_from(Some(""), &argv(&[])), LevelFilter::Info);
    }
}
