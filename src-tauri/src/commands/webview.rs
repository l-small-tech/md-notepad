//! Webview engine tuning that has no Tauri-level switch.

/// Toggle the engine's own smooth wheel scrolling for the calling window.
///
/// Only Linux does anything: WebKitGTK animates wheel scrolls on its
/// compositor thread when `enable-smooth-scrolling` is set, which is what the
/// "Smooth scrolling" setting means for DOM surfaces now that the frontend no
/// longer animates `scrollTop` itself (see src/ui/README.md — Smooth
/// scrolling). WebView2 (Chromium) already smooth-scrolls wheel input and
/// exposes no runtime toggle; macOS wheels step and trackpads carry the OS's
/// momentum — the command is a no-op on both.
///
/// No unit test: the body is a single engine-settings write that needs a live
/// webview, so it is covered by the QA checklist instead.
#[tauri::command]
pub fn set_smooth_scrolling(window: tauri::WebviewWindow, enabled: bool) {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{SettingsExt, WebViewExt};
        // Best-effort: a window mid-teardown may no longer dispatch.
        let _ = window.with_webview(move |webview| {
            if let Some(settings) = webview.inner().settings() {
                settings.set_enable_smooth_scrolling(enabled);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, enabled);
    }
}
