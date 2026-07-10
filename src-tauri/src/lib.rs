mod commands;

use std::sync::Mutex;
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

pub fn run() {
    let startup_files = file_args(&std::env::args().collect::<Vec<_>>());

    tauri::Builder::default()
        // single-instance must be the FIRST plugin registered (its docs) so it
        // can bail out before any other plugin does work in a doomed instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            let files = file_args(&args);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(StartupFiles(Mutex::new(startup_files)))
        .invoke_handler(tauri::generate_handler![
            drain_startup_files,
            commands::fs::read_text_file,
            commands::fs::atomic_write_text,
            commands::fs::list_notes,
            commands::fs::rename_path,
            commands::fs::delete_path,
            commands::fs::stat_path,
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
