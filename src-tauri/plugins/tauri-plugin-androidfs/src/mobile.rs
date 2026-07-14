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
}
