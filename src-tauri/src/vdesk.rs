//! Windows virtual-desktop awareness for the single-instance handoff.
//!
//! Windows 11 users park a window per virtual desktop and expect a launch from
//! desktop 3 to stay on desktop 3. `set_focus()` on a window that lives on
//! another desktop does the opposite: it yanks the whole desktop switch. So
//! lib.rs asks this module which surviving windows are on the desktop the user
//! is looking at right now, and only reuses one of those — otherwise it builds
//! a fresh window, which Windows places on the active desktop.
//!
//! `IVirtualDesktopManager` is the one *documented* shell interface here (the
//! richer `IVirtualDesktopManagerInternal` is undocumented and its vtable
//! changes between Windows builds — never reach for it).

use windows::core::Result;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

/// Is `hwnd` on the virtual desktop the user is currently looking at?
///
/// `None` = "could not tell" (pre-Win10 shell, COM refused, the window is
/// mid-creation and not yet assigned a desktop). Callers must treat that as
/// "assume yes" so a broken query degrades to the old focus-the-window
/// behaviour rather than spraying new windows.
///
/// `#[allow(dead_code)]` in debug: the only caller is the single-instance
/// callback, which is release-only (see lib.rs). Keeping the module compiled in
/// debug is deliberate — it is what makes CI's debug `clippy --all-targets`
/// type-check this file instead of leaving it to the release build.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn is_on_current_desktop(hwnd: HWND) -> Option<bool> {
    on_current_desktop(hwnd).ok()
}

fn on_current_desktop(hwnd: HWND) -> Result<bool> {
    // The caller is Tauri's main thread, which wry has already put in an STA —
    // this is a no-op returning S_FALSE there. It matters only if the handoff
    // ever runs somewhere else; an already-initialised thread is not an error,
    // and we deliberately never CoUninitialize (that would tear down wry's).
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let manager: IVirtualDesktopManager =
            CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL)?;
        Ok(manager.IsWindowOnCurrentVirtualDesktop(hwnd)?.as_bool())
    }
}
