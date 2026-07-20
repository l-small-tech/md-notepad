//! Android-only commands — delegates to the local `androidfs` mobile plugin
//! (Kotlin holds the Context/ContentResolver/SpeechRecognizer that pure-Rust
//! JNI can't reach in Tauri). This whole module is compiled only for Android:
//! the `#[cfg(target_os = "android")]` gate lives on the `pub mod android;`
//! declaration in `mod.rs`, so items here need no per-item cfg attributes.
//!
//! Shared error/result contracts (`FsError`, `FsResult`) live in `fs.rs`.

use super::fs::{FsError, FsResult};
use std::path::PathBuf;

/// The app-specific EXTERNAL files dir on Android
/// (`/storage/emulated/0/Android/data/<pkg>/files`) — a real POSIX path our
/// `std::fs` commands can use, visible in file managers, needing no runtime
/// permission. Tauri's `appDataDir()` only exposes the INTERNAL files dir, and
/// pure-Rust JNI can't reach the Context in Tauri, so we delegate to the local
/// `androidfs` mobile plugin (Kotlin has the Context). Returns `None` when
/// external storage is unavailable (e.g. removable volume unmounted); callers
/// fall back to internal.
///
/// Errors are plain strings (not `FsError`): the sole caller `resolvePaths`
/// treats any failure as "no external dir" and falls back, so a rich code is moot.
#[tauri::command]
pub async fn external_files_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .external_files_dir()
        .map_err(|e| e.to_string())
}

/// Extract the bundled `docs` asset folder to a real filesystem path and return
/// it. On Android the guide ships as compressed APK assets (`resolveResource`
/// would yield an `asset://` URI), but the explorer's list/read commands all use
/// `std::fs`, so Settings "Open docs" needs a POSIX copy. Delegates to the
/// `androidfs` plugin (Kotlin holds the AssetManager). Errors are plain strings
/// (not `FsError`): the sole caller `resolveDocsDir` treats any failure as "docs
/// unavailable" and shows a notice, so a rich code is moot.
#[tauri::command]
pub async fn extract_docs_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .extract_docs_dir()
        .map_err(|e| e.to_string())
}

/// Read a `content://` URI's bytes (base64) + display name — for copy-into-app
/// open of an external file chosen via the Android picker (Stage 2) or delivered
/// by an incoming intent (Stage 3). Delegates to the `androidfs` plugin.
#[tauri::command]
pub async fn read_content_uri(
    app: tauri::AppHandle,
    uri: String,
) -> Result<tauri_plugin_androidfs::ContentPayload, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .read_content_uri(uri)
        .map_err(|e| e.to_string())
}

/// Drain content:// URIs from incoming "Open with"/"Share" intents (Stage 3).
/// The frontend calls this at boot and on window focus, then copies each in.
#[tauri::command]
pub async fn take_incoming_uris(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .take_incoming_uris()
        .map_err(|e| e.to_string())
}

/* ---- Storage Access Framework (synced-folder workspaces) --------------- */
//
// These delegate to the androidfs plugin's SAF ops (Kotlin holds the
// ContentResolver). The Kotlin side rejects with a code-prefixed message
// ("NOT_FOUND: …", "EXISTS: …", "IO: …"); `map_saf_err` turns that back into
// the app's `{ code, message }` contract so TS `IpcError` semantics hold, the
// same way the std::fs commands in `fs.rs` do.

/// Map an androidfs plugin error (a flat string) onto an `FsError` code by
/// inspecting the Kotlin reject prefix. Anything unrecognized is IO.
fn map_saf_err(e: tauri_plugin_androidfs::Error) -> FsError {
    let msg = e.to_string();
    if msg.contains("NOT_FOUND") {
        FsError::NotFound(PathBuf::from(msg))
    } else if msg.contains("EXISTS") {
        FsError::Exists(PathBuf::from(msg))
    } else {
        FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, msg))
    }
}

/// Launch the SAF folder picker and return the picked tree URI + display name.
#[tauri::command]
pub async fn pick_synced_tree(
    app: tauri::AppHandle,
) -> FsResult<tauri_plugin_androidfs::PickTreeResponse> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs().pick_synced_tree().map_err(map_saf_err)
}

/// List one directory level of a synced tree.
#[tauri::command]
pub async fn saf_list(
    app: tauri::AppHandle,
    tree_uri: String,
    rel_path: String,
) -> FsResult<tauri_plugin_androidfs::SafList> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_list(tree_uri, rel_path)
        .map_err(map_saf_err)
}

/// Force a synced directory to re-fetch from its backend (picks up remote
/// changes the provider was serving from cache — see the plugin's safRefresh).
#[tauri::command]
pub async fn saf_refresh(
    app: tauri::AppHandle,
    tree_uri: String,
    rel_path: String,
) -> FsResult<()> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_refresh(tree_uri, rel_path)
        .map_err(map_saf_err)
}

/// Read a synced document's bytes as base64.
#[tauri::command]
pub async fn saf_read(
    app: tauri::AppHandle,
    tree_uri: String,
    rel_path: String,
) -> FsResult<tauri_plugin_androidfs::SafRead> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_read(tree_uri, rel_path)
        .map_err(map_saf_err)
}

/// Create-or-truncate write of base64 bytes into a synced tree.
#[tauri::command]
pub async fn saf_write(
    app: tauri::AppHandle,
    tree_uri: String,
    rel_path: String,
    base64: String,
) -> FsResult<()> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_write(tree_uri, rel_path, base64)
        .map_err(map_saf_err)
}

/// Create a directory in a synced tree.
#[tauri::command]
pub async fn saf_create_dir(
    app: tauri::AppHandle,
    tree_uri: String,
    rel_path: String,
) -> FsResult<()> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_create_dir(tree_uri, rel_path)
        .map_err(map_saf_err)
}

/// Same-parent display rename of a synced document.
#[tauri::command]
pub async fn saf_rename(
    app: tauri::AppHandle,
    tree_uri: String,
    rel_path: String,
    new_name: String,
) -> FsResult<()> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_rename(tree_uri, rel_path, new_name)
        .map_err(map_saf_err)
}

/// Delete a synced document (idempotent).
#[tauri::command]
pub async fn saf_delete(app: tauri::AppHandle, tree_uri: String, rel_path: String) -> FsResult<()> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_delete(tree_uri, rel_path)
        .map_err(map_saf_err)
}

/// Existence + type/size/mtime of a synced document.
#[tauri::command]
pub async fn saf_stat(
    app: tauri::AppHandle,
    tree_uri: String,
    rel_path: String,
) -> FsResult<tauri_plugin_androidfs::SafStat> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .saf_stat(tree_uri, rel_path)
        .map_err(map_saf_err)
}

/// Release a persisted folder permission (workspace removal).
#[tauri::command]
pub async fn release_synced_tree(app: tauri::AppHandle, tree_uri: String) -> FsResult<()> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .release_synced_tree(tree_uri)
        .map_err(map_saf_err)
}

/* ---- On-device speech-to-text (voice comments) ------------------------- */
//
// Delegates to the androidfs plugin (Kotlin drives SpeechRecognizer). Errors are
// plain strings: the frontend treats any failure as "STT unavailable" and the
// capture UI aborts with a notice, so a rich FsError code is moot here.

/// Whether on-device speech recognition is available on this device.
#[tauri::command]
pub async fn stt_available(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs().stt_available().map_err(|e| e.to_string())
}

/// Current RECORD_AUDIO grant, without prompting.
#[tauri::command]
pub async fn stt_permission(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs().stt_permission().map_err(|e| e.to_string())
}

/// Prompt for RECORD_AUDIO if needed; resolves the resulting grant.
#[tauri::command]
pub async fn stt_request_permission(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .stt_request_permission()
        .map_err(|e| e.to_string())
}

/// Start listening; resolves the final transcript text.
#[tauri::command]
pub async fn stt_start(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs()
        .stt_start()
        .map(|r| r.text)
        .map_err(|e| e.to_string())
}

/// Stop listening (the final transcript still resolves the pending start).
#[tauri::command]
pub async fn stt_stop(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_androidfs::AndroidfsExt;
    app.androidfs().stt_stop().map_err(|e| e.to_string())
}
