use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

/// Registers the Kotlin `AndroidfsPlugin` class (package `com.plugin.androidfs`)
/// so `run_mobile_plugin` can reach its `@Command` methods.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Androidfs<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.plugin.androidfs", "AndroidfsPlugin")?;
    Ok(Androidfs(handle))
}

/// Handle to the running Android plugin.
pub struct Androidfs<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct EmptyArgs {}

#[derive(Deserialize)]
struct ExternalDirResponse {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Serialize)]
struct ReadUriArgs {
    uri: String,
}

/// Bytes (base64) of an external file plus its display name, for copy-into-app.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPayload {
    pub base64: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
struct UrisResponse {
    #[serde(default)]
    uris: Vec<String>,
}

/* ---- Storage Access Framework (synced-folder workspaces) --------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafPathArgs {
    tree_uri: String,
    rel_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafWriteArgs {
    tree_uri: String,
    rel_path: String,
    base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafRenameArgs {
    tree_uri: String,
    rel_path: String,
    new_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeArgs {
    tree_uri: String,
}

/// The tree URI + display name of a folder the user picked via SAF.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickTreeResponse {
    pub tree_uri: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// One entry in a synced-folder listing.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafEntry {
    pub name: String,
    pub is_dir: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mtime_ms: i64,
}

#[derive(Serialize, Deserialize)]
pub struct SafList {
    #[serde(default)]
    pub entries: Vec<SafEntry>,
}

#[derive(Serialize, Deserialize)]
pub struct SafRead {
    pub base64: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafStat {
    pub exists: bool,
    #[serde(default)]
    pub is_dir: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mtime_ms: i64,
}

/// `{}` — the plugin resolves an empty object for the mutating ops.
#[derive(Deserialize)]
struct SafUnit {}

/* ---- On-device speech-to-text (voice comments) ------------------------- */

/// The final transcript from a dictation session.
#[derive(Serialize, Deserialize)]
pub struct SttResult {
    pub text: String,
}

#[derive(Deserialize)]
struct SttAvailable {
    available: bool,
}

#[derive(Deserialize)]
struct SttPermission {
    granted: bool,
}

impl<R: Runtime> Androidfs<R> {
    /// The app-specific EXTERNAL files dir
    /// (`/storage/emulated/0/Android/data/<pkg>/files`), or `None` when external
    /// storage is unavailable (removable volume unmounted).
    pub fn external_files_dir(&self) -> crate::Result<Option<String>> {
        self.0
            .run_mobile_plugin::<ExternalDirResponse>("getExternalFilesDir", EmptyArgs {})
            .map(|r| r.path)
            .map_err(Into::into)
    }

    /// Extract the bundled `docs` asset folder to a real filesystem path
    /// (`filesDir/docs`) and return it. The APK ships docs as compressed assets
    /// that our `std::fs` commands can't read, so this copies them out on each
    /// call (overwriting, so an app update refreshes the guide). `None` only if
    /// the plugin reports no path.
    pub fn extract_docs_dir(&self) -> crate::Result<Option<String>> {
        self.0
            .run_mobile_plugin::<ExternalDirResponse>("extractDocs", EmptyArgs {})
            .map(|r| r.path)
            .map_err(Into::into)
    }

    /// Read a `content://`/`file://` URI's bytes once (base64) plus its display
    /// name — the source for copy-into-app open of external files.
    pub fn read_content_uri(&self, uri: String) -> crate::Result<ContentPayload> {
        self.0
            .run_mobile_plugin::<ContentPayload>("readContentUri", ReadUriArgs { uri })
            .map_err(Into::into)
    }

    /// Drain URIs delivered by incoming "Open with"/"Share" intents since the
    /// last call (cold-start intent at boot; warm-start intents on focus).
    pub fn take_incoming_uris(&self) -> crate::Result<Vec<String>> {
        self.0
            .run_mobile_plugin::<UrisResponse>("takeIncomingUris", EmptyArgs {})
            .map(|r| r.uris)
            .map_err(Into::into)
    }

    /// Launch the SAF folder picker; resolves the picked tree URI + display name
    /// (after taking a persistable read/write grant), or errors on cancel.
    pub fn pick_synced_tree(&self) -> crate::Result<PickTreeResponse> {
        self.0
            .run_mobile_plugin::<PickTreeResponse>("pickSyncedTree", EmptyArgs {})
            .map_err(Into::into)
    }

    /// List one directory level of a synced tree.
    pub fn saf_list(&self, tree_uri: String, rel_path: String) -> crate::Result<SafList> {
        self.0
            .run_mobile_plugin::<SafList>("safList", SafPathArgs { tree_uri, rel_path })
            .map_err(Into::into)
    }

    /// Read a synced document's bytes as base64.
    pub fn saf_read(&self, tree_uri: String, rel_path: String) -> crate::Result<SafRead> {
        self.0
            .run_mobile_plugin::<SafRead>("safRead", SafPathArgs { tree_uri, rel_path })
            .map_err(Into::into)
    }

    /// Create-or-truncate write of base64 bytes (parents created as needed).
    pub fn saf_write(
        &self,
        tree_uri: String,
        rel_path: String,
        base64: String,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SafUnit>(
                "safWrite",
                SafWriteArgs {
                    tree_uri,
                    rel_path,
                    base64,
                },
            )
            .map(|_| ())
            .map_err(Into::into)
    }

    /// Create a directory in a synced tree (mkdir -p; EXISTS if the leaf is taken).
    pub fn saf_create_dir(&self, tree_uri: String, rel_path: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SafUnit>("safCreateDir", SafPathArgs { tree_uri, rel_path })
            .map(|_| ())
            .map_err(Into::into)
    }

    /// Same-parent display rename of a synced document.
    pub fn saf_rename(
        &self,
        tree_uri: String,
        rel_path: String,
        new_name: String,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SafUnit>(
                "safRename",
                SafRenameArgs {
                    tree_uri,
                    rel_path,
                    new_name,
                },
            )
            .map(|_| ())
            .map_err(Into::into)
    }

    /// Delete a synced document (idempotent).
    pub fn saf_delete(&self, tree_uri: String, rel_path: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SafUnit>("safDelete", SafPathArgs { tree_uri, rel_path })
            .map(|_| ())
            .map_err(Into::into)
    }

    /// Existence + type/size/mtime of a synced document.
    pub fn saf_stat(&self, tree_uri: String, rel_path: String) -> crate::Result<SafStat> {
        self.0
            .run_mobile_plugin::<SafStat>("safStat", SafPathArgs { tree_uri, rel_path })
            .map_err(Into::into)
    }

    /// Release a persisted folder permission (workspace removal; best-effort).
    pub fn release_synced_tree(&self, tree_uri: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SafUnit>("releaseSyncedTree", TreeArgs { tree_uri })
            .map(|_| ())
            .map_err(Into::into)
    }

    /* ---- On-device speech-to-text (voice comments) --------------------- */

    /// Whether on-device recognition is available on this device.
    pub fn stt_available(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin::<SttAvailable>("sttAvailable", EmptyArgs {})
            .map(|r| r.available)
            .map_err(Into::into)
    }

    /// Current RECORD_AUDIO grant, without prompting.
    pub fn stt_permission(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin::<SttPermission>("sttPermission", EmptyArgs {})
            .map(|r| r.granted)
            .map_err(Into::into)
    }

    /// Prompt for RECORD_AUDIO if needed; resolves the resulting grant.
    pub fn stt_request_permission(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin::<SttPermission>("sttRequestPermission", EmptyArgs {})
            .map(|r| r.granted)
            .map_err(Into::into)
    }

    /// Start listening; blocks (async on the JS side) until the recognizer
    /// reports the final transcript.
    pub fn stt_start(&self) -> crate::Result<SttResult> {
        self.0
            .run_mobile_plugin::<SttResult>("startSpeech", EmptyArgs {})
            .map_err(Into::into)
    }

    /// Stop listening; the final transcript still resolves the pending start.
    pub fn stt_stop(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SafUnit>("stopSpeech", EmptyArgs {})
            .map(|_| ())
            .map_err(Into::into)
    }
}
