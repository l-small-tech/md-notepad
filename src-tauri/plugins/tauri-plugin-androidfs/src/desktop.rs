use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

/// Desktop stub. The app only depends on this crate for the Android target, so
/// this is never compiled in practice — it exists to keep the crate valid off
/// mobile and mirror the standard Tauri plugin layout.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Androidfs<R>> {
    Ok(Androidfs(app.clone()))
}

pub struct Androidfs<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Androidfs<R> {
    pub fn external_files_dir(&self) -> crate::Result<Option<String>> {
        Ok(None)
    }
}
