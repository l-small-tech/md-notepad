//! Webview engine tuning that has no Tauri-level switch, plus display-server
//! introspection the frontend can't do itself.

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

/// Which display server this process talks to: `"x11"`, `"wayland"`, or
/// `"none"` off Linux.
///
/// The frontend gates the cross-window tab-drop hit-test on this: Wayland
/// gives an app neither the global cursor position nor its windows' screen
/// positions (by protocol design), so position-based window picking there
/// would compare junk coordinates and land tabs in the wrong window. Judged
/// from the environment rather than by asking GDK — the same variables decide
/// which backend GDK picks, and `GDK_BACKEND=x11` (the common WebKitGTK
/// workaround) forces X11 even inside a Wayland session. When nothing
/// identifies the session, "wayland" — the answer that disables the feature —
/// is the safe default.
#[tauri::command]
pub fn display_server() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        let forced_x11 = std::env::var("GDK_BACKEND")
            .is_ok_and(|backend| backend.split(',').next() == Some("x11"));
        if forced_x11 {
            "x11"
        } else if std::env::var("WAYLAND_DISPLAY").is_ok() {
            "wayland"
        } else if std::env::var("DISPLAY").is_ok() {
            "x11"
        } else {
            "wayland"
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        "none"
    }
}
